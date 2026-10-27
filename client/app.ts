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
  var rendererId: string | null = null;
  var reportingToken: string | null = null;
  var actualPage = 1;
  var pageCount = 1;
  var reporting = false;
  var reportAgain = false;

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

  function contentBlocks(
    content: KitchenDisplayProtocol.Content,
  ): HTMLElement[] {
    var blocks: HTMLElement[] = [];
    var view = content.view;
    var index: number;
    if (view.title) blocks.push(createElement("h1", "", view.title));
    if (view.type === "text") {
      blocks.push(createElement("p", "text-content", view.text));
    } else if (view.type === "list") {
      for (index = 0; index < view.items.length; index += 1) {
        var item = view.items[index]!;
        var row = createElement(
          "p",
          "display-item" + (item.checked ? " is-checked" : ""),
          (item.checked ? "✓ " : "• ") + item.text,
        );
        row.setAttribute("data-item-id", item.id);
        blocks.push(row);
      }
    } else if (content.focusedStep !== undefined) {
      blocks.push(
        createElement(
          "p",
          "eyebrow",
          "Steg " + content.focusedStep + " av " + view.steps.length,
        ),
      );
      blocks.push(
        createElement(
          "p",
          "text-content",
          view.steps[content.focusedStep - 1]!,
        ),
      );
    } else {
      if (view.cookingTimeMinutes !== undefined)
        blocks.push(
          createElement("p", "recipe-time", view.cookingTimeMinutes + " min"),
        );
      blocks.push(createElement("h2", "section-title", "Ingredienser"));
      for (index = 0; index < view.ingredients.length; index += 1) {
        blocks.push(
          createElement("p", "ingredient-item", "• " + view.ingredients[index]),
        );
      }
      blocks.push(createElement("h2", "section-title", "Gör så här"));
      for (index = 0; index < view.steps.length; index += 1) {
        blocks.push(
          createElement("p", "step-item", index + 1 + ". " + view.steps[index]),
        );
      }
    }
    return blocks;
  }

  // Measure at the actual viewport/font size. Split long blocks across pages,
  // preserving every character rather than shrinking text or requiring scrolling.
  function renderContent(content: KitchenDisplayProtocol.Content): HTMLElement {
    var view = createElement("section", "view content-view");
    var viewport = createElement("div", "page-viewport");
    var footer = createElement("p", "page-status");
    view.appendChild(viewport);
    view.appendChild(footer);
    app.appendChild(view);
    var pages: HTMLElement[] = [];
    var page = createElement("div", "page-content");
    viewport.appendChild(page);
    var blocks = contentBlocks(content);
    var index: number;

    function fits(): boolean {
      return page.scrollHeight <= viewport.clientHeight;
    }
    function newPage(): void {
      pages.push(page);
      viewport.removeChild(page);
      page = createElement("div", "page-content");
      viewport.appendChild(page);
    }
    for (index = 0; index < blocks.length; index += 1) {
      var block = blocks[index]!;
      var remaining = block.textContent || "";
      while (remaining.length > 0) {
        var node = block.cloneNode(false) as HTMLElement;
        node.textContent = remaining;
        page.appendChild(node);
        if (fits()) break;
        page.removeChild(node);
        if (page.childNodes.length > 0) {
          newPage();
          continue;
        }
        page.appendChild(node);
        var low = 1;
        var high = remaining.length;
        var best = 0;
        while (low <= high) {
          var middle = Math.floor((low + high) / 2);
          node.textContent = remaining.slice(0, middle);
          if (fits()) {
            best = middle;
            low = middle + 1;
          } else high = middle - 1;
        }
        // Keep surrogate pairs together when breaking a long word.
        if (
          best > 0 &&
          remaining.charCodeAt(best - 1) >= 0xd800 &&
          remaining.charCodeAt(best - 1) <= 0xdbff
        )
          best -= 1;
        if (best === 0) {
          // Only possible for a viewport shorter than one readable line.
          node.textContent = remaining;
          break;
        }
        var boundary = Math.max(
          remaining.lastIndexOf(" ", best - 1),
          remaining.lastIndexOf("\n", best - 1),
        );
        if (boundary > best / 2) best = boundary + 1;
        node.textContent = remaining.slice(0, best);
        remaining = remaining.slice(best);
        if (remaining.length > 0) newPage();
      }
    }
    pages.push(page);
    clear(viewport);
    pageCount = pages.length;
    actualPage = Math.max(1, Math.min(pageCount, content.page));
    viewport.appendChild(pages[actualPage - 1]!);
    footer.textContent = "Sida " + actualPage + " av " + pageCount;
    return view;
  }

  function timerById(
    id: string,
  ): KitchenDisplayProtocol.TimerState | undefined {
    if (!snapshot) return undefined;
    for (var index = 0; index < snapshot.timers.length; index += 1) {
      if (snapshot.timers[index]!.id === id) return snapshot.timers[index];
    }
    return undefined;
  }

  function countdown(
    timer: KitchenDisplayProtocol.TimerState,
    className: string,
  ): HTMLElement {
    var element = createElement(
      "span",
      className + " js-timer-countdown",
      formatDuration(timerSeconds(timer)),
    );
    element.setAttribute("data-timer-id", timer.id);
    return element;
  }

  function renderTimer(timer: KitchenDisplayProtocol.TimerState): HTMLElement {
    var view = createElement(
      "section",
      "view timer-view" +
        (timer.status === "finished" ? " timer-finished" : ""),
    );
    view.appendChild(
      createElement(
        "p",
        "timer-name" + (timer.name.length > 60 ? " is-long" : ""),
        timer.name,
      ),
    );
    view.appendChild(countdown(timer, "timer-countdown"));
    view.appendChild(
      createElement(
        "p",
        "timer-status",
        timer.status === "finished"
          ? "Timern är klar"
          : timer.status === "paused"
            ? "Pausad"
            : "Pågår",
      ),
    );
    return view;
  }

  function renderBanners(next: KitchenDisplayProtocol.DisplaySnapshot): void {
    var banners = createElement("aside", "timer-banners");
    for (var index = 0; index < next.timers.length; index += 1) {
      var timer = next.timers[index]!;
      if (next.view.type === "timer" && next.view.timerId === timer.id)
        continue;
      var banner = createElement(
        "div",
        "timer-banner" + (timer.status === "finished" ? " is-finished" : ""),
      );
      banner.appendChild(
        createElement(
          "span",
          "timer-banner-name",
          timer.name + (timer.status === "paused" ? " · Pausad" : ""),
        ),
      );
      banner.appendChild(
        timer.status === "finished"
          ? createElement("span", "timer-banner-countdown", "Klar")
          : countdown(timer, "timer-banner-countdown"),
      );
      banners.appendChild(banner);
    }
    if (banners.childNodes.length) app.appendChild(banners);
  }

  function report(): void {
    if (!snapshot || !rendererId || !reportingToken) return;
    if (reporting) {
      reportAgain = true;
      return;
    }
    reporting = true;
    var xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/renderers/" + encodeURIComponent(rendererId));
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("Authorization", "Bearer " + reportingToken);
    xhr.timeout = 10000;
    xhr.onloadend = function () {
      reporting = false;
      if (reportAgain) {
        reportAgain = false;
        report();
      }
    };
    xhr.send(
      JSON.stringify({
        revision: snapshot.revision,
        contentId:
          snapshot.view.type === "timer"
            ? undefined
            : snapshot.content && snapshot.content.id,
        page: actualPage,
        pageCount: pageCount,
        width: window.innerWidth,
        height: window.innerHeight,
        visible: document.visibilityState !== "hidden",
      }),
    );
  }

  function render(next: KitchenDisplayProtocol.DisplaySnapshot): void {
    snapshot = next;
    serverOffsetMilliseconds = Date.parse(next.serverTime) - Date.now();
    clear(app);
    actualPage = 1;
    pageCount = 1;
    renderBanners(next);
    if (next.view.type === "timer") {
      var timer = timerById(next.view.timerId);
      app.appendChild(timer ? renderTimer(timer) : renderIdle());
    } else if (next.content) {
      renderContent(next.content);
    } else app.appendChild(renderIdle());
    updateLiveValues();
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(report);
    });
  }

  function updateLiveValues(): void {
    var now = correctedNow();
    var clocks = document.querySelectorAll(".js-clock");
    var dates = document.querySelectorAll(".js-date");
    var countdowns = document.querySelectorAll(".js-timer-countdown");
    var index: number;
    for (index = 0; index < clocks.length; index += 1)
      clocks.item(index).textContent = formatClock(now);
    for (index = 0; index < dates.length; index += 1)
      dates.item(index).textContent = formatDate(now);
    for (index = 0; index < countdowns.length; index += 1) {
      var node = countdowns.item(index);
      var timer = timerById(node.getAttribute("data-timer-id") || "");
      if (timer) node.textContent = formatDuration(timerSeconds(timer));
    }
  }

  function validSnapshot(
    value: unknown,
  ): value is KitchenDisplayProtocol.DisplaySnapshot {
    if (!value || typeof value !== "object") return false;
    var candidate = value as KitchenDisplayProtocol.DisplaySnapshot;
    return (
      candidate.schemaVersion === 2 &&
      typeof candidate.revision === "number" &&
      !!candidate.view &&
      typeof candidate.view.type === "string" &&
      Array.isArray(candidate.timers) &&
      typeof candidate.updatedAt === "string" &&
      typeof candidate.serverTime === "string"
    );
  }

  function scheduleReconnect(): void {
    if (reconnectTimer !== null) return;
    reconnectTimer = window.setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(MAX_RECONNECT_DELAY, reconnectDelay * 2);
  }

  function connect(): void {
    if (eventSource) return;
    setConnectionStatus(snapshot ? "Anslutningen bröts" : "Ansluter…");
    var source = new EventSource("/api/events");
    eventSource = source;
    source.onopen = function () {
      reconnectDelay = 1000;
      setConnectionStatus();
    };
    source.addEventListener("renderer", function (event: Event) {
      var credentials = JSON.parse((event as MessageEvent).data) as {
        rendererId: string;
        token: string;
      };
      rendererId = credentials.rendererId;
      reportingToken = credentials.token;
    });
    source.addEventListener("display", function (event: Event) {
      try {
        var parsed = JSON.parse((event as MessageEvent).data) as unknown;
        if (!validSnapshot(parsed))
          throw new Error("Unsupported display snapshot");
        render(parsed);
        setConnectionStatus();
      } catch (_error) {
        setConnectionStatus("Displaydata kunde inte läsas");
      }
    });
    source.onerror = function () {
      source.close();
      if (eventSource === source) eventSource = null;
      rendererId = null;
      reportingToken = null;
      setConnectionStatus(snapshot ? "Anslutningen bröts" : "Ansluter…");
      scheduleReconnect();
    };
  }

  var resizeTimer: number | undefined;
  window.addEventListener("resize", function () {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(function () {
      if (snapshot) {
        // Resizing must not reset the last known server clock offset.
        snapshot.serverTime = correctedNow().toISOString();
        render(snapshot);
      }
    }, 150);
  });
  document.addEventListener("visibilitychange", report);
  app.appendChild(renderIdle());
  updateLiveValues();
  window.setInterval(updateLiveValues, 1000);
  window.setInterval(report, 15000);
  connect();
})();
