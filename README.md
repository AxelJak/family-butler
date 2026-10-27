# Family Butler — MCP Kitchen Display

A kitchen display controlled exclusively by an LLM through MCP. An assistant
chooses content through structured tools; a Raspberry Pi stores state, runs
local timers, and serves a readable display to an old iPad Air.

- Authenticated, stateless MCP over Streamable HTTP at `/mcp`.
- Text, recipes, checkable lists, recipe-step focus, and hands-free pagination.
- Up to eight independent local timers with pause, resume, and completion alerts.
- Persistent content, expiries, timer deadlines, and retry receipts.
- Stable content/item/timer IDs for follow-up requests.
- Browser acknowledgements report actual page, viewport, and visibility.
- Framework-free, ES5-compatible Swedish display; no touch controls or control token.
- Hardened, unprivileged systemd deployment.

The assistant runs elsewhere. Voice, conversation, and external capabilities
belong to its host. The display accepts plain structured data and owns layout;
it never executes model-provided HTML, CSS, or JavaScript.

## Documentation

- [MCP connection, tools, and assistant guidance](docs/mcp.md)
- [Product and technical specification](docs/spec.md)
- [Local development](docs/development.md)
- [Raspberry Pi installation and updates](docs/pi-deployment.md)
- [Physical acceptance checklist](docs/acceptance.md)

## Verify

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Node.js 20 or newer is required; CI and the setup script use Node.js 22.
Existing V1 state is migrated on first startup with an unchanged `.v1-backup`
file retained beside it. See the specification before rolling back.
