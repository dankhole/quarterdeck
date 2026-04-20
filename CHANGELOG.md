# Changelog

## [Unreleased]

### Refactor: clarify authoritative project sync vs cached board restore

- Refactored `web-ui/src/hooks/project/use-project-sync.ts` so authoritative runtime project-state application is now explicit and cache restore is tracked as a subordinate display policy instead of mutating the same revision model that drives persistence gating.
- Updated `web-ui/src/runtime/project-board-cache.ts` to store the authoritative revision a cached board was last aligned with, making it clearer that a restored board can be shown optimistically without being treated as authoritative for persistence.
- Added project-sync regression coverage for cached restore confirmation and stale previous-project updates during switches, alongside updated pure-domain tests for the authoritative board-application policy.

### Fix: terminal scroll-to-bottom on task load/untrash

- Fixed a race condition where the terminal would not scroll to the bottom when a task was first loaded (most noticeable after untrashing). The ResizeObserver could consume the `pendingScrollToBottom` flag before the reveal animation frame fired, leaving the terminal visible at the wrong scroll position.
- Removed a now-redundant non-initial-fit scroll block from the ResizeObserver callback in `SlotResizeManager`.

### Docs: flesh out next-wave refactor roadmap context

- Added `docs/refactor-roadmap-context.md`, a structured pickup guide for the current next 9 refactors after the recent terminal websocket bridge and project metadata monitor work.
- Linked the roadmap context from `docs/todo.md` and `docs/README.md`, and added concrete todo items for the broader design-roadmap work that previously existed only as high-level architectural ranking.

### Docs: capture project metadata monitor post-refactor follow-ups

- Added `docs/project-metadata-monitor-followups.md` to record the two remaining metadata-monitor follow-ups that surfaced after the refactor: shared mutable `ProjectMetadataEntry` coupling and `refreshProject()` vs per-task refresh overwrite races.
- Linked the new follow-up doc from `docs/README.md` and added a fresh todo entry in `docs/todo.md` so those architectural questions stay visible without reopening the completed refactor brief.

### Refactor: split project metadata monitor ownership from refresh policy

- Refactored `src/server/project-metadata-monitor.ts` into a thin registry/facade over `project-metadata-controller.ts`, `project-metadata-refresher.ts`, `project-metadata-poller.ts`, and `project-metadata-remote-fetch.ts`, so per-project metadata state/lifecycle is separated from polling cadence and remote-fetch freshness policy.
- Replaced module-scoped refresh/fetch guards with per-project dedupe while preserving the shared `p-limit(3)` git probe concurrency cap across all connected projects.
- Unified manual `requestTaskRefresh()` with the same per-task refresh path used by focused/background refreshes, including branch-change base-ref detection for non-focused tasks.
- Added `test/runtime/server/project-metadata-monitor.test.ts` to lock in multi-project independence, focused-vs-background cadence, manual task refresh behavior, and remote-fetch follow-up refresh behavior alongside the existing runtime stream integration coverage.

### Docs: add project metadata monitor refactor brief

- Added `docs/project-metadata-monitor-refactor-brief.md`, a dedicated design brief for refactoring `src/server/project-metadata-monitor.ts` so metadata ownership can be separated from polling cadence, focused/background prioritization, and remote-fetch policy without losing current stream semantics.
- Linked the new brief from `docs/README.md`, `docs/optimization-shaped-architecture-followups.md`, and the active todo item in `docs/todo.md`.

### Refactor: terminal websocket bridge ownership / policy split

- Split `src/terminal/ws-server.ts` into a thinner websocket orchestrator plus focused collaborators: `terminal-ws-connection-registry.ts`, `terminal-ws-output-fanout.ts`, `terminal-ws-restore-coordinator.ts`, `terminal-ws-backpressure-policy.ts`, `terminal-ws-protocol.ts`, and `terminal-ws-types.ts`.
- Preserved the existing terminal websocket behavior while making the bridge read task-stream ownership first and transport policy second: multi-viewer fanout, same-`clientId` socket replacement, restore-after-resize timing, restore-gap buffering, shared PTY pause/resume, and `recoverStaleSession(taskId)` on connect all remain intact.
- Expanded `test/runtime/terminal/ws-server.test.ts` to cover restore timing, restore-gap buffering, same-client socket replacement, last-viewer backpressure disconnect resume, and invalid control payload handling.

### Docs: terminal websocket bridge refactor brief

- Added `docs/terminal-ws-server-refactor-brief.md` — a dedicated planning brief for refactoring `src/terminal/ws-server.ts` without changing runtime behavior. It captures current responsibilities, transport-vs-policy boundaries, multi-viewer/backpressure/restore invariants, proposed backend module split, rollout order, acceptance criteria, and migration risks.
- Linked the new brief from the refactor docs map, the optimization-shaped architecture follow-up tracker, and the todo section that tracks this work.

### Fix: task switch and untrash terminal width/scroll restoration

- Reused pooled task terminals now request a fresh server restore snapshot whenever a non-active warm slot is promoted back to the visible task view. This makes normal task switches use the same repair path as the manual "Re-sync terminal content" action instead of showing stale hidden-slot geometry.
- Restored task terminals now defer reveal until a post-layout resize pass runs, reducing half-width first-frame rendering during untrash/remount flows and preserving bottom scroll before the terminal becomes visible.
- Added focused pool-acquire regression coverage to lock in restore-on-promotion behavior for `READY`, `PRELOADING`, and `PREVIOUS` task slots.

### Fix: untrash does not always restart agent session

- Untrashing a card while another card animation was in flight silently failed — `handleRestoreTaskFromTrash` bailed on `"blocked"` without ever calling `resumeTaskFromTrash`, leaving the card stuck in trash with no feedback.
- Resume fallback restart was gated on non-zero exit code — if `--continue` exited cleanly (code 0) because the conversation was garbage-collected, the session stayed dead in `awaiting_review` with no recovery path.

### Enhancement: restart button on review cards

- Hovering a review card with a live session now shows the restart button — previously only shown for dead/failed sessions. Matches the stop & trash pattern on running cards so users can restart a session from review without moving it back to in-progress first.

### Feature: single-tab guard

- Prevents multiple browser tabs from running Quarterdeck against the same server simultaneously. A second tab sees a "Quarterdeck is open in another tab" screen with a "Use here instead" button to transfer ownership. Uses localStorage heartbeat + BroadcastChannel — scoped per origin, so dogfood runs on different ports are unaffected.

### Fix: truncate schema validation errors in state file logging

- `formatSchemaIssues` now caps output at 5 issues with a `(N more)` suffix — prevents shutdown logs from dumping hundreds of identical validation errors when a stale `sessions.json` has many entries with the same missing/invalid field.

### Fix: base ref dropdown shows "(default)" only when explicitly pinned

- The base ref dropdown no longer labels the git-detected default branch (e.g. `main`) with "(default)" unless the user has explicitly pinned it via the pin icon. Previously, the auto-detected git default always showed the "(default)" suffix, implying the user had set it.

### Housekeeping: remove stale todo items

- Removed "Investigate and fix statusline counters vs task card stats" and "Audit default branch resolution" from the todo list.

### Enhancement: ghost-until-open base ref branch selector

- Base ref branch dropdown in inline task creation now renders transparent until clicked, reducing visual noise in the create card. The task creation dialog keeps the standard button style.

### Fix: ghost-until-open scope

- Removed `ghostUntilOpen` from the task creation dialog — the ghost style was only intended for the inline create card in the top bar, not full dialogs where the dropdown should remain visible.

### Docs: refactor agent instruction docs around AGENTS.md

- Established `AGENTS.md` as the canonical shared agent-instructions file — slimmed `CLAUDE.md` from ~140 lines to an 11-line compatibility shim that imports `@AGENTS.md` and points to human-facing docs.
- Moved duplicated content (quick reference, repo orientation, CI/CD notes) from `CLAUDE.md` to `DEVELOPMENT.md` and `README.md` where it belongs.
- Added `scripts/check-agent-instructions.mjs` — validates the AGENTS.md/CLAUDE.md bridge invariants (canonical heading, shim shape, no code blocks, line cap). Wired into `npm run check`.
- Rewrote the Codex todo section — replaced the monolithic status dump with four focused, actionable items reflecting Codex's native hook support.
- Updated worktree system prompt example to reference `AGENTS.md` instead of `CLAUDE.md`.

### Refactor: fix workspace→project/worktree rename oversights

