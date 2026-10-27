import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
  PersistedStateSchema as LegacySchema,
  type PersistedState as LegacyState,
} from "./legacy.js";
import {
  PersistedStateSchema,
  ToolSchemas,
  type Content,
  type DisplaySnapshot,
  type PersistedState,
  type Receipt,
  type ToolCommand,
  type ToolName,
} from "./schemas.js";

FormatRegistry.Set(
  "date-time",
  (value) =>
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(
      value,
    ) && Number.isFinite(Date.parse(value)),
);

interface StateLogger {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
  error(details: object, message: string): void;
}

export class StateValidationError extends Error {
  constructor(
    message: string,
    readonly code = "invalid_request",
  ) {
    super(message);
    this.name = "StateValidationError";
  }
}

export interface StateStoreOptions {
  stateFile: string;
  logger: StateLogger;
  now?: () => Date;
  onChange?: (snapshot: DisplaySnapshot) => void;
  getLayout?: (
    snapshot: DisplaySnapshot,
    contentId: string,
  ) => { page: number; pageCount: number } | undefined;
}

export interface OperationResult {
  snapshot: DisplaySnapshot;
  operation?: {
    operationId: string;
    revision: number;
    replayed: boolean;
    contentId?: string;
    timerId?: string;
  };
}

function defaultState(now: Date): PersistedState {
  return {
    schemaVersion: 2,
    revision: 0,
    timers: [],
    receipts: [],
    updatedAt: now.toISOString(),
  };
}

// Object key order is irrelevant to an operation's identity; array order is meaningful.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function legacyContent(view: LegacyState["baseView"]): Content | undefined {
  if (view.type === "idle") return undefined;
  return {
    id: randomUUID(),
    page: 1,
    view:
      view.type === "list"
        ? {
            ...view,
            items: view.items.map((text) => ({
              id: randomUUID(),
              text,
              checked: false,
            })),
          }
        : view,
  };
}

function migrate(legacy: LegacyState, now: Date): PersistedState {
  const next = defaultState(now);
  const base = legacyContent(legacy.baseView);
  if (base) next.base = base;
  if (legacy.temporary) {
    const temporary = legacyContent(legacy.temporary.view)!;
    next.temporary = { ...temporary, expiresAt: legacy.temporary.expiresAt };
  }
  if (legacy.activeTimer) {
    const id = randomUUID();
    const timer = legacy.activeTimer;
    next.timers = [
      timer.status === "finished"
        ? {
            id,
            name: timer.name,
            status: "finished",
            endedAt: now.toISOString(),
            alertUntil: legacy.timerAlertUntil ?? now.toISOString(),
          }
        : { ...timer, id },
    ];
    if (legacy.timerFocused && timer.status !== "finished")
      next.focusedTimerId = id;
  }
  return next;
}

