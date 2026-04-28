# Implementation Log

> Prior entries in `docs/history/`: `implementation-log-through-0.11.0.md`, `implementation-log-through-0.10.0.md`, `implementation-log-through-0.9.4.md`, `implementation-log-through-2026-04-15.md`, `implementation-log-through-2026-04-12.md`.

## Fix: show remote refs in base branch picker (2026-04-28)

Dogfooding exposed that the task top-bar "from {baseRef}" dropdown only rendered local branches even though the git refs API already returned remote tracking refs and the full branch picker already grouped them. This made repositories without a local checkout of the desired base branch look empty or incomplete when setting a task base ref.

The base-ref picker is now a dedicated `BaseRefLabel` component instead of an inline block inside `ConnectedTopBar`. It reuses the shared branch-selector sectioning helper, keeps project-pinned local branches first, renders separate Local and Remote sections, and updates the copy from branch-only language to ref-oriented loading, filter, and empty states. Selecting a remote ref stores the full ref name such as `origin/main`, so remote bases are not silently collapsed to local names.

Focused web tests cover pinned/local/remote grouping, filtering across local and remote refs, and selecting `origin/main` without aliasing it. Validation included the component test, web TypeScript checking, and a narrow Biome check for the touched files.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `web-ui/src/components/app/base-ref-label.tsx`, `web-ui/src/components/app/base-ref-label.test.tsx`, `web-ui/src/components/app/connected-top-bar.tsx`.

Commit: pending

## Chore: remove reviewed-task auto-trash (2026-04-28)

Removed the task-level auto-trash automation end to end. Board cards and runtime board schemas no longer carry `autoReviewEnabled` / `autoReviewMode`, create/update task mutations no longer accept those fields, persisted board parsing ignores the old fields, and the task indicator semantic layer no longer exposes auto-review-specific blocking state. Existing saved board JSON can still hydrate because the parser strips unknown legacy fields.

The web UI no longer renders the "Auto-trash when reviewed" checkbox in either task creation surface, no longer stores the last auto-review setting in local storage, and no longer schedules the 500 ms review-column timer. The `use-review-auto-actions` hook and its domain module/tests were deleted. The "Cancel Auto-trash" affordance was removed from board cards and task/detail terminal panels, which also let the card action context, interaction provider, task detail view, terminal panel layout, and related tests drop the automatic-action plumbing.

Manual trash behavior was intentionally preserved: moving a task to Trash still goes through the normal trash workflow, including confirmation when appropriate, session shutdown, worktree cleanup, dependency unlocks, and patch capture for uncommitted work. The man page and stale task-state note were updated so current documentation no longer advertises auto-review task fields.

Validation included `npm run typecheck`, `npm run web:typecheck`, `npm run lint` (left an unrelated existing info-level suggestion in `test/integration/shutdown-coordinator.integration.test.ts`), `npm test -- test/runtime/task-board-mutations.test.ts test/runtime/core/task-indicators.test.ts test/runtime/trpc/project-api-state.test.ts`, and `npm run web:test -- --run src/hooks/board/task-editor.test.ts src/hooks/board/task-editor-drafts.test.ts src/hooks/board/use-task-editor.test.tsx src/components/task/task-create-dialog.test.tsx src/components/board/board-card.test.tsx src/components/task/task-detail-terminal-surface.test.tsx src/state/board-state-mutations.test.ts src/state/board-state-normalization.test.ts`.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `docs/task-state-system-stale.md`, `man/quarterdeck.1`, `src/core/api/board.ts`, `src/core/api/shared.ts`, `src/core/api/task-indicators.ts`, `src/core/task-board-mutations.ts`, `src/prompts/prompt-templates.ts`, `test/runtime/core/task-indicators.test.ts`, `test/runtime/task-board-mutations.test.ts`, `test/runtime/trpc/project-api-state.test.ts`, `web-ui/src/App.tsx`, `web-ui/src/components/app/app-dialogs.tsx`, `web-ui/src/components/board/board-card.tsx`, `web-ui/src/components/board/board-column.tsx`, `web-ui/src/components/task/task-create-dialog.tsx`, `web-ui/src/components/task/task-detail-terminal-surface.tsx`, `web-ui/src/components/task/task-inline-create-card.tsx`, `web-ui/src/components/terminal/agent-terminal-panel.tsx`, `web-ui/src/components/terminal/column-context-panel.tsx`, `web-ui/src/components/terminal/persistent-terminal-panel-layout.tsx`, `web-ui/src/hooks/app/use-app-action-models.ts`, `web-ui/src/hooks/board/board-card.ts`, `web-ui/src/hooks/board/index.ts`, `web-ui/src/hooks/board/task-editor-drafts.ts`, `web-ui/src/hooks/board/task-editor.ts`, `web-ui/src/hooks/board/use-board-interactions.ts`, `web-ui/src/hooks/board/use-card-detail-view.ts`, `web-ui/src/hooks/board/use-task-editor.ts`, `web-ui/src/hooks/board/use-task-lifecycle.ts`, `web-ui/src/providers/interactions-provider.tsx`, `web-ui/src/state/board-state-parser.ts`, `web-ui/src/state/board-state.ts`, `web-ui/src/state/card-actions-context.tsx`, `web-ui/src/storage/local-storage-store.ts`, `web-ui/src/types/board.ts`, `web-ui/src/utils/app-utils.tsx`, plus related test fixture cleanup and deleted auto-review tests/modules.

Commit: pending

## Feature: send worktree context to Codex agents (2026-04-28)

Quarterdeck's configurable worktree context prompt was previously wired only into Claude task launches through system-prompt context. Codex task sessions could receive Quarterdeck's native launch-scoped hooks, but they did not receive the same repo/task guidance text, so custom worktree instructions in settings were not available to Codex agents.

Codex task launch preparation now builds the existing worktree context prompt and passes it through Codex's `developer_instructions` config key using the same command-line `-c` channel already used for launch-scoped hook configuration. The value is serialized as TOML before being appended to the Codex argv. If the user already supplied a launch-level `developer_instructions` override in the agent's configured launch args, Quarterdeck leaves that override alone instead of appending a second value.

The settings reminder now describes both delivery paths: Claude receives the context as system-prompt context, while Codex receives it as developer instructions. Focused adapter tests cover the injected Codex config and the explicit-override skip path.

Validation included `npm test -- test/runtime/terminal/agent-session-adapters.test.ts`, `npm run typecheck`, `npm run web:typecheck`, and `npx @biomejs/biome check src/terminal/agent-session-adapters.ts test/runtime/terminal/agent-session-adapters.test.ts web-ui/src/components/settings/agent-section.tsx`.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `src/terminal/agent-session-adapters.ts`, `test/runtime/terminal/agent-session-adapters.test.ts`, `web-ui/src/components/settings/agent-section.tsx`.

Commit: pending

## Fix: checkout remote branch refs from branch picker (2026-04-28)

The branch selector passes `RuntimeGitRef.name` through checkout actions. For remote rows, that name is an explicit remote ref such as `origin/feature/foo`. `runGitCheckoutAction(...)` only handled bare branch names: it could turn `feature/foo` into `origin/feature/foo`, but when it received `origin/feature/foo` directly it looked for `refs/remotes/origin/origin/feature/foo` and then fell through to `git switch origin/feature/foo`, which fails because Git treats that as a remote branch ref rather than a local branch checkout target.

The checkout helper now validates the requested ref, recognizes explicit `refs/remotes/<remote>/<branch>` names, maps an explicit remote ref to its existing local branch when one is already present, and otherwise uses `git switch --track <remote>/<branch>` so Git creates the matching local tracking branch. Local branch checkout still wins when the exact requested branch exists locally, preserving normal branch switching behavior. This shared helper is used by both home checkout and task-scoped checkout, so the fix covers the top-bar picker, file-scope picker, and linked worktree task contexts.

Focused runtime tests create temporary origin remotes and verify the regression paths: a remote-only branch selected as `origin/<branch>`, a full `refs/remotes/origin/<branch>` ref, an explicit remote ref whose local branch already exists, the same remote-only checkout from a linked worktree, the locked-worktree fallback when the matching local branch is checked out elsewhere, and invalid full remote refs whose normalized remote name would be unsafe as a git argument.

Validation included `npm test -- --run test/runtime/git-checkout.test.ts`, `npm run typecheck`, and `npx @biomejs/biome check src/workdir/git-sync.ts test/runtime/git-checkout.test.ts`.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `src/workdir/git-sync.ts`, `test/runtime/git-checkout.test.ts`.

Commit: pending

## Fix: start Codex with measured task terminal width (2026-04-28)

Codex terminal sessions could render their initial screen at roughly half width because task startup read the geometry registry synchronously and fell back to an old one-third-viewport estimate when no fresh terminal measurement was available. Codex hard-wraps early TUI output at the PTY width it sees during spawn, so later browser resizes could shrink or redraw content but did not reliably make already-emitted lines longer.

The browser task-start path now resolves geometry through `resolveTaskStartGeometry(...)`: it waits up to 300ms for a real terminal measurement when none exists, and waits 100ms for already cached geometry to settle so pending resize-observer updates from a just-widened terminal can replace stale cached columns before spawning the PTY. If no frontend terminal is attached, startup still cannot know a real browser width, so the detached fallback now uses a wider viewport-based estimate capped at 160 columns instead of the previous one-third-width estimate.

Focused tests cover all three geometry paths: cached geometry settling to a newer value, missing geometry resolving after the wait, and detached fallback estimation. `useTaskSessions` coverage now also proves `runtime.startTaskSession.mutate(...)` is not called until geometry resolution completes, locking in the ordering that matters for Codex's first draw.