- Fixed identifiers that were renamed from "workspace" to "project" but should have been "worktree" (per-task git worktree metadata): `RuntimeTaskProjectMetadata` → `RuntimeTaskWorktreeMetadata`, `TrackedTaskProject` → `TrackedTaskWorktree`, `CachedTaskProjectMetadata` → `CachedTaskWorktreeMetadata`, `loadTaskProjectMetadata` → `loadTaskWorktreeMetadata`, `ReviewTaskProjectSnapshot` → `ReviewTaskWorktreeSnapshot`, and all associated store hooks/functions.
- Fixed remaining stale "workspace" identifiers: `WORKSPACE_STATE_FILENAMES` → `PROJECT_STATE_FILENAMES`, `WORKSPACE_STATE_PERSIST_DEBOUNCE_MS` → `PROJECT_STATE_PERSIST_DEBOUNCE_MS`, `WORKSPACE_ID` → `PROJECT_ID` in test fixture, `NOOP_FETCH_WORKSPACE_INFO` → `NOOP_FETCH_WORKTREE_INFO`.
- Fixed stale `createWorkspaceTrpcClient` reference in biome.json lint rule (function was already renamed to `createProjectTrpcClient`).

### Refactor: terminal architecture split into session / viewport / attachment / reuse / prewarm layers

- Extracted `terminal-session-handle.ts`, `terminal-viewport.ts`, `terminal-attachment-controller.ts`, `terminal-reuse-manager.ts`, and `terminal-prewarm-policy.ts` so terminal correctness is separated more clearly from optimization policy.
- Slimmed `terminal-slot.ts` into a compatibility wrapper over the new layers while preserving reconnect, restore, quick switch-back, and buffer inspection behavior.
- Split shell-vs-agent terminal UI surfaces via `shell-terminal-panel.tsx` and `persistent-terminal-panel-layout.tsx`, keeping dedicated shell behavior distinct from pooled task agent terminals.
- Moved app-facing pooled terminal consumers off raw pool verbs and behind reuse/policy seams, so prewarm can be replaced or disabled for testing/measurement without changing correctness paths.

### Refactor: app shell component decomposition and design guardrails

- Decomposed `project-navigation-panel.tsx` (679L → 74L) into `project-navigation-list.tsx`, `project-navigation-row.tsx`, `project-navigation-removal-dialog.tsx`, and `project-navigation-sidebar-sections.tsx`.
- Decomposed `top-bar.tsx` (624L → 176L) into `top-bar-scope-section.tsx`, `top-bar-project-shortcut-control.tsx`, `top-bar-prompt-shortcut-control.tsx`, and `git-branch-status-control.tsx`.
- Added design guardrails doc, design weaknesses roadmap, optimization-shaped architecture follow-ups, and terminal architecture refactor brief.
- Fixed pre-existing type error in `orphan-cleanup.ts` (`comm` possibly undefined).
- Completed the `isWorkspacePathLoading` → `isProjectPathLoading` prop rename across `TopBar` and `ConnectedTopBar`.

### Refactor: rename "workspace" to "project" throughout codebase

- Unified the state-container concept under "project" — the backend previously used "workspace" while the UI/API layer used "project", causing confusion. All types, files, functions, variables, API routes, wire protocol strings, HTTP headers, and on-disk paths now consistently use "project".
- Renamed `src/workspace/` to `src/workdir/` with updated function names (`*Workspace*` → `*Workdir*`) for working directory operations. Agent workspace trust files (`claude-workspace-trust.ts`, etc.) intentionally unchanged — "workspace" is the agent's own terminology.
- On-disk state path changed from `~/.quarterdeck/workspaces/` to `~/.quarterdeck/projects/`. Manual migration: `cp -r ~/.quarterdeck/workspaces ~/.quarterdeck/projects` and rename `workspaceId` to `projectId` in `index.json`.
- Completed remaining renames across 106 files: `notificationWorkspaceIds` → `notificationProjectIds`, `cleanupTaskWorkspace` → `cleanupTaskWorktree`, `disposeTrackedWorkspace` → `disposeTrackedProject`, `SearchWorkspaceTextOptions` → `SearchWorkdirTextOptions`, `@runtime-task-worktree-path` alias fix, plus full sweep of all remaining workspace→project/worktree/workdir identifiers, string literals, comments, Zod messages, env vars (`QUARTERDECK_HOOK_WORKSPACE_ID` → `QUARTERDECK_HOOK_PROJECT_ID`), and test fixtures.

### Feature: file finder (Cmd+P) and text search (Cmd+Shift+F)

- Added two VS Code-style search overlays — file finder (Cmd+P) for fuzzy filename search and text search (Cmd+Shift+F) for full-text grep across the workspace. Both open as centered floating panels with keyboard navigation (arrow keys, Enter, Escape) and outside-click dismiss.
- File finder uses the existing `workspace.searchFiles` endpoint with 150ms debounce and request-ID race protection. Text search uses a new `workspace.searchText` endpoint backed by `git grep`, with case sensitivity and regex toggles, results grouped by file with match highlighting, and truncation at 100 matches.
- Selecting a result in either modal opens the file in the file content viewer via the existing `pendingFileNavigation` mechanism. Both modals are only active when a workspace is selected and close on project switch.
- Follow-up fixes from sanity review: added request-ID race protection to text search hook, replaced mutable render-time counter with precomputed `useMemo` array for flat-index mapping, removed dead `onDismiss` parameter from hook interfaces, stabilized Escape listener with ref to avoid re-registration on every render.

### Feature: scroll-to-line on text search result click

- Clicking a text search result now scrolls the file content viewer to the matched line. The line number is passed through `pendingFileNavigation` to `FileContentViewer`, which calls `scrollToIndex()` on the virtualizer after the file loads.

### Enhancement: notification muting — "Mute project viewed"

- Renamed "Mute focused project" to "Mute project viewed" in the notification settings grid.
- Per-project notification suppression now only applies while the tab is visible — sounds always play when the user has tabbed away, even for the viewed project.
- Defaulted review event suppression to `true` for new users — review sounds are muted for the project you're actively watching, reducing noise without missing anything.

### Chore: dead code cleanup

- Deleted orphaned `task-chat.ts` API contract (unimplemented feature) and `OpenWorkspaceButton` component (unused).
- Removed dead `getGitSummary` and `notifyStateUpdated` tRPC procedures — full chain through router, context interface, and factory functions.
- Removed deprecated `mcp` and `update` CLI command stubs.
- Removed legacy `QUARTERDECK_TITLE_MODEL` env var alias — use `QUARTERDECK_LLM_MODEL` instead.
- Removed unused `neverthrow` and `mitt` npm dependencies.
- Removed dead `.kb-line-clamp-2` / `.kb-line-clamp-5` CSS classes.
- Pruned barrel re-exports with no external consumers from `core/`, `state/`, and `config/` index files.

### Fix: terminal restore snapshot renders at wrong dimensions

- Deferred the initial restore snapshot on the server until the client's first resize message arrives (100ms timeout fallback). Previously, the snapshot was serialized before the resize updated the server-side mirror, causing cursor-positioned content (status bars, prompts) to appear garbled or half-wide.
- Added resize-on-connect to the control socket open handler — every new control socket connection now sends the client's current terminal dimensions to the server. Fixes terminals rendering at default PTY dimensions after server restart or sleep/wake reconnect.
- Armed `pendingScrollToBottom` in the restore handler to prevent a debounced ResizeObserver callback from undoing the scroll position after the terminal becomes visible.

### Feature: syntax highlighting in file browser

- Added Prism syntax highlighting to the file content viewer — code lines are highlighted using the same language/grammar resolution and token theme already used by the diff viewer. Fenced code blocks in the markdown preview are also highlighted via a custom `code` component.
- Renamed `diff-highlighting.ts` → `syntax-highlighting.ts` to reflect shared usage across diffs, file viewer, and markdown preview. Added `resolvePrismLanguageByAlias()` for resolving short language aliases (`ts`, `py`, `sh`, `yml`) used in markdown fences.
- Collapsed duplicated Prism token CSS selectors using `:is()` — adding future token groups is now a single rule instead of a duplicated pair.

### Refactor: runtime barrel exports

- Added `index.ts` barrel files to 9 runtime directories (`core/`, `terminal/`, `workspace/`, `server/`, `config/`, `state/`, `trpc/`, `fs/`, `title/`) — each re-exports the directory's public surface. Updated ~150 import paths across `src/` and `test/` to use directory-level imports instead of specific module paths. Three source files (`lock-cleanup.ts`, `task-worktree-lifecycle.ts`, `task-worktree-patch.ts`, `claude-workspace-trust.ts`) retain direct imports to preserve vitest mock compatibility.

### Refactor: git action toast helpers and loading guard

