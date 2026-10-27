# Local development

Node.js 20 or newer and npm are required. CI and `.agents/setup` use Node.js 22.
The service needs no backing services or model credentials.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Generate a development control token locally and start the server:

```sh
KITCHEN_DISPLAY_API_TOKEN=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
export KITCHEN_DISPLAY_API_TOKEN
export HOST=127.0.0.1
export PORT=3000
export STATE_FILE=./data/state.json
export PUBLIC_DIR=./dist/client
npm start
```

Open `http://127.0.0.1:3000` for the display. Configure an MCP client with
`http://127.0.0.1:3000/mcp` and the bearer header described in [mcp.md](mcp.md).
`npm run dev` builds the client once and watches the server; rebuild the client
after client changes. `.agents/setup` prepares the Node toolchain, installs
locked dependencies, and builds the project. `.agents/resume` needs no setup.

## Configuration

| Variable                    | Default           | Meaning                                                               |
| --------------------------- | ----------------- | --------------------------------------------------------------------- |
| `KITCHEN_DISPLAY_API_TOKEN` | required          | Control bearer token, at least 32 characters                          |
| `HOST`                      | `127.0.0.1`       | Listen address; use `0.0.0.0` for the Pi's LAN                        |
| `PORT`                      | `3000`            | Listen port                                                           |
| `STATE_FILE`                | `data/state.json` | Atomically persisted state and retry receipts                         |
| `PUBLIC_DIR`                | `dist/client`     | Built static renderer                                                 |
| `LOG_LEVEL`                 | `info`            | Fastify/Pino log level                                                |
| `ALLOWED_ORIGINS`           | empty             | Additional comma-separated browser origins, no trailing slashes/paths |

Keep tokens out of repository files, logs, URLs, and chat. Reads and renderer
reporting credentials are accessible to trusted LAN devices. Do not expose the
service publicly.

## Internal renderer endpoints

```sh
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/display
```

`/api/events` supplies SSE `renderer` credentials followed by full `display`
snapshots. The renderer posts acknowledgements to `/api/renderers/:rendererId`
using that connection's ephemeral bearer token. The token confers report-only
access. Opening this stream manually reveals reporting credentials, so do not
paste its raw output into logs or chat.

Control is exclusively through MCP tools. There are no REST mutation routes.
Tests use the official MCP client against the actual HTTP transport and fake
time for durable timer/content lifecycle checks.
