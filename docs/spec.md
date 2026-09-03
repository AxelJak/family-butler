# Kitchen Display V1 specification

## Purpose

Kitchen Display is a visual Home Assistant capability. Home Assistant Assist,
LLM conversation agents, and automations send structured display commands. The
display service owns presentation and never accepts arbitrary HTML, CSS,
JavaScript, or Markdown.

V1 is a useful appliance before it is a general family-agent platform. Hermes,
OpenClaw, web search, and other external agent harnesses are not dependencies.

## Architecture

```text
Home Assistant Companion App
  -> Kitchen Butler Assist pipeline
     -> ElevenLabs speech-to-text
     -> OpenRouter conversation agent
        -> built-in Assist LLM API (exposed HA controls)
        -> Kitchen Display LLM API (display tools)
     -> ElevenLabs text-to-speech

Home Assistant Kitchen Display integration
  -> authenticated structured HTTP
  -> Raspberry Pi Zero 2 W display server
     -> persisted display state
     -> Server-Sent Events
     -> first-generation iPad Air web client
```

Home Assistant is the capability broker, not the renderer. It pushes curated
commands and timer state to the Pi. The Pi never stores a Home Assistant
credential and remains the source of truth for presentation state.

## V1 capabilities

The Kitchen Display LLM API and matching Home Assistant actions expose:

- `show_text`
- `show_recipe`
- `show_list`
- `show_timer`
- `clear_display`

The LLM should use the display for recipes, lists, multi-step instructions,
timers, and information worth leaving visible. It should always obey an
explicit request to show something, complement visual output with a short
conversational response, and avoid the display for greetings, jokes,
acknowledgements, and short factual answers.

The V1 idle view, text, recipe, list, and timer are the complete supported view
set. Weather, calendar, generic entity, image, and camera views are deferred.

## Public display protocol

The current view remains a discriminated union:

```ts
type DisplayState =
  | { type: "idle" }
  | { type: "text"; title?: string; text: string }
  | {
      type: "recipe";
      title: string;
      ingredients: string[];
      steps: string[];
      cookingTimeMinutes?: number;
    }
  | { type: "list"; title: string; items: string[] }
  | { type: "timer" };
```

An active timer is global structured status so it can appear as a compact
banner above another view:

```ts
type TimerState =
  | { name: string; status: "active"; endsAt: string }
  | { name: string; status: "paused"; remainingSeconds: number }
  | { name: string; status: "finished" };

interface DisplaySnapshot {
  schemaVersion: 1;
  view: DisplayState;
  activeTimer?: TimerState;
  updatedAt: string;
  expiresAt?: string;
  serverTime: string;
}
```

All timestamps use ISO 8601 UTC strings. Every SSE message contains a complete
snapshot, and a newly connected client receives one immediately. A future
e-ink renderer can poll the same snapshot without using SSE.

### HTTP API

- `GET /api/health` — public health information
- `GET /api/display` — public current snapshot
- `POST /api/display` — authenticated display command
- `DELETE /api/display` — authenticated return to idle
- `PUT /api/timer` — authenticated timer synchronization
- `DELETE /api/timer` — authenticated timer cancellation
- `GET /api/events` — public SSE stream of complete snapshots

Successful mutations return the resulting snapshot. Invalid, oversized,
unsupported-version, and unauthorized requests never alter state and return a
structured error. The maximum request body is 64 KiB. The API is LAN-only and
is not exposed to the internet. Health remains public when called without
credentials; if an authorization header is supplied, it must contain the valid
write token so Home Assistant can verify its configuration.

## Validation boundaries

- Titles: at most 120 characters
- Text: at most 4,000 characters
- Lists: at most 50 items
- Recipes: at most 50 ingredients and 50 steps
- Each item, ingredient, or step: at most 500 characters
- Explicit positive timeout: 10 seconds through 24 hours

Tool descriptions additionally instruct the model to keep content concise and
readable from a distance. The server enforces the limits independently and
never silently truncates content.

## Lifecycle

- Text expires after 120 seconds by default.
- Recipes and lists are persistent by default.
- Text, recipe, and list commands can set an explicit timeout.
- `timeoutSeconds: 0` means persistent.
- There is one persistent base view and at most one temporary visible view.
- The last valid accepted command wins; V1 has no queue or priority system.
- Temporary expiry restores the latest persistent view.
- Clear resets the base and temporary views to idle but does not cancel a timer.
- State and absolute expiry times persist atomically across process restarts.
- Expired state is discarded during recovery.
- A corrupt state file is retained for diagnosis and the server starts idle.