- Added `showGitErrorToast`/`showGitWarningToast`/`showGitSuccessToast` helpers to `hooks/git/git-actions.ts` — standardize icon, intent, and timeout defaults across all git toast calls. Normalized `use-branch-actions.ts` error toasts to include `warning-sign` icon and 7s timeout (previously inconsistent with `use-git-actions.ts`).
- Added `useLoadingGuard` hook to `utils/react-use.ts` — replaces the repeated `useState(false)` + `try/finally` pattern with a ref-guarded async wrapper that prevents double-clicks and auto-resets. Includes `reset()` for force-clearing on project switch.
- Applied both to `use-git-actions.ts` (626→515 lines) and `use-branch-actions.ts` (520→493 lines). Net ~56 line reduction across the two hooks.

### Refactor: split terminal slot hosting and visibility lifecycle

- Refactored `web-ui/src/terminal/terminal-slot.ts` so the main class now reads primarily as terminal orchestration. Constructor/setup work is grouped behind named helper methods for xterm creation, addon wiring, socket/write-queue setup, and restore handling.
- Added `slot-dom-host.ts` to own the persistent parking-root host element, stage-container attachment, reveal/hide behavior, and parking transitions. Added `slot-visibility-lifecycle.ts` to own the tab-visibility refresh and reconnect-on-return behavior that previously lived inline in `TerminalSlot`.
- Added focused regression coverage for the extracted collaborators and kept the existing terminal pool/session tests green to verify that reconnect, restore, and hosting behavior stayed stable.

### Refactor: split dedicated terminal registry from terminal pool

- Kept the shared-slot allocation and lifecycle state machine in `web-ui/src/terminal/terminal-pool.ts`, where the `FREE/PRELOADING/READY/ACTIVE/PREVIOUS` policy and eviction invariants are easier to inspect together.
- Extracted dedicated-terminal ownership into `web-ui/src/terminal/terminal-dedicated-registry.ts`, separating the home/detail terminal registry from shared pool allocation and making the pool module read more clearly as shared-slot policy plus cross-terminal utilities.

### Refactor: extract `updateCardInBoard` helper in board-state

- Extracted repeated nested `columns.map → cards.map` pattern into a single `updateCardInBoard` helper. Refactored `updateTask`, `reconcileTaskWorkingDirectory`, `reconcileTaskBranch`, and `toggleTaskPinned` to use it. ~33 line net reduction, zero behavior changes.

### Refactor: decompose CLI startup into named bootstrap phases

- Split `src/cli.ts` startup flow into focused helpers for lazy runtime module loading, startup cleanup, orphaned-agent cleanup, runtime bootstrap state, and runtime server handle creation. Preserved the existing lazy import boundary and startup behavior while making `startServer()` read as a small bootstrap pipeline.

### Refactor: extract App.tsx composition hooks

- Broke `web-ui/src/App.tsx` orchestration into named app hooks for side effects, card action models, and home side-panel resize. The render tree stays intact, but the top-level app component now reads more like a composition root and less like a merged effect/callback registry.

### Refactor: extract board-state parser/schema helpers

- Moved the persisted board hydration path in `web-ui/src/state/board-state.ts` into a companion `board-state-parser.ts` module built around named `zod` schemas and parser helpers for board payloads, cards, dependencies, and task images. Behavior stays the same, but the browser normalization flow now reads as parse-and-assemble instead of inline `unknown` inspection. Added direct parser coverage in the board-state normalization tests.

### Refactor: consolidate board rules behind the runtime board module

- Trimmed `web-ui/src/state/board-state.ts` so task update, task deletion, column clearing, pinned-state toggling, and post-parse dependency cleanup all delegate to `src/core/task-board-mutations.ts` instead of re-implementing nearby board rules in the browser layer. Persisted dependency parsing now only normalizes raw saved records; the runtime module canonically drops invalid links, reorients backlog-linked pairs, and dedupes adjacent dependency concepts after hydration. The browser module keeps parsing, drag/drop placement, and metadata reconciliation concerns. Added regression coverage for the thinner browser adapters and the runtime-owned board canonicalization path.

### Refactor: slim project navigation panel composition

- Moved project sidebar orchestration into `useProjectNavigationPanel`, consolidating optimistic reorder state, drag/drop handling, removal confirmation state, and needs-input badge counts behind a named project hook.
- Split the render surface in `project-navigation-panel.tsx` into smaller view sections for the draggable list and portal-backed drag row, so the main component now reads as UI composition instead of mixed controller/render logic.
- Added focused hook coverage for approval-count derivation, optimistic reorder reset, and removal confirmation flow.

### Refactor: split runtime state hub coordination

- Split `src/server/runtime-state-hub.ts` into a slimmer coordinator plus two focused collaborators: `runtime-state-client-registry.ts` now owns websocket client registration, workspace-scoped tracking, and cleanup, while `runtime-state-message-batcher.ts` owns task-summary and debug-log batching. Public hub behavior, websocket payload shapes, and workspace disposal semantics stay the same.
- Added targeted server-side unit coverage for the extracted registry and batching helpers, including workspace client disconnect cleanup and summary/debug-log batch timing.

## [0.9.4] — 2026-04-16

### Refactor: split session-manager into concern-based modules

- Split the 928-line `TerminalSessionManager` class into 4 files organized by concern — lifecycle (spawn/exit/recovery/hydration, 510 lines), output pipeline (protocol filter → mirror → trust → transition → broadcast, 154 lines), input pipeline (protocol detection → permission clearing → interrupt → PTY write, 124 lines), and the slimmed manager (370 lines, registry + PTY control + state coordination). Follows the existing free-function-with-deps-injection pattern used by the 5 companion modules. Zero behavior changes.

### Refactor: split workspace-api into domain-grouped modules

- Split the 1,092-line `src/trpc/workspace-api.ts` into 7 focused files grouped by git domain — shared helpers (148 lines), git ops (305), changes/files/history (314), staging/stash (178), conflict resolution (106), state/worktrees (140), and a 21-line coordinator that composes them via spread. Each domain module returns a typed `Pick<>` of the full workspace API interface, validated at compile time. Zero behavior changes.

### Refactor: split runtime-config into focused modules

- Split the 917-line `runtime-config.ts` into normalizers (372 lines, pure functions), persistence (332 lines, file I/O), and barrel (262 lines, public API). Moved `AudibleNotification*` interfaces into `config-defaults.ts` to break a circular type dependency. All consumer imports unchanged.

### Fix: resume --continue fallback after server restart

- After a server restart, sessions resumed with `--continue` could fail if the conversation no longer existed, leaving a zombie session with no process. Now retries via `scheduleAutoRestart` with `skipContinueAttempt` to start a fresh session instead.

### Refactor: split task-create-dialog into focused files

- Split the 725-line `TaskCreateDialog` into three files — pure utilities (`parseListItems`, start action types, `ButtonShortcut`), a multi-task list component with its own focus management, and the slimmed dialog (544 lines). Zero consumer changes.

### Refactor: split board-card into domain module and actions component

- Split the 784-line `BoardCard` into 3 focused files — domain module (`board-card-display.ts`, pure TS tooltip/activity/branch-name helpers), actions sub-component (`board-card-actions.tsx`, column-specific action buttons), and slimmed-down card component (520 lines). Public API unchanged.

### Refactor: split git-view into domain module, hook, and sub-components

- Split the 757-line `GitView` monolith into 5 focused files — domain module (`hooks/git/git-view.ts`, types + persistence), hook (`hooks/git/use-git-view.ts`, state + effects + data fetching), `CompareBar` component, empty/loading panels, and slimmed-down view component (255 lines). Public API unchanged.

### Refactor: split hooks-api test into domain-focused files

- Split the 888-line `hooks-api.test.ts` monolith into a `hooks-api/` subdirectory with 4 focused test files — transitions, conversation summaries, permission guard, and turn checkpoints — plus a shared `_helpers.ts` with test factories and a `createTestApi` helper that eliminates boilerplate. Moved misplaced `isPermissionActivity` tests to `test/runtime/terminal/`.

### Refactor: split board-state test file into domain-focused modules

- Split the 899-line `board-state.test.ts` monolith into 4 focused test files — dependencies (10 tests), drag (8 tests), normalization (6 tests), and mutations (12 tests) — plus a shared helpers module. All 36 tests preserved.

### Fix: client-side logger missing log level gating

- The client-side logger (`client-logger.ts`) had no log level filtering — when the debug panel was open, all `log.debug()` calls (including `[perf]` entries) flooded the console and panel regardless of the user's chosen level. Added `LOG_LEVEL_SEVERITY` gating to match the server-side logger, and synced the level from the debug panel to the client logger.

### Refactor: frontend feature folders and barrel exports (Phases 1, 2, 4)

