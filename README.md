# Family Butler — Kitchen Display

A lightweight kitchen display for Home Assistant. Home Assistant and its LLM
choose **what** to show through structured tools; a Raspberry Pi Zero 2 W stores
the state and decides **how** it appears on an old iPad Air.

V1 includes:

- a Fastify/TypeScript server with a validated bearer-authenticated API;
- persistent idle, text, recipe, list, and timer states;
- full-state Server-Sent Events with reconnect-safe clients;
- a framework-free, ES5-compatible Swedish web UI;
- a Home Assistant custom integration with actions and LLM tools;
- an unprivileged, hardened systemd deployment.

The browser never receives the write token, and neither automations nor an LLM
can provide HTML, CSS, JavaScript, or arbitrary UI.

## Documentation

- [Product and technical specification](docs/spec.md)
- [Local development and API](docs/development.md)
- [Raspberry Pi installation and updates](docs/pi-deployment.md)
- [Home Assistant, OpenRouter, and ElevenLabs setup](docs/home-assistant.md)
- [Physical acceptance checklist](docs/acceptance.md)

## Quick verification

```sh
npm ci
npm run typecheck
npm test
npm run build
```

The Home Assistant Python checks use Python 3.13 and
`pytest-homeassistant-custom-component`; CI runs them against the current Home
Assistant test package.
