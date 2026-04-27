# Implementation Log

> Prior entries in `docs/history/`: `implementation-log-through-0.11.0.md`, `implementation-log-through-0.10.0.md`, `implementation-log-through-0.9.4.md`, `implementation-log-through-2026-04-15.md`, `implementation-log-through-2026-04-12.md`.

## Fix: skip shell stop RPC when home terminal was never opened (2026-04-27)

Dogfooding surfaced a recurring debug warning:

```
[terminal-panels] failed to stop shell terminal {
  projectId: "airlock",
  taskId: "__home_terminal__",
  reason: "close",
  error: "Could not stop terminal session."
}
```

Root cause sat on the browser side. `useProjectSwitchCleanup` runs `resetTerminalPanelsState()` in a layout effect on every current-project change, which calls `closeHomeTerminal()` unconditionally. The old implementation in `web-ui/src/hooks/terminal/use-terminal-panels.ts` fell back to `currentProjectId` when `homeTerminalProjectIdRef.current` was null:

```ts
const projectId = homeTerminalProjectIdRef.current ?? currentProjectId;
```

If the user had never opened the home shell in the current project, the ref was `null` but `currentProjectId` was truthy, so the UI fired `trpcClient.runtime.stopTaskSession.mutate({ taskId: "__home_terminal__", waitForExit: true })` for a task id the runtime had never seen. `handleStopTaskSession` correctly returned `{ ok: false, summary: null }` (no `error` because there was no failure to describe — just nothing to stop), and the client's background wrapper surfaced a synthetic `"Could not stop terminal session."` warning.

The fix drops the fallback. `homeTerminalProjectIdRef` is populated by every path that actually starts the shell (`handleToggleHomeTerminal`, `startHomeTerminalSession`, `prepareTerminalForShortcut`, and the project-change effect), so a null ref unambiguously means "never opened" and there is nothing to stop. No server-side change is needed — the runtime contract for task sessions correctly treats "unknown session" as `ok:false`, which is still a real signal for other callers.

I considered a second change to treat `{ ok: false, summary: null }` without an `error` field as an idempotent no-op on the client. After a review round I dropped it: once the root-cause fallback is removed, `ok:false` during shell close would indicate some *other* invariant going wrong, and we'd rather see it than swallow it.

Files touched: `web-ui/src/hooks/terminal/use-terminal-panels.ts`, `web-ui/src/hooks/terminal/use-terminal-panels.test.tsx` (regression test asserts `resetTerminalPanelsState()` and `closeHomeTerminal()` on a never-opened shell do not call `stopTaskSession`).

Commit: pending

## Docs: consolidate architecture and convention references (2026-04-27)

The docs cleanup merged the old split between ranked architecture weaknesses and per-item refactor context into a single `docs/architecture-roadmap.md`. The new roadmap keeps the quick ranking at the top, retains the active order and item briefs from the old context doc, and removes stale phrasing that still described completed split-brain task-state cleanup as the current top weakness. `docs/todo.md` now points at the merged roadmap while staying the live execution queue.

The convention-style docs were reorganized under `docs/conventions/`: `design-guardrails.md` moved to `conventions/architecture-guardrails.md`, the cleaned-up UI layout reference moved to `conventions/ui-layout.md`, and the stale `ui-component-cheatsheet.md` was removed after its useful naming glossary was absorbed into the UI layout doc. The conventions cleanup branch also brought in `conventions/web-ui.md`, `conventions/frontend-hooks.md`, `docs/history/`, and the stale task-state-system marker; this pass reconciled those names with the merged roadmap and docs index.

`AGENTS.md` now has an area-specific documentation lookup cheat sheet so agents read convention docs only when entering the relevant work area instead of treating every convention doc as mandatory context for every task. The cheat sheet points frontend work to `conventions/web-ui.md`, hook/provider extraction work to `conventions/frontend-hooks.md`, UI surface/layout work to `conventions/ui-layout.md`, and optimization/lifecycle-policy work to `conventions/architecture-guardrails.md`.

