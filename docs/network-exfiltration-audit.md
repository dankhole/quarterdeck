# Network Exfiltration Audit

All paths where data leaves the local machine, excluding agent processes (PTY sessions).

Last audited: 2026-04-05

---

## 1. Sentry — Error Tracking

**Always active. No user-facing disable option.**

| Surface | File | DSN Target |
|---------|------|------------|
| Node runtime | `src/telemetry/sentry-node.ts` | `ingest.us.sentry.io` (org: `cline-bot-inc-xi`, project: `kanban-node`) |
| Web UI (React) | `web-ui/src/telemetry/sentry.ts` | `ingest.us.sentry.io` (org: `cline-bot-inc-xi`, project: `kanban-react`) |
| Build (source maps) | `scripts/upload-sentry-sourcemaps.mjs` | `ingest.us.sentry.io` (requires `SENTRY_AUTH_TOKEN`) |

**Data sent:**
- Uncaught exceptions and stack traces
- App version, environment, platform info, OS type/version
- Tags: `app: "kanban"`, `runtime_surface: "node"` or `"web"`

**Privacy controls:**
- `sendDefaultPii: false` on both Node and Web instances
- Environment override: `SENTRY_NODE_ENVIRONMENT` env var

**Integration points:**
- `src/cli.ts:29` — imports for shutdown/startup error capture
- `src/cli.ts:546, 639` — captures exceptions during shutdown and startup
- `web-ui/src/components/app-error-boundary.tsx:49` — wraps entire app with `Sentry.ErrorBoundary`
- `web-ui/src/main.tsx:8` — calls `initializeSentry()` before rendering

---

## 2. PostHog — Product Analytics

**Web UI only. Gated behind `POSTHOG_KEY` env var AND `isTelemetryEnabled()`.**

| Config | Value |
|--------|-------|
| Config file | `web-ui/src/telemetry/posthog-config.ts` |
| Default host | `https://data.cline.bot` |
| Host override | `POSTHOG_HOST` env var |
| API key | `POSTHOG_KEY` env var |

**Events captured** (`web-ui/src/telemetry/events.ts`):
- `task_created` — selected_agent_id, start_in_plan_mode, auto_review_mode, prompt_character_count
- `task_dependency_created`
- `tasks_auto_started_from_dependency` — count
- `task_resumed_from_trash`
- Page views and page leaves (automatic)

**Disabled features:**
- `autocapture: false`
- `disable_session_recording: true`
- `capture_exceptions: false`
- `disable_surveys: true`
- `disable_web_experiments: true`
- `person_profiles: "identified_only"`

**Provider:** `web-ui/src/telemetry/posthog-provider.tsx` — wraps app with `PostHogProvider` if telemetry enabled.

---

## 3. Featurebase — Feedback Widget

**Web UI only. Loads external SDK dynamically.**

| Component | Target |
|-----------|--------|
| SDK script | `https://do.featurebase.app/js/sdk.js` |
| Organization | `"cline"` |
| Hook | `web-ui/src/hooks/use-featurebase-feedback-widget.ts` |

**Data sent:**
- User feedback text
- Metadata: `{ app: "kanban" }`
- Theme and locale info

**Token fetch chain:**
1. Web UI calls `fetchFeaturebaseToken(workspaceId)` (`web-ui/src/runtime/runtime-config-query.ts:135`)
2. Runtime tRPC handler calls `fetchSdkFeaturebaseToken()` (`src/cline-sdk/sdk-provider-boundary.ts:553`)
3. `ClineAccountService` from `@clinebot/core/node` makes HTTP request to `https://api.cline.bot`

---

## 4. Cline Account API

**Runtime. Authenticated with Cline OAuth bearer token.**

| Endpoint | `https://api.cline.bot` (configurable via provider settings `baseUrl`) |
|----------|--------|

**API calls** (all in `src/cline-sdk/sdk-provider-boundary.ts`):

| Function | Line | Purpose |
|----------|------|---------|
| `fetchSdkAccountProfile()` | 535 | Fetch user profile |
| `fetchSdkOrgData()` | 545 | Fetch organization data |
| `fetchSdkFeaturebaseToken()` | 553 | Get Featurebase JWT |
| `fetchSdkClineUserRemoteConfig()` | 565 | Fetch remote user config |