- **Phase 1 — Hook reorganization:** Sorted 15 orphan hooks from `hooks/` root into domain subdirectories (`hooks/app/`, `hooks/debug/`, `hooks/settings/`, and 4 existing dirs). Pure file moves + import path updates.
- **Phase 2 — Component grouping:** Moved 48 root-level component files from `components/` root into 6 feature directories (`app/`, `board/`, `task/`, `git/`, `terminal/`, `debug/`) plus 2 into existing `settings/`. Renamed `detail-panels/` to `git/panels/` and `git-history/` to `git/history/`. Components root now has only 4 cross-cutting files plus `shared/` and `ui/`.
- **Phase 4 — Barrel exports:** Added 17 `index.ts` barrel files across all feature directories in `components/` and `hooks/`. Updated 14 consumer files (App.tsx, main.tsx, all 6 providers, app-dialogs, home-view, card-detail-view, and 5 hook files) to use consolidated barrel imports. Phase 3 (component decomposition) deferred.

### Fix: awaiting_review sessions reset to idle after server restart

- Sessions in `awaiting_review` with terminal review reasons (hook, exit, error, attention, stalled) were incorrectly recovered to idle after a server restart. The preservation guard in `recoverStaleSession` was gated on `restartRequest` — an in-memory field lost across restarts. Now uses `isTerminalReviewReason` to preserve review state regardless of server lifetime, matching the semantics already used by `hydrateFromRecord`.

### Refactor: decompose terminal-slot into focused modules

- Broke the 1,227-line `terminal-slot.ts` into 5 files: orchestrator (`terminal-slot.ts`, 749), socket management (`slot-socket-manager.ts`, 239), WebGL rendering (`slot-renderer.ts`, 185), resize handling (`slot-resize-manager.ts`, 115), and write queue (`slot-write-queue.ts`, 65). Zero consumer changes.
- Fixed scroll races during terminal restore — reordered to fit → scrollToBottom → ensureVisible, with synchronous scroll on armed ResizeObserver callbacks.
- Added `[perf]` timing logs across the full terminal pipeline: warmup, acquireForTask, show, socket open, font ready, restore apply, restore round-trip, connect-to-ready, show-to-interactive, and server-side getSnapshot/sendRestoreSnapshot.

### Feat: terminal loading spinner

- Show a centered spinner in the terminal container while connecting/restoring, replacing the empty background visible for 50-500ms. Spinner disappears when `onConnectionReady` fires.
- Moved the background `requestRestore()` from PREVIOUS slot demotion to PREVIOUS slot re-acquire — the restore now runs when the user actually switches back, repairing any client-side buffer drift accumulated while the slot was hidden.

### Fix: clicking agent terminal panel now always focuses terminal for input

- Added click handler to the agent terminal panel wrapper so clicking anywhere in the terminal area (including padding/gutters outside the xterm canvas) focuses the terminal for keyboard input.

### Refactor: split globals.css into domain-specific stylesheets

- Split the 920-line `web-ui/src/styles/globals.css` into 9 focused files — `theme.css` (design tokens), `base.css` (resets, scrollbars, focus ring), `board.css` (board layout, card shell, dependencies, navbar), `diff.css` (diff viewer, split view, syntax tokens, readonly), `markdown.css` (rendered prose), `components.css` (project rows, file tree, git history, terminal, toast), `animations.css` (keyframes, skeleton), `pwa.css` (window controls overlay), `utilities.css` (line clamp helpers). `globals.css` is now an 11-line import manifest. No style changes.

### Feature: stale-while-revalidate board caching for project switches

- Switching between previously visited projects now shows the cached board state immediately instead of a loading spinner. Fresh data loads in the background and seamlessly replaces the cached version. Board state (tasks, columns, sessions, workspace metadata) is cached per project in memory with a 5-minute TTL and 10-entry limit. `canPersistWorkspaceState` stays false until authoritative data arrives, preventing stale data from being written back to disk. Complements the existing preload-on-hover cache (which handles first visits) with longer-lived caching for revisits.

### Feature: auto-sync task base ref on branch change

- Task base ref now auto-updates when the worktree's branch changes (e.g. checking out a feature branch forked from `develop` updates the base ref from `main` to `develop`). Detection runs during the existing metadata polling cycle — resolves via upstream tracking ref, then falls back to merge-base distance against well-known integration branches. The "from X" label in the top bar is now clickable, opening a popover to manually set the base ref and pin it (preventing auto-updates). Pinned base refs show a lock icon.

### Feat: wire inline diff comments to agent terminal

- Connected the existing inline comment UI in the diff viewer to the agent terminal. Click any diff line, type a comment, then Cmd+Enter pastes formatted comments into the agent's terminal (Add), or Cmd+Shift+Enter pastes and submits (Send). Callbacks created in `CardDetailView` using `sendTaskSessionInput`, threaded through `GitView` → `DiffViewerPanel`. Removed orphaned `handleAddReviewComments`/`handleSendReviewComments` from `useBoardInteractions` — they were never consumed.

### Branch management — rebase onto, rename branch, reset to here

- **Rebase onto** — context menu action in branch selector popover and git history refs panel. Rebases the current branch onto the selected ref. Integrates with the existing conflict resolver for multi-round rebase conflicts. Confirmation dialog warns about history rewriting. Disabled on current branch.
- **Rename branch** — context menu action on local branches. Dialog with pre-filled editable input. Validates uniqueness and disables on worktree-locked branches.
- **Reset to here** — context menu action on any branch or ref. Performs `git reset --hard` to the selected ref. Danger-styled confirmation dialog. Works in both home repo and task-scoped worktrees.

### Perf: headless mirror batching and scrollback reduction

- Server-side headless terminal mirrors now batch output writes when no browser viewer is connected — chunks accumulate for up to 160ms and flush as a single `terminal.write()`, dramatically reducing event loop contention with many concurrent agents.
- Batching disables instantly when a viewer attaches (warmup/task switch) and re-enables when the last viewer detaches.
- Reduced terminal scrollback from 3,000 to 1,500 lines on both server and client, halving per-terminal memory and snapshot serialization cost.

### Refactor: remove CLI task commands and enforce single-writer pattern

- Removed the `quarterdeck task` CLI subcommands (create, update, trash, delete, start, link, unlink, list) — all board operations are now exclusively handled by the browser UI.
- Deleted `mutateWorkspaceState` — the only server-side board state writer that could race with the UI's single-writer persist cycle.
- Refactored `migrate-task-working-directory` to broadcast a lightweight `task_working_directory_updated` WebSocket message instead of writing board state server-side. The UI applies the change to its local board and persists through its normal debounced cycle, following the established `task_title_updated` pattern.

### Refactor: complete domain logic extraction from hooks (Phase 2 final)

- **Batch 3** — Extracted 7 more domain modules: `notifications/audible-notifications.ts` (column derivation, sound event resolution, settle window, visibility, project suppression), `debug-logging.ts` (log merging, filtering, tag extraction, disabled-tag persistence), `task-editor.ts` (branch ref resolution, plan mode incompatibility, task save validation), `board/review-auto-actions.ts` (auto-review eligibility, column mapping, review card collection, auto-trash mode), `terminal/shell-auto-restart.ts` (rate limiting, restart target parsing, restart eligibility), `board/linked-backlog-task-actions.ts` (dependency error messages, trash warning view model), `shortcut-actions.ts` (label collision detection, shortcut creation validation). 119 new domain-level unit tests across 7 test files.
- Confirmed `use-board-interactions` and `use-task-start` as pure orchestration hooks — no extractable domain logic. Phase 2 now fully complete: 16 domain modules, 211 domain-level unit tests total.

### Refactor: split audible-notifications test into focused modules

- Split the 1,393-line `use-audible-notifications.test.tsx` into 4 focused test files + shared test utilities module, all under 500 lines. Same 31 tests, same assertions.

### Refactor: split linked backlog task actions test file

- Split the 1,096-line `use-linked-backlog-task-actions.test.tsx` into a shared test harness (183 lines) and 3 focused test files — core actions (265), trash confirmation dialog (321), worktree notice toast (385). All under the 500-line target. 22 tests, zero behavior change.

### Refactor: split runtime-state-stream integration tests into focused files

- Broke the 1,126-line monolithic `runtime-state-stream.integration.test.ts` into 4 sub-500-line files grouped by domain: `project-discovery` (3 tests), `project-management` (2 tests), `state-streaming` (3 tests), `server-restart` (3 tests). Extracted shared board factory helpers (`createBoard`, `createReviewBoard`) into `test/utilities/board-factory.ts`.

### Fix: Windows compatibility — path resolution and signal handling