Files touched: `AGENTS.md`, `CHANGELOG.md`, `docs/README.md`, `docs/architecture-roadmap.md`, `docs/conventions/architecture-guardrails.md`, `docs/conventions/frontend-hooks.md`, `docs/conventions/ui-layout.md`, `docs/todo.md`; deleted `docs/design-weaknesses-roadmap.md`, `docs/refactor-roadmap-context.md`, `docs/design-guardrails.md`, `docs/ui-layout-architecture.md`, and `docs/ui-component-cheatsheet.md`.

Commit: pending

## Fix: repair invalid session entries during project load (2026-04-27)

The first hardening pass made `readProjectSessions` tolerant of bad entries, but its repair path only renamed the original corrupt file and relied on a later browser save to write a clean `sessions.json`. That left the project in a poor intermediate state if no save followed: valid surviving sessions were only returned for that one load, the canonical file was not immediately repaired, and a later load could see missing or still-invalid session state depending on where the previous attempt stopped. The WebSocket startup path also still treated selected-project state as all-or-nothing: `loadInitialSnapshot` used `Promise.all` for the project list and full project state, so one invalid selected project's state discarded the already-built project list and left the UI showing no projects.

The fix makes invalid session-entry recovery an immediate read-repair. `readProjectSessions` now validates the outer `sessions.json` object strictly, parses each entry independently, preserves the original file as `sessions.json.corrupt-<timestamp>-<suffix>`, and writes a repaired `sessions.json` containing only the surviving valid summaries. The project-state response carries a `sessions_corruption` warning so the UI can show a one-time warning toast for the affected project. The warning is also held in a small pending map until the next authoritative save, because startup terminal-manager hydration can read and repair the file before the browser asks for its first snapshot. Truly malformed outer shapes still throw because there is no safe per-entry salvage.

Runtime streaming now builds and sends the projects payload before attempting the selected project's full state. If project-state loading still fails, the snapshot contains the visible project list with `projectState: null`, and the error is sent as a separate WebSocket error message. The browser-side visibility refresh now requires an actual streamed project state before calling `project.getState`, preventing the partial snapshot from immediately retrying the same failed load and producing a second identical toast.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `src/core/api/project-state.ts`, `src/server/runtime-state-hub.ts`, `src/state/project-state-index.ts`, `src/state/project-state.ts`, `test/integration/project-state.integration.test.ts`, `test/integration/state-streaming.integration.test.ts`, `web-ui/src/hooks/project/use-project-sync.test.tsx`, `web-ui/src/hooks/project/use-project-sync.ts`

Commit: `94bdae0eb`

## Fix: stop shell terminal sessions on close (2026-04-27)

Shell terminals could get into a split-brain state where the PTY still accepted shortcut commands but the visible xterm pane stayed on the loading spinner with no logs. The fragile path was the dedicated shell-terminal persistence layer: closing or switching context hid/parked the terminal view while keeping the backing shell session around, then a later show had to coordinate DOM reattachment, WebSocket restore, and server session state perfectly.

The intermediate fix makes shell lifetime explicit and conservative. Home shells are owned by the current project/root context; detail shells are owned by the selected task/worktree context. Closing a shell, switching away from its owning context, project switching, reset, and manual restart now dispose the dedicated terminal slot and send `stopTaskSession({ waitForExit: true })` for the shell task id. `pendingShellStopsRef` serializes close -> open races so a fresh start waits for the old PTY to finish exiting, and it now ignores duplicate stop requests for the same project/task while a stop is already pending. `useShellAutoRestart` gained one-shot exit suppression so intentional shell stops do not get treated as unexpected crashes. Project shortcuts were adjusted to truly reuse an already-open home/task shell instead of calling `startShellSession` again.

Server-side, shell process exits now route through `finalizeProcessExit(...)` instead of manually notifying listeners and clearing `entry.active`; this resolves pending `stopTaskSessionAndWaitForExit` callers for shell sessions and makes the new client-side wait path reliable. Added shell spawn/exit logging on the runtime side plus dedicated-shell show/ready/error/exit/hide logging in the browser so future failures have a breadcrumb trail.

