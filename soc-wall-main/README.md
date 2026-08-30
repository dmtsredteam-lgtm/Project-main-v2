# SOC Wall V3

A cinematic, modular Security Operations Center interface for 1920×1080 and 4K wall displays.

## Run locally

```bash
pnpm install
pnpm dev
```

Build the deployment bundle with `pnpm build`.

## Data adapters

The frontend consumes exactly four normalized adapters from `js/api.js`:

- `fetchAlerts()` — OpenSearch / Wazuh alerts
- `fetchTickets()` — Motadata open requests and SLA state
- `fetchIntel()` — OpenCTI indicators
- `fetchHealth()` — ManageEngine OpManager availability

Demo telemetry is enabled by default. To connect live services, define `window.SOC_CONFIG` before `js/main.js` loads and set `demo: false`. The existing function names are also exposed on `window` for backward compatibility.

## Architecture

- `css/` — reset, visual tokens, responsive layout, and reduced-motion animation rules
- `js/api.js` — backend contract boundary and demo-safe normalization
- `js/globe.js` — pooled Three.js attack vectors, atmosphere, radar globe, and impact pulses
- `js/particles.js` — ambient Canvas particle field
- `js/charts.js` — counters and sparklines
- `js/alerts.js`, `js/timeline.js` — incident state and cinematic cards
- `js/ai.js` — animated analyst assessment
- `js/mitre.js`, `js/health.js`, `js/ticker.js` — operational surfaces

No API credentials are stored in the repository.