- Use `path.isAbsolute()` instead of `startsWith("/")` for detecting absolute paths in git conflict detection and state backup restore — fixes broken path resolution on Windows where absolute paths start with a drive letter.
- Guard the parent-disconnect self-signal in the CLI entry point with a platform check — SIGHUP is not a valid signal on Windows and would crash the process; uses SIGTERM on Windows instead, which the graceful shutdown handler already listens for.

### Fix: restore sidebar panel state when returning to agent chat

- Switching from agent chat (terminal view) to a full-screen view (file browser, git) and back now automatically reopens the previously-open sidebar panel (e.g. task column). The auto-collapse on view switch saves what was open; returning to terminal restores it. Manual sidebar toggles, home navigation, and project switches clear the saved state so restoration only fires for the specific auto-collapse → return flow.

### Refactor: split runtime-config test file into focused modules

- Split the 951-line `runtime-config.test.ts` into 5 focused test files + shared helpers module, all under 250 lines. Extracted repeated 40-field save payloads into a `createDefaultSavePayload()` factory. No test logic changes — same 28 tests, same assertions.

### Refactor: split terminal-pool test file

- Split the 1,002-line `terminal-pool.test.ts` monolith into three focused test files by domain: `terminal-pool-acquire.test.ts` (acquire, release, slot lookup), `terminal-pool-lifecycle.test.ts` (init, warmup, eviction, rotation, attach/detach), `terminal-pool-dedicated.test.ts` (dedicated terminals, write, session status). All 42 tests preserved.

## [0.9.2] — 2026-04-15

### Fix: remember last viewed file when switching tasks

- Git view now restores the previously selected file when switching back to a task, instead of resetting to the first file. Uses the existing `lastSelectedPathByScope` per-task cache — replaced the unconditional null reset with scope-aware eager restoration on task switch, matching the pattern in `use-file-browser-data.ts`.

### Fix: preserve file browser scroll position and expanded dirs across navigation

- File browser tree panel now saves and restores its scroll position when navigating away and back (switching tasks, toggling views). Uses the virtualizer's `initialOffset` for flash-free restoration with a module-level Map keyed by scope.
- Expanded directory state and initialization flag are now persisted per scope in `FilesView`, so switching tasks no longer collapses the tree and re-runs initial expansion.

### Refactor: extract domain logic from hooks into plain TS modules (Phase 2)

- **Batch 1** — Split 3 priority hooks into domain module + thin React wrapper pairs: `task-lifecycle.ts` (board revert helpers, workspace info mapping, isolation predicate), `conflict-resolution.ts` (step-change detection, unresolved path filtering, external resolution detection), `workspace-sync.ts` (session merging, revision conflict guards, board hydration decisions). 29 new domain-level unit tests across 3 test files.
- **Batch 2** — Extracted 6 more hooks: `git-actions.ts` (loading state derivation, workspace info matching, error titles), `terminal-panels.ts` (geometry estimation, pane height persistence, panel state helpers), `settings-form.ts` (form values type, initial values resolver, equality check), `commit-panel.ts` (selection sync, commit validation, success formatting), `trash-workflow.ts` (types, initial states, trash column queries), `project-navigation.ts` (error parsing, picker detection, manual path prompt). 63 new domain-level unit tests across 6 test files. Phase 2 now 9 of ~11 candidates done.

### Docs: hooks architecture conventions (Phase 3)

- Added "Hooks architecture" section to `docs/web-ui-conventions.md` — codifies directory structure, domain module vs hook separation pattern, naming conventions, backward-compatible re-exports, and reference table of all 9 existing extractions. Updated `AGENTS.md` to reference the new conventions and add the >50-line extraction rule.

### Refactor: extract ConnectedTopBar, HomeView, and AppDialogs from AppContent

- Extracted three JSX-heavy sections from AppContent (1348 → 820 lines) into dedicated components. Each reads from existing contexts and receives only hook-local values as props — pure JSX extraction with zero behavior change. ConnectedTopBar (184 lines) owns the TopBar with branch pill and git sync wiring; HomeView (271 lines) owns the loading/empty/board/git/files view switch and bottom terminal; AppDialogs (234 lines) owns all 18 dialog/shelf components.

### Fix: dedicated shell terminals blank after close/reopen

- Closing and reopening a shell terminal (home or detail dev shell) could leave the terminal blank or broken. The xterm canvas was orphaned from the DOM when React unmounted the panel container, causing WebGL context loss. Added `park()` to `TerminalSlot` — moves the host element back to the off-screen parking root before the container is removed, keeping the canvas in the live DOM so it survives the round-trip.

### Fix: auto-restart only fires for genuine crashes, not normal agent exits

- `shouldAutoRestart` now checks the pre-exit session state — only restarts when the agent was actively `running` at exit time. Agent processes that exit after completing work (already in `awaiting_review`) are normal lifecycle cleanup, not crashes.
- The state machine's `process.exit` handler now preserves the existing review reason when the session is already in `awaiting_review`. Previously it unconditionally overwrote the reason (e.g. `hook` → `error`), making completed tasks show "Error" instead of "Ready for review".
- `recoverStaleSession` only attempts restart for `reviewReason: "error"` (genuine crash). Previously it restarted for any non-`exit` reason, causing spurious restarts on viewer reconnect.
- Reconciliation sweep treats all processless `awaiting_review` sessions as expected — the agent finished and the process exited as normal cleanup.

### Fix: auto-focus agent terminal on open

- Opening an agent terminal now immediately grabs keyboard focus. Previously, `terminal.focus()` fired before the restore snapshot completed — while the terminal was still `visibility: hidden` — so the browser silently ignored it. Focus is now deferred until the terminal is revealed after restore, including the restore-failure path.

### Refactor: rename debug-logger to runtime-logger

- Renamed `src/core/debug-logger.ts` to `src/core/runtime-logger.ts` — the "debug" name was a holdover from when logging was a boolean on/off toggle. Renamed internal types (`DebugLogLevel` → `LogLevel`, `DebugLogEntry` → `LogEntry`) and functions (`getRecentDebugLogEntries` → `getRecentLogEntries`, `onDebugLogEntry` → `onLogEntry`) to match. API contract wire-format schemas unchanged.
- Added `HH:MM:SS` local-time timestamps to all console log output from the runtime logger.
- Bumped orphan cleanup "found" and "killed" log messages from `info` to `warn` so they appear at the default threshold.

### Refactor: complete frontend provider migration

- Migrated all hook/state logic from the monolithic App.tsx into 6 focused provider components (ProjectProvider, BoardProvider, TerminalProvider, GitProvider, InteractionsProvider, DialogProvider). Eliminated the AppCore intermediate component. App is now a ~50-line composition root; each provider is independently maintainable. AppContent props reduced from 35+ to 2.

### Refactor: organize web-ui hooks into domain subdirectories

- Reorganized the flat 78-file `hooks/` directory into 5 domain subdirectories (`board/`, `git/`, `terminal/`, `project/`, `notifications/`) — hooks are now grouped by the domain they serve. Relocated 5 non-hook files (utility functions, constants, React components) to their proper directories (`utils/`, `terminal/`, `components/`). ~123 import sites updated across ~40 files. Pure structural change — no logic modifications.

## [0.9.1] — 2026-04-15

### Fix: preserve terminal review reasons across server restart

- Sessions in `awaiting_review` with a terminal review reason (`hook`, `exit`, `error`, `attention`, `stalled`) now survive server restarts and shutdowns — they represent completed agent work or explicit review requests. Previously, both `hydrateFromRecord` (startup) and the shutdown coordinator unconditionally overwrote them to `interrupted`, losing the meaningful review state.
- Only `running` sessions and `awaiting_review` sessions with non-terminal reasons (`interrupted`, `null`) are marked interrupted for auto-resume.

### Fix: CI test failures — bare repo branch name, stale hydration assertions

- Fixed `git-stash.test.ts` `dirtyTree` test: bare repo `git init` missing `-b main` caused `push origin main` to fail on CI runners with `init.defaultBranch=master`.
- Updated 4 test files with assertions that expected `awaiting_review` → `interrupted` after hydration to match the new preserve-terminal-reasons behavior.

### Fix: reconnect terminal WebSockets after sleep/wake

- After a computer sleeps and wakes, WebSocket connections die but the terminal pool still held slot references for the task. `acquireForTask()` and `ensureDedicatedTerminal()` returned the existing slot without reconnecting, leaving the terminal blank despite a live agent session. Added `ensureConnected()` to `TerminalSlot` and a `visibilitychange` reconnection path so terminals auto-recover on wake.

### Perf: auto-evict PREVIOUS terminal slot after 30 seconds