The known tradeoff is intentional: this branch chooses "close means stop" over keeping shell PTYs alive while minimized. A follow-up todo tracks restoring VS Code-style minimized shell persistence once the hidden-shell lifecycle has a stronger ownership model.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `docs/todo.md`, `src/terminal/session-lifecycle.ts`, `web-ui/src/hooks/terminal/use-shell-auto-restart.ts`, `web-ui/src/hooks/terminal/use-terminal-panels.test.tsx`, `web-ui/src/hooks/terminal/use-terminal-panels.ts`, `web-ui/src/terminal/use-persistent-terminal-session.ts`

Commit: `0dbd86632`, `2cdad884d`

## Fix: log full toast warning/error messages to the debug log (2026-04-25)

Toast-delivered warnings and errors were the only surface for certain failures — for example, the server's `Invalid sessions.json file at … Fix or remove the file. Validation errors: …` message that flows from `parsePersistedStateFile` through the WebSocket error channel and lands in `useStreamErrorHandler` → `notifyError`. `sanitizeErrorForToast` collapses the message to its first non-empty line capped at 150 characters, so the actual Zod validation issues were truncated away and there was no debug-log trace, making the failure hard to diagnose after the toast disappeared.

The fix centralizes the logging inside `showAppToast`: when `intent` is `danger` or `warning` it now emits the full, untruncated `props.message` via `createClientLogger("toast")` before dispatching to sonner. This covers ~80 call sites (all `showAppToast` danger/warning invocations, `notifyError`, and the `showGitErrorToast` / `showGitWarningToast` wrappers that already route through `showAppToast`) with one edit, so future toasts automatically log without per-site boilerplate. `notifyError`'s now-redundant `log.error` call was removed to avoid duplicate entries.

Two direct `toast.*` calls that bypassed `showAppToast` were cleaned up in the same pass: `conflict-resolution-panel.tsx` now uses `showAppToast({ intent: "success", … })` for its copy-path toast; the info-style "Task worktree removed" toast in `use-linked-backlog-task-actions.ts` uses custom sonner options (cancel action with `className: "toast-with-dismiss-link"`) that `showAppToast` doesn't expose, and it's info-only rather than warning/error, so it was left alone.

Server-side, `src/server/runtime-state-hub.ts` also sends raw error strings to browser clients via `buildErrorMessage`, including the sessions.json case. Added a `createTaggedLogger("runtime-state-hub")` and wired it into the three `buildErrorMessage` call sites (removed-project notice, snapshot-load failure, connection-resolution failure) plus the `disposeProject(..., { closeClientErrorMessage })` path so the full message is also recoverable from runtime logs on the server side, not only via the client-side mirror.

Verified clean with `npm run typecheck`, `npm run web:typecheck`, `npm run lint`, `npm run test:fast` (748/748 runtime), and `npm run web:test` (884/884 web).

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `src/server/runtime-state-hub.ts`, `web-ui/src/components/app-toaster.ts`, `web-ui/src/components/git/panels/conflict-resolution-panel.tsx`

Commit: pending

## Chore: bump postcss to 8.5.10 in both packages (2026-04-24)

During an internal security review of Quarterdeck, `npm audit` reported one open moderate-severity advisory (GHSA-qx2v-qp2m-jg93, "PostCSS has XSS via Unescaped `</style>` in its CSS Stringify Output", CVSS 6.1) in both the root and `web-ui` packages. The vulnerable version was `postcss@8.5.8`, reached transitively via the Vite/Tailwind CSS toolchain. The fix was available in `postcss@8.5.10`, so I ran `npm audit fix` in both package roots to pull the lockfiles forward. No `package.json` edits were needed because `postcss` is not a direct dependency. The root `package-lock.json` also had a pre-existing drift where its internal version field still read `0.10.0` despite `package.json` being on `0.11.0`; `npm audit fix` re-synced that field as a side effect.