Validation included `npm --prefix web-ui run test -- src/hooks/board/task-session-geometry.test.ts src/hooks/board/use-task-sessions.test.tsx src/runtime/task-session-geometry.test.ts`, `npm --prefix web-ui run typecheck`, the staged Biome check, root `npm run typecheck`, and root `npm run test:fast` through the commit hook.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `web-ui/src/hooks/board/task-session-geometry.ts`, `web-ui/src/hooks/board/task-session-geometry.test.ts`, `web-ui/src/hooks/board/use-task-sessions.ts`, `web-ui/src/hooks/board/use-task-sessions.test.tsx`, `web-ui/src/runtime/task-session-geometry.ts`, `web-ui/src/runtime/task-session-geometry.test.ts`.

Commit: pending

## Fix: add form field identifiers (2026-04-28)

Browser and accessibility diagnostics were still reporting unlabeled form controls across Quarterdeck's web UI because many utility search boxes, textareas, select filters, and hidden file inputs had neither an `id` nor a `name`. The fix adds stable `name` attributes to those native controls without changing their visible labels or control flow, covering top-bar branch filters, shortcut editors, debug filters, git branch/file panels, search overlays, notification volume, prompt shortcut editing, task title editing, task creation prompts, feature branch naming, inline diff comments, stash messages, and commit messages.

Shared controls use their existing contextual identifiers where available: `TaskPromptComposer` derives the field name from its optional `id`, `SearchSelectDropdown` derives the search field from its trigger id, and file/diff controls include scope or comment context so repeated instances stay distinguishable. The task-create dialog test mocks were updated to expose the same field names as the real controls.

Validation included an AST scan over tracked `web-ui/src/**/*.tsx` confirming every native `input`, `textarea`, and `select` has either `id` or `name`, plus `npm run web:test -- --run src/components/task/task-create-dialog.test.tsx`.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `web-ui/src/components/app/connected-top-bar.tsx`, `web-ui/src/components/app/top-bar-project-shortcut-control.tsx`, `web-ui/src/components/debug/debug-log-panel.tsx`, `web-ui/src/components/git/history/git-refs-panel.tsx`, `web-ui/src/components/git/panels/branch-selector-popover.tsx`, `web-ui/src/components/git/panels/commit-panel.tsx`, `web-ui/src/components/git/panels/diff-viewer-utils.tsx`, `web-ui/src/components/git/panels/file-browser-tree-panel.tsx`, `web-ui/src/components/git/panels/rename-branch-dialog.tsx`, `web-ui/src/components/search-select-dropdown.tsx`, `web-ui/src/components/search/file-finder-overlay.tsx`, `web-ui/src/components/search/text-search-overlay.tsx`, `web-ui/src/components/settings/display-sections.tsx`, `web-ui/src/components/settings/prompt-shortcut-editor-dialog.tsx`, `web-ui/src/components/settings/shortcuts-section.tsx`, `web-ui/src/components/task/inline-title-editor.tsx`, `web-ui/src/components/task/task-create-dialog.test.tsx`, `web-ui/src/components/task/task-create-dialog.tsx`, `web-ui/src/components/task/task-create-multi-list.tsx`, `web-ui/src/components/task/task-prompt-composer.tsx`.

Commit: pending

## Chore: remove frontend perf-investigation logging (2026-04-28)

After the hidden terminal stream lifetime fix, the remaining browser-side `[perf-investigation]` probes were no longer needed. The cleanup removes the xterm write-rate accumulator from `SlotWriteQueue`, the restore-applied counter from `TerminalViewport`, and the reconnect-rate counter from `TerminalSessionHandle`. The sampled `[quarterdeck-debug] terminal reconnect on session_instance_changed` trace stays in `TerminalAttachmentController` as a targeted lifecycle breadcrumb, with its comment rewritten so it no longer references the temporary investigation counters.

The diagnostic helper module was only feeding those removed browser console probes, so `terminal-write-diagnostics.ts` was deleted instead of leaving investigation-shaped types behind. That let the surrounding terminal classes drop socket-state getters, pool-role mirroring into slots, viewport visibility diagnostics, and mock-only test plumbing. The terminal pool still owns its role union directly, preserving pool behavior while narrowing the public surface.

The remaining raw trash/trash-warning browser breadcrumbs were also routed through `createClientLogger(...)`, so they respect Quarterdeck's normal client log enablement and level controls instead of writing directly to the console. This touched the board interaction hook, linked backlog trash actions, and trash workflow confirm/cancel handlers without changing the trash lifecycle behavior.

Validation included `rg "\[perf-investigation\]|perf-investigation" src web-ui/src` with no matches, `npm --prefix web-ui run typecheck`, and `npm --prefix web-ui run test -- terminal-pool`.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `web-ui/src/hooks/board/use-board-interactions.ts`, `web-ui/src/hooks/board/use-linked-backlog-task-actions.ts`, `web-ui/src/hooks/board/use-trash-workflow.ts`, `web-ui/src/terminal/slot-socket-manager.ts`, `web-ui/src/terminal/slot-write-queue.ts`, `web-ui/src/terminal/terminal-attachment-controller.ts`, `web-ui/src/terminal/terminal-pool.ts`, `web-ui/src/terminal/terminal-pool-acquire.test.ts`, `web-ui/src/terminal/terminal-pool-dedicated.test.ts`, `web-ui/src/terminal/terminal-pool-lifecycle.test.ts`, `web-ui/src/terminal/terminal-session-handle.ts`, `web-ui/src/terminal/terminal-slot.ts`, `web-ui/src/terminal/terminal-viewport.ts`, deleted `web-ui/src/terminal/terminal-write-diagnostics.ts`.

Commit: pending

## Fix: keep .NET build outputs local to task worktrees (2026-04-28)

Dogfooding a .NET project exposed a bad interaction between Quarterdeck's ignored-path mirroring and mutable build outputs. `syncIgnoredPathsIntoWorktree(...)` intentionally symlinks ignored paths from the parent checkout into task worktrees so dependency/setup directories such as `node_modules` do not need to be recreated for every task. In .NET repositories, `bin/`, `obj/`, and `TestResults/` are ignored too, but MSBuild and test runners write through those directories. Symlinking them back to the parent checkout can cross the worktree sandbox boundary and can also mix build artifacts from different branches.

The ignored-path filter now skips any path segment named `bin`, `obj`, or `TestResults` before the mirroring pass creates symlinks or writes the managed `info/exclude` block. This keeps those paths absent in new task worktrees so local builds create per-worktree outputs normally, while still allowing dependency-style ignored paths to mirror. A focused integration test creates the .NET-style ignored output tree next to a normal `node_modules` ignored path and verifies the build outputs are not symlinked while `node_modules` still is.

`docs/todo.md` now tracks the broader design follow-up: replace broad ignored-path mirroring with an explicit allowlist plus project-level opt-ins, so future ecosystems do not rely on an ever-growing denylist.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `docs/todo.md`, `src/workdir/task-worktree-symlinks.ts`, `test/integration/task-worktree.integration.test.ts`.

Commit: pending

## Fix: avoid blocking project git context probes (2026-04-28)

Project-scoped HTTP routing and hook ingest were still using full project context loading in places where they only needed the project id and repository path. Full context loading also detects current branch, local branches, and default branch, so frequent request setup could pay for git metadata probes even when the handler did not use branch data. That undercut the metadata-polling work that moved slow git probes away from runtime snapshots.

Project state now separates lightweight `RuntimeProjectScopeContext` from full `RuntimeProjectContext`. Runtime request scope resolution, hook ingest, and project-add base-path resolution use the scope-only lookup, while state hydration still calls the full context path when it needs `RuntimeGitRepositoryInfo`. Repository info detection now uses async `runGit` metadata probes, parallelizes branch/default-branch reads, dedupes concurrent loads, and keeps a short in-memory cache. Git mutation handlers and home metadata polling explicitly invalidate that cache; comments mark this as a future cleanup point if git mutation ownership moves behind a shared effects layer.

Focused integration coverage now verifies scope lookup by project id and repository git-info caching/invalidation. Validation for the landed branch included typecheck, fast runtime/utilities tests, project-state integration tests, and the task-worktree metadata streaming regression.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `src/server/project-metadata-loaders.ts`, `src/server/runtime-server.ts`, `src/state/index.ts`, `src/state/project-state-utils.ts`, `src/state/project-state.ts`, `src/trpc/hooks-api.ts`, `src/trpc/project-api-git-ops.ts`, `src/trpc/projects-api.ts`, `test/integration/project-state.integration.test.ts`.

Commit: pending

## Fix: avoid tsx force-killing dev shutdown (2026-04-28)

Reproducing `npm run dev -- --no-open --port auto` showed that a single Ctrl+C could print `Previous process hasn't exited yet. Force killing...` from `tsx watch` while Quarterdeck was still inside its graceful shutdown path. The warning was emitted by `tsx`'s parent watcher signal handler, not by Quarterdeck's HTTP `server.close()`: npm/terminal wrapper signal delivery could reach `tsx` a second time while the watched Quarterdeck child was still persisting shutdown state and closing sockets.

The dev runtime now launches `tsx watch src/cli.ts` through `scripts/dev-runtime.mjs`, which resolves the local `tsx/cli` entrypoint and supervises it with a managed child-process helper. The helper starts the child in its own process group, forwards only one graceful shutdown signal to the immediate child, waits for exit, and reserves process-group `SIGKILL` for the timeout fallback. `scripts/dev-full.mjs` now reuses that helper for both runtime and web UI children, waits for both processes during shutdown, and passes runtime CLI arguments through to the runtime supervisor for local repros.

Verified with isolated `QUARTERDECK_STATE_HOME` runs: `npm run dev -- --no-open --port auto` now exits with `Cleaning up... done` and no `tsx` force-kill warning; `npm run dev:full -- --no-open --port auto` cleanly shuts down both runtime and web UI children. Syntax checks passed for all touched `.mjs` dev scripts.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `package.json`, `scripts/dev-full.mjs`, `scripts/dev-process.mjs`, `scripts/dev-runtime.mjs`.

Commit: pending

## Fix: bound hidden terminal stream lifetimes (2026-04-28)

