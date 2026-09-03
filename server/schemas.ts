import { type Static, Type } from "@sinclair/typebox";

const TITLE_MAX_LENGTH = 120;
const CONTENT_MAX_LENGTH = 4_000;
const ITEM_MAX_LENGTH = 500;
const ITEM_MAX_COUNT = 50;
const TIMEOUT_MAX_SECONDS = 86_400;

const SchemaVersionProperty = Type.Optional(Type.Literal(1));
const TitleSchema = Type.String({ minLength: 1, maxLength: TITLE_MAX_LENGTH });
const ItemSchema = Type.String({ minLength: 1, maxLength: ITEM_MAX_LENGTH });
const TimeoutSchema = Type.Optional(
  Type.Union([
    Type.Literal(0),
    Type.Integer({ minimum: 10, maximum: TIMEOUT_MAX_SECONDS }),
  ]),
);

export const IdleViewSchema = Type.Object(
  { type: Type.Literal("idle") },
  { additionalProperties: false },
);

export const TextViewSchema = Type.Object(
  {
    type: Type.Literal("text"),
    title: Type.Optional(TitleSchema),
    text: Type.String({ minLength: 1, maxLength: CONTENT_MAX_LENGTH }),
  },
  { additionalProperties: false },
);

export const RecipeViewSchema = Type.Object(
  {
    type: Type.Literal("recipe"),
    title: TitleSchema,
    ingredients: Type.Array(ItemSchema, {
      minItems: 1,
      maxItems: ITEM_MAX_COUNT,
    }),
    steps: Type.Array(ItemSchema, { minItems: 1, maxItems: ITEM_MAX_COUNT }),
    cookingTimeMinutes: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 1_440 }),
    ),
  },
  { additionalProperties: false },
);

export const ListViewSchema = Type.Object(
  {
    type: Type.Literal("list"),
    title: TitleSchema,
    items: Type.Array(ItemSchema, { minItems: 1, maxItems: ITEM_MAX_COUNT }),
  },
  { additionalProperties: false },
);

export const TimerViewSchema = Type.Object(
  { type: Type.Literal("timer") },
  { additionalProperties: false },
);

export const BaseViewSchema = Type.Union([
  IdleViewSchema,
  TextViewSchema,
  RecipeViewSchema,
  ListViewSchema,
]);

export const DisplayViewSchema = Type.Union([
  IdleViewSchema,
  TextViewSchema,
  RecipeViewSchema,
  ListViewSchema,
  TimerViewSchema,
]);

export const ActiveTimerSchema = Type.Object(
  {
    name: TitleSchema,
    status: Type.Literal("active"),
    endsAt: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);

export const PausedTimerSchema = Type.Object(
  {
    name: TitleSchema,
    status: Type.Literal("paused"),
    remainingSeconds: Type.Integer({ minimum: 0, maximum: TIMEOUT_MAX_SECONDS }),
  },
  { additionalProperties: false },
);

export const FinishedTimerSchema = Type.Object(
  {
    name: TitleSchema,
    status: Type.Literal("finished"),
  },
  { additionalProperties: false },
);

export const TimerStateSchema = Type.Union([
  ActiveTimerSchema,
  PausedTimerSchema,
  FinishedTimerSchema,
]);

const IdleCommandSchema = Type.Object(
  { schemaVersion: SchemaVersionProperty, type: Type.Literal("idle") },
  { additionalProperties: false },
);

const TextCommandSchema = Type.Object(
  {
    schemaVersion: SchemaVersionProperty,
    type: Type.Literal("text"),
    title: Type.Optional(TitleSchema),
    text: Type.String({ minLength: 1, maxLength: CONTENT_MAX_LENGTH }),
    timeoutSeconds: TimeoutSchema,
  },
  { additionalProperties: false },
);

const RecipeCommandSchema = Type.Object(
  {
    schemaVersion: SchemaVersionProperty,
    type: Type.Literal("recipe"),
    title: TitleSchema,
    ingredients: Type.Array(ItemSchema, {
      minItems: 1,
      maxItems: ITEM_MAX_COUNT,
    }),
    steps: Type.Array(ItemSchema, { minItems: 1, maxItems: ITEM_MAX_COUNT }),
    cookingTimeMinutes: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 1_440 }),
    ),
    timeoutSeconds: TimeoutSchema,
  },
  { additionalProperties: false },
);

const ListCommandSchema = Type.Object(
  {
    schemaVersion: SchemaVersionProperty,
    type: Type.Literal("list"),
    title: TitleSchema,
    items: Type.Array(ItemSchema, { minItems: 1, maxItems: ITEM_MAX_COUNT }),
    timeoutSeconds: TimeoutSchema,
  },
  { additionalProperties: false },
);

const TimerCommandSchema = Type.Object(
  {
    schemaVersion: SchemaVersionProperty,
    type: Type.Literal("timer"),
    name: TitleSchema,
    status: Type.Literal("active"),
    endsAt: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);

export const DisplayCommandSchema = Type.Union([
  IdleCommandSchema,
  TextCommandSchema,
  RecipeCommandSchema,
  ListCommandSchema,
  TimerCommandSchema,
]);

const TimerSyncActiveSchema = Type.Object(
  {
    schemaVersion: SchemaVersionProperty,
    name: TitleSchema,
    status: Type.Literal("active"),
    endsAt: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);

const TimerSyncPausedSchema = Type.Object(
  {
    schemaVersion: SchemaVersionProperty,
    name: TitleSchema,
    status: Type.Literal("paused"),
    remainingSeconds: Type.Integer({ minimum: 0, maximum: TIMEOUT_MAX_SECONDS }),
  },
  { additionalProperties: false },
);

const TimerSyncFinishedSchema = Type.Object(
  {
    schemaVersion: SchemaVersionProperty,
    name: TitleSchema,
    status: Type.Literal("finished"),
  },
  { additionalProperties: false },
);

export const TimerSyncSchema = Type.Union([
  TimerSyncActiveSchema,
  TimerSyncPausedSchema,
  TimerSyncFinishedSchema,
]);

export const PersistedStateSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    baseView: BaseViewSchema,
    temporary: Type.Optional(
      Type.Object(
        {
          view: Type.Union([TextViewSchema, RecipeViewSchema, ListViewSchema]),
          expiresAt: Type.String({ minLength: 1, maxLength: 64 }),
        },
        { additionalProperties: false },
      ),
    ),
    activeTimer: Type.Optional(TimerStateSchema),
    timerFocused: Type.Boolean(),
    timerAlertUntil: Type.Optional(
      Type.String({ minLength: 1, maxLength: 64 }),
    ),
    updatedAt: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);

export const ErrorResponseSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String(),
        message: Type.String(),
        requestId: Type.String(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type DisplayCommand = Static<typeof DisplayCommandSchema>;
export type TimerSync = Static<typeof TimerSyncSchema>;
export type PersistedState = Static<typeof PersistedStateSchema>;

export const limits = {
  titleLength: TITLE_MAX_LENGTH,
  contentLength: CONTENT_MAX_LENGTH,
  itemLength: ITEM_MAX_LENGTH,
  itemCount: ITEM_MAX_COUNT,
  timeoutSeconds: TIMEOUT_MAX_SECONDS,
} as const;
