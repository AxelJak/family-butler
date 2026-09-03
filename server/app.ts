import { timingSafeEqual } from "node:crypto";

import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";

import type { ServerConfig } from "./config.js";
import { DisplayEvents } from "./events.js";
import {
  DisplayCommandSchema,
  type DisplayCommand,
  TimerSyncSchema,
  type TimerSync,
} from "./schemas.js";
import { DisplayStateStore, StateValidationError } from "./state-store.js";

class UnauthorizedError extends Error {
  constructor() {
    super("A valid bearer token is required");
    this.name = "UnauthorizedError";
  }
}

export interface BuildAppOptions {
  config: ServerConfig;
  logger?: boolean;
}

function bearerToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }
  return authorization.slice("Bearer ".length);
}

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) {
    return false;
  }
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function errorCode(error: Error): string {
  if (error instanceof UnauthorizedError) {
    return "unauthorized";
  }
  if (error instanceof StateValidationError || "validation" in error) {
    return "invalid_request";
  }
  if ("code" in error && error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return "payload_too_large";
  }
  return "internal_error";
}

function errorStatus(error: Error): number {
  if (error instanceof UnauthorizedError) {
    return 401;
  }
  if (error instanceof StateValidationError || "validation" in error) {
    return 400;
  }
  if ("code" in error && error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return 413;
  }
  return 500;
}

export async function buildApp(
  options: BuildAppOptions,
): Promise<FastifyInstance> {
  const { config } = options;
  const app = Fastify({
    logger: options.logger === false ? false : { level: config.logLevel },
    bodyLimit: 64 * 1_024,
    ajv: { customOptions: { removeAdditional: false } },
    forceCloseConnections: true,
  });
  const events = new DisplayEvents();
  const state = new DisplayStateStore({
    stateFile: config.stateFile,
    logger: app.log,
    onChange: (snapshot) => events.publish(snapshot),
  });
  await state.initialize();

  async function requireWriteAccess(request: FastifyRequest): Promise<void> {
    if (!tokenMatches(bearerToken(request), config.apiToken)) {
      throw new UnauthorizedError();
    }
  }

  app.setErrorHandler((error, request, reply) => {
    const handledError =
      error instanceof Error ? error : new Error("Unknown request error");
    const status = errorStatus(handledError);
    if (status >= 500) {
      request.log.error(
        { error: handledError.message, requestId: request.id },
        "request failed",
      );
    }
    void reply.status(status).send({
      error: {
        code: errorCode(handledError),
        message:
          status >= 500
            ? "The display server could not complete the request"
            : handledError.message,
        requestId: request.id,
      },
    });
  });

  app.addHook("onRequest", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; " +
        "style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'",
    );
  });

  app.get(
    "/api/health",
    {
      preHandler: async (request) => {
        if (request.headers.authorization !== undefined) {
          await requireWriteAccess(request);
        }
      },
    },
    async () => ({
      status: "ok",
      schemaVersion: 1,
      uptimeSeconds: Math.floor(process.uptime()),
      displayState: state.snapshot().view.type,
      connectedClients: events.listenerCount,
    }),
  );

  app.get("/api/display", async () => state.snapshot());

  app.post(
    "/api/display",
    {
      schema: { body: DisplayCommandSchema },
      preHandler: requireWriteAccess,
    },
    async (request) =>
      state.applyDisplayCommand(request.body as DisplayCommand),
  );

  app.delete(
    "/api/display",
    { preHandler: requireWriteAccess },
    async () => state.clearDisplay(),
  );

  app.put(
    "/api/timer",
    {
      schema: { body: TimerSyncSchema },
      preHandler: requireWriteAccess,
    },
    async (request) => state.synchronizeTimer(request.body as TimerSync),
  );

  app.delete(
    "/api/timer",
    { preHandler: requireWriteAccess },
    async () => state.cancelTimer(),
  );

  app.get("/api/events", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    });
    reply.raw.flushHeaders();
    reply.raw.write("retry: 2000\n\n");

    const send = (snapshot: KitchenDisplayProtocol.DisplaySnapshot): void => {
      if (!reply.raw.writableEnded) {
        reply.raw.write(
          `id: ${snapshot.updatedAt}\nevent: display\ndata: ${JSON.stringify(snapshot)}\n\n`,
        );
      }
    };
    send(state.snapshot());
    const unsubscribe = events.subscribe(send);
    const heartbeat = setInterval(() => {
      if (!reply.raw.writableEnded) {
        reply.raw.write(": heartbeat\n\n");
      }
    }, 15_000);
    heartbeat.unref();

    reply.raw.once("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  await app.register(fastifyStatic, {
    root: config.publicDir,
    cacheControl: false,
    etag: true,
    lastModified: true,
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      void reply.status(404).send({
        error: {
          code: "not_found",
          message: "API endpoint not found",
          requestId: request.id,
        },
      });
      return;
    }
    void reply.status(404).type("text/plain").send("Not found");
  });

  app.addHook("onClose", async () => state.close());
  return app;
}
