declare namespace KitchenDisplayProtocol {
  type IdleView = { type: "idle" };

  type TextView = {
    type: "text";
    title?: string;
    text: string;
  };

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
    items: string[];
  };

  type TimerView = { type: "timer" };

  type DisplayState =
    | IdleView
    | TextView
    | RecipeView
    | ListView
    | TimerView;

  type ActiveTimer = {
    name: string;
    status: "active";
    endsAt: string;
  };

  type PausedTimer = {
    name: string;
    status: "paused";
    remainingSeconds: number;
  };

  type FinishedTimer = {
    name: string;
    status: "finished";
  };

  type TimerState = ActiveTimer | PausedTimer | FinishedTimer;

  interface DisplaySnapshot {
    schemaVersion: 1;
    view: DisplayState;
    activeTimer?: TimerState;
    updatedAt: string;
    expiresAt?: string;
    serverTime: string;
  }
}
