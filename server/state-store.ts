import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Value } from "@sinclair/typebox/value";

import {
  type DisplayCommand,
  PersistedStateSchema,
  type PersistedState,
  type TimerSync,
} from "./schemas.js";

const TEXT_DEFAULT_TIMEOUT_SECONDS = 120;
const TIMER_ALERT_SECONDS = 60;
const MAX_TIMER_DELAY = 2_147_483_647;

interface StateLogger {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
  error(details: object, message: string): void;
}

export class StateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateValidationError";
  }
}

export interface StateStoreOptions {
  stateFile: string;
  logger: StateLogger;
  now?: () => Date;
  onChange?: (snapshot: KitchenDisplayProtocol.DisplaySnapshot) => void;
}

function defaultState(now: Date): PersistedState {
  return {
    schemaVersion: 1,
    baseView: { type: "idle" },
    timerFocused: false,
    updatedAt: now.toISOString(),
  };
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function assertTimestamp(value: string, field: string): void {
  if (!validTimestamp(value)) {
    throw new StateValidationError(`${field} must be a valid ISO 8601 timestamp`);
  }
}

function displayViewFromCommand(
  command: Exclude<DisplayCommand, { type: "idle" } | { type: "timer" }>,
): KitchenDisplayProtocol.TextView |
  KitchenDisplayProtocol.RecipeView |
  KitchenDisplayProtocol.ListView {
  switch (command.type) {
    case "text":
      return {
        type: "text",
        ...(command.title === undefined ? {} : { title: command.title }),
        text: command.text,
      };
    case "recipe":
      return {
        type: "recipe",
        title: command.title,
        ingredients: [...command.ingredients],
        steps: [...command.steps],
        ...(command.cookingTimeMinutes === undefined
          ? {}
          : { cookingTimeMinutes: command.cookingTimeMinutes }),
      };
    case "list":
      return {
        type: "list",
        title: command.title,
        items: [...command.items],
      };
  }
}

function timerFromSync(
  timer: TimerSync | Extract<DisplayCommand, { type: "timer" }>,
): KitchenDisplayProtocol.TimerState {
  switch (timer.status) {
    case "active":
      assertTimestamp(timer.endsAt, "endsAt");
      return { name: timer.name, status: "active", endsAt: timer.endsAt };
    case "paused":
      return {
        name: timer.name,
        status: "paused",
        remainingSeconds: timer.remainingSeconds,
      };
    case "finished":
      return { name: timer.name, status: "finished" };
  }
}

function timeoutForCommand(
  command: Exclude<DisplayCommand, { type: "idle" } | { type: "timer" }>,
): number {
  if (command.timeoutSeconds !== undefined) {
    return command.timeoutSeconds;
  }
  return command.type === "text" ? TEXT_DEFAULT_TIMEOUT_SECONDS : 0;
}

function stateHasValidDates(state: PersistedState): boolean {
  if (!validTimestamp(state.updatedAt)) {
    return false;
  }
  if (state.temporary && !validTimestamp(state.temporary.expiresAt)) {
    return false;
  }
  if (state.timerAlertUntil && !validTimestamp(state.timerAlertUntil)) {
    return false;
  }
  return !(
    state.activeTimer?.status === "active" &&
    !validTimestamp(state.activeTimer.endsAt)
  );
}

export class DisplayStateStore {
  readonly #stateFile: string;
  readonly #logger: StateLogger;
  readonly #now: () => Date;
  readonly #onChange: (
    snapshot: KitchenDisplayProtocol.DisplaySnapshot,
  ) => void;
  #state: PersistedState;
  #operation: Promise<void> = Promise.resolve();
  #expiryTimer: NodeJS.Timeout | undefined;

  constructor(options: StateStoreOptions) {
    this.#stateFile = options.stateFile;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
    this.#onChange = options.onChange ?? (() => undefined);
    this.#state = defaultState(this.#now());
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.#stateFile), { recursive: true });

    try {
      const stored = JSON.parse(await readFile(this.#stateFile, "utf8")) as unknown;
      if (
        !Value.Check(PersistedStateSchema, stored) ||
        !stateHasValidDates(stored)
      ) {
        throw new Error("saved state does not match schema version 1");
      }
      this.#state = stored;
      const normalized = this.#normalizedState(this.#state, this.#now());
      if (normalized !== this.#state) {
        this.#state = normalized;
        await this.#persist(this.#state);
      }
      this.#logger.info(
        { stateType: this.snapshot().view.type },
        "restored display state",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const corruptPath = `${this.#stateFile}.corrupt-${this.#now()
          .toISOString()
          .replaceAll(":", "-")}`;
        try {
          await rename(this.#stateFile, corruptPath);
        } catch (renameError) {
          this.#logger.error(
            { error: renameError instanceof Error ? renameError.message : "unknown" },
            "could not preserve corrupt state file",
          );
        }
        this.#logger.warn(
          { reason: error instanceof Error ? error.message : "unknown" },
          "saved state was corrupt; starting idle",
        );
      }
      this.#state = defaultState(this.#now());
      await this.#persist(this.#state);
    }

    this.#scheduleExpiry();
  }

  snapshot(): KitchenDisplayProtocol.DisplaySnapshot {
    const serverTime = this.#now().toISOString();
    const view = this.#effectiveView();
    const temporaryVisible =
      view.type !== "timer" && this.#state.temporary?.view === view;

    return {
      schemaVersion: 1,
      view,
      ...(this.#state.activeTimer === undefined
        ? {}
        : { activeTimer: this.#state.activeTimer }),
      updatedAt: this.#state.updatedAt,
      ...(temporaryVisible && this.#state.temporary
        ? { expiresAt: this.#state.temporary.expiresAt }
        : {}),
      serverTime,
    };
  }

  async applyDisplayCommand(
    command: DisplayCommand,
  ): Promise<KitchenDisplayProtocol.DisplaySnapshot> {
    return this.#enqueue(async () => {
      const now = this.#now();
      let next = this.#normalizedState(this.#state, now);

      if (command.type === "timer") {
        next = {
          ...next,
          activeTimer: timerFromSync(command),
          timerFocused: true,
          updatedAt: now.toISOString(),
        };
        delete next.timerAlertUntil;
      } else if (command.type === "idle") {
        next = {
          ...next,
          baseView: { type: "idle" },
          timerFocused: false,
          updatedAt: now.toISOString(),
        };
        delete next.temporary;
      } else {
        const view = displayViewFromCommand(command);
        const timeoutSeconds = timeoutForCommand(command);
        next = {
          ...next,
          timerFocused: false,
          updatedAt: now.toISOString(),
        };
        if (timeoutSeconds === 0) {
          next.baseView = view;
          delete next.temporary;
        } else {
          next.temporary = {
            view,
            expiresAt: new Date(
              now.getTime() + timeoutSeconds * 1_000,
            ).toISOString(),
          };
        }
      }

      return this.#commit(next);
    });
  }

  async clearDisplay(): Promise<KitchenDisplayProtocol.DisplaySnapshot> {
    return this.applyDisplayCommand({ schemaVersion: 1, type: "idle" });
  }

  async synchronizeTimer(
    timer: TimerSync,
  ): Promise<KitchenDisplayProtocol.DisplaySnapshot> {
    return this.#enqueue(async () => {
      const now = this.#now();
      let next = this.#normalizedState(this.#state, now);
      const synchronizedTimer = timerFromSync(timer);
      const alreadyFinished = next.activeTimer?.status === "finished";

      next = {
        ...next,
        activeTimer: synchronizedTimer,
        updatedAt: now.toISOString(),
      };

      if (synchronizedTimer.status === "finished") {
        next.timerFocused = true;
        if (!alreadyFinished || !next.timerAlertUntil) {
          next.timerAlertUntil = new Date(
            now.getTime() + TIMER_ALERT_SECONDS * 1_000,
          ).toISOString();
        }
      } else {
        delete next.timerAlertUntil;
      }

      return this.#commit(next);
    });
  }

  async cancelTimer(): Promise<KitchenDisplayProtocol.DisplaySnapshot> {
    return this.#enqueue(async () => {
      const now = this.#now();
      const next = {
        ...this.#normalizedState(this.#state, now),
        timerFocused: false,
        updatedAt: now.toISOString(),
      };
      delete next.activeTimer;
      delete next.timerAlertUntil;
      return this.#commit(next);
    });
  }

  async close(): Promise<void> {
    if (this.#expiryTimer) {
      clearTimeout(this.#expiryTimer);
      this.#expiryTimer = undefined;
    }
    await this.#operation;
  }

  #effectiveView(): KitchenDisplayProtocol.DisplayState {
    if (this.#state.timerFocused && this.#state.activeTimer) {
      return { type: "timer" };
    }
    return this.#state.temporary?.view ?? this.#state.baseView;
  }

  #normalizedState(state: PersistedState, now: Date): PersistedState {
    const nowMs = now.getTime();
    let next = state;

    if (state.temporary && Date.parse(state.temporary.expiresAt) <= nowMs) {
      next = { ...next };
      delete next.temporary;
    }

    if (next.activeTimer?.status === "active") {
      const activeTimer = next.activeTimer;
      const endsAt = Date.parse(activeTimer.endsAt);
      if (endsAt <= nowMs) {
        const alertUntil = endsAt + TIMER_ALERT_SECONDS * 1_000;
        next = { ...next };
        if (alertUntil <= nowMs) {
          delete next.activeTimer;
          delete next.timerAlertUntil;
          next.timerFocused = false;
        } else {
          next.activeTimer = {
            name: activeTimer.name,
            status: "finished",
          };
          next.timerAlertUntil = new Date(alertUntil).toISOString();
          next.timerFocused = true;
        }
      }
    } else if (
      next.activeTimer?.status === "finished" &&
      next.timerAlertUntil &&
      Date.parse(next.timerAlertUntil) <= nowMs
    ) {
      next = { ...next };
      delete next.activeTimer;
      delete next.timerAlertUntil;
      next.timerFocused = false;
    }

    if (!next.activeTimer && next.timerFocused) {
      next = { ...next, timerFocused: false };
    }

    if (next !== state) {
      next.updatedAt = now.toISOString();
    }
    return next;
  }

  async #commit(
    next: PersistedState,
  ): Promise<KitchenDisplayProtocol.DisplaySnapshot> {
    const previous = this.#state;
    this.#state = next;
    try {
      await this.#persist(next);
    } catch (error) {
      this.#state = previous;
      this.#scheduleExpiry();
      throw error;
    }

    this.#scheduleExpiry();
    const snapshot = this.snapshot();
    this.#onChange(snapshot);
    return snapshot;
  }

  async #persist(state: PersistedState): Promise<void> {
    const temporaryFile = `${this.#stateFile}.${process.pid}.tmp`;
    await writeFile(temporaryFile, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryFile, this.#stateFile);
  }

  #scheduleExpiry(): void {
    if (this.#expiryTimer) {
      clearTimeout(this.#expiryTimer);
      this.#expiryTimer = undefined;
    }

    const candidates: number[] = [];
    if (this.#state.temporary) {
      candidates.push(Date.parse(this.#state.temporary.expiresAt));
    }
    if (this.#state.activeTimer?.status === "active") {
      candidates.push(Date.parse(this.#state.activeTimer.endsAt));
    }
    if (this.#state.timerAlertUntil) {
      candidates.push(Date.parse(this.#state.timerAlertUntil));
    }
    if (candidates.length === 0) {
      return;
    }

    const delay = Math.min(
      MAX_TIMER_DELAY,
      Math.max(0, Math.min(...candidates) - this.#now().getTime()),
    );
    this.#expiryTimer = setTimeout(() => {
      void this.#enqueue(async () => {
        const normalized = this.#normalizedState(this.#state, this.#now());
        if (normalized === this.#state) {
          this.#scheduleExpiry();
          return;
        }
        await this.#commit(normalized);
      }).catch((error: unknown) => {
        this.#logger.error(
          { error: error instanceof Error ? error.message : "unknown" },
          "could not expire display state",
        );
      });
    }, delay);
    this.#expiryTimer.unref();
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
