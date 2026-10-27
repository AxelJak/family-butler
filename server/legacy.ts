// Read-only V1 disk schema, retained solely for one-way state migration.
import { type Static, Type } from "@sinclair/typebox";

const options = { additionalProperties: false };
const title = Type.String({ minLength: 1, maxLength: 120 });
const item = Type.String({ minLength: 1, maxLength: 500 });
const items = Type.Array(item, { minItems: 1, maxItems: 50 });
const timestamp = Type.String({ format: "date-time" });
const content = Type.Union([
  Type.Object(
    {
      type: Type.Literal("text"),
      title: Type.Optional(title),
      text: Type.String({ minLength: 1, maxLength: 4000 }),
    },
    options,
  ),
  Type.Object(
    {
      type: Type.Literal("recipe"),
      title,
      ingredients: items,
      steps: items,
      cookingTimeMinutes: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 1440 }),
      ),
    },
    options,
  ),
  Type.Object({ type: Type.Literal("list"), title, items }, options),
]);

export const PersistedStateSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    baseView: Type.Union([
      Type.Object({ type: Type.Literal("idle") }, options),
      content,
    ]),
    temporary: Type.Optional(
      Type.Object({ view: content, expiresAt: timestamp }, options),
    ),
    activeTimer: Type.Optional(
      Type.Union([
        Type.Object(
          { name: title, status: Type.Literal("active"), endsAt: timestamp },
          options,
        ),
        Type.Object(
          {
            name: title,
            status: Type.Literal("paused"),
            remainingSeconds: Type.Integer({ minimum: 0, maximum: 86400 }),
          },
          options,
        ),
        Type.Object({ name: title, status: Type.Literal("finished") }, options),
      ]),
    ),
    timerFocused: Type.Boolean(),
    timerAlertUntil: Type.Optional(timestamp),
    updatedAt: timestamp,
  },
  options,
);
export type PersistedState = Static<typeof PersistedStateSchema>;
