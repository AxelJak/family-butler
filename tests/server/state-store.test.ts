import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DisplayStateStore } from "../../server/state-store.js";
import type { DisplaySnapshot } from "../../server/schemas.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("standalone display state", () => {
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
  async function initialize(
    getLayout?: (
      snapshot: DisplaySnapshot,
      id: string,
    ) => { page: number; pageCount: number } | undefined,
  ) {
    store = new DisplayStateStore({
      stateFile,
      logger,
      ...(getLayout ? { getLayout } : {}),
    });
    await store.initialize();
    return store;
  }
  const list = {
    operationId: "list",
    title: "Handla",
    items: ["Mjölk", "Pasta"],
  };

  it("expires temporary content and restores the persistent content's identity and page", async () => {
    const state = await initialize();
    const base = await state.execute("show_list", list);
    const contentId = base.operation!.contentId!;
    await state.execute("set_page", {
      operationId: "page",
      contentId,
      page: 2,
    });
    const text = await state.execute("show_text", {
      operationId: "text",
      text: "Maten är klar",
    });
    expect(text.snapshot.content?.expiresAt).toBe("2026-09-03T10:02:00.000Z");
    expect(text.snapshot.backgroundContent?.id).toBe(contentId);
    await vi.advanceTimersByTimeAsync(120_000);
    await state.execute("get_display_state", {}); // Wait for queued lifecycle persistence.
    expect(state.snapshot().content).toMatchObject({
      id: contentId,
      page: 2,
      view: { type: "list" },
    });
  });

  it("deduplicates concurrent timer retries and persists receipts across restarts", async () => {
    let state = await initialize();
    const args = { operationId: "timer", name: "Pasta", durationSeconds: 60 };
    const results = await Promise.all([
      state.execute("start_timer", args),
      state.execute("start_timer", { ...args }),
    ]);
    expect(results[0]!.operation?.timerId).toBe(results[1]!.operation?.timerId);
    expect(results[1]!.operation?.replayed).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    await state.close();
    state = await initialize();
    const retry = await state.execute("start_timer", {
      durationSeconds: 60,
      name: "Pasta",
      operationId: "timer",
    });
    expect(retry.operation?.replayed).toBe(true);
    expect(retry.snapshot.timers).toHaveLength(1);
    expect(retry.snapshot.timers[0]).toMatchObject({
      endsAt: "2026-09-03T10:01:00.000Z",
    });
    await expect(
      state.execute("start_timer", { ...args, durationSeconds: 90 }),
    ).rejects.toMatchObject({ code: "operation_conflict" });
  });

  it("runs independent timers, preserves pause duration, alerts locally and restores content", async () => {
    const state = await initialize();
    await state.execute("show_list", list);
    const a = await state.execute("start_timer", {
      operationId: "a",
      name: "Pasta",
      durationSeconds: 30,
    });
    const b = await state.execute("start_timer", {
      operationId: "b",
      name: "Sås",
      durationSeconds: 90,
      focus: true,
    });
    const timerA = a.operation!.timerId!;
    const timerB = b.operation!.timerId!;
    await vi.advanceTimersByTimeAsync(10_500);
    await state.execute("pause_timer", {
      operationId: "pause",
      timerId: timerB,
    });
    expect(state.snapshot().timers[1]).toMatchObject({
      status: "paused",
      remainingSeconds: 79.5,
    });
    await vi.advanceTimersByTimeAsync(19_500);
    await state.execute("get_display_state", {});
    expect(state.snapshot().view).toEqual({ type: "timer", timerId: timerA });
    expect(state.snapshot().timers[0]).toMatchObject({ status: "finished" });
    await vi.advanceTimersByTimeAsync(60_000);
    await state.execute("get_display_state", {});
    expect(state.snapshot().view).toEqual({ type: "timer", timerId: timerB });
    await state.execute("clear_display", { operationId: "clear" });
    expect(state.snapshot().timers).toHaveLength(2);
    expect(state.snapshot().view).toEqual({ type: "idle" });
    await state.execute("resume_timer", {
      operationId: "resume",
      timerId: timerB,
    });
    expect(state.snapshot().timers[1]).toMatchObject({
      status: "active",
      endsAt: "2026-09-03T10:02:49.500Z",
    });
    await state.execute("cancel_timer", {
      operationId: "cancel",
      timerId: timerA,
    });
    expect(state.snapshot().timers.map((timer) => timer.id)).toEqual([timerB]);
  });

  it("recovers elapsed timers and temporary content after downtime without replaying old alerts", async () => {
    let state = await initialize();
    const base = await state.execute("show_list", list);
    await state.execute("show_text", {
      operationId: "temp",
      text: "Tillfälligt",
      timeoutSeconds: 10,
    });
    await state.execute("start_timer", {
      operationId: "timer",
      name: "Ägg",
      durationSeconds: 20,
      focus: true,
    });
    await state.close();
    vi.setSystemTime(new Date("2026-09-03T10:00:25Z"));
    state = await initialize();
    expect(state.snapshot().view.type).toBe("timer");
    expect(state.snapshot().timers[0]?.status).toBe("finished");
    await state.close();
    vi.setSystemTime(new Date("2026-09-03T10:05:00Z"));
    state = await initialize();
    expect(state.snapshot().view.type).toBe("list");
    expect(state.snapshot().content?.id).toBe(base.operation?.contentId);
    expect(state.snapshot().timers[0]?.status).toBe("finished");
  });

  it("targets list updates by stable IDs and rejects replaced content", async () => {
    const state = await initialize();
    const shown = await state.execute("show_list", list);
    const content = shown.snapshot.content!;
    if (content.view.type !== "list") throw new Error("Expected list");
    await state.execute("update_list_item", {
      operationId: "check",
      contentId: content.id,
      itemId: content.view.items[0]!.id,
      checked: true,
    });
    const updated = state.snapshot().content!.view;
    expect(updated).toMatchObject({
      items: [
        { checked: true, text: "Mjölk" },
        { checked: false, text: "Pasta" },
      ],
    });
    await state.execute("show_text", {
      operationId: "replace",
      text: "Hej",
      timeoutSeconds: 0,
    });
    await expect(
      state.execute("set_page", {
        operationId: "stale",
        contentId: content.id,
        page: 1,
      }),
    ).rejects.toMatchObject({ code: "content_not_found" });
  });

  it("focuses recipe steps and uses acknowledged pagination bounds", async () => {
    const state = await initialize(() => ({ page: 2, pageCount: 2 }));
    const shown = await state.execute("show_recipe", {
      operationId: "recipe",
      title: "Pasta",
      ingredients: ["Pasta"],
      steps: ["Koka", "Servera"],
    });
    const contentId = shown.operation!.contentId!;
    await state.execute("set_recipe_step", {
      operationId: "step",
      contentId,
      step: 2,
    });
    expect(state.snapshot().content?.focusedStep).toBe(2);
    await expect(
      state.execute("set_recipe_step", {
        operationId: "bad-step",
        contentId,
        step: 3,
      }),
    ).rejects.toThrow("Step exceeds");
    await state.execute("next_page", { operationId: "next", contentId });
    expect(state.snapshot().content?.page).toBe(2);
    await state.execute("next_page", {
      operationId: "back",
      contentId,
      direction: "backward",
    });
    expect(state.snapshot().content?.page).toBe(1);
    await state.execute("set_recipe_step", {
      operationId: "overview",
      contentId,
      step: 0,
    });
    expect(state.snapshot().content).not.toHaveProperty("focusedStep");
  });

  it("rejects malformed tools and timer overflow without changing state", async () => {
    const state = await initialize();
    for (const args of [
      { operationId: "bad", text: "Hej", extra: "x" },
      { operationId: "bad", text: "" },
      { operationId: "bad", text: "x".repeat(4001) },
      { operationId: "bad", text: "Hej", timeoutSeconds: "120" },
    ])
      await expect(state.execute("show_text", args)).rejects.toMatchObject({
        code: "invalid_request",
      });
    expect(state.snapshot().revision).toBe(0);
    for (let i = 0; i < 8; i++)
      await state.execute("start_timer", {
        operationId: `timer-${i}`,
        name: "Timer",
        durationSeconds: 60,
      });
    await expect(
      state.execute("start_timer", {
        operationId: "too-many",
        name: "Timer",
        durationSeconds: 60,
      }),
    ).rejects.toMatchObject({ code: "timer_limit" });
    expect(state.snapshot().timers).toHaveLength(8);
  });

  it("migrates V1 content and timers, retaining the original file", async () => {
    const legacy = {
      schemaVersion: 1,
      baseView: { type: "list", title: "Handla", items: ["Mjölk"] },
      temporary: {
        view: { type: "text", text: "Hej" },
        expiresAt: "2026-09-03T10:01:00Z",
      },
      activeTimer: {
        name: "Pasta",
        status: "active",
        endsAt: "2026-09-03T10:02:00Z",
      },
      timerFocused: false,
      updatedAt: "2026-09-03T10:00:00Z",
    };
    await writeFile(stateFile, JSON.stringify(legacy));
    const state = await initialize();
    expect(state.snapshot().schemaVersion).toBe(2);
    expect(state.snapshot().content?.view).toEqual({
      type: "text",
      text: "Hej",
    });
    expect(state.snapshot().backgroundContent?.view).toMatchObject({
      items: [{ text: "Mjölk", checked: false }],
    });
    expect(state.snapshot().timers[0]).toMatchObject({
      status: "active",
      name: "Pasta",
    });
    expect(
      JSON.parse(await readFile(`${stateFile}.v1-backup`, "utf8")),
    ).toEqual(legacy);
  });

  it("preserves corrupt state and starts idle", async () => {
    await writeFile(stateFile, "not json", "utf8");
    const state = await initialize();
    expect(state.snapshot().view).toEqual({ type: "idle" });
    expect(
      (await readdir(directory)).some((name) =>
        name.startsWith("state.json.corrupt-"),
      ),
    ).toBe(true);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("does not publish or remember an operation if persistence fails", async () => {
    const state = await initialize();
    // Prevent temporary-file creation without changing the committed file.
    await rm(directory, { recursive: true });
    await expect(state.execute("show_list", list)).rejects.toThrow();
    expect(state.snapshot().revision).toBe(0);
    expect(state.snapshot().content).toBeUndefined();
  });

  it("restores content after a focused timer completes, while allowing explicit focus on retained finished timers", async () => {
    const state = await initialize();
    await state.execute("show_list", list);
    const timer = await state.execute("start_timer", {
      operationId: "start",
      name: "Ägg",
      durationSeconds: 1,
      focus: true,
    });
    await vi.advanceTimersByTimeAsync(61_000);
    await state.execute("get_display_state", {});
    expect(state.snapshot().view.type).toBe("list");
    await state.execute("focus_timer", {
      operationId: "focus-finished",
      timerId: timer.operation!.timerId,
    });
    await state.execute("get_display_state", {});
    expect(state.snapshot().view).toEqual({
      type: "timer",
      timerId: timer.operation!.timerId,
    });
  });

  it("keeps the committed alert on a failed lifecycle write and retries recovery", async () => {
    const state = await initialize();
    await state.execute("show_list", list);
    await state.execute("start_timer", {
      operationId: "start",
      name: "Ägg",
      durationSeconds: 1,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await state.execute("get_display_state", {});
    expect(state.snapshot().view.type).toBe("timer");
    const revision = state.snapshot().revision;
    await rm(directory, { recursive: true });
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(state.execute("get_display_state", {})).rejects.toThrow();
    expect(state.snapshot().revision).toBe(revision);
    expect(state.snapshot().view.type).toBe("timer");
    await mkdir(directory);
    await vi.advanceTimersByTimeAsync(1000);
    await state.execute("get_display_state", {});
    expect(state.snapshot().view.type).toBe("list");
  });
});