Verified the bump is safe with the full local check matrix: `npm run typecheck` (clean), `npm run web:typecheck` (clean), `npm run build` (runtime + web UI bundles built successfully), `npm test` (777 runtime tests across 88 files passing), and `npm run web:test` (884 web tests across 110 files passing). Post-fix `npm audit` reports 0 vulnerabilities in both packages. The attack surface for the advisory requires feeding untrusted CSS through PostCSS's stringifier, which Quarterdeck does not do at runtime — PostCSS only runs at build time on project-authored Tailwind/CSS — so the real-world risk here was already low, but clearing the advisory keeps the security review lockfile-clean.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `package-lock.json`, `web-ui/package-lock.json`

Commit: pending

## Fix: resume Codex task sessions by stored session id (2026-04-23)

Quarterdeck’s Codex resume path was still keyed to `codex resume --last`, which is only “most recent session in this repo” rather than “the session that belongs to this task.” That meant trash restore, manual restart, and interrupted-session recovery could all attach a Codex task to the wrong conversation when another Codex run had happened in the same checkout. The local Codex 0.123.0 CLI now supports `codex resume [SESSION_ID]`, and Codex’s rollout/session logs already expose the root session id in `session_meta`, so the missing piece was persisting that id through Quarterdeck’s hook transport and feeding it back into every resume path.

The runtime contract now carries an explicit `resumeSessionId` on task session summaries plus `sessionId` in hook-ingest metadata. Codex parsing now maps root `session_meta` events from both live session logs and rollout fallback scans into that metadata, `hooks-api` persists the id onto the session summary without polluting hook-activity state, and the Codex adapter prefers `codex resume <stored-id>` while keeping `--last` as a fallback for older sessions that do not have an id yet. The start-task-session handler and interrupted-session auto-resume path now thread the stored id into task restarts, and the web UI reuses the start response summary so non-isolated Codex tasks stop showing the repo-global resume warning once an id-backed resume is actually available. Added focused runtime tests for API parsing, Codex log parsing, hook persistence, and adapter argument construction, plus a web regression test for the warning suppression path. Added the matching release note in `CHANGELOG.md` and trimmed the remaining Codex native-hooks todo so it no longer tracks the now-completed session-id resume subtask.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `docs/todo.md`, `src/commands/codex-rollout-parser.ts`, `src/commands/codex-session-parser.ts`, `src/commands/hook-metadata.ts`, `src/commands/hooks.ts`, `src/core/api/task-session.ts`, `src/core/api-validation.ts`, `src/server/project-registry.ts`, `src/terminal/agent-session-adapters.ts`, `src/terminal/session-lifecycle.ts`, `src/terminal/session-manager-types.ts`, `src/terminal/session-summary-store.ts`, `src/trpc/handlers/start-task-session.ts`, `src/trpc/hooks-api.ts`, `test/runtime/api-validation.test.ts`, `test/runtime/hooks-codex-parser.test.ts`, `test/runtime/terminal/agent-session-adapters.test.ts`, `test/runtime/trpc/hooks-api/_helpers.ts`, `test/runtime/trpc/hooks-api/transitions.test.ts`, `test/utilities/task-session-factory.ts`, `web-ui/src/hooks/board/use-board-interactions.test.tsx`, `web-ui/src/hooks/board/use-board-interactions.ts`, `web-ui/src/hooks/board/use-task-lifecycle.ts`, `web-ui/src/hooks/board/use-task-sessions.ts`, `web-ui/src/test-utils/task-session-factory.ts`, `web-ui/src/utils/app-utils.tsx`

Commit: `dccf2e0f`

## Fix: replay queued restore requests after the initial terminal restore (2026-04-22)

The second untrash follow-up taught the terminal layer to notice a new session instance (`startedAt`/`pid`) and request a fresh restore, but there was still a narrower timing hole: if that restore request landed while the first control-socket restore was still in flight, `SlotSocketManager.requestRestore()` logged that the initial restore was not complete yet and dropped the refresh entirely. That left the terminal attached to the empty pre-spawn snapshot from before the resumed Codex process existed, which matched the live symptom exactly: restored task, loading spinner, no logs, and no explicit error.

