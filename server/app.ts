import fastifyStatic from "@fastify/static";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import type { ServerConfig } from "./config.js";
import { DisplayEvents } from "./events.js";
import { createMcpServer } from "./mcp.js";
import { Renderers, tokenMatches } from "./renderers.js";
import { RendererReportSchema, type RendererReport } from "./schemas.js";
import { DisplayStateStore, StateValidationError } from "./state-store.js";

export interface BuildAppOptions {
  config: ServerConfig;
  logger?: boolean;
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

export async function buildApp(
  options: BuildAppOptions,
): Promise<FastifyInstance> {
  const { config } = options;
  const app = Fastify({
    logger: options.logger === false ? false : { level: config.logLevel },
    bodyLimit: 64 * 1024,
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        useDefaults: false,
      },
    },
    forceCloseConnections: true,
  });
  const events = new DisplayEvents();
  const renderers = new Renderers();
  const state = new DisplayStateStore({
    stateFile: config.stateFile,
    logger: app.log,
    onChange: (snapshot) => events.publish(snapshot),
    getLayout: (snapshot, contentId) => renderers.layout(snapshot, contentId),
  });
  await state.initialize();

  function requireControl(request: FastifyRequest): void {
    if (!tokenMatches(bearerToken(request), config.apiToken)) {
      throw new StateValidationError(
        "A valid control bearer token is required",
        "unauthorized",
      );
    }
  }

  function requireAllowedOrigin(request: FastifyRequest): void {
    const origin = request.headers.origin;
    if (origin === undefined) return; // Non-browser MCP clients often omit Origin.
    const ownOrigin = `${request.protocol}://${request.headers.host}`;
    if (origin !== ownOrigin && !config.allowedOrigins?.includes(origin)) {
      throw new StateValidationError(
        "Origin is not allowed",
        "forbidden_origin",
      );
    }
  }

  app.setErrorHandler((error, request, reply) => {
    const handled = error instanceof Error ? error : new Error("Unknown error");
    const code =
      handled instanceof StateValidationError
        ? handled.code
        : "validation" in handled ||
            ("statusCode" in handled && handled.statusCode === 400)
          ? "invalid_request"
          : "code" in handled && handled.code === "FST_ERR_CTP_BODY_TOO_LARGE"
            ? "payload_too_large"
            : "internal_error";
    const status =
      code === "unauthorized"
        ? 401
        : code === "forbidden_origin"
          ? 403
          : code === "stale_report"
            ? 409
            : code === "payload_too_large"
              ? 413
              : code === "internal_error"
                ? 500
                : 400;
    if (status >= 500)
      request.log.error({ requestId: request.id }, "request failed");
    void reply
      .status(status)
      .send({
        error: {
          code,
          message:
            status >= 500
              ? "The display server could not complete the request"
              : handled.message,
          requestId: request.id,
        },
      });
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Cache-Control", "no-store");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    if (request.url.startsWith("/mcp") || request.url.startsWith("/api/"))
      requireAllowedOrigin(request);
    if (request.url === "/mcp" && request.headers.origin) {
      reply.header("Access-Control-Allow-Origin", request.headers.origin);
      reply.header("Vary", "Origin");
      reply.header(
        "Access-Control-Allow-Methods",
        "POST, GET, DELETE, OPTIONS",
      );
      reply.header(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, Accept, MCP-Protocol-Version",
      );
    }
  });

  // Browser preflight carries no bearer token; the origin check still applies.
  app.options("/mcp", async (_request, reply) => reply.code(204).send());

  app.get("/api/health", async (request) => {
    if (request.headers.authorization !== undefined) requireControl(request);
    return {
      status: "ok",
      schemaVersion: 2,
      uptimeSeconds: Math.floor(process.uptime()),
      displayState: state.snapshot().view.type,
      connectedClients: events.listenerCount,
    };
  });
  app.get("/api/display", async () => state.snapshot());

  app.route({
    method: ["POST", "GET", "DELETE"],
    url: "/mcp",
    preHandler: async (request) => requireControl(request),
    handler: async (request, reply) => {
      if (request.method !== "POST")
        return reply
          .header("Allow", "POST")
          .code(405)
          .send({ error: "Use POST for stateless MCP" });
      const server = createMcpServer(state, renderers);
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      await server.connect(transport);
      reply.hijack();
      for (const [key, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) reply.raw.setHeader(key, value);
      }
      reply.raw.once("close", () => {
        void server.close().catch(() => undefined);
      });
      try {
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch {
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { "Content-Type": "application/json" });
          reply.raw.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32603, message: "MCP request failed" },
            }),
          );
        }
      }
    },
  });

  app.post<{ Params: { rendererId: string }; Body: RendererReport }>(
    "/api/renderers/:rendererId",
    {
      schema: { body: RendererReportSchema },
    },
    async (request) => {
      renderers.report(
        request.params.rendererId,
        bearerToken(request),
        request.body,
        state.snapshot(),
      );
      return { accepted: true };
    },
  );

  app.get("/api/events", async (_request, reply) => {
    const credentials = renderers.connect();
    reply.hijack();
    for (const [key, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(key, value);
    }
    reply.raw.writeHead(200, {
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    });
    reply.raw.flushHeaders();
    reply.raw.write(
      `retry: 2000\nevent: renderer\ndata: ${JSON.stringify(credentials)}\n\n`,
    );
    const send = (
      snapshot: ReturnType<DisplayStateStore["snapshot"]>,
    ): void => {
      if (!reply.raw.writableEnded)
        reply.raw.write(
          `id: ${snapshot.revision}\nevent: display\ndata: ${JSON.stringify(snapshot)}\n\n`,
        );
    };
    send(state.snapshot());
    const unsubscribe = events.subscribe(send);
    const heartbeat = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(": heartbeat\n\n");
    }, 15_000);
    heartbeat.unref();
    reply.raw.once("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      renderers.disconnect(credentials.rendererId);
    });
  });

  await app.register(fastifyStatic, {
    root: config.publicDir,
    cacheControl: false,
    etag: true,
    lastModified: true,
  });
  app.setNotFoundHandler((_request, reply) => {
    void reply
      .status(404)
      .send({ error: { code: "not_found", message: "Endpoint not found" } });
  });
  app.addHook("onClose", async () => state.close());
  return app;
}
