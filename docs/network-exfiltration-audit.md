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
- **Cline Account API** — authenticated calls to `https://api.cline.bot`
- **Cline SDK Telemetry** — telemetry inside `@clinebot/core` package
- **Featurebase** — feedback widget loading `https://do.featurebase.app/js/sdk.js` (JWT auth required Cline OAuth; hook is now a no-op stub)
- **`@clinebot/*` packages** — `@clinebot/agents`, `@clinebot/core`, `@clinebot/llms`, `@clinebot/shared` all uninstalled

---

## Remaining

**None.** The runtime and web UI make no outbound network requests beyond what the user's own agent processes (PTY sessions) produce.