Terminal prewarm and quick-switch slots were intentionally kept alive briefly to make hover-to-click and task switching feel instant. Dogfooding showed two missing bounds in that policy layer: a `PRELOADING` / `READY` slot could stay connected if the caller never sent `cancelWarmup()`, and a quick switch back to an already-retained slot could leave the formerly visible task marked `ACTIVE` even though it was now hidden.

The terminal pool now starts a 12-second max-TTL timer when `warmup(...)` creates a slot, while the existing 3-second `cancelWarmup(...)` mouseleave grace path remains unchanged. PREVIOUS slots now auto-evict after 8 seconds. Active promotion flows through one pool-policy helper that demotes any other `ACTIVE` slot to `PREVIOUS`, schedules that slot's eviction, promotes the requested slot, and evicts stale previous slots. This keeps the attachment/session mechanism unchanged while making the shared-pool policy maintain the invariant that only the visible task is `ACTIVE`.

The browser terminal write diagnostics were widened at the same boundary. `TerminalViewport` now reports slot/task identity, pool role, visibility, IO/control socket state, readiness, and restore state into the aggregate `[perf-investigation]` xterm write-rate probe. This is diagnostic-only plumbing: it observes the session/viewport state instead of owning lifecycle transitions.

Focused terminal-pool tests now cover warm-slot max-TTL eviction, previous-slot eviction, existing PREVIOUS reacquire demoting the former active slot, warmed-slot promotion demoting the former active slot, cancel-warmup eviction, acquisition cleanup, and `releaseAll()` clearing delayed timers without a second disconnect.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `web-ui/src/terminal/slot-socket-manager.ts`, `web-ui/src/terminal/slot-write-queue.ts`, `web-ui/src/terminal/terminal-attachment-controller.ts`, `web-ui/src/terminal/terminal-pool.ts`, `web-ui/src/terminal/terminal-pool-acquire.test.ts`, `web-ui/src/terminal/terminal-pool-dedicated.test.ts`, `web-ui/src/terminal/terminal-pool-lifecycle.test.ts`, `web-ui/src/terminal/terminal-session-handle.ts`, `web-ui/src/terminal/terminal-slot.ts`, `web-ui/src/terminal/terminal-viewport.ts`, `web-ui/src/terminal/terminal-write-diagnostics.ts`.

Commit: pending

## Fix: abort timed-out hook ingests (2026-04-28)

Investigating a canceled Codex task stuck on `Running 2 PostToolUse hooks` narrowed the likely failure to the hook CLI timeout path. `quarterdeck hooks ingest` wrapped the tRPC mutation in a `Promise.race(...)`, but the losing HTTP request was never aborted. If the runtime request hung or the connection stayed open after the timeout, the hook subprocess could remain alive after the CLI had already decided the attempt had timed out, and Codex would keep waiting for its native `PostToolUse` hooks to finish.

The hook CLI now uses an abortable timeout. Each ingest attempt creates its own tRPC client with a fetch wrapper bound to an `AbortSignal`; when the 3-second hook timeout fires, the signal aborts the underlying HTTP request before the timeout error is returned and the normal single retry path runs. A focused regression test covers the important contract directly: pending hook work receives an aborted signal when the timeout elapses.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `src/commands/hooks.ts`, `test/runtime/commands/hooks.test.ts`.

Commit: pending

## Fix: harden git metadata polling and command isolation (2026-04-28)

The git metadata investigation found that Quarterdeck had several separate risks in the same area: aggressive project/task polling, connect-time refreshes that could make runtime snapshots wait on git, metadata probes sharing only a global limiter, and git helpers that either had no timeout or inherited a timeout that was too short for legitimate user-facing inspection reads. A slow or wedged repository could therefore spend process slots and make visible project state feel sluggish even when another project was healthy.

The runtime metadata monitor now owns fixed poll cadence in code instead of exposing user settings: focused tasks poll every 5 seconds only while the project document is visible and a focused task exists, background tasks poll every 20 seconds, home metadata polls every 30 seconds, and hidden tabs back off to 60 seconds. Remote fetch cadence moved to 120 seconds. The browser reports document visibility through `project.setDocumentVisible`, and focus cleanup clears the focused task on project teardown. Runtime project-state broadcasts now schedule metadata refresh in the background so snapshots and WebSocket broadcasts are not blocked on git freshness.

Metadata probes now run through a two-tier limiter: per-project concurrency protects one project from stampeding its own repository, while a global limit caps total git process count across projects. Remote fetches use the same limiter path. `runGit` and `runGitSync` now apply explicit timeout classes, with short metadata/sync defaults, longer remote fetch and inspection windows, a checkpoint-specific timeout, and a long user-action timeout for operations such as branch changes, stash apply/pop, worktree creation, rebase/merge, reset, and commit. Direct git file search moved onto `runGit`, preserving porcelain output with `trimStdout: false`, and start-time turn checkpoint capture is now fire-and-forget with a stale-session guard so slow checkpoint git work cannot hold task-session startup open.

The settings UI and config schemas no longer include git polling interval fields; old persisted values are ignored and will fall out on the next settings save. Focused tests cover timeout propagation, worktree user-action timeouts, fixed/visibility-aware polling cadence, per-project metadata isolation, remote fetch cadence, and non-blocking checkpoint capture.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `src/cli.ts`, `src/config/global-config-fields.ts`, `src/core/api/config.ts`, `src/core/service-interfaces.ts`, `src/server/project-metadata-controller.ts`, `src/server/project-metadata-loaders.ts`, `src/server/project-metadata-monitor.ts`, `src/server/project-metadata-poller.ts`, `src/server/project-metadata-refresher.ts`, `src/server/project-metadata-remote-fetch.ts`, `src/server/runtime-state-hub.ts`, `src/trpc/handlers/save-config.ts`, `src/trpc/handlers/start-task-session.ts`, `src/trpc/project-api-changes.ts`, `src/trpc/project-api-state.ts`, `src/trpc/project-procedures.ts`, `src/workdir/get-workdir-changes.ts`, `src/workdir/git-cherry-pick.ts`, `src/workdir/git-conflict.ts`, `src/workdir/git-history.ts`, `src/workdir/git-stash.ts`, `src/workdir/git-sync.ts`, `src/workdir/git-utils.ts`, `src/workdir/initialize-repo.ts`, `src/workdir/search-workdir-files.ts`, `src/workdir/search-workdir-text.ts`, `src/workdir/task-worktree-lifecycle.ts`, `src/workdir/task-worktree-patch.ts`, `src/workdir/task-worktree-symlinks.ts`, `src/workdir/turn-checkpoints.ts`, `web-ui/src/components/settings/general-sections.tsx`, `web-ui/src/hooks/app/use-app-side-effects.ts`, `web-ui/src/hooks/notifications/use-focused-task-notification.ts`, `web-ui/src/hooks/notifications/use-project-metadata-visibility.ts`, `web-ui/src/hooks/settings/settings-form.ts`, `web-ui/src/test-utils/runtime-config-factory.ts`, and focused runtime/tRPC/web-ui test fixtures.

Commit: pending

## Fix: stop PTY output from driving session-summary churn (2026-04-28)

Dogfooding and follow-up code tracing showed that every non-empty task and shell PTY output chunk updated `lastOutputAt` through the normal session-summary store. That write stamped a new `updatedAt`, emitted to terminal state listeners, entered the runtime-state message batcher, refreshed cross-project notification memory, and requested project-summary broadcasts. Claude/Codex idle redraws and status-line traffic could therefore wake the whole runtime/browser fanout path even though terminal rendering already receives raw PTY output through a separate low-latency stream.

The fix removes PTY-output-driven `lastOutputAt` writes from `src/terminal/session-output-pipeline.ts`, while leaving terminal mirror updates, workspace-trust detection, deferred Codex input, output-transition detection, and listener output broadcasts intact. The temporary output perf probe now measures raw/filter/mirror/output-listener activity only, because there is no summary update in the PTY output hot path anymore.

The hook CLI no longer writes `[hooks:cli] parsed ...` to stderr for every successful hook ingest. Retry, retry-failure, parse-failure, and metadata-enrichment diagnostics still use stderr because those paths may fail before the runtime-side hook logger can record the event, but normal successful hooks now stay out of the agent PTY output stream.

The previous stalled-session watchdog was removed as the only production consumer of fresh `lastOutputAt`. `src/terminal/session-reconciliation.ts` no longer exports or runs `checkStalledSession`, the sweep no longer applies a `mark_stalled` action, and the state machine no longer accepts `reconciliation.stalled`. The runtime still accepts legacy `reviewReason: "stalled"` summaries and can return them to running via hooks, so older local state stays readable; new sessions simply stop producing that review reason. `docs/todo.md` now tracks a replacement stalled/unresponsive detector that must use a cheap internal signal or low-frequency health check rather than output-driven summary fanout.

Focused coverage was updated to assert that terminal output reaches output listeners without changing `lastOutputAt` or emitting session-state summaries, and reconciliation/state-machine tests were reduced to the remaining live checks plus legacy stalled compatibility.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `docs/todo.md`, `src/commands/hooks.ts`, `src/server/runtime-state-message-batcher.ts`, `src/server/shutdown-coordinator.ts`, `src/terminal/index.ts`, `src/terminal/session-auto-restart.ts`, `src/terminal/session-lifecycle.ts`, `src/terminal/session-output-pipeline.ts`, `src/terminal/session-reconciliation.ts`, `src/terminal/session-reconciliation-sweep.ts`, `src/terminal/session-state-machine.ts`, `src/terminal/session-summary-store.ts`, `test/runtime/terminal/session-manager-reconciliation.test.ts`, `test/runtime/terminal/session-reconciliation.test.ts`, `test/runtime/terminal/session-state-machine.test.ts`.

Commit: 4ab91214b

## Fix: reconcile stale project notification indicators (2026-04-28)

Dogfooding found that project-level needs-input indicators could outlive the board and session truth they were supposed to summarize. The browser notification memory was intentionally monotonic for live deltas, which is useful for avoiding duplicate audible transitions, but that meant a task notification from a deleted or orphaned card could remain in the project bucket after a later project snapshot proved the task no longer existed on the board. The previous orphan-session pruning fixed payload bloat, but notification projection still needed a separate board-only view because live orphan summaries can remain useful for terminal restore paths while still being wrong for project badges.