V1 uses one selected Home Assistant timer helper. A new timer replaces the
existing timer. Active, paused, cancelled, restarted, and finished changes in
Home Assistant are synchronized to the display. An active timer is shown as a
compact banner over another view. Completion takes over the screen for 60
seconds and then restores the prior content. Audible alerts are handled by
Home Assistant automations, not Safari.

## Home Assistant integration

The HACS-compatible `kitchen_display` custom integration provides:

- a distinct Kitchen Display LLM API;
- matching typed Home Assistant actions;
- a config flow for the display URL, bearer token, and timer helper;
- setup-time connection validation;
- timer state synchronization and display availability diagnostics;
- Swedish and English integration strings.

The dedicated Kitchen Butler conversation agent selects both the built-in
Assist API and Kitchen Display API. Simple home controls should prefer reliable
local Assist intents. OpenRouter handles open-ended requests. GLM 5.3 Flash is
the initial low-cost model candidate, but acceptance depends on observed
Swedish tool-call behavior rather than a fixed model choice.

The Companion App supplies the microphone and speaker. Home Assistant's
official ElevenLabs integration supplies Swedish speech-to-text and
text-to-speech. Text input remains a fallback when cloud speech is unavailable.

## Client experience

The client is framework-free and compatible with Safari 12. It has no write
credential or write controls. It reconnects indefinitely with backoff, retains
the last rendered content after a connection loss, and shows a small Swedish
connection warning rather than replacing useful content.

V1 starts with a light, high-contrast, low-distraction theme:

- idle: large clock and Swedish date;
- recipe: title/time header, ingredients left, numbered steps right;
- text: one large readable plain-text column;
- list: large readable rows;
- timer: name and very large countdown;
- finished timer: static high-contrast full-screen alert, with no flashing.

Landscape is the primary orientation. Portrait has a usable single-column
fallback. Long content scrolls manually; the client does not auto-scroll,
paginate, or shrink text until it is unreadable. The timer corrects for the
offset between server and iPad clocks.

The iPad is manually added to the Home Screen and configured with Auto-Lock
Never and Guided Access. Automatic launch after an iPad reboot is not part of
V1.

## Runtime and operations

- Pi server: Node.js, TypeScript, Fastify, and TypeBox
- Client: framework-free TypeScript compiled to ES5-compatible JavaScript
- HA integration: Python using supported Home Assistant extension APIs
- Pi OS: current Raspberry Pi OS Lite 64-bit
- Address: `http://kitchen-display.local` on port 80
- Process: unprivileged systemd service with only low-port bind capability
- Discovery: Avahi/mDNS hostname
- Persistence: atomic local JSON state file
- Assets: local only; no CDN, remote fonts, analytics, or crash reporting

State-changing endpoints require a generated bearer token stored in a
root-readable Pi environment file and Home Assistant's config-entry storage.
Static assets, health, current state, and SSE are readable on the trusted LAN.
Credentials and display content are never logged.

Updates are deliberate, not automatic. The repository supplies installation,
update, restart, and health-check instructions. Production dependencies avoid
native addons so release artifacts remain architecture-independent.

## Verification and acceptance

Automated checks cover schemas, authentication, lifecycle timing, persistence,
SSE delivery/reconnection, timer synchronization, and Home Assistant tools and
actions. Physical acceptance additionally verifies:

- boot and systemd recovery on the Pi;
- idle and reconnect behavior on the actual iPad;
- HA actions for text, recipe, and list;
- expiry, restoration, and restart persistence;
- timer synchronization and completion;
- Swedish text and Companion App voice tool calls;
- reliable simple light control;
- rejection of invalid and unauthorized requests;
- readability of idle, recipe, timer, long-list, and disconnected states.

Physical deployment is a guided user-run stage because repository automation
must not provision household credentials or devices.

## Explicit non-goals

- Weather, calendar, entity, image, and camera views
- E-ink implementation
- Multiple logical displays
- General notification priorities or queues
- Browser-side write controls
- Web search
- Hermes or OpenClaw
- Dark mode
- Automatic iPad launch after reboot
- Internet exposure
- Publication to the default HACS catalog or a package registry

Licensing is intentionally undecided for V1.
