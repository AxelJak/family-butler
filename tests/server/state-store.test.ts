import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DisplayStateStore } from "../../server/state-store.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("DisplayStateStore", () => {
  let directory: string;
  let stateFile: string;
  let store: DisplayStateStore | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T10:00:00Z"));
    directory = await mkdtemp(join(tmpdir(), "kitchen-display-state-"));
    stateFile = join(directory, "state.json");
  });

  afterEach(async () => {
    await store?.close();
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function initialize(): Promise<DisplayStateStore> {
    store = new DisplayStateStore({
      stateFile,
      logger,
      now: () => new Date(Date.now()),
    });
    await store.initialize();
    return store;
  }

  it("expires temporary text and restores the persistent base view", async () => {
    const state = await initialize();
    await state.applyDisplayCommand({
      schemaVersion: 1,
      type: "recipe",
      title: "Pasta",
      ingredients: ["Pasta"],
      steps: ["Koka"],
      timeoutSeconds: 0,
    });

    const temporary = await state.applyDisplayCommand({
      schemaVersion: 1,
      type: "text",
      text: "Maten är klar",
    });
    expect(temporary.view).toEqual({ type: "text", text: "Maten är klar" });
    expect(temporary.expiresAt).toBe("2026-09-03T10:02:00.000Z");

    await vi.advanceTimersByTimeAsync(120_000);
    expect(state.snapshot().view).toMatchObject({ type: "recipe", title: "Pasta" });
    expect(state.snapshot()).not.toHaveProperty("expiresAt");
  });

  it("keeps a timer as a banner until focused and restores content when cancelled", async () => {
    const state = await initialize();
    await state.applyDisplayCommand({
      schemaVersion: 1,
      type: "list",
      title: "Handla",
      items: ["Mjölk"],
      timeoutSeconds: 0,
    });

    const banner = await state.synchronizeTimer({
      schemaVersion: 1,
      name: "Pasta",
      status: "active",
      endsAt: "2026-09-03T10:10:00Z",
    });
    expect(banner.view.type).toBe("list");
    expect(banner.activeTimer).toMatchObject({ name: "Pasta", status: "active" });

    const focused = await state.applyDisplayCommand({
      schemaVersion: 1,
      type: "timer",
      name: "Pasta",
      status: "active",
      endsAt: "2026-09-03T10:10:00Z",
    });
    expect(focused.view.type).toBe("timer");

    const paused = await state.synchronizeTimer({
      schemaVersion: 1,
      name: "Pasta",
      status: "paused",
      remainingSeconds: 300,
    });
    expect(paused.view.type).toBe("timer");
    expect(paused.activeTimer).toEqual({ name: "Pasta", status: "paused", remainingSeconds: 300 });

    const cancelled = await state.cancelTimer();
    expect(cancelled.view).toMatchObject({ type: "list", title: "Handla" });
    expect(cancelled).not.toHaveProperty("activeTimer");
  });

  it("clears the main view without cancelling an active timer", async () => {
    const state = await initialize();
    await state.applyDisplayCommand({
      schemaVersion: 1,
      type: "timer",
      name: "Pasta",
      status: "active",
      endsAt: "2026-09-03T10:10:00Z",
    });

    const cleared = await state.clearDisplay();

    expect(cleared.view).toEqual({ type: "idle" });
    expect(cleared.activeTimer).toMatchObject({ name: "Pasta", status: "active" });
  });

  it("shows a finished timer for 60 seconds and then restores the base view", async () => {
    const state = await initialize();
    await state.applyDisplayCommand({
      schemaVersion: 1,
      type: "text",
      text: "Bakgrund",
      timeoutSeconds: 0,
    });

    const finished = await state.synchronizeTimer({
      schemaVersion: 1,
      name: "Kakan",
      status: "finished",
    });
    expect(finished.view.type).toBe("timer");
    expect(finished.activeTimer).toEqual({ name: "Kakan", status: "finished" });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.snapshot().view).toEqual({ type: "text", text: "Bakgrund" });
    expect(state.snapshot()).not.toHaveProperty("activeTimer");
  });

  it("restores valid state after restart", async () => {
    let state = await initialize();
    await state.applyDisplayCommand({
      schemaVersion: 1,
      type: "list",
      title: "Att göra",
      items: ["Duka"],
      timeoutSeconds: 0,
    });
    await state.close();

    store = state = new DisplayStateStore({
      stateFile,
      logger,
      now: () => new Date(Date.now()),
    });
    await state.initialize();
    expect(state.snapshot().view).toEqual({ type: "list", title: "Att göra", items: ["Duka"] });

    const persisted = JSON.parse(await readFile(stateFile, "utf8")) as { schemaVersion: number };
    expect(persisted.schemaVersion).toBe(1);
  });

  it("preserves corrupt state and starts idle", async () => {
    await writeFile(stateFile, "not json", "utf8");
    const state = await initialize();

    expect(state.snapshot().view).toEqual({ type: "idle" });
    expect((await readdir(directory)).some((name) => name.startsWith("state.json.corrupt-"))).toBe(true);
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