The runtime now has `pruneOrphanSessionsForNotification(...)`, a board-linked filter specifically for badge/sound projection. Cross-project notification snapshots use it instead of the broader broadcast filter, and live `task_notification` batches read the board before broadcasting. If a live batch contains summaries whose task IDs are no longer on the board, the stream omits those summaries and includes `removedTaskIds` tombstones so already-open browsers can clear stale entries without waiting for a reconnect. If the board read fails, the runtime keeps live notifications flowing and relies on the next authoritative snapshot or project-state update to repair stale memory.

The browser notification store now separates live deltas from authoritative replacement. `task_notification` still merges newer summaries into a project bucket, but it also applies tombstone removals. Runtime snapshots and active-project state updates replace the affected project buckets using board-linked sessions from the authoritative project state, so stale entries are cleared when the server re-sends truth. While finishing the branch, the reducer was tightened to replace notification memory from the already reconciled project state, not the raw incoming payload, so an older replayed snapshot or project-state event cannot downgrade a newer local session summary.

Focused coverage now exercises notification bucket replacement from snapshots, active-project project-state replacement, live tombstone removals, preservation of reconciled newer summaries, stream dispatch of `removedTaskIds`, and the integration stream path that seeds another project's notification baseline only when the task exists on that project's board.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `docs/todo.md`, `src/core/api/streams.ts`, `src/core/index.ts`, `src/core/task-board-mutations.ts`, `src/server/runtime-state-hub.ts`, `src/server/runtime-state-messages.ts`, `test/integration/state-streaming.integration.test.ts`, `web-ui/src/runtime/runtime-notification-projects.ts`, `web-ui/src/runtime/runtime-state-stream-store.ts`, `web-ui/src/runtime/runtime-state-stream-store.test.ts`, `web-ui/src/runtime/runtime-stream-dispatch.ts`, `web-ui/src/runtime/runtime-stream-dispatch.test.ts`.

Commit: pending

## Fix: expose degraded terminal DOM diagnostics (2026-04-28)

Dogfooding a degraded Quarterdeck browser session showed roughly 22 `textarea.xterm-helper-textarea` nodes even though no shell terminals were open. The existing debug-panel button was not reliable in that state because the panel path itself could be slow or blocked, and unnamed xterm helper textareas made it hard to tell which DOM nodes belonged to live Quarterdeck terminal slots versus orphaned hosts.

The browser terminal layer now has a direct DevTools diagnostic path: `window.__quarterdeckDumpTerminalState()` returns and logs registered pool/dedicated terminal slots, buffer summaries, helper textarea counts, missing `id`/`name` counts, xterm DOM counts, parking-root children, and parent paths for every helper textarea. Xterm's generated helper textarea is also assigned a stable `quarterdeck-terminal-input-<slotId>` `id`/`name` when a slot opens, so pre-existing orphaned helpers remain obvious. The terminal pool now disposes all pool and dedicated terminal instances on Vite hot-module disposal, which prevents dev reloads from accumulating old xterm DOM hosts.

To catch the failure mode while it is forming, the pool starts a minute-based DOM health monitor after initialization. It expects the steady-state terminal count to be low: four pooled task terminals plus a small number of dedicated home/detail shell terminals. If registered terminals, helper textareas, or xterm nodes exceed eight, it emits a raw browser-console warning first, then schedules a best-effort Quarterdeck client-log warning. The raw console path uses the new `warnToBrowserConsole(...)` escape hatch, documented as critical degraded-UI/debug-only logging rather than a general app logger.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `web-ui/src/terminal/slot-renderer.ts`, `web-ui/src/terminal/terminal-dom-diagnostics.ts`, `web-ui/src/terminal/terminal-dom-diagnostics.test.ts`, `web-ui/src/terminal/terminal-helper-textarea.ts`, `web-ui/src/terminal/terminal-helper-textarea.test.ts`, `web-ui/src/terminal/terminal-pool.ts`, `web-ui/src/terminal/terminal-pool-lifecycle.test.ts`, `web-ui/src/hooks/terminal/use-terminal-panels.ts`, `web-ui/src/terminal/use-persistent-terminal-session.ts`, `web-ui/src/utils/global-error-capture.ts`.

Commit: pending

## Chore: add perf-investigation instrumentation (2026-04-28)

Dogfooding found an idle terminal scrollbar/CPU slowdown that could come from several different layers: child PTY output, terminal mirror writes, runtime session-summary fanout, cross-project notification seeding, hook ingest, browser terminal reconnects, xterm write queues, or restore/snapshot churn. The first instrumentation pass covered only a few browser-side symptoms and PTY input writes, which was not enough to rule out the likely output and fanout hot paths.

The branch now adds temporary `[perf-investigation]` aggregate probes across the suspected path. Runtime terminal output records raw and filtered chunk/byte windows plus `TerminalStateMirror.applyOutput(...)` and session-summary update timing. `RuntimeStateMessageBatcher` reports onChange, queued message, flush, delivery, task-notification, and project-refresh rates. `RuntimeStateHubImpl.collectNotificationSummariesByProject()` records per-call duration, managed-project counts, before/after prune counts, board-read failures, and calls in the last minute with throttled warnings for suspicious connection-time notification snapshots. Existing browser terminal probes were kept low-noise by sampling reconnect stack traces and reporting write-queue, restore, and reconnect rates through direct console output.

All investigation probes are intentionally marked with `[perf-investigation]` comments. Where practical, they bypass Quarterdeck's tagged logger and write directly to `console.*` so the diagnostics do not feed back into the runtime debug-log WebSocket stream while performance is degraded. Remove these marked blocks once the slowdown investigation is complete.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `src/server/runtime-state-hub.ts`, `src/server/runtime-state-message-batcher.ts`, `src/terminal/pty-session.ts`, `src/terminal/session-output-pipeline.ts`, `src/trpc/hooks-api.ts`, `web-ui/src/terminal/slot-write-queue.ts`, `web-ui/src/terminal/terminal-attachment-controller.ts`, `web-ui/src/terminal/terminal-session-handle.ts`, `web-ui/src/terminal/terminal-viewport.ts`.

Commit: pending

## Fix: prune orphan session summaries from project state (2026-04-28)

Dogfooding the Codex slowdown investigation found that project state could carry hundreds of session summaries even when the visible board had only a small number of active cards. The terminal-manager store hydrates persisted `sessions.json`, project snapshots merge every live store summary back into the response, browser saves previously wrote every authoritative summary, and cross-project notification snapshots enumerated every managed-project summary. Old deleted-card summaries therefore inflated stream payloads, save payloads, notification baselines, and browser reconciliation work long after the corresponding cards were gone.

The fix adds shared board-linked pruning helpers in `src/core/task-board-mutations.ts`. Broadcast snapshots keep board-linked summaries plus live summaries so active processes and open shell terminals stay visible during the current runtime, while persistence uses a stricter board-only filter so deleted task summaries and ephemeral shell entries do not survive restart. `ProjectRegistry.buildProjectStateSnapshot(...)` and the runtime stream notification baseline use the broadcast filter; `project.saveState` and shutdown's sessions-only writer use the persistence filter. The shutdown path is important because it bypasses the browser save API while marking active sessions interrupted, so it now applies the same strict filter before calling `saveProjectSessions(...)`.

The follow-up startup hardening adds `pruneProjectSessionsForBoard(...)` in the state layer and runs it during CLI startup cleanup after project index discovery but before `createProjectRegistry(...)` hydrates terminal managers. The helper loads the persisted board as the durable task registry, filters `sessions.json` down to board-linked task IDs, writes only `sessions.json`, leaves `board.json` and `meta.json` untouched, and preserves any pending invalid-session repair warning by using the sessions-only writer without clearing warning memory. When it drops entries it first writes a `sessions.json.pruned-*` backup and logs the before/after counts, so recovery remains possible if an operator needs to inspect the old file.

Focused unit and integration coverage verifies both filters, confirms active home/detail shell summaries are not persisted during shutdown, confirms the state-layer prune preserves board revision and board contents, and starts the CLI against a pre-bloated state home to prove startup rewrites `sessions.json` before terminal-manager hydration.

Files touched: `CHANGELOG.md`, `docs/codex-session-slowdown-investigation.md`, `docs/implementation-log.md`, `src/cli.ts`, `src/core/index.ts`, `src/core/task-board-mutations.ts`, `src/server/project-registry.ts`, `src/server/runtime-state-hub.ts`, `src/server/shutdown-coordinator.ts`, `src/state/index.ts`, `src/state/project-state.ts`, `src/trpc/project-api-state.ts`, `test/integration/project-state.integration.test.ts`, `test/integration/startup-session-prune.integration.test.ts`, `test/integration/state-streaming.integration.test.ts`, `test/integration/shutdown-coordinator.integration.test.ts`, `test/runtime/task-board-mutations.test.ts`.

Commit: pending

## Fix: explain why title regeneration failed (2026-04-28)

The "Could not regenerate title" toast was the only visible signal when title regeneration failed, and every layer in the chain swallowed its real reason. The browser `handleRegenerateTitleTask` did `.catch(() => showAppToast(...))` with no logging and did not even react to the `{ ok: false }` success path. On the runtime side, `generateTaskTitle` only logged a generic "returned null", and `callLlm` returned null without any log at all when `ANTHROPIC_BEDROCK_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` were missing — the most common cause in dev.

The fix keeps the same control flow but makes every failure mode self-describing.