- Hidden PREVIOUS terminal slots kept their IO WebSocket open indefinitely, causing xterm.js to parse incoming PTY bytes and execute WebGL draw calls into an invisible canvas — driving GPU work and WindowServer compositing overhead. PREVIOUS slots now auto-evict after 30 seconds, closing sockets and stopping rendering. Switching back within 30s still reuses the warm slot instantly; after 30s the slot is reacquired fresh with a server restore.

### Fix: background terminal re-sync on task switch

- When switching tasks, the previously-active terminal slot is demoted to PREVIOUS but keeps its WebSocket connections open. The xterm buffer could drift into a garbled visual state during this period, which persisted if the user switched back before the slot was evicted. Now `requestRestore()` fires on demotion — re-syncing the buffer from the server's headless mirror while the user isn't looking — so the terminal is clean on return.

### Fix: compare view branch dropdown left-click

- Left-clicking a branch in the compare bar's source/target dropdowns opened the context menu instead of selecting the branch. Added `disableContextMenu` to both `BranchSelectorPopover` instances in `CompareBar` so left-click performs direct selection.

### Fix: noisy auto-restart warning on task trash

- Trashing a running task triggers `stopTaskSession` → SIGHUP → exit code 129. The exit handler logged this as a `warn`-level "auto-restart skipped" message even though the skip was intentional. Changed `shouldAutoRestart` to return a discriminated union with a `reason` field (`suppressed` | `no_listeners` | `rate_limited`) so the caller can log intentional suppression at `debug` instead of `warn`. Added `displaySummary` to session exit and auto-restart skip log lines for easier task identification.

## [0.9.0] — 2026-04-15

### Fix: resolved conflicts reappearing in auto-merged section during merge

- After resolving a conflict file, the next metadata poll re-classified it as "auto-merged" (it appeared in `git diff --cached` but was no longer in the unmerged set). This caused duplicates in the file list and permanently blocked the "Complete Merge" button — the file couldn't be "accepted" in the auto-merged section because the detail pane showed "File resolved" with no action button. Fixed by filtering `resolvedFiles` out of the effective auto-merged list in the UI.

### Diagnostic: idle session lifecycle logging

- Added 4 structured diagnostic events to trace why agent processes die and sessions drop to idle: `server.started`, `workspace.terminal_manager_created`, `session.autorestart_skipped` (warn), `session.recover_to_idle` (warn). All log to both the console logger (debug ring buffer / WebSocket) and the JSONL event log.
- `hydrateFromRecord` now marks `awaiting_review` sessions as `interrupted` (same as `running` sessions) during workspace bootstrap, feeding them into `resumeInterruptedSessions` on first viewer connect instead of dropping to idle via `recoverStaleSession`.
- Added convention to `event-log.ts`: every `emitEvent`/`emitSessionEvent` call should have a corresponding console log unless there's a specific reason to omit it.

### Feature: three-dot diff in compare view

- Added "Only branch changes" toggle to the compare bar (default on). When enabled, diffs show only changes the branch introduced since diverging from the base, excluding base-side changes — matching GitHub/GitLab PR diff behavior.
- Backend uses native `git diff A...B` syntax for ref-to-ref comparisons and `git merge-base` for ref-vs-working-tree. File content loading reads the old side from the merge-base instead of the raw fromRef.
- Toggle persists to localStorage independently of "Include uncommitted work".

### Refactor: unify default branch resolution

- Unified three independent "default branch" paths into a single `resolveDefaultBaseRef` function with priority chain: config pin → git detection → fallback.
- CLI task creation (`quarterdeck task create`) now respects the user's pinned `defaultBaseRef` config — previously only used git auto-detection.
- Frontend "(default)" label in the branch dropdown now follows the config pin instead of being hardwired to `"main"`.
- Home terminal `baseRef` resolution now respects the config pin.

### Docs: hooks directory refactoring plan

- Added `docs/refactor-hooks-directory.md` — three-phase plan for organizing the 78-file flat `web-ui/src/hooks/` directory. Phase 1: group into domain subdirectories (board, git, terminal, project, notifications). Phase 2: extract domain logic from hooks into pure TS modules (incremental, as-touched). Phase 3: conventions for `web-ui-conventions.md` to prevent re-bloating.

### Fix: card-detail-view test failures after GitContext extraction

- Added `GitContext.Provider` with a noop value to the test harness's `renderWithProviders` — the GitContext extraction (phase 8 step 4) added a `useGitContext()` call in `CardDetailView` but the test wrapper was never updated, breaking all 3 tests.

### Fix: title generation timeout noise

- Bumped title and branch-name generation timeouts from 3s to 5s — matches the summary generator and `callLlm` default fallback. 3s was too aggressive for Bedrock proxy round-trips.
- Timeout errors (`AbortError`) in `llm-client.ts` now log at `debug` level instead of `warn`. Actual failures (network errors, unexpected exceptions) remain at `warn`.

### Fix: remove arrow key task cycling

- Removed the `useHotkeys` bindings that cycled task selection on up/down/left/right arrow keys. The original fix (suppressing inside `.xterm`) was too narrow — focus could land on the terminal panel wrapper, toolbar, or other elements outside the `.xterm` DOM, causing arrow keys to unexpectedly switch the selected task. Removed the feature entirely: `isTypingTarget` helper, `handleSelectAdjacentCard` callback, both hotkey bindings, and the `react-hotkeys-hook` import from `card-detail-view.tsx`. 5007e1de

### Refactor: complete provider shapes and AppProviders compositor — phase 8 step 5

- Created `TerminalContext` (`web-ui/src/providers/terminal-provider.tsx`) — context shape for terminal panel state (`useTerminalPanels` result), connection readiness (`useTerminalConnectionReady`), and derived metadata (home/detail terminal summaries, subtitles, visibility flag).
- Created `InteractionsContext` (`web-ui/src/providers/interactions-provider.tsx`) — context shape for board interactions (`useBoardInteractions` result: drag/drop, trash workflow, task lifecycle) and task start actions (`useTaskStartActions` result).
- Created `AppProviders` compositor (`web-ui/src/providers/app-providers.tsx`) — composes all 6 context providers in dependency order (Project → Board → Terminal → Git → Interactions → Dialog). App.tsx return statement simplified from 4 inline `.Provider` wrappers to a single `<AppProviders>` component.
- All 6 provider shapes now exist; remaining phase 8 work is migrating state/hooks from App.tsx into each provider component.

### Refactor: extract GitContext provider from App.tsx — phase 8 step 4

- Introduced `GitContext` (`web-ui/src/providers/git-provider.tsx`) — owns all git-related state: git actions (`runGitAction`, `switchHomeBranch`, loading/error state), git history toggle, git navigation (`pendingCompareNavigation`, `pendingFileNavigation`, `navigateToFile`, `navigateToGitView`), home file browser scope context, and the derived `gitSyncTaskScope`.
- `CardDetailView` now reads git navigation, git history, conflict detection, and pull/push callbacks from `useGitContext()` instead of props — removes 12 props (`isGitHistoryOpen`, `onToggleGitHistory`, `pendingCompareNavigation`, `onCompareNavigationConsumed`, `onOpenGitCompare`, `pendingFileNavigation`, `onFileNavigationConsumed`, `navigateToFile`, `onConflictDetected`, `onPullBranch`, `onPushBranch`).
- Context value constructed in App.tsx via `useMemo`, provider wraps inside `BoardContext.Provider`. Hooks remain in App.tsx — only their return values are exposed via context.

### Feat: state backup system with periodic snapshots

- Added automatic state backup system that snapshots critical files (`config.json`, `workspaces/index.json`, per-workspace `board.json`, `sessions.json`, `meta.json`, `pinned-branches.json`) to `~/.quarterdeck-backups/` — a sibling directory that survives a wipe of `~/.quarterdeck/`.
- Backups are created automatically on server startup and periodically (default every 30 minutes, configurable via `backupIntervalMinutes`). Periodic backups use mtime+size fingerprinting to skip no-op snapshots when nothing has changed.
- CLI commands: `quarterdeck backup create` (manual snapshot), `quarterdeck backup list` (show available backups), `quarterdeck backup restore [name]` (restore from a backup). Automatic pruning retains the 10 most recent backups.
- Backup location overridable via `QUARTERDECK_BACKUP_HOME` environment variable.

### Refactor: C#-style readability — phase 3 (shared service interfaces, message factories, dispatch map)