**Provider service:** `src/cline-sdk/cline-provider-service.ts:44` defines the default base URL.

---

## 5. NPM Registry — Update Check

**Runtime. Disableable.**

| File | `src/update/update.ts` |
|------|------------------------|
| Endpoint | `https://registry.npmjs.org/{packageName}/{npmTag}` |
| Function | `fetchLatestVersionFromRegistry()` (lines 474-495) |
| Timeout | 2.5 seconds |

**When called:**
- `runAutoUpdateCheck()` (lines 666-723) — background check on startup
- `runOnDemandUpdate()` (lines 553-664) — user-initiated

**Data sent:** Package name in URL only (GET request).

**Disable:** `KANBAN_NO_AUTO_UPDATE=1`, `CI=true`, or `NODE_ENV=test`.

---

## 6. Cline SDK Telemetry

**Runtime. Destination is inside external `@clinebot/core` package.**

| File | `src/cline-sdk/cline-telemetry-service.ts` |
|------|---------------------------------------------|
| Package | `@clinebot/core/telemetry` |
| Creation | Lines 31-34 |
| Disposal | `disposeCliTelemetryService()` line 47, called during shutdown |

**Metadata sent:**
- `extension_version` (kanban version)
- `cline_type: "kanban"`
- `platform: "kanban"`
- `platform_version` (Node.js version)
- `os_type` (`os.platform()`)
- `os_version` (`os.version()`)

**Note:** The actual endpoint and transport are defined inside `@clinebot/core`, not visible in this repo.

---

## 7. OpenTelemetry (Build-Time Configured)

**Only active if `OTEL_*` env vars were set at build time.**

`scripts/build.mjs` (lines 18-27) bakes these into the bundle:
- `OTEL_TELEMETRY_ENABLED`
- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_METRICS_EXPORTER`
- `OTEL_LOGS_EXPORTER`
- `OTEL_EXPORTER_OTLP_PROTOCOL`
- `OTEL_METRIC_EXPORT_INTERVAL`
- `OTEL_EXPORTER_OTLP_HEADERS`

---

## Black Boxes

The following external packages may contain additional phone-home behavior not auditable from this codebase:

- `@clinebot/agents` v0.0.28
- `@clinebot/core` v0.0.28
- `@clinebot/llms` v0.0.28
- `@clinebot/shared` v0.0.28

---

## Not Found

The following were searched for and **not found**:

- Slack webhooks or notification services
- GitHub API calls (gh CLI or octokit)
- Cloud SDKs (AWS, GCP, Azure)
- `axios`, `got`, `node-fetch`, `undici` HTTP clients
- Raw `net`, `dgram`, `tls` outbound sockets
- Tracking pixels or beacons
- Discord integrations
- DNS lookups for phone-home domains

---

## Summary Table

| # | Service | Endpoint | Trigger | Disableable |
|---|---------|----------|---------|-------------|
| 1 | Sentry (Node) | `ingest.us.sentry.io` | Uncaught exceptions | No |
| 2 | Sentry (Web) | `ingest.us.sentry.io` | React errors | No |
| 3 | Sentry (Build) | `ingest.us.sentry.io` | Source map upload | Only runs with `SENTRY_AUTH_TOKEN` |
| 4 | PostHog | `data.cline.bot` | Manual analytics events, page views | Yes (`POSTHOG_KEY` + telemetry toggle) |
| 5 | Featurebase | `do.featurebase.app` | User clicks feedback | Only loads on demand |
| 6 | Cline Account API | `api.cline.bot` | Profile/org/config fetches | No (required for auth) |
| 7 | NPM Registry | `registry.npmjs.org` | Startup + on-demand | Yes (`KANBAN_NO_AUTO_UPDATE=1`) |
| 8 | Cline SDK Telemetry | Unknown (in `@clinebot/core`) | Runtime lifecycle | Unknown |
| 9 | OpenTelemetry | Build-time configured | Metrics/logs export | Yes (only if env vars set) |
