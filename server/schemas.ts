import { type Static, Type } from "@sinclair/typebox";

const objectOptions = { additionalProperties: false };
export const IdSchema = Type.String({ minLength: 1, maxLength: 128 });
const Title = Type.String({ minLength: 1, maxLength: 120 });
const ItemText = Type.String({ minLength: 1, maxLength: 500 });
const Items = Type.Array(ItemText, { minItems: 1, maxItems: 50 });
const Text = Type.String({ minLength: 1, maxLength: 4_000 });
const DateTime = Type.String({ format: "date-time" });
const Page = Type.Integer({ minimum: 1, maximum: 100_000 });
const Timeout = Type.Optional(
  Type.Union([Type.Literal(0), Type.Integer({ minimum: 10, maximum: 86_400 })]),
);

export const ListItemSchema = Type.Object(
  {
    id: IdSchema,
    text: ItemText,
    checked: Type.Boolean(),
  },
  objectOptions,
);

export const ContentViewSchema = Type.Union([
  Type.Object(
    { type: Type.Literal("text"), title: Type.Optional(Title), text: Text },
    objectOptions,
  ),
  Type.Object(
    {
      type: Type.Literal("recipe"),
      title: Title,
      ingredients: Items,
      steps: Items,
      cookingTimeMinutes: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 1440 }),
      ),
    },
    objectOptions,
  ),
  Type.Object(
    {
      type: Type.Literal("list"),
      title: Title,
      items: Type.Array(ListItemSchema, { minItems: 1, maxItems: 50 }),
    },
    objectOptions,
  ),
]);

export const ContentSchema = Type.Object(
  {
    id: IdSchema,
    view: ContentViewSchema,
    page: Page,
    focusedStep: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    expiresAt: Type.Optional(DateTime),
  },
  objectOptions,
);

const TimerFields = { id: IdSchema, name: Title };
export const TimerSchema = Type.Union([
  Type.Object(
    { ...TimerFields, status: Type.Literal("active"), endsAt: DateTime },
    objectOptions,
  ),
  Type.Object(
    {
      ...TimerFields,
      status: Type.Literal("paused"),
      remainingSeconds: Type.Number({ minimum: 0, maximum: 86_400 }),
    },
    objectOptions,
  ),
  Type.Object(
    {
      ...TimerFields,
      status: Type.Literal("finished"),
      endedAt: DateTime,
      alertUntil: DateTime,
    },
    objectOptions,
  ),
]);

export const SnapshotSchema = Type.Object(
  {
    schemaVersion: Type.Literal(2),
    revision: Type.Integer({ minimum: 0 }),
    view: Type.Union([
      Type.Object({ type: Type.Literal("idle") }, objectOptions),
      Type.Object(
        {
          type: Type.Union([
            Type.Literal("text"),
            Type.Literal("recipe"),
            Type.Literal("list"),
          ]),
          contentId: IdSchema,
        },
        objectOptions,
      ),
      Type.Object(
        { type: Type.Literal("timer"), timerId: IdSchema },
        objectOptions,
      ),
    ]),
    content: Type.Optional(ContentSchema),
    backgroundContent: Type.Optional(ContentSchema),
    timers: Type.Array(TimerSchema, { maxItems: 8 }),
    updatedAt: DateTime,
    serverTime: DateTime,
  },
  objectOptions,
);

const ReceiptSchema = Type.Object(
  {
    operationId: IdSchema,
    fingerprint: Type.String(),
    revision: Type.Integer({ minimum: 1 }),
    contentId: Type.Optional(IdSchema),
    timerId: Type.Optional(IdSchema),
  },
  objectOptions,
);

export const PersistedStateSchema = Type.Object(
  {
    schemaVersion: Type.Literal(2),
    revision: Type.Integer({ minimum: 0 }),
    base: Type.Optional(ContentSchema),
    temporary: Type.Optional(ContentSchema),
    timers: Type.Array(TimerSchema, { maxItems: 8 }),
    focusedTimerId: Type.Optional(IdSchema),
    receipts: Type.Array(ReceiptSchema, { maxItems: 256 }),
    updatedAt: DateTime,
  },
  objectOptions,
);

