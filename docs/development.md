# Local development and API

## Prerequisites

- Node.js 20 or newer
- npm

Install and verify:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Generate a local token and start the server:

```sh
KITCHEN_DISPLAY_API_TOKEN=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
export KITCHEN_DISPLAY_API_TOKEN
export HOST=127.0.0.1
export PORT=3000
export STATE_FILE=./data/state.json
export PUBLIC_DIR=./dist/client
npm start
```

During development, `npm run dev` rebuilds the client once and watches the
server TypeScript. Re-run `npm run build:client` after client changes.

## Amp orbs

`.agents/setup` prepares Node.js 22 and Python 3.13 (matching CI), installs the
locked npm dependencies and Python CI tools in `.venv`, and builds the app.
Amp snapshots this environment so fresh orbs can reuse it without reinstalling
dependencies. Setup is idempotent when a snapshot needs refreshing; resume does
no installation because there are no backing services or authentication to repair.

New login shells in this checkout automatically select these toolchains, so
`npm test`, `pytest`, and `ruff` work directly. To refresh the environment manually,
run `.agents/setup`, then start a new login shell. Python test dependencies follow
CI's unpinned packages and resolve to releases compatible with Python 3.13.

No API token is baked into the shared snapshot. To run the app, generate and export
a development token using the commands above, then run `npm start`. For a persistent
orb preview, use `amp orb service start display --command 'npm start' --portal`
and share its returned portal URL rather than a loopback URL.

## API examples

Reads and SSE are intentionally public to clients on the trusted LAN:

```sh
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/display
curl -N http://127.0.0.1:3000/api/events
```

Supplying an authorization header to the health endpoint also validates the
token. This is how the Home Assistant config flow catches a wrong token.

Show temporary text (120 seconds by default):

```sh
curl -X POST http://127.0.0.1:3000/api/display \
  -H "Authorization: Bearer $KITCHEN_DISPLAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"schemaVersion":1,"type":"text","title":"Svar","text":"Maten är klar."}'
```

Show a persistent recipe:

```sh
curl -X POST http://127.0.0.1:3000/api/display \
  -H "Authorization: Bearer $KITCHEN_DISPLAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "schemaVersion": 1,
    "type": "recipe",
    "title": "Pasta med parmesan",
    "ingredients": ["Pasta", "Parmesan", "Grädde"],
    "steps": ["Koka pastan", "Blanda såsen", "Vänd ihop"],
    "cookingTimeMinutes": 20
  }'
```

Show a persistent list and then clear it:

```sh
curl -X POST http://127.0.0.1:3000/api/display \
  -H "Authorization: Bearer $KITCHEN_DISPLAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"list","title":"Handla","items":["Mjölk","Pasta"],"timeoutSeconds":0}'

curl -X DELETE http://127.0.0.1:3000/api/display \
  -H "Authorization: Bearer $KITCHEN_DISPLAY_API_TOKEN"
```

Use `PUT /api/timer` only to synchronize the selected Home Assistant timer.
Normal users and automations should call the integration's `show_timer` action
instead, so Home Assistant remains authoritative.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `KITCHEN_DISPLAY_API_TOKEN` | required | Write token, at least 32 characters |
| `HOST` | `127.0.0.1` | Listen address |
| `PORT` | `3000` | Listen port |
| `STATE_FILE` | `data/state.json` | Atomic persisted state |
| `PUBLIC_DIR` | `dist/client` | Built static client |
| `LOG_LEVEL` | `info` | Fastify/Pino log level |

Do not put real tokens in the repository or expose this HTTP service outside
the trusted home LAN.
