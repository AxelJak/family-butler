import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../../server/app.js";
import type { ServerConfig } from "../../server/config.js";

const TOKEN = "test-token-that-is-at-least-32-characters";

describe("Kitchen Display API", () => {
  let directory: string;
  let app: FastifyInstance | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "kitchen-display-api-"));
  });

  afterEach(async () => {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  });

  function config(): ServerConfig {
    return {
      apiToken: TOKEN,
      host: "127.0.0.1",
      port: 3000,
      stateFile: join(directory, "state.json"),
      publicDir: resolve("dist/client"),
      logLevel: "silent",
    };
  }

  async function initialize(): Promise<FastifyInstance> {
    app = await buildApp({ config: config(), logger: false });
    return app;
  }

  it("keeps reads public and validates a supplied health-check token", async () => {
    const server = await initialize();
    expect((await server.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect(
      (await server.inject({ method: "GET", url: "/api/display" })).json().view,
    ).toEqual({ type: "idle" });

    const unauthorized = await server.inject({
      method: "GET",
      url: "/api/health",
      headers: { authorization: "Bearer wrong" },
    });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await server.inject({
      method: "GET",
      url: "/api/health",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(authorized.statusCode).toBe(200);
  });

  it("rejects unauthorized or invalid writes without changing state", async () => {
    const server = await initialize();
    const withoutToken = await server.inject({
      method: "POST",
      url: "/api/display",
      payload: { type: "text", text: "Hemligt" },
    });
    expect(withoutToken.statusCode).toBe(401);

    const invalid = await server.inject({
      method: "POST",
      url: "/api/display",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { type: "text", text: "<script>alert(1)</script>", extra: true },
    });
    expect(invalid.statusCode).toBe(400);

    const current = await server.inject({ method: "GET", url: "/api/display" });
    expect(current.json().view).toEqual({ type: "idle" });
  });

  it("accepts a structured command and clears it", async () => {
    const server = await initialize();
    const shown = await server.inject({
      method: "POST",
      url: "/api/display",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        schemaVersion: 1,
        type: "recipe",
        title: "Pasta",
        ingredients: ["Pasta", "Parmesan"],
        steps: ["Koka pastan"],
      },
    });
    expect(shown.statusCode).toBe(200);
    expect(shown.json().view).toMatchObject({ type: "recipe", title: "Pasta" });

    const cleared = await server.inject({
      method: "DELETE",
      url: "/api/display",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().view).toEqual({ type: "idle" });
  });

  it("sends SSE snapshots and closes active streams during shutdown", async () => {
    const server = await initialize();
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${address}/api/events`, { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.body).not.toBeNull();

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const snapshots: KitchenDisplayProtocol.DisplaySnapshot[] = [];

    async function readUntil(count: number): Promise<void> {
      while (snapshots.length < count) {
        const chunk = await reader.read();
        if (chunk.done) {
          throw new Error("SSE stream closed unexpectedly");
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6);
          if (data) {
            snapshots.push(JSON.parse(data) as KitchenDisplayProtocol.DisplaySnapshot);
          }
        }
      }
    }

    await readUntil(1);
    expect(snapshots[0]?.view).toEqual({ type: "idle" });

    await fetch(`${address}/api/display`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "text", text: "Hej köket", timeoutSeconds: 0 }),
    });
    await readUntil(2);
    expect(snapshots[1]?.view).toEqual({ type: "text", text: "Hej köket" });

    await server.close();
    app = undefined;
    controller.abort();
    await reader.cancel().catch(() => undefined);
  });
});
