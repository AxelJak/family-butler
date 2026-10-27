# MCP kitchen display specification

## Purpose and ownership

An LLM is the sole controller. People read a passive screen and speak or type
to their chosen assistant host. The appliance provides MCP tools, durable state,
local timers, and deterministic rendering. It contains no conversation agent,
model credentials, speech pipeline, or external home automation dependency.

An assistant host connects to `/mcp` using authenticated Streamable HTTP. The Pi
persists accepted actions, publishes complete snapshots over `/api/events`, and
serves a framework-free Swedish renderer to Safari 12 on an iPad Air. The browser
never receives the control token. It receives only an ephemeral reporting
credential scoped to its live event connection.

## Control contract

The complete tools and usage contract are documented in [mcp.md](mcp.md).
TypeBox schemas in `server/schemas.ts` define the advertised tools and runtime
validation. Inputs are strict: no extra fields, silent truncation, or coercion.

Titles are limited to 120 characters, text to 4000 characters, and list items,
ingredients, and recipe steps to 500 characters each. Lists and recipes contain
at most 50 entries in each array. Request bodies are limited to 64 KiB.
Timers accept 1–86400 seconds; positive content timeouts accept 10–86400 seconds.
Zero means persistent content. Pages and steps are 1-based; step 0 means recipe
overview. Structured text is rendered with DOM text nodes, never interpreted as
HTML, CSS, JavaScript, or Markdown.

Content, list items, and timers have stable IDs. Targeted commands fail when
their targets no longer exist. Every successful mutation has a durable receipt
keyed by operationId and a canonical argument fingerprint. Identical retries
return the original receipt plus current state without replaying the action.
Conflicting reuse fails. The most recent 256 receipts are retained.

## Content and navigation

There is one persistent base content and at most one temporary content. Text is
temporary for 120 seconds by default; recipes and lists persist by default.
Expiry restores base content. Clear removes both, but does not cancel timers.
A new persistent content replaces both the base and temporary content.

Each content stores its requested page and optional focused recipe step. Lists
store independently addressable items with checked state. The renderer measures
content at its real dimensions and readable font size, splitting blocks across
pages without dropping characters or requiring scrolling. Only the requested
page is shown, clamped to the available range. Resize recomputes pagination.
The LLM can navigate pages and focus recipe steps. There are no touch controls.

## Timers

The service owns up to eight independent named timers, including retained
finished timers. Each timer has a stable ID. Running timers persist absolute
UTC deadlines; paused timers persist fractional remaining seconds. Pause and
resume never reset the original duration. Restart reconstructs the lifecycle
from saved deadlines, independent of an LLM or browser connection.

Timers normally appear as compact banners, with an optional focused countdown.
Completion displays a static, high-contrast alert for 60 seconds after the timer's
original deadline, then restores the prior content/focus. Simultaneous alerts
select the first timer in creation order; the others remain visible as banners.
Finished timers remain queryable until cancelled. Cancel dismisses that timer's
alert and removes it. Clear affects content and focus, while timers continue.

A restart during an alert's window restores it. A restart after the window marks
the timer finished without replaying an old alert. Audible alarms are outside
the appliance's contract.

## State and delivery

Schema version 2 snapshots contain revision, effective view reference, current content,
optional background content, all timers, updatedAt, and serverTime. Content is
also included while a timer overlays it. All timestamps are ISO 8601 UTC.
Content is included once rather than duplicated inside the effective view.
Full snapshots on connect and every change make reconnect independent of missed
events. Revisions increase on mutations and lifecycle transitions.

State changes are serialized and atomically saved by temporary file and rename
before publication. On write failure, previous state remains authoritative and
no receipt is recorded. Failed lifecycle writes retry after one second. Files
are private to the service account. Content and credentials are not logged.

A live renderer reports revision, actual page/count, viewport, visibility, and
content ID. Reports for stale revisions or mismatched content are rejected.
Delivery requires a fresh report (under 45 seconds old) for the current revision
from a visible renderer. Acknowledgement describes browser state, not human
attention. Ephemeral report tokens cannot call control tools and expire when
the event connection closes. Reconnect creates new reporting credentials.

The browser retains its last content during connection loss, reconnects with
backoff, and shows a small Swedish warning. Countdown clocks use the server/iPad
clock offset. Timers and expiries continue server-side without the browser.

## HTTP and security

- `POST /mcp`: bearer-authenticated MCP initialization, discovery, and tool calls.
- `GET`, `DELETE /mcp`: authenticated 405; transport is stateless.
- `OPTIONS /mcp`: browser preflight; origin-checked without bearer authentication.
- `GET /api/health`: public status; validates control token if supplied.
- `GET /api/display`: public renderer snapshot.
- `GET /api/events`: public complete snapshots and scoped reporting credentials.
- `POST /api/renderers/:rendererId`: report-only credential and strict report body.
- `/`: static renderer; no control forms or control credentials.

The old REST mutation and timer-synchronization routes are removed. Read access
is deliberately public on the trusted LAN. Browser origins must be same-origin
or explicitly configured. No CORS wildcard, public internet deployment, or OAuth
server is included. Assistant hosts must reach the LAN and support bearer
headers. Configuration and deployment are documented separately.

## Upgrade and recovery

V1 files are validated and converted into V2 content/item/timer IDs. Original
bytes are saved in `state.json.v1-backup` without overwriting an earlier backup.
V1 deadlines and temporary expiry are preserved. Malformed or unsupported state
is retained as `.corrupt-*` before starting idle. Read/write/permission failures
fail startup rather than being treated as corruption.

V2 files cannot be read by the V1 application. To roll back to V1, stop the
service and restore the V1 backup explicitly; doing so discards subsequent V2
actions. Binary rollback alone is not a state migration. Keep an independent
state backup before upgrading a physical appliance.
