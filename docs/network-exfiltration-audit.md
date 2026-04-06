# Network Exfiltration Audit

All paths where data leaves the local machine, excluding agent processes (PTY sessions).

Last audited: 2026-04-05

---

## Removed

The following were previously present and have been removed:

- **Sentry** (Node + Web) — error tracking to `ingest.us.sentry.io`
- **PostHog** — product analytics to `data.cline.bot`
- **OpenTelemetry** — build-time configured metrics/logs export
- **NPM auto-update check** — startup version check to `registry.npmjs.org`

---

## Remaining (Cline-specific)

### 1. Featurebase — Feedback Widget

**Web UI only. Loads external SDK dynamically.**

| Component | Target |
|-----------|--------|
| SDK script | `https://do.featurebase.app/js/sdk.js` |
| Organization | `"cline"` |
| Hook | `web-ui/src/hooks/use-featurebase-feedback-widget.ts` |

### 2. Cline Account API

**Runtime. Authenticated with Cline OAuth bearer token.**

| Endpoint | `https://api.cline.bot` |
|----------|--------|

### 3. Cline SDK Telemetry

**Runtime. Destination is inside external `@clinebot/core` package.**

| File | `src/cline-sdk/cline-telemetry-service.ts` |
|------|---------------------------------------------|

### Black Boxes

The following external packages may contain additional phone-home behavior not auditable from this codebase:

- `@clinebot/agents`
- `@clinebot/core`
- `@clinebot/llms`
- `@clinebot/shared`