The fix moves that race handling into `web-ui/src/terminal/slot-socket-manager.ts`. Restore requests are now only rejected when the control socket is unavailable; if the socket is open but the initial restore is still running, the manager records a queued restore request and replays it immediately from `markRestoreCompleted()` after sending `restore_complete`. That preserves the original restore protocol while guaranteeing that a second session-instance-driven refresh is not lost. Added focused coverage in `web-ui/src/terminal/slot-socket-manager.test.ts` to assert the queue/replay behavior, and repaired the constructor-style mocks in `web-ui/src/terminal/terminal-attachment-controller.test.ts` so the existing new-session restore regression coverage runs again. Added the matching release note in `CHANGELOG.md`.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `web-ui/src/terminal/slot-socket-manager.test.ts`, `web-ui/src/terminal/slot-socket-manager.ts`, `web-ui/src/terminal/terminal-attachment-controller.test.ts`

Commit: `34aed3de`

## Fix: request a fresh restore when untrash spawns a new task session (2026-04-22)

The first untrash follow-up serialized trash shutdown before resume, but restored Codex tasks could still land on a loading spinner with no logs when the terminal connected early enough to receive an empty restore snapshot before the resumed process actually existed. Once the runtime later published the real resumed session, the browser only looked at coarse state-string transitions; if the task stayed in `awaiting_review`, nothing asked for another restore snapshot, so the terminal stayed attached to the empty pre-spawn snapshot.

The fix widens the terminal-side session-change signal from `state` alone to the full previous summary. `TerminalSessionHandle` now passes the whole previous summary into the attachment controller, and `TerminalAttachmentController` requests a fresh restore whenever the same visible task reports a new session instance (`startedAt` or `pid` changed). That preserves the existing resize-on-enter-running behavior while also repairing the specific untrash path where the real resumed process appears after the first restore. Added focused regression coverage in `web-ui/src/terminal/terminal-attachment-controller.test.ts` so a new session instance must trigger exactly one restore request while same-instance summary churn does not. Added the release note in `CHANGELOG.md`.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `web-ui/src/terminal/terminal-attachment-controller.test.ts`, `web-ui/src/terminal/terminal-attachment-controller.ts`, `web-ui/src/terminal/terminal-session-handle.ts`

Commit: `34aed3de`

## Fix: serialize trash-stop exit before untrash resume (2026-04-22)

Restoring a trashed task could race the earlier trash cleanup. The trash flow already stops the task session with `waitForExit: true`, but that work happens asynchronously after the card moves to trash; if the user untrashed quickly enough, restore immediately called `startTaskSession(...)` while the old process entry was still active. In that window `TerminalSessionManager.startTaskSession()` legitimately short-circuited and returned the old active summary instead of spawning a new session. Once the old process finally exited, the restored card was left in review with no live agent behind it, which surfaced as restored Codex tasks that only showed a loading spinner / empty terminal.

The fix makes restore follow the same lifecycle serialization as explicit restart: `useTaskLifecycle.resumeTaskFromTrash()` now awaits `stopTaskSession(taskId, { waitForExit: true })` before any worktree ensure/resume work. This keeps the runtime from reusing the pre-trash process entry during a rapid trash→untrash round trip. `useBoardInteractions` now threads the stop callback into `useTaskLifecycle`, the board interaction test suite now asserts the stop-before-ensure-before-start ordering for restore, and `AGENTS.md` records the race as shared tribal knowledge so future terminal/trash refactors do not reintroduce it. Added the release note in `CHANGELOG.md`.

Files touched: `AGENTS.md`, `CHANGELOG.md`, `docs/implementation-log.md`, `web-ui/src/hooks/board/use-board-interactions.test.tsx`, `web-ui/src/hooks/board/use-board-interactions.ts`, `web-ui/src/hooks/board/use-task-lifecycle.ts`

Commit: `383762f3`
## Refactor: always show running-task stop/trash actions (2026-04-22)