export const RendererReportSchema = Type.Object(
  {
    revision: Type.Integer({ minimum: 0 }),
    contentId: Type.Optional(IdSchema),
    page: Page,
    pageCount: Page,
    width: Type.Integer({ minimum: 1, maximum: 16384 }),
    height: Type.Integer({ minimum: 1, maximum: 16384 }),
    visible: Type.Boolean(),
  },
  objectOptions,
);

const operation = {
  operationId: Type.String({
    minLength: 1,
    maxLength: 128,
    description:
      "Unique ID for this action. Reuse the same ID and arguments only when retrying; retained for the latest 256 actions across restarts.",
  }),
};
const contentTarget = { ...operation, contentId: IdSchema };
const timerTarget = { ...operation, timerId: IdSchema };

// These exact JSON Schemas are both advertised by MCP and enforced at execution.
export const ToolSchemas = {
  get_display_state: Type.Object({}, objectOptions),
  show_text: Type.Object(
    {
      ...operation,
      text: Text,
      title: Type.Optional(Title),
      timeoutSeconds: Timeout,
    },
    objectOptions,
  ),
  show_recipe: Type.Object(
    {
      ...operation,
      title: Title,
      ingredients: Items,
      steps: Items,
      cookingTimeMinutes: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 1440 }),
      ),
      timeoutSeconds: Timeout,
    },
    objectOptions,
  ),
  show_list: Type.Object(
    { ...operation, title: Title, items: Items, timeoutSeconds: Timeout },
    objectOptions,
  ),
  update_text: Type.Object(
    { ...contentTarget, text: Text, title: Type.Optional(Title) },
    objectOptions,
  ),
  update_list_item: Type.Object(
    {
      ...contentTarget,
      itemId: IdSchema,
      checked: Type.Boolean(),
      text: Type.Optional(ItemText),
    },
    objectOptions,
  ),
  set_recipe_step: Type.Object(
    {
      ...contentTarget,
      step: Type.Integer({
        minimum: 0,
        maximum: 50,
        description: "1-based recipe step; 0 restores the overview.",
      }),
    },
    objectOptions,
  ),
  set_page: Type.Object({ ...contentTarget, page: Page }, objectOptions),
  next_page: Type.Object(
    {
      ...contentTarget,
      direction: Type.Optional(
        Type.Union([Type.Literal("forward"), Type.Literal("backward")]),
      ),
    },
    objectOptions,
  ),
  clear_display: Type.Object(operation, objectOptions),
  start_timer: Type.Object(
    {
      ...operation,
      name: Title,
      durationSeconds: Type.Integer({ minimum: 1, maximum: 86_400 }),
      focus: Type.Optional(Type.Boolean({ default: false })),
    },
    objectOptions,
  ),
  pause_timer: Type.Object(timerTarget, objectOptions),
  resume_timer: Type.Object(timerTarget, objectOptions),
  cancel_timer: Type.Object(timerTarget, objectOptions),
  focus_timer: Type.Object(timerTarget, objectOptions),
};

export type ToolName = keyof typeof ToolSchemas;
export type ToolArguments<N extends ToolName> = Static<(typeof ToolSchemas)[N]>;
export type ToolCommand = {
  [N in ToolName]: { name: N; args: ToolArguments<N> };
}[ToolName];
export type PersistedState = Static<typeof PersistedStateSchema>;
export type DisplaySnapshot = Static<typeof SnapshotSchema>;
export type Content = Static<typeof ContentSchema>;
export type Timer = Static<typeof TimerSchema>;
export type Receipt = Static<typeof ReceiptSchema>;
export type RendererReport = Static<typeof RendererReportSchema>;
