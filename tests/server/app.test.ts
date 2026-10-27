import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../server/app.js";
import type { DisplaySnapshot } from "../../server/schemas.js";
import type { OperationResult } from "../../server/state-store.js";

const TOKEN = "test-token-that-is-at-least-32-characters";
type Result = OperationResult & {
  delivery: {
    status: string;
    renderers: { acknowledged: boolean; page?: number; pageCount?: number }[];
  };
};

describe("MCP display appliance", () => {
  let directory: string;
  let app: FastifyInstance | undefined;
  let client: Client | undefined;
  let address: string;
  const streams: { cancel: () => Promise<void> }[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "kitchen-display-api-"));
  });
  afterEach(async () => {
    await Promise.all(streams.splice(0).map((stream) => stream.cancel()));
    await client?.close();
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function initialize() {
    app = await buildApp({
      config: {
        apiToken: TOKEN,
        host: "127.0.0.1",
        port: 3000,
        stateFile: join(directory, "state.json"),
        publicDir: resolve("dist/client"),
        logLevel: "silent",
      },
      logger: false,
    });
    address = await app.listen({ host: "127.0.0.1", port: 0 });
    client = new Client({ name: "test-assistant", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${address}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    return app;
  }
  async function call(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<Result> {
    const result = await client!.callTool({ name, arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result));
    return result.structuredContent as unknown as Result;
  }
  async function stream() {
    const controller = new AbortController();
    const response = await fetch(`${address}/api/events`, {
      signal: controller.signal,
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    streams.push({
      cancel: async () => {
        controller.abort();
        await reader.cancel().catch(() => undefined);
      },
    });
    const decoder = new TextDecoder();
    let buffer = "";
    async function frame(): Promise<{ event: string; data: unknown }> {
      while (true) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const message = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = message
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6);
          if (!data) continue;
          return {
            event: message
              .split("\n")
              .find((line) => line.startsWith("event: "))!
              .slice(7),
            data: JSON.parse(data) as unknown,
          };
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Stream closed unexpectedly");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    }
    const credentials = await frame();
    expect(credentials.event).toBe("renderer");
    const initial = await frame();
    return {
      credentials: credentials.data as { rendererId: string; token: string },
      initial: initial.data as DisplaySnapshot,
      frame,
    };
  }

  it("supports SDK initialization, tool discovery, structured results and retry semantics", async () => {
    await initialize();
    const tools = await client!.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("start_timer");
    expect(
      tools.tools.every(
        (tool) =>
          tool.inputSchema.additionalProperties === false && tool.outputSchema,
      ),
    ).toBe(true);
    const shown = await call("show_recipe", {
      operationId: "recipe",
      title: "Pasta",
      ingredients: ["Pasta"],
      steps: ["Koka"],
    });
    expect(shown.snapshot.content?.view).toMatchObject({
      type: "recipe",
      title: "Pasta",
    });
    expect(shown.operation?.contentId).toBeTruthy();
    expect(shown.delivery.status).toBe("disconnected");
    const retry = await call("show_recipe", {
      steps: ["Koka"],
      ingredients: ["Pasta"],
      title: "Pasta",
      operationId: "recipe",
    });
    expect(retry.operation).toMatchObject({
      replayed: true,
      contentId: shown.operation?.contentId,
    });
    const cleared = await call("clear_display", { operationId: "clear" });
    expect(cleared.snapshot.view).toEqual({ type: "idle" });
  });

  it("protects every MCP request and rejects foreign browser origins", async () => {
    await initialize();
    for (const method of ["POST", "GET", "DELETE"]) {
      expect((await fetch(`${address}/mcp`, { method })).status).toBe(401);
    }
    const forbidden = await fetch(`${address}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: "https://foreign.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(forbidden.status).toBe(403);
    const preflight = await fetch(`${address}/mcp`, {
      method: "OPTIONS",
      headers: {
        Origin: address,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(address);
    expect(
      (
        await fetch(`${address}/mcp`, {
          method: "OPTIONS",
          headers: { Origin: "https://foreign.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${address}/mcp`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        })
      ).status,
    ).toBe(405);
  });

  it("keeps renderer reads public and removes the old REST control routes", async () => {
    await initialize();
    expect((await fetch(`${address}/api/health`)).status).toBe(200);
    expect((await fetch(`${address}/api/display`)).status).toBe(200);
    expect(
      (
        await fetch(`${address}/api/health`, {
          headers: { Authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(401);
    for (const [method, path] of [
      ["POST", "/api/display"],
      ["DELETE", "/api/display"],
      ["PUT", "/api/timer"],
      ["DELETE", "/api/timer"],
    ]) {
      expect(
        (
          await fetch(`${address}${path}`, {
            method: method!,
            headers: { Authorization: `Bearer ${TOKEN}` },
          })
        ).status,
      ).toBe(404);
    }
  });

  it("returns actionable tool errors and never accepts extra fields or coerces values", async () => {
    await initialize();
    for (const args of [
      { operationId: "bad", text: "Hej", html: "<script>" },
      { operationId: "bad", text: "Hej", timeoutSeconds: "120" },
      { text: "Hej" },
    ]) {
      const result = await client!.callTool({
        name: "show_text",
        arguments: args,
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: "invalid_request" },
      });
    }
    const state = await call("get_display_state");
    expect(state.snapshot.revision).toBe(0);
    await expect(
      call("show_text", { operationId: "huge", text: "x".repeat(70_000) }),
    ).rejects.toThrow();
  });

  it("streams changes and accepts scoped renderer acknowledgements without control access", async () => {
    await initialize();
    const browser = await stream();
    expect(browser.initial.view).toEqual({ type: "idle" });
    const shown = await call("show_list", {
      operationId: "list",
      title: "Handla",
      items: ["Mjölk"],
    });
    expect(shown.delivery.status).toBe("pending");
    const pushed = (await browser.frame()).data as DisplaySnapshot;
    expect(pushed.revision).toBe(shown.snapshot.revision);
    const { rendererId, token } = browser.credentials;
    const report = {
      revision: pushed.revision,
      contentId: pushed.content!.id,
      page: 1,
      pageCount: 3,
      width: 1024,
      height: 768,
      visible: true,
    };
    const reported = await fetch(`${address}/api/renderers/${rendererId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(report),
    });
    expect(reported.status).toBe(200);
    const observed = await call("get_display_state");
    expect(observed.delivery.status).toBe("acknowledged");
    expect(observed.delivery.renderers[0]).toMatchObject({
      page: 1,
      pageCount: 3,
      acknowledged: true,
    });
    expect(
      (
        await fetch(`${address}/mcp`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(401);
    const next = await call("next_page", {
      operationId: "next",
      contentId: pushed.content!.id,
    });
    expect(next.snapshot.content?.page).toBe(2);
    expect(next.delivery.status).toBe("pending");
    const stale = await fetch(`${address}/api/renderers/${rendererId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(report),
    });
    expect(stale.status).toBe(409);
    const guessed = await fetch(`${address}/api/renderers/${rendererId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...report, revision: next.snapshot.revision }),
    });
    expect(guessed.status).toBe(401);
    const premature = await client!.callTool({
      name: "next_page",
      arguments: { operationId: "premature", contentId: pushed.content!.id },
    });
    expect(premature.isError).toBe(true);
    expect(premature.structuredContent).toMatchObject({
      error: { code: "renderer_not_ready" },
    });
  });

  it("does not treat hidden renderers as visible delivery and closes SSE on shutdown", async () => {
    await initialize();
    const browser = await stream();
    const { rendererId, token } = browser.credentials;
    await fetch(`${address}/api/renderers/${rendererId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        revision: 0,
        page: 1,
        pageCount: 1,
        width: 1024,
        height: 768,
        visible: false,
      }),
    });
    expect((await call("get_display_state")).delivery.status).toBe("pending");
    await client!.close();
    client = undefined;
    await app!.close();
    app = undefined;
  });
});
