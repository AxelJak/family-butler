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