- `web-ui/src/hooks/board/use-title-actions.ts` now logs `console.error` with error name/message/stack when the mutation throws, and logs `console.warn` (and still toasts) when the server returns `ok: false`, pointing at the runtime `title-gen` / `llm-client` tags. It also warns on the missing-project no-op and adds matching diagnostics to `handleUpdateTaskTitle`.
- `src/title/title-generator.ts` now short-circuits with a descriptive warning when `isLlmConfigured()` is false and when the prompt is empty after trim, and the post-call null warning now says explicitly that the cause is in the preceding `llm-client` log.
- `src/title/llm-client.ts` now emits distinct warnings per failure: rate limiter hits include `inFlight`, calls-in-window, and configured limits; HTTP non-2xx responses capture status, statusText, a 500-char response body snippet, and the model; empty content logs whether any choices came back; sanitizer rejection includes the model; and the timeout branch is split from the generic network/parse branch with `timeoutMs` recorded.

No behavioral change: failure still returns null/`ok: false` and still shows the same toast. Only logging output changed.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `src/title/llm-client.ts`, `src/title/title-generator.ts`, `web-ui/src/hooks/board/use-title-actions.ts`.

Commit: pending

## Fix: fall back after missing Codex resume ids (2026-04-28)

Dogfooding showed that a failed targeted Codex resume could trap a task in a repeated failure: `codex resume <stored-id>` exited with "No saved session found", Quarterdeck preserved the failed review summary, but the bad `resumeSessionId` stayed on the summary. A later manual restart or terminal reconnect could reuse the same missing id, so the user saw the same failed-resume terminal state instead of a best-effort continuation.

The terminal layer now treats a non-zero targeted Codex resume as evidence that the stored id is no longer usable. It keeps the failed output and review/error state, but clears `resumeSessionId`, stores a warning that the next restart will fall back to the most recent Codex session, and writes that warning into the terminal mirror for restore. `recoverStaleSession` also recognizes Codex resume-failure summaries and does not auto-restart them on WebSocket reconnect, so reconnects cannot silently loop the same failed resume. The tRPC start handler recognizes older persisted summaries with the previous generic "Resume failed before opening an interactive session" warning and suppresses the stale id before launching, which lets already-stuck tasks recover via the same `codex resume --last` fallback path. Focused tests cover the id clearing, reconnect non-retry, and legacy failed-summary fallback.

Files touched: `AGENTS.md`, `CHANGELOG.md`, `docs/implementation-log.md`, `src/terminal/codex-resume-failure.ts`, `src/terminal/session-lifecycle.ts`, `src/trpc/handlers/start-task-session.ts`, `test/runtime/terminal/session-manager-auto-restart.test.ts`, `test/runtime/trpc/runtime-api.test.ts`.

Commit: pending

## Fix: keep shutdown cleanup from overwriting board state (2026-04-27)

Dogfooding showed that stopping and restarting the Quarterdeck server could make many in-progress and review cards disappear or move unexpectedly across projects. Startup backups confirmed the server still had large session sets, but some affected project boards were already stale or empty on disk. The root cause was shutdown cleanup violating the board single-writer contract: it loaded project state and called the full `saveProjectState(...)` writer just to persist interrupted runtime sessions. That rewrote `board.json` from whatever snapshot shutdown had read and bumped the board revision, so a stale server-side board snapshot could overwrite the browser-owned durable board layout during shutdown.

The fix adds `saveProjectSessions(...)`, a narrow state writer that validates and atomically writes only `sessions.json` under the existing project directory lock. Shutdown cleanup now uses that sessions-only writer after marking resumable sessions interrupted, leaving `board.json` and `meta.json` untouched. This preserves card placement and avoids revision churn while still giving startup resume the interrupted session records it needs. Integration coverage now asserts that shutdown preserves board revision for both managed and indexed projects, and project-state coverage asserts that sessions-only persistence changes runtime session truth without rewriting board state.

The history check found the shutdown-overwrite risk came from `5bc6c1c1d` (2026-04-13), which changed graceful shutdown to preserve cards but kept a full board/session save. It became a clear architecture violation after `5dfdcc84c` (2026-04-20), when the browser became the durable board owner and the server became the runtime-session owner.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `src/server/shutdown-coordinator.ts`, `src/state/index.ts`, `src/state/project-state.ts`, `test/integration/project-state.integration.test.ts`, `test/integration/shutdown-coordinator.integration.test.ts`, `test/runtime/shutdown-coordinator-timeout.test.ts`.

Commit: pending

## Fix: add terminal restore watchdog logging (2026-04-27)

Dogfooding an untrashed Codex task showed the agent terminal could remain behind the loading spinner long enough that switching projects away and back was needed to recover the view. Local `main` already contained the behavioral recovery pieces for the known restore races: queued restore requests during initial connect, IO-open fallback after 1.5 seconds, pooled-slot reconnect on session-instance changes, and guards against empty restore snapshots blanking live output. Reapplying the older worktree's behavioral patch on top of `main` would have risked duplicating or perturbing that flow.

The main-based fix therefore adds observability instead of changing restore semantics. `SlotSocketManager` now tracks restore cycles started by initial connect, restore payloads, and explicit restore requests; clears that tracking on successful restore, reset, and shutdown; and emits warning-level diagnostics if restore remains pending for 10 seconds, if IO/control sockets close mid-restore, or if snapshot application throws. The focused test cleanup now resets the manager after exercising queued restore requests so the watchdog timer cannot leak across tests.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `web-ui/src/terminal/slot-socket-manager.ts`, `web-ui/src/terminal/slot-socket-manager.test.ts`.

Commit: pending

## Fix: seed cross-project notification state on stream connect (2026-04-27)

Notification ownership is intentionally project-bucketed in the browser, but a fresh runtime WebSocket connection only hydrated full session state for the selected project. Other projects entered notification memory only after a live `task_notification` delta arrived. That meant a reload/reconnect could miss already-running or already-waiting tasks in other managed projects, breaking cross-project needs-input badges and audible-notification transition baselines until the next task event.

The runtime stream snapshot now carries `notificationSummariesByProject`, a connection-time baseline collected from every managed project's terminal summary store. The browser reducer seeds its project-owned notification buckets from that baseline, then continues to process `task_notification` messages as the live delta channel. This keeps the correctness model simple: `snapshot` establishes initial state, `task_notification` advances it. The stream client remains registered globally before snapshot loading, so live deltas that happen during snapshot construction are still received.

The investigation also confirmed that current-project mute wiring was already sound: `audibleNotificationsOnlyWhenHidden` is the global gate, and the per-project review/permission/failure suppression applies after that. Added focused Codex coverage to lock in the shared indicator semantics: `PermissionRequest` remains a permission event even when `notificationType` is null, while Codex `Stop` remains a review event and is suppressed by current-project review mute.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `src/core/api/streams.ts`, `src/server/runtime-state-hub.ts`, `src/server/runtime-state-messages.ts`, `test/integration/state-streaming.integration.test.ts`, `web-ui/src/hooks/notifications/audible-notifications-suppress.test.tsx`, `web-ui/src/runtime/runtime-notification-projects.ts`, `web-ui/src/runtime/runtime-state-stream-store.test.ts`, `web-ui/src/runtime/runtime-state-stream-store.ts`.

Commit: pending

## Fix: suppress closed-PTY async write noise (2026-04-27)

Dogfooding showed `Unhandled pty write error [Error: EIO: i/o error, write]` immediately after startup backup logging. The backup itself was incidental; the exact error line comes from node-pty's Unix `CustomWriteStream`, which accepts input synchronously through `IPty.write()` and performs the real `fs.write(...)` later. If the child PTY exits or is killed in that async window, macOS/Linux can report `EIO` or `EBADF`. Quarterdeck's existing `PtySession.write()` try/catch already ignored synchronous closed-PTY write errors, but it could not intercept node-pty's later internal `console.error(...)`.

`PtySession.spawn(...)` now installs a narrow node-pty write-queue guard when the Unix private write-stream shape is present. The guard keeps the upstream `EAGAIN` retry behavior, clears the queue on terminal write failure like node-pty already did, suppresses only expected closed-PTY `EIO` / `EBADF` shutdown races, and continues logging any other write error. Focused tests mock the async `fs.write` callback to verify both the suppressed closed-PTY path and the still-visible unexpected-error path.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `src/terminal/pty-session.ts`, `test/runtime/terminal/pty-session.test.ts`.

Commit: pending

## Fix: preserve non-zero startup resume failures (2026-04-27)

Dogfooding showed a review-ready Codex task could come back after server startup with a blank terminal. The runtime log had the important clue: `codex resume <stored-id>` exited with code 1, then the generic resume-failure fallback opened a fresh non-resume Codex prompt. That second prompt had no task prompt or conversation context, cleared the stored `resumeSessionId`, and replaced the useful failed-resume terminal output with an empty live session.

The terminal exit path now treats clean and failed resume exits differently. Clean startup-resume exits still use the fresh-prompt fallback because some `codex resume` / Claude `--continue` launches can exit 0 without leaving an interactive session. Non-zero resume exits are preserved instead: the session stays in review with `reviewReason: "error"`, a `warningMessage` is stored for the UI toast, and a `[quarterdeck]` line is written into the terminal mirror so later restores are not blank even if the agent's own error output was sparse. Added regression coverage for both the failed-resume preservation path and the clean-exit fallback.

Files touched: `AGENTS.md`, `CHANGELOG.md`, `docs/implementation-log.md`, `src/terminal/session-lifecycle.ts`, `test/runtime/terminal/session-manager-auto-restart.test.ts`.

Commit: pending

## Fix: keep Codex slash-command maintenance from faking resumed work (2026-04-27)

Dogfooding native Codex hooks showed a review-ready task could jump back to `running` after `/compact` and then stay there. The failure mode was a combination of state signals that are too broad for native hooks: Codex `SessionStart` can fire during session maintenance and the old Codex prompt-redraw fallback treated a repainted `›` prompt after Enter as proof the agent was working. Once the card was back in `running`, the reconciliation sweep often failed to recover it because Codex's TUI redraw traffic kept `lastOutputAt` fresh.