export class DisplayStateStore {
  readonly #stateFile: string;
  readonly #logger: StateLogger;
  readonly #now: () => Date;
  readonly #onChange: (snapshot: DisplaySnapshot) => void;
  readonly #getLayout: StateStoreOptions["getLayout"];
  #state: PersistedState;
  #operation: Promise<void> = Promise.resolve();
  #expiryTimer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: StateStoreOptions) {
    this.#stateFile = options.stateFile;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
    this.#onChange = options.onChange ?? (() => undefined);
    this.#getLayout = options.getLayout;
    this.#state = defaultState(this.#now());
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.#stateFile), { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.#stateFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.#persist(this.#state);
      return;
    }
    let stored: unknown;
    let legacy = false;
    try {
      stored = JSON.parse(raw) as unknown;
      if (Value.Check(LegacySchema, stored)) {
        stored = migrate(stored, this.#now());
        legacy = true;
      }
      if (!Value.Check(PersistedStateSchema, stored))
        throw new Error("invalid saved state");
      this.#validateState(stored);
    } catch {
      await rename(this.#stateFile, `${this.#stateFile}.corrupt-${Date.now()}`);
      this.#logger.warn(
        {},
        "saved state was corrupt; preserved it and started idle",
      );
      await this.#persist(this.#state);
      return;
    }
    if (legacy) {
      // Never overwrite a prior V1 backup or discard a valid state on an I/O failure.
      await writeFile(`${this.#stateFile}.v1-backup`, raw, {
        flag: "wx",
        mode: 0o600,
      }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
    this.#state = stored as PersistedState;
    const normalized = this.#normalizedState(this.#state, this.#now());
    await this.#persist(normalized);
    this.#state = normalized;
    this.#scheduleExpiry();
    this.#logger.info(
      { revision: this.#state.revision },
      "restored display state",
    );
  }

  snapshot(): DisplaySnapshot {
    const state = this.#state;
    const content = state.temporary ?? state.base;
    // The effective view must depend only on the committed revision. A wall-clock
    // check here could change the view before a lifecycle write has succeeded.
    const alert = state.timers.find(
      (timer) =>
        timer.status === "finished" &&
        Date.parse(timer.alertUntil) > Date.parse(state.updatedAt),
    );
    const focused =
      alert ?? state.timers.find((timer) => timer.id === state.focusedTimerId);
    return structuredClone({
      schemaVersion: 2,
      revision: state.revision,
      view: focused
        ? { type: "timer", timerId: focused.id }
        : content
          ? { type: content.view.type, contentId: content.id }
          : { type: "idle" },
      ...(content ? { content } : {}),
      ...(state.temporary && state.base
        ? { backgroundContent: state.base }
        : {}),
      timers: state.timers,
      updatedAt: state.updatedAt,
      serverTime: this.#now().toISOString(),
    });
  }

  async execute(name: string, args: unknown): Promise<OperationResult> {
    if (!Object.hasOwn(ToolSchemas, name))
      throw new StateValidationError("Unknown tool", "unknown_tool");
    const schema = ToolSchemas[name as ToolName];
    if (!Value.Check(schema, args)) {
      const errors = [...Value.Errors(schema, args)]
        .slice(0, 6)
        .map((error) => `${error.path || "/"}: ${error.message}`)
        .join("; ");
      throw new StateValidationError(errors);
    }
    const command = { name, args } as ToolCommand;
    return this.#enqueue(async () => {
      const normalized = this.#normalizedState(this.#state, this.#now());
      if (normalized !== this.#state) await this.#commit(normalized);
      if (command.name === "get_display_state")
        return { snapshot: this.snapshot() };
      const fingerprint = createHash("sha256")
        .update(canonical(command))
        .digest("hex");
      const previous = this.#state.receipts.find(
        (receipt) => receipt.operationId === command.args.operationId,
      );
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new StateValidationError(
            "operationId was already used with different arguments; use a new operationId",
            "operation_conflict",
          );
        return this.#result(previous, true);
      }
      const next = structuredClone(this.#state);
      const receipt: Receipt = {
        operationId: command.args.operationId,
        fingerprint,
        revision: next.revision + 1,
      };
      this.#apply(next, command, receipt);
      next.receipts = [...next.receipts, receipt].slice(-256);
      next.revision = receipt.revision;
      next.updatedAt = this.#now().toISOString();
      await this.#commit(next);
      return this.#result(receipt, false);
    });
  }

  #result(receipt: Receipt, replayed: boolean): OperationResult {
    const { fingerprint: _fingerprint, ...operation } = receipt;
    return { snapshot: this.snapshot(), operation: { ...operation, replayed } };
  }

  #content(state: PersistedState, id: string): Content {
    const content = [state.base, state.temporary].find(
      (item) => item?.id === id,
    );
    if (!content)
      throw new StateValidationError(
        "Content no longer exists; read get_display_state",
        "content_not_found",
      );
    return content;
  }

  #apply(
    state: PersistedState,
    command: Exclude<ToolCommand, { name: "get_display_state" }>,
    receipt: Receipt,
  ): void {
    const now = this.#now();
    if (
      command.name === "show_text" ||
      command.name === "show_recipe" ||
      command.name === "show_list"
    ) {
      const {
        operationId: _operationId,
        timeoutSeconds,
        ...fields
      } = command.args;
      let content: Content;
      if (command.name === "show_list") {
        content = {
          id: randomUUID(),
          page: 1,
          view: {
            type: "list",
            title: command.args.title,
            items: command.args.items.map((text) => ({
              id: randomUUID(),
              text,
              checked: false,
            })),
          },
        };
      } else if (command.name === "show_text") {
        content = {
          id: randomUUID(),
          page: 1,
          view: {
            type: "text",
            text: command.args.text,
            ...(command.args.title === undefined
              ? {}
              : { title: command.args.title }),
          },
        };
      } else {
        content = {
          id: randomUUID(),
          page: 1,
          view: { type: "recipe", ...fields } as Extract<
            Content["view"],
            { type: "recipe" }
          >,
        };
      }
      const timeout =
        timeoutSeconds ?? (command.name === "show_text" ? 120 : 0);
      if (timeout > 0) {
        content.expiresAt = new Date(
          now.getTime() + timeout * 1000,
        ).toISOString();
        state.temporary = content;
      } else {
        state.base = content;
        delete state.temporary;
      }
      delete state.focusedTimerId;
      receipt.contentId = content.id;
      return;
    }
    if (command.name === "clear_display") {
      delete state.base;
      delete state.temporary;
      delete state.focusedTimerId;
      return;
    }
    if ("contentId" in command.args) {
      const content = this.#content(state, command.args.contentId);
      receipt.contentId = content.id;
      switch (command.name) {
        case "update_text":
          if (content.view.type !== "text")
            throw new StateValidationError("Content must be text");
          content.view.text = command.args.text;
          if (command.args.title !== undefined)
            content.view.title = command.args.title;
          content.page = 1;
          break;
        case "update_list_item": {
          if (content.view.type !== "list")
            throw new StateValidationError("Content must be a list");
          const item = content.view.items.find(
            (item) => item.id === command.args.itemId,
          );
          if (!item)
            throw new StateValidationError(
              "List item no longer exists",
              "item_not_found",
            );
          item.checked = command.args.checked;
          if (command.args.text !== undefined) item.text = command.args.text;
          break;
        }
        case "set_recipe_step":
          if (content.view.type !== "recipe")
            throw new StateValidationError("Content must be a recipe");
          if (command.args.step > content.view.steps.length)
            throw new StateValidationError(
              "Step exceeds the number of recipe steps",
            );
          if (command.args.step === 0) delete content.focusedStep;
          else content.focusedStep = command.args.step;
          content.page = 1;
          break;
        case "set_page":
          content.page = command.args.page;
          break;
        case "next_page": {
          const layout = this.#getLayout?.(this.snapshot(), content.id);
          if (!layout)
            throw new StateValidationError(
              "Wait for the current content to be acknowledged by a visible renderer, or use set_page",
              "renderer_not_ready",
            );
          content.page = Math.max(
            1,
            Math.min(
              layout.pageCount,
              layout.page + (command.args.direction === "backward" ? -1 : 1),
            ),
          );
          break;
        }
      }
      delete state.focusedTimerId;
      return;
    }
    if (command.name === "start_timer") {
      if (state.timers.length >= 8)
        throw new StateValidationError(
          "At most 8 timers; cancel a timer before starting another",
          "timer_limit",
        );
      const id = randomUUID();
      state.timers.push({
        id,
        name: command.args.name,
        status: "active",
        endsAt: new Date(
          now.getTime() + command.args.durationSeconds * 1000,
        ).toISOString(),
      });
      if (command.args.focus) state.focusedTimerId = id;
      receipt.timerId = id;
      return;
    }
    if (!("timerId" in command.args)) return;
    const id = command.args.timerId;
    const timer = state.timers.find((timer) => timer.id === id);
    if (!timer)
      throw new StateValidationError(
        "Timer no longer exists; read get_display_state",
        "timer_not_found",
      );
    receipt.timerId = id;
    switch (command.name) {
      case "pause_timer":
        if (timer.status === "finished")
          throw new StateValidationError("A finished timer cannot be paused");
        if (timer.status === "active")
          state.timers[state.timers.indexOf(timer)] = {
            id,
            name: timer.name,
            status: "paused",
            remainingSeconds: Math.max(
              0,
              (Date.parse(timer.endsAt) - now.getTime()) / 1000,
            ),
          };
        break;
      case "resume_timer":
        if (timer.status === "finished")
          throw new StateValidationError(
            "A finished timer cannot be resumed; start a new timer",
          );
        if (timer.status === "paused")
          state.timers[state.timers.indexOf(timer)] = {
            id,
            name: timer.name,
            status: "active",
            endsAt: new Date(
              now.getTime() + timer.remainingSeconds * 1000,
            ).toISOString(),
          };
        break;
      case "cancel_timer":
        state.timers = state.timers.filter((timer) => timer.id !== id);
        if (state.focusedTimerId === id) delete state.focusedTimerId;
        break;
      case "focus_timer":
        state.focusedTimerId = id;
        break;
    }
  }

  #validateState(state: PersistedState): void {
    const contentIds = [state.base, state.temporary]
      .filter((item) => item !== undefined)
      .map((item) => item.id);
    if (
      new Set(contentIds).size !== contentIds.length ||
      (state.temporary && !state.temporary.expiresAt)
    )
      throw new Error("invalid contents");
    for (const content of [state.base, state.temporary]) {
      if (!content) continue;
      if (
        content.focusedStep &&
        (content.view.type !== "recipe" ||
          content.focusedStep > content.view.steps.length)
      )
        throw new Error("invalid focus");
      if (
        content.view.type === "list" &&
        new Set(content.view.items.map((item) => item.id)).size !==
          content.view.items.length
      )
        throw new Error("duplicate items");
    }
    if (
      new Set(state.timers.map((timer) => timer.id)).size !==
      state.timers.length
    )
      throw new Error("duplicate timers");
    if (
      new Set(state.receipts.map((receipt) => receipt.operationId)).size !==
        state.receipts.length ||
      state.receipts.some((receipt) => receipt.revision > state.revision)
    )
      throw new Error("invalid receipts");
  }

  #normalizedState(state: PersistedState, now: Date): PersistedState {
    const next = structuredClone(state);
    const time = now.getTime();
    let changed = false;
    if (next.temporary && Date.parse(next.temporary.expiresAt!) <= time) {
      delete next.temporary;
      changed = true;
    }
    next.timers = next.timers.map((timer) => {
      if (timer.status !== "active" || Date.parse(timer.endsAt) > time)
        return timer;
      changed = true;
      if (next.focusedTimerId === timer.id) delete next.focusedTimerId;
      return {
        id: timer.id,
        name: timer.name,
        status: "finished",
        endedAt: timer.endsAt,
        alertUntil: new Date(Date.parse(timer.endsAt) + 60_000).toISOString(),
      };
    });
    if (next.focusedTimerId) {
      const focused = next.timers.find(
        (timer) => timer.id === next.focusedTimerId,
      );
      if (!focused) {
        delete next.focusedTimerId;
        changed = true;
      }
    }
    // An alert's end changes the effective view even though the finished timer is retained.
    if (
      state.timers.some(
        (timer) =>
          timer.status === "finished" &&
          Date.parse(timer.alertUntil) <= time &&
          Date.parse(timer.alertUntil) > Date.parse(state.updatedAt),
      )
    )
      changed = true;
    if (!changed) return state;
    next.revision += 1;
    next.updatedAt = now.toISOString();
    return next;
  }

  async #commit(next: PersistedState): Promise<void> {
    // Publish only after durable acceptance. Failed writes leave the previous state visible.
    await this.#persist(next);
    this.#state = next;
    this.#scheduleExpiry();
    this.#onChange(this.snapshot());
  }

  async #persist(state: PersistedState): Promise<void> {
    const temporaryFile = `${this.#stateFile}.${process.pid}.tmp`;
    await writeFile(temporaryFile, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryFile, this.#stateFile);
  }

  #scheduleExpiry(retry = false): void {
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
    this.#expiryTimer = undefined;
    if (this.#closed) return;
    const now = this.#now().getTime();
    const deadlines = this.#state.timers.flatMap((timer) =>
      timer.status === "active"
        ? [Date.parse(timer.endsAt)]
        : timer.status === "finished" &&
            Date.parse(timer.alertUntil) > Date.parse(this.#state.updatedAt)
          ? [Date.parse(timer.alertUntil)]
          : [],
    );
    if (this.#state.temporary)
      deadlines.push(Date.parse(this.#state.temporary.expiresAt!));
    if (!deadlines.length) return;
    this.#expiryTimer = setTimeout(
      () => {
        void this.#enqueue(async () => {
          const next = this.#normalizedState(this.#state, this.#now());
          if (next !== this.#state) await this.#commit(next);
          else this.#scheduleExpiry();
        }).catch(() => {
          this.#logger.error(
            {},
            "could not persist display lifecycle; retrying",
          );
          this.#scheduleExpiry(true);
        });
      },
      retry
        ? 1000
        : Math.min(2_147_483_647, Math.max(0, Math.min(...deadlines) - now)),
    );
    this.#expiryTimer.unref();
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Display is closing"));
    const result = this.#operation.then(operation);
    this.#operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
    await this.#operation;
  }
}
