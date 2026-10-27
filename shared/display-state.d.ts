// Renderer wire types. All command/input validation lives in server/schemas.ts.
declare namespace KitchenDisplayProtocol {
  type TextView = { type: "text"; title?: string; text: string };
  type RecipeView = {
    type: "recipe";
    title: string;
    ingredients: string[];
    steps: string[];
    cookingTimeMinutes?: number;
  };
  type ListView = {
    type: "list";
    title: string;
    items: { id: string; text: string; checked: boolean }[];
  };
  type ContentView = TextView | RecipeView | ListView;
  type Content = {
    id: string;
    view: ContentView;
    page: number;
    focusedStep?: number;
    expiresAt?: string;
  };
  type TimerState = { id: string; name: string } & (
    | { status: "active"; endsAt: string }
    | { status: "paused"; remainingSeconds: number }
    | { status: "finished"; endedAt: string; alertUntil: string }
  );
  interface DisplaySnapshot {
    schemaVersion: 2;
    revision: number;
    view:
      | { type: "idle" }
      | { type: "text" | "recipe" | "list"; contentId: string }
      | { type: "timer"; timerId: string };
    content?: Content;
    backgroundContent?: Content;
    timers: TimerState[];
    updatedAt: string;
    serverTime: string;
  }
}