- Created 5 shared service interfaces in `src/core/service-interfaces.ts` (`IRuntimeBroadcaster`, `ITerminalManagerProvider`, `IWorkspaceResolver`, `IRuntimeConfigProvider`, `IWorkspaceDataProvider`) — replaces 4 bespoke `Create*Dependencies` bags that each re-declared the same function signatures. `RuntimeStateHub` extends `IRuntimeBroadcaster`; `WorkspaceRegistry` extends the 4 workspace interfaces. API consumers accept nested `{ config, broadcaster, terminals, workspaces, data }` objects instead of flat function plucking.
- Extracted 11 message factory functions into `src/server/runtime-state-messages.ts` — all 14 inline `satisfies` object constructions in `RuntimeStateHub` replaced with one-liner factory calls.
- Created typed WebSocket dispatch map (`web-ui/src/runtime/runtime-stream-dispatch.ts`) — compiler-enforced handler map keyed by message type replaces the 110-line if/else chain in `use-runtime-state-stream.ts`. Adding a new message type causes a compile error until a handler is added.
- Simplified `runtime-server.ts` wiring from 42 individually plucked functions to passing service objects directly. Removed redundant `ensureTerminalManagerForWorkspace` from server deps (available via `workspaceRegistry`).
- Split `RuntimeApiImpl` handler methods into 11 individual files under `src/trpc/handlers/` — `RuntimeApiImpl` is now a ~90-line thin dispatcher that delegates to standalone handler functions, each with explicit dependency interfaces. Completes section 5 of the readability roadmap.

### Fix: terminal scroll flash when switching to stale tasks

- Switching to a task whose terminal slot was evicted from the pool caused the entire chat history to visibly scroll past as xterm rendered the restore snapshot. mount() now defers visibility when restoreCompleted is false — the terminal stays hidden until the snapshot is fully written and scrolled to bottom, then appears instantly.
- Socket error/close handlers call ensureVisible() as a safety net so the terminal never stays permanently hidden if the restore message never arrives.
- Warmup timeout no longer fires while the card is still hovered — the 3s grace period now starts on mouseLeave instead of mouseEnter, so hovering for >3s before clicking still gets a warm slot.
- Sidebar task cards now trigger terminal warmup on hover, matching the main board cards (was missing onTerminalWarmup/onTerminalCancelWarmup passthrough from CardActionsContext).
- Eliminated DOM reparent on task switch via pre-mount architecture: all 4 pool slots are staged in a shared container via `attachPoolContainer()`/`attachToStageContainer()` when the terminal panel mounts. `mount()` replaced with `show()` (visibility toggle + `terminal.refresh()` insurance), `unmount()` replaced with `hide()` (visibility toggle). No `repairRendererCanvas` or SIGWINCH on normal task switch.
- Added `document.visibilitychange` listener per slot — repaints the visible terminal when the browser tab returns to foreground (handles GPU texture eviction during backgrounding).
- `requestResize` guard loosened to `visibleContainer ?? stageContainer` so warmup can send correct dimensions to the server before the slot is shown.
- Pool rotation stages replacement slots into the container if one is registered.
- `show()` now calls `scrollToBottom()` after `fitAddon.fit()` when the terminal is already restored, so switching tasks snaps to the latest output instead of showing a stale scroll position. Reveal deferred until after fit+scroll to prevent a visible frame at the old position. A one-shot `pendingScrollToBottom` flag re-scrolls after the first ResizeObserver-driven reflow.
- Post-restore resize guard widened to `visibleContainer ?? stageContainer` so warmup sends correct browser dimensions to the server immediately after restore — eliminates dimension mismatch that caused intermittent TUI layout gaps.

### Fix: remove unauthenticated `resetAllState` endpoint

- Removed the `runtime.resetAllState` tRPC endpoint, which recursively deleted `~/.quarterdeck` and `~/.quarterdeck/worktrees` with no authentication — any process on localhost could call it. Also removed the "Reset all state" button and confirmation dialog from the debug tools UI, the `prepareForStateReset` server callback, the frontend `resetRuntimeDebugState` helper, and all associated types, schemas, and tests.

### Refactor: C#-style readability — phase 1 & 2 (named types, IDisposable, class conversions)

- Installed `neverthrow` (typed `Result<T,E>`) and `mitt` (typed event emitter) for incremental adoption — no callsite changes yet, packages available for phase 3+.
- Replaced `ReturnType<typeof>` gymnastics with named types across 11 sites in 9 files — `ResolvedAgentCommand`, `RuntimeConfigState`, `PreparedAgentLaunch`, `RuntimeWorkspaceStateResponse`, `ReconciliationTimer` (new), `RuntimeTrpcClient` (new), `RuntimeServerHandle` (new), `CardSelection`, and direct types for `UseRuntimeStateStreamResult` fields.
- Created `src/core/disposable.ts` — `IDisposable` interface, `toDisposable()`, `DisposableStore`, and `Disposable` base class (~70 lines). Equivalent to VS Code's lifecycle primitives.
- Converted `RuntimeStateHub` from 550-line factory-closure to `RuntimeStateHubImpl` class extending `Disposable` — 7 closure Maps/Sets become private readonly fields, 130-line inline WebSocket handler becomes `handleConnection()` pipeline, metadata monitor and debug log subscription managed via `_register()`.
- Converted `RuntimeApi` from 615-line factory-closure to `RuntimeApiImpl` class — handler methods organized by section (Config, Sessions, Shell, Debug, Migration), `createRuntimeApi()` wrapper preserved for backward compatibility.

### Refactor: begin App.tsx context provider extraction — DialogContext, ProjectContext, BoardContext

- Introduced `DialogContext` (`web-ui/src/providers/dialog-provider.tsx`) — the first step of the App.tsx provider split described in `docs/refactor-csharp-readability.md` section 8. Defines a typed context for all dialog open/close state, debug tools, and debug logging.
- Extracted `DebugShelf` component (`web-ui/src/components/debug-shelf.tsx`) — renders the DebugLogPanel and DebugDialog by reading from `useDialogContext()` instead of receiving 25+ props from App.tsx. Removes ~30 lines of inline JSX from App.tsx.
- Introduced `ProjectContext` (`web-ui/src/providers/project-provider.tsx`) — the second provider in the extraction. Surfaces project navigation, runtime config (both current and settings scope), startup onboarding, access gate, and all config-derived values + mutation callbacks.
- Extracted `ProjectDialogs` component (`web-ui/src/components/project-dialogs.tsx`) — renders StartupOnboardingDialog and GitInitDialog by reading from `useProjectContext()`.
- Introduced `BoardContext` (`web-ui/src/providers/board-provider.tsx`) — owns board data, task sessions, and task selection state (`board`, `setBoard`, `sessions`, `upsertSession`, `selectedTaskId`, `selectedCard`, `setSelectedTaskId`). `CardDetailView` now reads `board`, `taskSessions`, and `upsertSession` from context instead of props, removing 3 of its 55 props.
- All three contexts are constructed in App.tsx via `useMemo` and provided inline. Hooks stay in App.tsx — child components opt into context reads incrementally.

### Perf: replace per-task xterm instances with fixed 4-slot terminal pool

- Terminals are no longer created and destroyed per task. A pool of 4 pre-allocated `TerminalSlot` instances is reused across tasks via `connectToTask`/`disconnectFromTask`. Only the currently viewed task (ACTIVE) and the previously viewed task (PREVIOUS) keep live WebSocket connections — all other slots are free for warmup or rotation.
- Hovering a task card pre-connects a pool slot (PRELOADING → READY), so clicking it shows the terminal near-instantly instead of waiting for WebSocket handshake + restore.
- Scrollback reduced from 10,000 to 3,000 lines on both client and server mirrors — sufficient for agent sessions and significantly lighter with 4 concurrent terminals.
- Server-side (`ws-server.ts`): output chunks are no longer buffered for viewers whose IO socket is intentionally disconnected, preventing unbounded memory growth during long sessions.
- Dedicated terminals (home shell, dev shells) remain outside the pool with their own lifecycle.
- Proactive slot rotation every 3 minutes replaces the oldest idle slot to prevent xterm canvas/WebGL resource staleness in long sessions.
- Project switch cleanup properly releases all pool slots and disposes all dedicated terminals.
- Task switch no longer triggers a redundant server restore round-trip — the existing buffer is already current. Canvas repair (dimension bounce + texture rebuild) now completes while hidden, eliminating visible flicker.
- Session restart detection added to the pool path — stale scrollback from a previous session is cleared when `sessionStartedAt` changes.
- Deleted compatibility shims (`warmupPersistentTerminal`/`cancelWarmupPersistentTerminal`) and dead `deferredResizeRaf` code.

### Fix: simplify notification settings — merge completion into review

