(function () {
  "use strict";

  var TIME_ZONE = "Europe/Stockholm";
  var MAX_RECONNECT_DELAY = 30000;
  var app = requiredElement("app");
  var connectionStatus = requiredElement("connection-status");
  var snapshot: KitchenDisplayProtocol.DisplaySnapshot | null = null;
  var eventSource: EventSource | null = null;
  var reconnectTimer: number | null = null;
  var reconnectDelay = 1000;
  var serverOffsetMilliseconds = 0;

  function requiredElement(id: string): HTMLElement {
    var found = document.getElementById(id);
    if (!found) {
      throw new Error("Missing element: " + id);
    }
    return found;
  }

  function createElement(
    tagName: string,
    className?: string,
    text?: string,
  ): HTMLElement {
    var result = document.createElement(tagName);
    if (className) {
      result.className = className;
    }
    if (text !== undefined) {
      result.textContent = text;
    }
    return result;
  }

  function clear(element: HTMLElement): void {
    while (element.firstChild) {
      element.removeChild(element.firstChild);
    }
  }

  function setConnectionStatus(message?: string): void {
    if (!message) {
      connectionStatus.className = "connection-status is-hidden";
      return;
    }
    connectionStatus.textContent = message;
    connectionStatus.className = "connection-status";
  }

  function correctedNow(): Date {
    return new Date(Date.now() + serverOffsetMilliseconds);
  }

  function formatClock(date: Date): string {
    try {
      return new Intl.DateTimeFormat("sv-SE", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: TIME_ZONE,
      }).format(date);
    } catch (_error) {
      return twoDigits(date.getHours()) + ":" + twoDigits(date.getMinutes());
    }
  }

  function formatDate(date: Date): string {
    try {
      return new Intl.DateTimeFormat("sv-SE", {
        weekday: "long",
        day: "numeric",
        month: "long",
        timeZone: TIME_ZONE,
      }).format(date);
    } catch (_error) {
      var weekdays = [
        "söndag",
        "måndag",
        "tisdag",
        "onsdag",
        "torsdag",
        "fredag",
        "lördag",
      ];
      var months = [
        "januari",
        "februari",
        "mars",
        "april",
        "maj",
        "juni",
        "juli",
        "augusti",
        "september",
        "oktober",
        "november",
        "december",
      ];
      return (
        weekdays[date.getDay()] +
        " " +
        date.getDate() +
        " " +
        months[date.getMonth()]
      );
    }
  }

  function twoDigits(value: number): string {
    return value < 10 ? "0" + value : String(value);
  }

  function formatDuration(totalSeconds: number): string {
    var seconds = Math.max(0, Math.ceil(totalSeconds));
    var hours = Math.floor(seconds / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    var remainder = seconds % 60;
    if (hours > 0) {
      return hours + ":" + twoDigits(minutes) + ":" + twoDigits(remainder);
    }
    return twoDigits(minutes) + ":" + twoDigits(remainder);
  }

  function timerSeconds(timer: KitchenDisplayProtocol.TimerState): number {
    if (timer.status === "finished") {
      return 0;
    }
    if (timer.status === "paused") {
      return timer.remainingSeconds;
    }
    return (Date.parse(timer.endsAt) - correctedNow().getTime()) / 1000;
  }

  function appendHeading(
    parent: HTMLElement,
    title: string,
    eyebrow?: string,
  ): void {
    if (eyebrow) {
      parent.appendChild(createElement("p", "eyebrow", eyebrow));
    }
    parent.appendChild(createElement("h1", "", title));
  }

  function renderIdle(): HTMLElement {
    var view = createElement("section", "view idle-view");
    view.appendChild(createElement("p", "idle-time js-clock"));
    view.appendChild(createElement("p", "idle-date js-date"));
    return view;
  }

  function renderText(viewState: KitchenDisplayProtocol.TextView): HTMLElement {
    var view = createElement("section", "view text-view");
    if (viewState.title) {
      appendHeading(view, viewState.title);
    }
    view.appendChild(createElement("p", "text-content", viewState.text));
    return view;
  }

  function appendStringItems(
    parent: HTMLElement,
    items: string[],
    ordered: boolean,
    className: string,
  ): void {
    var list = createElement(ordered ? "ol" : "ul", className);
    var index: number;
    for (index = 0; index < items.length; index += 1) {
      list.appendChild(createElement("li", "", items[index]));
    }
    parent.appendChild(list);
  }

  function renderRecipe(
    viewState: KitchenDisplayProtocol.RecipeView,
  ): HTMLElement {
    var view = createElement("section", "view recipe-view");
    var header = createElement("header", "recipe-header");
    appendHeading(header, viewState.title, "Recept");
    if (viewState.cookingTimeMinutes !== undefined) {
      header.appendChild(
        createElement(
          "span",
          "recipe-time",
          viewState.cookingTimeMinutes + " min",
        ),
      );
    }
    view.appendChild(header);

    var columns = createElement("div", "recipe-columns");
    var ingredients = createElement(
      "section",
      "recipe-column recipe-ingredients",
    );
    ingredients.appendChild(createElement("h2", "section-title", "Ingredienser"));
    appendStringItems(
      ingredients,
      viewState.ingredients,
      false,
      "ingredient-list",
    );
    columns.appendChild(ingredients);

    var steps = createElement("section", "recipe-column recipe-steps");
    steps.appendChild(createElement("h2", "section-title", "Gör så här"));
    appendStringItems(steps, viewState.steps, true, "step-list");
    columns.appendChild(steps);
    view.appendChild(columns);
    return view;
  }

  function renderList(viewState: KitchenDisplayProtocol.ListView): HTMLElement {
    var view = createElement("section", "view list-view");
    var header = createElement("header", "list-header");
    appendHeading(header, viewState.title, "Lista");
    view.appendChild(header);
    appendStringItems(view, viewState.items, false, "display-list");
    return view;
  }

  function renderTimer(
    timer: KitchenDisplayProtocol.TimerState | undefined,
  ): HTMLElement {
    if (!timer) {
      return renderIdle();
    }
    var finished = timer.status === "finished";
    var view = createElement(
      "section",
      "view timer-view" + (finished ? " timer-finished" : ""),
    );
    view.appendChild(createElement("p", "timer-name", timer.name));
    view.appendChild(
      createElement(
        "p",
        "timer-countdown js-timer-countdown",
        formatDuration(timerSeconds(timer)),
      ),
    );
    view.appendChild(
      createElement(
        "p",
        "timer-status",
        finished ? "Timern är klar" : timer.status === "paused" ? "Pausad" : "Pågår",
      ),
    );
    return view;
  }

  function renderTimerBanner(timer: KitchenDisplayProtocol.TimerState): HTMLElement {
    var banner = createElement("aside", "timer-banner");
    banner.setAttribute("aria-label", "Aktiv timer");
    banner.appendChild(createElement("span", "timer-banner-name", timer.name));
    banner.appendChild(
      createElement(
        "span",
        "timer-banner-countdown js-timer-countdown",
        formatDuration(timerSeconds(timer)),
      ),
    );
    return banner;
  }

  function render(next: KitchenDisplayProtocol.DisplaySnapshot): void {
    snapshot = next;
    serverOffsetMilliseconds = Date.parse(next.serverTime) - Date.now();
    clear(app);
    app.className = "";

    if (next.activeTimer && next.view.type !== "timer") {
      app.className = "has-timer-banner";
      app.appendChild(renderTimerBanner(next.activeTimer));
    }

    switch (next.view.type) {
      case "idle":
        app.appendChild(renderIdle());
        break;
      case "text":
        app.appendChild(renderText(next.view));
        break;
      case "recipe":
        app.appendChild(renderRecipe(next.view));
        break;
      case "list":
        app.appendChild(renderList(next.view));
        break;
      case "timer":
        app.appendChild(renderTimer(next.activeTimer));
        break;
    }
    updateLiveValues();
  }

  function updateLiveValues(): void {
    var now = correctedNow();
    var clocks = document.querySelectorAll(".js-clock");
    var dates = document.querySelectorAll(".js-date");
    var countdowns = document.querySelectorAll(".js-timer-countdown");
    var index: number;

    for (index = 0; index < clocks.length; index += 1) {
      clocks.item(index).textContent = formatClock(now);
    }
    for (index = 0; index < dates.length; index += 1) {
      dates.item(index).textContent = formatDate(now);
    }
    if (snapshot && snapshot.activeTimer) {
      var formatted = formatDuration(timerSeconds(snapshot.activeTimer));
      for (index = 0; index < countdowns.length; index += 1) {
        countdowns.item(index).textContent = formatted;
      }
    }
  }

  function validSnapshot(value: unknown): value is KitchenDisplayProtocol.DisplaySnapshot {
    if (!value || typeof value !== "object") {
      return false;
    }
    var candidate = value as KitchenDisplayProtocol.DisplaySnapshot;
    return (
      candidate.schemaVersion === 1 &&
      !!candidate.view &&
      typeof candidate.view.type === "string" &&
      typeof candidate.updatedAt === "string" &&
      typeof candidate.serverTime === "string"
    );
  }

  function scheduleReconnect(): void {
    if (reconnectTimer !== null) {
      return;
    }
    reconnectTimer = window.setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(MAX_RECONNECT_DELAY, reconnectDelay * 2);
  }

  function connect(): void {
    if (eventSource) {
      return;
    }
    setConnectionStatus(snapshot ? "Anslutningen bröts" : "Ansluter…");
    var source = new EventSource("/api/events");
    eventSource = source;

    source.onopen = function () {
      reconnectDelay = 1000;
      setConnectionStatus();
    };
    source.addEventListener("display", function (event: Event) {
      try {
        var parsed = JSON.parse((event as MessageEvent).data) as unknown;
        if (!validSnapshot(parsed)) {
          throw new Error("Unsupported display snapshot");
        }
        render(parsed);
        setConnectionStatus();
      } catch (_error) {
        setConnectionStatus("Displaydata kunde inte läsas");
      }
    });
    source.onerror = function () {
      source.close();
      if (eventSource === source) {
        eventSource = null;
      }
      setConnectionStatus(snapshot ? "Anslutningen bröts" : "Ansluter…");
      scheduleReconnect();
    };
  }

  render({
    schemaVersion: 1,
    view: { type: "idle" },
    updatedAt: new Date(0).toISOString(),
    serverTime: new Date().toISOString(),
  });
  window.setInterval(updateLiveValues, 1000);
  connect();
})();