The fix makes Codex state transitions hook-driven. `SessionStart` now maps to `activity` so Quarterdeck can still persist `session_id` metadata without moving cards between columns, and `PostToolUse` now uses a single `to_in_progress` hook because that ingest path already stores tool metadata. The Codex adapter no longer installs a prompt-output transition detector, and the old Codex prompt-ready flag was removed from the terminal session state, so slash-command prompt redraws cannot move review cards back to running. The stalled-session watchdog keeps its existing activity clock (`max(lastHookAt, lastOutputAt)`) so long legitimate Codex thinking or tool runs are not prematurely moved to review just because hooks are sparse.

The parity docs now call out the native-hook slash-command limitation beside the existing subagent `Stop` limitation. The task-state guide documents `SessionStart` as metadata-only and explains that `/compact`, `/resume`, plugin reloads, and other TUI-local commands cannot show precise lifecycle state until Codex exposes dedicated hooks. Added runtime coverage for the new `SessionStart`/`PostToolUse` hook mapping and prompt-redraw non-transitions.

Files touched: `AGENTS.md`, `CHANGELOG.md`, `docs/implementation-log.md`, `docs/task-state-system-stale.md`, `docs/todo.md`, `src/codex-hooks.ts`, `src/terminal/agent-session-adapters.ts`, `src/terminal/session-input-pipeline.ts`, `src/terminal/session-manager-types.ts`, `src/terminal/session-output-pipeline.ts`, `src/terminal/session-transition-controller.ts`, `src/trpc/hooks-api.ts`, `test/runtime/codex-hooks.test.ts`, `test/runtime/terminal/agent-session-adapters.test.ts`, `test/runtime/terminal/session-manager-ordering.test.ts`, `test/runtime/terminal/session-transition-controller.test.ts`.

Commit: pending

## Fix: keep interrupted auto-restart skips at debug level (2026-04-27)

Dogfooding surfaced a warning-level log for an expected interrupted task exit:

```
[session-mgr] auto-restart skipped on exit {
  reason: "no_listeners",
  preExitState: "interrupted",
  exitState: "interrupted"
}
```

The underlying restart policy was already right: auto-restart only recovers unexpected crashes from the `running` state, and `interrupted` exits are normal stop/trash cleanup. The bug was the skip-reason order in `shouldAutoRestart(...)`: it checked listener count before the pre-exit state, so an expected interrupted exit with no browser listener was classified as `no_listeners`. `session-lifecycle.ts` intentionally logs `no_listeners` at warn because a truly running task that crashes while detached is skipped crash recovery, but that severity is wrong for non-running lifecycle cleanup.

The fix checks `preExitState !== "running"` before the listener/restart-request guard. Expected review/interrupted cleanup now reports `not_running` and keeps the existing debug-level skip log, while actual running exits with no task listener still report `no_listeners` and remain warning-level. A focused unit test covers both paths so the severity contract stays tied to the restart decision rather than the log call site.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `src/terminal/session-auto-restart.ts`, `test/runtime/terminal/session-auto-restart.test.ts`

Commit: pending

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

## Fix: harden Codex native hook dogfooding (2026-04-27)

Follow-up review found that the native Codex hook branch was accepting much older Codex builds than the current hook surface really needs, and that hook debugging still lacked enough correlation data for early dogfooding. Codex's `codex_hooks` feature became stable in the 0.124.x line, so the runtime availability gate now requires `0.124.0` or newer and treats a present-but-disabled feature row as unsupported. The availability probe also emits tagged debug logs for version probe results, feature probe results, and rejection reasons so Settings/onboarding mismatches can be diagnosed from the debug log rather than inferred from UI state.

Hook diagnostics were expanded across the launch, CLI, server, broadcast, and checkpoint path. Codex launch now logs the generated hook event count and resume context. The hook CLI stderr line includes project/task/session/source fields and logs retry/enrichment failures. The server hook API now logs structured project/task/session/source metadata on ingest, no-op transitions, guard blocks, missing project/task rejections, transition failures, successful transitions, broadcast-effect failures, and background checkpoint capture/delete failures. This keeps the existing 3-second hook response behavior while making state-transition investigations more traceable when debug/info logging is enabled.

The known Codex subagent parity gap is explicitly documented instead of silently claimed as parity. Quarterdeck still maps Codex `Stop` to review so main-agent completion works, but current Codex hook payloads do not reliably distinguish root-agent and subagent `Stop` events. The limitation is now called out in code comments, `docs/task-state-system-stale.md`, and the active todo list so it can be revisited once Codex exposes a discriminator. The stale `docs/codex-native-hooks-review.md` branch-review handoff was removed because it described older iterations that no longer match the implementation.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `docs/task-state-system-stale.md`, `docs/todo.md`, deleted `docs/codex-native-hooks-review.md`, `src/codex-hooks.ts`, `src/commands/hooks.ts`, `src/config/agent-registry.ts`, `src/terminal/agent-session-adapters.ts`, `src/trpc/hooks-api.ts`, `test/runtime/config/agent-registry.test.ts`, `test/runtime/config/agent-selection.test.ts`, `test/runtime/config/runtime-config-helpers.ts`

Commit: `f117d0e41`

## Fix: stabilize Codex untrash and startup resume (2026-04-27)

The Codex trash/untrash bug was a stack of session-lifecycle and terminal-restore races. The durable fixes now cover both runtime ownership and browser terminal attachment: task exit callbacks are tied to the concrete spawned `PtySession` so late exits from old Codex wrappers cannot clear a replacement session; explicit stop/trash paths suppress the resume-failure fallback so a stopped resume process cannot spawn a fresh non-resume Codex instance and wipe the stored `resumeSessionId`; startup resume keeps the clean-exit fallback for non-stopped resumed agents; shutdown persistence preserves already-interrupted in-memory summaries; and startup selection now resumes stale live `awaiting_review` / `attention` summaries with a persisted pid while preserving completed `hook` / `exit` review sessions.

The browser-side terminal fixes address the spinner/blank-output half of the bug. Pooled task terminals queue restore requests until initial restore completes, reconnect IO/control sockets when a live task session instance changes, avoid that reconnect for processless stop summaries, reveal the terminal when IO is open but restore readiness stalls, and skip delayed empty restore snapshots over non-empty visible buffers after draining queued writes. This keeps untrash from getting stuck behind a loading overlay or briefly rendering Codex output before an empty restore blanks it.

Diagnostics were also normalized. Routine breadcrumbs stay debug-level, startup scan/launch breadcrumbs are info-level, and user-visible degradation paths such as missing Codex resume ids, `--last` fallback, still-exiting starts, stale replaced-process exits, startup resume misses, and stop timeouts are warn-level. Temporary raw Codex subprocess `process.stderr.write(...)` traces were removed from wrapper/parser code so debug output does not pollute the visible agent terminal stream. The detailed review/handoff timeline moved to `docs/codex-untrash-resume-handoff.md` so this implementation-log entry can stay concise.

Files touched: `AGENTS.md`, `CHANGELOG.md`, `docs/codex-untrash-resume-handoff.md`, `docs/implementation-log.md`, `src/commands/codex-rollout-parser.ts`, `src/commands/codex-session-parser.ts`, `src/commands/codex-wrapper.ts`, `src/server/project-registry.ts`, `src/server/shutdown-coordinator.ts`, `src/terminal/agent-session-adapters.ts`, `src/terminal/session-lifecycle.ts`, `src/terminal/session-manager.ts`, `src/terminal/session-summary-store.ts`, `src/trpc/handlers/start-task-session.ts`, `src/trpc/handlers/stop-task-session.ts`, `src/trpc/hooks-api.ts`, `test/integration/shutdown-coordinator.integration.test.ts`, `test/runtime/server/project-registry-startup-resume.test.ts`, `test/runtime/terminal/session-manager-auto-restart.test.ts`, `test/runtime/terminal/session-manager-ordering.test.ts`, `test/runtime/trpc/runtime-api.test.ts`, `web-ui/src/hooks/board/use-task-lifecycle.ts`, `web-ui/src/hooks/board/use-task-sessions.ts`, `web-ui/src/terminal/slot-socket-manager.test.ts`, `web-ui/src/terminal/slot-socket-manager.ts`, `web-ui/src/terminal/terminal-attachment-controller.test.ts`, `web-ui/src/terminal/terminal-attachment-controller.ts`, `web-ui/src/terminal/terminal-restore-policy.test.ts`, `web-ui/src/terminal/terminal-restore-policy.ts`, `web-ui/src/terminal/terminal-reuse-manager.ts`, `web-ui/src/terminal/terminal-session-handle.test.ts`, `web-ui/src/terminal/terminal-session-handle.ts`, `web-ui/src/terminal/terminal-viewport.ts`, `web-ui/src/terminal/use-persistent-terminal-session.test.tsx`, `web-ui/src/terminal/use-persistent-terminal-session.ts`

Commit: `2422d0059`, `ef16a74c0`

## Fix: log full toast warning/error messages to the debug log (2026-04-25)

Toast-delivered warnings and errors were the only surface for certain failures — for example, the server's `Invalid sessions.json file at … Fix or remove the file. Validation errors: …` message that flows from `parsePersistedStateFile` through the WebSocket error channel and lands in `useStreamErrorHandler` → `notifyError`. `sanitizeErrorForToast` collapses the message to its first non-empty line capped at 150 characters, so the actual Zod validation issues were truncated away and there was no debug-log trace, making the failure hard to diagnose after the toast disappeared.

The fix centralizes the logging inside `showAppToast`: when `intent` is `danger` or `warning` it now emits the full, untruncated `props.message` via `createClientLogger("toast")` before dispatching to sonner. This covers ~80 call sites (all `showAppToast` danger/warning invocations, `notifyError`, and the `showGitErrorToast` / `showGitWarningToast` wrappers that already route through `showAppToast`) with one edit, so future toasts automatically log without per-site boilerplate. `notifyError`'s now-redundant `log.error` call was removed to avoid duplicate entries.

Two direct `toast.*` calls that bypassed `showAppToast` were cleaned up in the same pass: `conflict-resolution-panel.tsx` now uses `showAppToast({ intent: "success", … })` for its copy-path toast; the info-style "Task worktree removed" toast in `use-linked-backlog-task-actions.ts` uses custom sonner options (cancel action with `className: "toast-with-dismiss-link"`) that `showAppToast` doesn't expose, and it's info-only rather than warning/error, so it was left alone.