Removed the `showRunningTaskEmergencyActions` escape-hatch setting and collapsed the running-card action path down to the default behavior. The setting started as a temporary workaround for stuck sessions, but the extra config plumbing no longer bought anything useful and forced the runtime config contract, settings form, test fixtures, and board/sidebar card surfaces to carry a dead boolean. The runtime-side cleanup removed the field from the global config registry and runtime config Zod schemas (`src/config/global-config-fields.ts`, `src/core/api/config.ts`). The web UI cleanup removed the setting from the settings form and Troubleshooting section (`web-ui/src/hooks/settings/settings-form.ts`, `web-ui/src/components/settings/general-sections.tsx`), dropped the reactive card-state/context threading (`web-ui/src/state/card-actions-context.tsx`, `web-ui/src/hooks/app/use-app-action-models.ts`), and simplified both board and sidebar card renderers so in-progress cards always show the force-restart and force-trash actions on hover when the session is alive (`web-ui/src/components/board/board-card-actions.tsx`, `web-ui/src/components/board/board-card.tsx`, `web-ui/src/components/board/board-column.tsx`, `web-ui/src/components/terminal/column-context-panel.tsx`). Updated frontend fixtures/tests to match the smaller config and reactive-state shapes (`web-ui/src/test-utils/runtime-config-factory.ts`, `web-ui/src/components/terminal/column-context-panel.test.tsx`, `web-ui/src/components/task/card-detail-view.test.tsx`) and added a focused hover regression test in `web-ui/src/components/board/board-card.test.tsx` so running cards must keep exposing the restart/trash escape hatches by default. Added the release note in `CHANGELOG.md`.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `src/config/global-config-fields.ts`, `src/core/api/config.ts`, `web-ui/src/components/board/board-card.test.tsx`, `web-ui/src/components/board/board-card-actions.tsx`, `web-ui/src/components/board/board-card.tsx`, `web-ui/src/components/board/board-column.tsx`, `web-ui/src/components/settings/general-sections.tsx`, `web-ui/src/components/task/card-detail-view.test.tsx`, `web-ui/src/components/terminal/column-context-panel.test.tsx`, `web-ui/src/components/terminal/column-context-panel.tsx`, `web-ui/src/hooks/app/use-app-action-models.ts`, `web-ui/src/hooks/settings/settings-form.ts`, `web-ui/src/state/card-actions-context.tsx`, `web-ui/src/test-utils/runtime-config-factory.ts`

Commit: `55e48635`

## Fix: harden Codex CLI detection with version gating (2026-04-22)

Replaced the old Codex "binary exists on PATH" check with a small compatibility gate that still uses PATH for discovery but now probes `codex --version`, enforces a minimum supported version (`0.30.0`), and blocks launch plus auto-selection when the detected Codex build is too old or its version cannot be determined. On the runtime side, this changed `src/config/agent-registry.ts` to add the version probe, compare versions, expose explicit install states and status messages, and leave inline TODO comments for a future capability-based Codex probe; updated `src/config/runtime-config.ts` and `src/config/index.ts` so default agent auto-selection uses only runnable agents; extended the runtime config API contract in `src/core/api/config.ts`; and updated the Codex install URL in `src/core/agent-catalog.ts` to the official OpenAI Codex CLI quickstart. On the web UI side, this updated the settings and onboarding surfaces to distinguish `upgrade_required` from `missing`, show the corresponding messaging and button label, and clarify that CLI detection is PATH-based with a Codex version floor in `web-ui/src/components/settings/agent-section.tsx`, `web-ui/src/components/settings/runtime-settings-dialog.tsx`, and `web-ui/src/components/task/task-start-agent-onboarding-carousel.tsx`. Updated runtime and web test helpers plus focused runtime/native-agent tests to cover the new status fields and version gating behavior in `test/runtime/config/agent-registry.test.ts`, `test/runtime/config/agent-selection.test.ts`, `test/runtime/config/runtime-config-helpers.ts`, `web-ui/src/runtime/native-agent.test.ts`, and `web-ui/src/test-utils/runtime-config-factory.ts`.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `docs/todo.md`, `src/config/agent-registry.ts`, `src/config/index.ts`, `src/config/runtime-config.ts`, `src/core/agent-catalog.ts`, `src/core/api/config.ts`, `test/runtime/config/agent-registry.test.ts`, `test/runtime/config/agent-selection.test.ts`, `test/runtime/config/runtime-config-helpers.ts`, `web-ui/src/components/settings/agent-section.tsx`, `web-ui/src/components/settings/runtime-settings-dialog.tsx`, `web-ui/src/components/task/task-start-agent-onboarding-carousel.tsx`, `web-ui/src/runtime/native-agent.test.ts`, `web-ui/src/test-utils/runtime-config-factory.ts`