- Removed the separate "Completion" notification event. Successful agent exits now use the "Review" sound and setting, since both mean "task needs your attention." The notification settings grid drops from 4 rows to 3 (Permission, Review, Failure).
- Renamed the confusing "Other projects only" column header to "Mute focused project" for clarity.
- Updated the Review event description from "Task is ready for review" to "Task finished or needs attention" to reflect its broader scope.

### Fix: un-trash no longer flashes error state during reconnect

- Un-trashing a card no longer shows a red "Error" status pill while the session reconnects. The race was between `startTaskSession` (async spawn in-flight) and `recoverStaleSession` (triggered by the terminal WebSocket connecting before the spawn completes). A `pendingSessionStart` flag on `ProcessEntry` now guards both `recoverStaleSession` and the reconciliation sweep from clobbering the session state during the async gap.

### Feature: inline scrollable diffs with last-viewed persistence

- The compare, uncommitted, and last turn tabs in the git view now show all file diffs inline in a single scrollable list — no need to click individual files on the left to load their diffs. Diffs load progressively with per-file loading skeletons that fill in as each file's content arrives.
- The file tree panel becomes a jump-to navigator: clicking a file scrolls to its diff section, and the tree highlight follows the scroll position.
- Switching away from a git view tab and back restores the last-viewed file position instead of resetting to the top. Persistence is scoped per task and per tab, stored in localStorage.
- Scroll-sync ping-pong (where scrolling in the compare view snapped the file selection back to the first file) is eliminated by removing the single-file fetch chain that caused the re-render cycle.

### Feature: commit sidebar improvements — stash relocated, generate-message button

- Stash and Discard All buttons moved above the commit message textarea, visually separating "save/discard work" actions from "commit" actions. Stash is now immediately accessible without scrolling past the message input.
- Added a Sparkles (generate) button in the top-right corner of the commit message textarea. Sends the selected files' diff to the LLM pipeline (same Haiku model used for title and summary generation) and populates the textarea with the result. The message is fully editable before committing. Gracefully falls back when LLM is not configured — button shows a warning toast instead of failing silently.
- New backend: `generateCommitMessage` tRPC mutation, `commit-message-generator.ts` generator module, `getDiffText` workspace API helper.

### Docs: C#-style readability refactoring roadmap

- Added `docs/refactor-csharp-readability.md` — an 8-section plan to make the TypeScript codebase navigable like a well-structured C# solution. Covers typed errors (`neverthrow`), typed events (`mitt`), VS Code's IDisposable lifecycle pattern, factory-closure to class conversions, shared service interfaces, message factory functions, and App.tsx provider extraction.
- Replaced todo #18 (App.tsx investigation) with the broader roadmap that subsumes it.

### Feature: per-event scoped notification beeps

- Each notification event type (permission, review, failure, completion) can independently be configured to only beep for tasks in other projects, suppressing sounds for the currently viewed project. The settings dialog notifications section now displays events in a two-column grid with "Enabled" and "Other projects only" columns per event type.
- Settings dialog widened from 600px to 960px to accommodate the grid layout.
- The per-event suppress check runs at sound-fire time (after the settle window), so switching projects during the window uses the correct project context.

### Feature: log level setting replaces boolean debug toggle

- The runtime debug logger now uses a four-level threshold (`debug`, `info`, `warn`, `error`) instead of an on/off boolean. Default is `warn` — only warnings and errors are captured. Setting `info` captures informational messages like orphan cleanup without the full debug firehose.
- The log level is persisted in `config.json` as `logLevel` and applied at startup.
- The debug log panel (Cmd+Shift+D) is now a pure viewer — opening/closing it no longer toggles server-side logging. A "capture:" dropdown in the panel header changes the runtime log level. A "show:" label clarifies the filter bar is for local display filtering only.
- The `setDebugLogging` boolean tRPC endpoint is replaced by `setLogLevel` which accepts a level string.

### Fix: arrow key task navigation suppressed when terminal is focused

- Arrow keys (up/down/left/right) no longer navigate between tasks when an xterm.js terminal has focus. The `isTypingTarget` guard in `CardDetailView` now checks `closest(".xterm")` in addition to INPUT/TEXTAREA/contentEditable, so keystrokes inside terminals go to the terminal instead of cycling the selected card.

### Fix: trash confirmation dialog always shown

- The trash button on task cards now always shows a confirmation dialog before trashing, regardless of whether the task has uncommitted changes. Previously the dialog was only shown when the workspace snapshot reported changed files — tasks with no changes, or whose snapshot hadn't loaded yet, were trashed immediately without asking. The dialog adapts its message: tasks with uncommitted changes get the full warning about worktree deletion and patch capture; clean tasks get a simpler "are you sure?" prompt.

### Fix: branch name click in dropdown opens context menu instead of closing

- Left-clicking a branch row in the top bar branch dropdown now opens the context menu (checkout, compare, merge, copy, etc.) instead of immediately navigating to that branch's file view and closing the dropdown. The old file-browsing action is available as "Browse files" — the first item in the context menu. The `disableContextMenu` codepath (file browser dropdown) retains the original direct-select behavior.

### Fix: git conflict tests fail on CI due to default branch name

- Test helpers (`git init`) didn't specify a branch name, so runners with `init.defaultBranch=master` failed on `checkout main`. Added `-b main` to `git init` in all test `initRepository` functions and the shared `initGitRepository` helper.

### Fix: permission badge clobbered by terminal focus event

- Selecting a "Waiting for Approval" card no longer clears the permission badge. xterm.js focus reporting (`DECSET 1004`) sends `\x1b[I` when the terminal panel gains focus — `writeInput` was treating this protocol response as user interaction and clearing `latestHookActivity`. Added `isTerminalProtocolResponse()` to filter focus-in/out and DSR cursor position reports from the permission-clearing path.

### Refactor: file browser uses filesystem listing for on-disk repos

- The file browser tree now lists files via `fs.readdir` instead of `git ls-files` when viewing on-disk repos (home and task worktrees). Shows everything actually on disk rather than a git-filtered view. Branch browsing (refs not checked out) still uses `git ls-tree`. No new dependencies.

### Docs: comprehensive performance audit

- Rewrote `docs/performance-bottleneck-analysis.md` with a full audit covering all subsystems — state persistence, WebSocket broadcasting, frontend memory, terminal/PTY backpressure, tRPC/API polling, git operations, and React rendering. Documents what shipped since the previous 2026-04-07 audit (lazy diff loading, scoped metadata refresh, terminal backpressure redesign, chat message removal) and identifies remaining medium-severity items (undebounced state broadcasts, uncached workspace snapshots, global project broadcasts, metadata polling cost).

### Fix: remove drag-and-drop from sidebar task column

- Sidebar task cards are no longer draggable — the `DragDropContext`, `Droppable`, and `Draggable` wrappers are removed from the column context panel. Cards are still clickable, hoverable, and support all existing actions (start, trash, pin, edit, etc.). Main board drag-and-drop is unaffected.

### Fix: base ref dropdown not resetting to user's default on dialog open

- The create task dialog now resets the base ref dropdown to the user's default (pinned or auto-detected) each time it opens, instead of retaining whatever branch was used for the previous task.
- Removed the misleading "(default)" label from git-detected branches in the dropdown — it was independent of the user's pinned default and couldn't be overridden, causing confusion when both were visible. The pin icon is the authoritative default indicator.
- Added todo #19 and `docs/refactor-default-branch.md` documenting the three independent default-branch systems and a plan to unify them.

### Refactor: file browser branch dropdown cleanup

- Disabled right-click context menus on the file browser's branch dropdown (`BranchSelectorPopover`) via a new `disableContextMenu` prop — the top bar dropdown retains context menus. Renamed local App.tsx aliases from ambiguous `home*` prefix (`homeBranchActions`, `homeResolvedScope`, etc.) to `fileBrowser*` to clarify they're scoped to the file browser, not the top bar.

### Feature: editable worktree system prompt

- The hardcoded worktree context prompt appended to Claude agent sessions via `--append-system-prompt` is now a user-editable template stored in global config (`worktreeSystemPromptTemplate`). Supports `{{cwd}}`, `{{workspace_path}}`, and `{{detached_head_note}}` placeholders resolved at launch time. A collapsible editor in Settings > Agent lets users customize the prompt and reset to the built-in default. Only applies to worktree sessions — non-worktree behavior is unchanged.

### Docs: todo roadmap updates

- Replaced the Go backend rewrite todo with a standalone desktop app (Electron/Tauri) todo — browser-tab limitations (duplicate connections, no window management, no OS integration) are the bigger pain point.

> Prior entries (0.8.0 and earlier) in `docs/changelog-through-0.8.0.md` and `docs/changelog-through-0.5.0.md`.