Server-side, `src/server/runtime-state-hub.ts` also sends raw error strings to browser clients via `buildErrorMessage`, including the sessions.json case. Added a `createTaggedLogger("runtime-state-hub")` and wired it into the three `buildErrorMessage` call sites (removed-project notice, snapshot-load failure, connection-resolution failure) plus the `disposeProject(..., { closeClientErrorMessage })` path so the full message is also recoverable from runtime logs on the server side, not only via the client-side mirror.

Verified clean with `npm run typecheck`, `npm run web:typecheck`, `npm run lint`, `npm run test:fast` (748/748 runtime), and `npm run web:test` (884/884 web).

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `src/server/runtime-state-hub.ts`, `web-ui/src/components/app-toaster.ts`, `web-ui/src/components/git/panels/conflict-resolution-panel.tsx`

Commit: pending

## Fix: scope Codex hooks to Quarterdeck-launched sessions only (2026-04-24)

Quarterdeck's previous Codex hook follow-up solved the repo-dirtying problem by moving hook generation out of the task checkout, but it still relied on writing `~/.codex/hooks.json`. That meant Codex app/GUI sessions outside Quarterdeck loaded the same Quarterdeck hook commands and started reporting hook failures whenever they were launched without Quarterdeck's hook environment. The fix is to stop installing Quarterdeck-managed Codex hooks into Codex's discovered config layers at all and make them launch-scoped instead.

The runtime side now treats `src/codex-hooks.ts` as an inline hook-config builder rather than a hook-file installer. It builds the same native `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, and `Stop` mappings, but serializes them into inline TOML-compatible `-c hooks.<Event>=...` overrides. `src/terminal/agent-session-adapters.ts` appends those overrides only when Quarterdeck launches Codex and still forces `--enable codex_hooks`, so the hook surface is present only for Quarterdeck-owned Codex sessions. With that change in place, the old install/overwrite setup path became dead weight, so the runtime config contract, tRPC mutation, startup onboarding plumbing, and settings dialog/setup button flow were all removed. The Codex availability path in `src/config/agent-registry.ts` is back to simple version-plus-feature gating, while the UI once again follows the existing agent-selection standards instead of a special Codex setup dialog path. Updated `AGENTS.md` and the task-state docs to record the new invariant: never write Quarterdeck-managed hooks into repo-local or user-global Codex hook files because standalone Codex surfaces will load them too.

Files touched: `AGENTS.md`, `CHANGELOG.md`, `docs/implementation-log.md`, `docs/task-state-system.md`, `docs/todo.md`, `src/codex-hooks.ts`, `src/config/agent-registry.ts`, `src/core/api-validation.ts`, `src/core/api/config.ts`, `src/terminal/agent-session-adapters.ts`, `src/trpc/app-router-context.ts`, `src/trpc/app-router.ts`, `src/trpc/runtime-api.ts`, deleted `src/trpc/handlers/install-codex-hooks.ts`, `test/runtime/config/agent-registry.test.ts`, `test/runtime/config/agent-selection.test.ts`, `test/runtime/terminal/agent-session-adapters.test.ts`, `web-ui/src/components/app/project-dialogs.tsx`, `web-ui/src/components/app/startup-onboarding-dialog.tsx`, `web-ui/src/components/settings/agent-section.tsx`, `web-ui/src/components/settings/runtime-settings-dialog.test.tsx`, `web-ui/src/components/settings/runtime-settings-dialog.tsx`, `web-ui/src/components/task/task-start-agent-onboarding-carousel.tsx`, `web-ui/src/hooks/project/use-startup-onboarding.test.tsx`, `web-ui/src/hooks/project/use-startup-onboarding.ts`, `web-ui/src/providers/project-runtime-provider.test.tsx`, `web-ui/src/providers/project-runtime-provider.tsx`, `web-ui/src/runtime/native-agent.test.ts`, `web-ui/src/runtime/runtime-config-query.ts`, `web-ui/src/test-utils/runtime-config-factory.ts`

Commit: `pending`

## Chore: bump postcss to 8.5.10 in both packages (2026-04-24)

During an internal security review of Quarterdeck, `npm audit` reported one open moderate-severity advisory (GHSA-qx2v-qp2m-jg93, "PostCSS has XSS via Unescaped `</style>` in its CSS Stringify Output", CVSS 6.1) in both the root and `web-ui` packages. The vulnerable version was `postcss@8.5.8`, reached transitively via the Vite/Tailwind CSS toolchain. The fix was available in `postcss@8.5.10`, so `npm audit fix` was run in both package roots to pull the lockfiles forward. No `package.json` edits were needed because `postcss` is not a direct dependency. The root `package-lock.json` also had a pre-existing drift where its internal version field still read `0.10.0` despite `package.json` being on `0.11.0`; `npm audit fix` re-synced that field as a side effect.

Verified the bump is safe with the full local check matrix: `npm run typecheck`, `npm run web:typecheck`, `npm run build`, `npm test`, and `npm run web:test`, and post-fix `npm audit` reported 0 vulnerabilities in both packages. The advisory requires feeding untrusted CSS through PostCSS's stringifier, which Quarterdeck does not do at runtime because PostCSS only runs at build time on project-authored CSS, so the real-world risk was already low, but clearing the advisory keeps the lockfiles clean for future security reviews.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `package-lock.json`, `web-ui/package-lock.json`

Commit: `a24b9cf6a`

## Fix: require explicit Codex hook installation before use (2026-04-23)

Quarterdeck’s first native Codex hooks pass still treated `~/.codex/hooks.json` as runtime-owned and silently rewrote it during task launch. That avoided dirtying repos, but it was still the wrong ownership model for a user-level config file because anyone with their own Codex hooks would lose them without warning. The follow-up keeps Quarterdeck’s generated payload under `~/.quarterdeck/hooks/codex/hooks.json`, but moves the global write behind an explicit setup flow instead of doing it implicitly when a task starts.

The runtime side now centralizes Codex hook payload generation and install-state detection in `src/codex-hooks.ts`, adds a new `setup_required` agent status plus setup actions to the runtime config contract, and makes Codex non-runnable until either the managed hooks file is already present or the user explicitly installs/overwrites it. `src/config/agent-registry.ts` reports whether Codex needs hook installation or would overwrite a foreign `~/.codex/hooks.json`, `src/config/runtime-config.ts` blocks saving `selectedAgentId: "codex"` until that setup step is complete, and a new tRPC handler in `src/trpc/handlers/install-codex-hooks.ts` performs the explicit install when the UI asks for it. On the frontend, Settings and startup onboarding now surface a standard `Set up` action with a confirmation dialog that warns users to back up `~/.codex/hooks.json` first before overwriting, refresh runtime config after the install mutation, and keep Codex unavailable until the setup action succeeds. Added focused regression coverage for the new selection gate and explicit-install flows in runtime and web tests, and updated `AGENTS.md`, `CHANGELOG.md`, and `docs/todo.md` so the repo guidance matches the new ownership rule.

Files touched: `AGENTS.md`, `CHANGELOG.md`, `docs/implementation-log.md`, `docs/todo.md`, `src/codex-hooks.ts`, `src/config/agent-registry.ts`, `src/config/runtime-config.ts`, `src/core/api-validation.ts`, `src/core/api/config.ts`, `src/core/index.ts`, `src/terminal/agent-session-adapters.ts`, `src/trpc/app-router-context.ts`, `src/trpc/app-router.ts`, `src/trpc/handlers/install-codex-hooks.ts`, `src/trpc/runtime-api.ts`, `test/runtime/config/agent-registry.test.ts`, `test/runtime/config/agent-selection.test.ts`, `test/runtime/terminal/agent-session-adapters.test.ts`, `web-ui/src/components/settings/runtime-settings-dialog.test.tsx`, `web-ui/src/components/settings/agent-section.tsx`, `web-ui/src/components/settings/runtime-settings-dialog.tsx`, `web-ui/src/components/app/project-dialogs.tsx`, `web-ui/src/components/app/startup-onboarding-dialog.tsx`, `web-ui/src/components/task/task-start-agent-onboarding-carousel.tsx`, `web-ui/src/hooks/project/use-startup-onboarding.test.tsx`, `web-ui/src/hooks/project/use-startup-onboarding.ts`, `web-ui/src/providers/project-runtime-provider.test.tsx`, `web-ui/src/providers/project-runtime-provider.tsx`, `web-ui/src/runtime/native-agent.test.ts`, `web-ui/src/runtime/runtime-config-query.ts`, `web-ui/src/test-utils/runtime-config-factory.ts`

Commit: `679758f1`

## Fix: warn when Claude trash restore no longer has the original worktree identity (2026-04-24)

The remaining “startup resume works, untrash resume does not” bug turned out to be a different class from the shutdown race. Startup resume is driven by `resumeInterruptedSessions(...)` and reuses the persisted `card.workingDirectory` for isolated tasks when that original worktree still exists. Trash restore is not equivalent: moving a task to trash clears `workingDirectory` in board state and deletes the worktree, so untrash later recreates a fresh worktree path. That means Claude restore is no longer resuming against the same task identity; it is launching `claude --continue` in a recreated worktree, and Claude has no stored session-id resume path analogous to Codex. That explains the observed behavior exactly: startup can reopen the original Claude chat, while untrash may silently land on a fresh prompt even though process startup succeeds cleanly.

The code change stays at the runtime start-session boundary in `src/trpc/handlers/start-task-session.ts`, because that is the one place that can see all relevant facts together: this is a resume request, the selected agent is Claude, the task is isolated, the persisted `workingDirectory` is gone, and the previous session launched from a task worktree. When those conditions line up, the handler now emits a server warning log (`[task-session-start] resume requested after task worktree identity was lost`) and writes a `warningMessage` onto the returned session summary: Claude resume after trash restore is best-effort only because the original task worktree was deleted. That warning then flows through the existing browser-side session-summary toast path instead of requiring any new UI-specific trash logic.

I also captured the behavior in shared repo instructions so future agents do not assume startup resume and untrash resume are equivalent for isolated Claude tasks. Added runtime coverage in `test/runtime/trpc/runtime-api.test.ts` to assert both the warning log and the surfaced warning message when resume recreates a trashed Claude worktree, and updated the changelog entry to document the visible distinction between startup restore and untrash restore.

Files touched: `AGENTS.md`, `CHANGELOG.md`, `docs/implementation-log.md`, `src/trpc/handlers/start-task-session.ts`, `test/runtime/trpc/runtime-api.test.ts`

Commit: pending

## Fix: fail loudly when untrash/restart races a still-exiting task session (2026-04-23)

The remaining "untrash shows a spinner forever with no logs" bug was not actually specific to Codex resume ids. The shared failure mode was that trash restore and manual restart both rely on `stopTaskSession(..., { waitForExit: true })`, but the terminal layer only waited 5 seconds and then let the caller continue without distinguishing "process exited" from "we gave up waiting." If the old PTY was still alive, `TerminalSessionManager.startTaskSession()` saw an active `running` / `awaiting_review` entry for the same task and quietly returned that stale summary instead of spawning anything new. Once the old PTY finally exited, the card was left in review with no live session behind it, which surfaced as a loading spinner and empty terminal for both Claude and Codex restores.

The runtime fix hardens that contract in `src/terminal/session-manager.ts`. `stopTaskSessionAndWaitForExit()` now waits up to 3 seconds (tight enough not to feel like a hang, long enough to cover a clean PTY stop), removes timed-out wait resolvers cleanly, and emits a warning log when the PTY still has not exited. More importantly, `startTaskSession()` now treats "same task is still exiting after an explicit stop request" as a real error: when `suppressAutoRestartOnExit` is still set, it logs a warning and throws `Task session is still shutting down. Wait a moment and try again.` instead of silently reusing the stale summary. That keeps the runtime from lying about a successful resume when no new process exists yet.

The adjacent silent-resume failure modes now emit warnings too. The tRPC `start-task-session` handler logs when `resumeConversation=true` arrives without a stored `resumeSessionId` (which is how "Codex came back up but in the wrong conversation" escaped notice), and the Codex adapter logs when it falls back to `codex resume --last`. The Claude adapter logs its `--continue` cwd at debug level so worktree-path divergence can be spotted if `--continue` ever picks up the wrong cached session.

The browser-side follow-through was intentionally small: the existing restore/restart hooks already surface failed `startTaskSession()` results, so once the runtime stopped returning false-success summaries the board logic behaved correctly again. Added a frontend regression in `web-ui/src/hooks/board/use-board-interactions.test.tsx` to lock in the user-visible behavior: if restore hits the "still shutting down" error after the stop wait, the task is moved back to trash and the error is surfaced instead of staying in review with a dead spinner. Added matching runtime tests in `test/runtime/terminal/session-manager.test.ts` for both the timeout warning and the start-while-exiting throw. Also updated the `AGENTS.md` terminal note because this shutdown-timeout / start-short-circuit interaction is easy to miss when touching terminal lifecycle code.

Files touched: `AGENTS.md`, `CHANGELOG.md`, `docs/implementation-log.md`, `src/terminal/agent-session-adapters.ts`, `src/terminal/session-manager.ts`, `src/trpc/handlers/start-task-session.ts`, `test/runtime/terminal/session-manager.test.ts`, `web-ui/src/hooks/board/use-board-interactions.test.tsx`

Commit: `e88e820d9`

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

## Refactor: switch Codex integration to native hooks (2026-04-22)

Replaced Quarterdeck's legacy Codex wrapper integration with native Codex hooks end to end. The Codex adapter in `src/terminal/agent-session-adapters.ts` now writes repo-local `.codex/hooks.json` into the task working directory, maps native `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, and `Stop` events into Quarterdeck's existing `to_in_progress` / `to_review` / `activity` ingest flow, and launches `codex` directly instead of routing through `quarterdeck hooks codex-wrapper`. On the ingest side, `src/commands/hooks.ts` now reads Codex `session_id` directly from native hook payloads and forwards it through the tRPC hook request, while `src/trpc/hooks-api.ts`, `src/core/api/task-session.ts`, `src/terminal/session-summary-store.ts`, and `src/terminal/session-lifecycle.ts` persist that identifier on `RuntimeTaskSessionSummary.agentSessionId` so resumed Codex tasks can target `codex resume <session_id>` rather than `--last` once the first native hook has arrived. This also removed the now-unused Codex wrapper/log watcher/rollout parser modules and their dedicated tests, updated the task-state documentation to describe the native-hook architecture, and refreshed the targeted adapter tests around generated `.codex/hooks.json` plus session-id-aware resume behavior.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `docs/task-state-system.md`, `docs/todo.md`, `src/commands/claude-transcript-parser.ts`, `src/commands/hooks.ts`, `src/core/api/task-session.ts`, `src/terminal/agent-session-adapters.ts`, `src/terminal/session-lifecycle.ts`, `src/terminal/session-summary-store.ts`, `src/trpc/hooks-api.ts`, `test/runtime/terminal/agent-session-adapters.test.ts`, `test/utilities/task-session-factory.ts`, `web-ui/src/test-utils/task-session-factory.ts`, deleted `src/commands/codex-hook-events.ts`, `src/commands/codex-rollout-parser.ts`, `src/commands/codex-session-parser.ts`, `src/commands/codex-wrapper.ts`, `test/runtime/hooks-codex-rollout-fallback.test.ts`, `test/runtime/hooks-codex-wrapper.test.ts`, `test/runtime/hooks-codex-watcher.test.ts`