Commit: `bcf31abc`

## Refactor: remove session event log debugging path (2026-04-22)

Removed the developer-only session event log feature end-to-end. On the runtime side this deleted `src/core/event-log.ts`, removed its startup/config plumbing from `src/cli.ts`, `src/trpc/handlers/save-config.ts`, `src/core/index.ts`, `src/config/global-config-fields.ts`, and `src/core/api/config.ts`, and dropped the now-pointless event-emission call sites from the runtime server, project registry, session lifecycle/reconciliation/auto-restart/input/workspace-trust modules, and hook ingestion pipeline. On the tRPC/browser side this removed the `flagTaskForDebug` mutation and handler from `src/trpc/app-router.ts`, `src/trpc/app-router-context.ts`, `src/trpc/runtime-api.ts`, and `src/trpc/handlers/flag-task-for-debug.ts`, removed the “Session event log” settings toggle and config-form field from `web-ui/src/components/settings/general-sections.tsx` and `web-ui/src/hooks/settings/settings-form.ts`, and stripped the board/detail debug action wiring from `web-ui/src/hooks/app/use-app-action-models.ts`, `web-ui/src/state/card-actions-context.tsx`, `web-ui/src/components/board/board-card-actions.tsx`, `web-ui/src/components/board/board-card.tsx`, `web-ui/src/components/board/board-column.tsx`, and `web-ui/src/components/terminal/column-context-panel.tsx`. Updated the frontend runtime-config test factory and added the release note in `CHANGELOG.md`. Verified with `npm run typecheck` and `npm run web:typecheck`.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `src/cli.ts`, `src/config/global-config-fields.ts`, `src/core/api/config.ts`, `src/core/event-log.ts`, `src/core/index.ts`, `src/server/project-registry.ts`, `src/server/runtime-server.ts`, `src/terminal/session-auto-restart.ts`, `src/terminal/session-input-pipeline.ts`, `src/terminal/session-interrupt-recovery.ts`, `src/terminal/session-lifecycle.ts`, `src/terminal/session-reconciliation-sweep.ts`, `src/terminal/session-transition-controller.ts`, `src/terminal/session-workspace-trust.ts`, `src/trpc/app-router-context.ts`, `src/trpc/app-router.ts`, `src/trpc/handlers/flag-task-for-debug.ts`, `src/trpc/handlers/save-config.ts`, `src/trpc/hooks-api.ts`, `src/trpc/runtime-api.ts`, `web-ui/src/components/board/board-card-actions.tsx`, `web-ui/src/components/board/board-card.tsx`, `web-ui/src/components/board/board-column.tsx`, `web-ui/src/components/settings/general-sections.tsx`, `web-ui/src/components/terminal/column-context-panel.tsx`, `web-ui/src/hooks/app/use-app-action-models.ts`, `web-ui/src/hooks/settings/settings-form.ts`, `web-ui/src/state/card-actions-context.tsx`, `web-ui/src/test-utils/runtime-config-factory.ts`

Commit: `5d65404a`

## Refactor: remove task working-directory migration (2026-04-22)