Commit: `23b45e2b`

## Refactor: always show running-task stop/trash actions (2026-04-22)

Removed the `showRunningTaskEmergencyActions` escape-hatch setting and collapsed the running-card action path down to the default behavior. The setting started as a temporary workaround for stuck sessions, but the extra config plumbing no longer bought anything useful and forced the runtime config contract, settings form, test fixtures, and board/sidebar card surfaces to carry a dead boolean. The runtime-side cleanup removed the field from the global config registry and runtime config Zod schemas (`src/config/global-config-fields.ts`, `src/core/api/config.ts`). The web UI cleanup removed the setting from the settings form and Troubleshooting section (`web-ui/src/hooks/settings/settings-form.ts`, `web-ui/src/components/settings/general-sections.tsx`), dropped the reactive card-state/context threading (`web-ui/src/state/card-actions-context.tsx`, `web-ui/src/hooks/app/use-app-action-models.ts`), and simplified both board and sidebar card renderers so in-progress cards always show the force-restart and force-trash actions on hover when the session is alive (`web-ui/src/components/board/board-card-actions.tsx`, `web-ui/src/components/board/board-card.tsx`, `web-ui/src/components/board/board-column.tsx`, `web-ui/src/components/terminal/column-context-panel.tsx`). Updated frontend fixtures/tests to match the smaller config and reactive-state shapes (`web-ui/src/test-utils/runtime-config-factory.ts`, `web-ui/src/components/terminal/column-context-panel.test.tsx`, `web-ui/src/components/task/card-detail-view.test.tsx`) and added a focused hover regression test in `web-ui/src/components/board/board-card.test.tsx` so running cards must keep exposing the restart/trash escape hatches by default. Added the release note in `CHANGELOG.md`.

Files touched: `CHANGELOG.md`, `docs/implementation-log.md`, `src/config/global-config-fields.ts`, `src/core/api/config.ts`, `web-ui/src/components/board/board-card.test.tsx`, `web-ui/src/components/board/board-card-actions.tsx`, `web-ui/src/components/board/board-card.tsx`, `web-ui/src/components/board/board-column.tsx`, `web-ui/src/components/settings/general-sections.tsx`, `web-ui/src/components/task/card-detail-view.test.tsx`, `web-ui/src/components/terminal/column-context-panel.test.tsx`, `web-ui/src/components/terminal/column-context-panel.tsx`, `web-ui/src/hooks/app/use-app-action-models.ts`, `web-ui/src/hooks/settings/settings-form.ts`, `web-ui/src/state/card-actions-context.tsx`, `web-ui/src/test-utils/runtime-config-factory.ts`

Commit: `55e48635`


## Fix: harden Codex CLI detection with version gating (2026-04-22)

Replaced the old Codex "binary exists on PATH" check with a small compatibility gate that still uses PATH for discovery but now probes `codex --version`, enforces a minimum supported version, and blocks launch plus auto-selection when the detected Codex build is too old or its version cannot be determined. The floor is currently `0.124.0` after the 2026-04-27 hardening pass above. On the runtime side, this changed `src/config/agent-registry.ts` to add the version probe, compare versions, expose explicit install states and status messages, and leave inline TODO comments for a future capability-based Codex probe; updated `src/config/runtime-config.ts` and `src/config/index.ts` so default agent auto-selection uses only runnable agents; extended the runtime config API contract in `src/core/api/config.ts`; and updated the Codex install URL in `src/core/agent-catalog.ts` to the official OpenAI Codex CLI quickstart. On the web UI side, this updated the settings and onboarding surfaces to distinguish `upgrade_required` from `missing`, show the corresponding messaging and button label, and clarify that CLI detection is PATH-based with a Codex version floor in `web-ui/src/components/settings/agent-section.tsx`, `web-ui/src/components/settings/runtime-settings-dialog.tsx`, and `web-ui/src/components/task/task-start-agent-onboarding-carousel.tsx`. Updated runtime and web test helpers plus focused runtime/native-agent tests to cover the new status fields and version gating behavior in `test/runtime/config/agent-registry.test.ts`, `test/runtime/config/agent-selection.test.ts`, `test/runtime/config/runtime-config-helpers.ts`, `web-ui/src/runtime/native-agent.test.ts`, and `web-ui/src/test-utils/runtime-config-factory.ts`.

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