Removed the end-to-end task working-directory migration feature so tasks can no longer be hot-swapped between the main checkout and an isolated worktree after they already exist. On the runtime side, this deleted the dedicated migration handler (`src/trpc/handlers/migrate-task-working-directory.ts`), removed the tRPC contract from `src/core/api/task-session.ts`, `src/trpc/app-router.ts`, `src/trpc/app-router-context.ts`, and `src/trpc/runtime-api.ts`, and deleted the lightweight runtime stream message/broadcaster plumbing from `src/core/api/streams.ts`, `src/core/service-interfaces.ts`, `src/server/runtime-state-messages.ts`, `src/server/runtime-state-hub.ts`, `src/server/index.ts`, and `src/trpc/runtime-mutation-effects.ts`. On the web UI side, this removed the migration dialog/hooks (`web-ui/src/components/task/migrate-working-directory-dialog.tsx`, `web-ui/src/hooks/terminal/use-migrate-working-directory.ts`, `web-ui/src/hooks/terminal/use-migrate-task-dialog.ts`), removed migration state from the runtime stream store/provider path (`web-ui/src/runtime/runtime-state-stream-store.ts`, `web-ui/src/runtime/runtime-stream-dispatch.ts`, `web-ui/src/runtime/use-runtime-state-stream.ts`, `web-ui/src/hooks/project/use-project-navigation.ts`, `web-ui/src/providers/project-provider.tsx`, `web-ui/src/hooks/app/use-app-side-effects.ts`, `web-ui/src/hooks/board/index.ts`), and removed the board/card wiring from `web-ui/src/state/card-actions-context.tsx`, `web-ui/src/hooks/app/use-app-action-models.ts`, `web-ui/src/components/app/app-dialogs.tsx`, `web-ui/src/App.tsx`, `web-ui/src/components/board/board-card.tsx`, `web-ui/src/components/board/board-column.tsx`, `web-ui/src/components/terminal/column-context-panel.tsx`, and `web-ui/src/components/task/index.ts`. Updated runtime/frontend tests to drop the removed API and deleted migration-only test coverage from `test/runtime/trpc/runtime-api.test.ts`; adjusted UI tests in `web-ui/src/components/terminal/column-context-panel.test.tsx` and `web-ui/src/components/task/card-detail-view.test.tsx`; and refreshed repo instructions in `AGENTS.md` plus the release note in `CHANGELOG.md`.

Files touched: `AGENTS.md`, `CHANGELOG.md`, `docs/implementation-log.md`, `src/core/api/streams.ts`, `src/core/api/task-session.ts`, `src/core/service-interfaces.ts`, `src/server/index.ts`, `src/server/runtime-state-hub.ts`, `src/server/runtime-state-messages.ts`, `src/trpc/app-router-context.ts`, `src/trpc/app-router.ts`, `src/trpc/handlers/start-task-session.ts`, `src/trpc/runtime-api.ts`, `src/trpc/runtime-mutation-effects.ts`, `test/runtime/trpc/runtime-api.test.ts`, `web-ui/src/App.tsx`, `web-ui/src/components/app/app-dialogs.tsx`, `web-ui/src/components/board/board-card.tsx`, `web-ui/src/components/board/board-column.tsx`, `web-ui/src/components/task/index.ts`, `web-ui/src/components/task/card-detail-view.test.tsx`, `web-ui/src/components/terminal/column-context-panel.test.tsx`, `web-ui/src/components/terminal/column-context-panel.tsx`, `web-ui/src/hooks/app/use-app-action-models.ts`, `web-ui/src/hooks/app/use-app-side-effects.ts`, `web-ui/src/hooks/board/index.ts`, `web-ui/src/hooks/project/use-project-navigation.ts`, `web-ui/src/hooks/terminal/index.ts`, `web-ui/src/providers/project-provider.tsx`, `web-ui/src/runtime/runtime-state-stream-store.ts`, `web-ui/src/runtime/runtime-stream-dispatch.ts`, `web-ui/src/runtime/use-runtime-state-stream.ts`

Commit: `417d540f`

## Fix: clarify worktree system prompt is Claude Code only (2026-04-22)

The settings UI described the worktree system prompt template as appended "to the agent's system prompt", but only the Claude adapter in `src/terminal/agent-session-adapters.ts` injects it via `--append-system-prompt`. The Codex adapter has no equivalent. Updated the description in `web-ui/src/components/settings/agent-section.tsx` to say "Claude Code's system prompt" so users know the scope.

Files touched: `web-ui/src/components/settings/agent-section.tsx`

## Docs cleanup and version bump to 0.11.0 (2026-04-22)

Archived 7 completed refactor docs to `docs/archive/`, rotated changelog and implementation log into their archive files, bumped version from 0.10.0 to 0.11.0, and updated `docs/README.md` cross-references.
