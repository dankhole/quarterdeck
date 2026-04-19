# Implementation Log

> Prior entries in `docs/implementation-archive/`: `implementation-log-through-0.9.4.md`, `implementation-log-through-2026-04-15.md`, `implementation-log-through-2026-04-12.md`.

## Enhancement: ghost-until-open base ref branch selector (2026-04-19)

**What:** The base ref `BranchSelectDropdown` in task creation views now renders as a transparent ghost button until the popover is opened.

**Why:** The solid button drew too much visual attention in the create card, competing with the primary input. A ghost button blends with the surrounding UI until the user interacts with it.

**Changes:**
- Added `ghostUntilOpen` prop to `SearchSelectDropdown` — when true, the trigger uses the `ghost` Button variant while closed and switches to `default` when the popover opens.
- Threaded the prop through `BranchSelectDropdown`.
- Enabled `ghostUntilOpen` on both call sites: `task-inline-create-card.tsx` and `task-create-dialog.tsx`.

**Files touched:** `web-ui/src/components/search-select-dropdown.tsx`, `web-ui/src/components/git/branch-select-dropdown.tsx`, `web-ui/src/components/task/task-inline-create-card.tsx`, `web-ui/src/components/task/task-create-dialog.tsx`, `CHANGELOG.md`, `docs/implementation-log.md`.

## Docs: refactor agent instruction docs around AGENTS.md (2026-04-19)

**What:** Established `AGENTS.md` as the single canonical agent-instructions file. Slimmed `CLAUDE.md` to a minimal compatibility shim. Moved duplicated developer content to human-facing docs. Added a CI check script to prevent drift. Rewrote the Codex todo items to reflect native hook support.

**Why:** `CLAUDE.md` had grown to ~140 lines duplicating content that belonged in `README.md`, `DEVELOPMENT.md`, and `AGENTS.md`. This created maintenance drift — updates to one file didn't propagate to the other. The Codex todo section was a stale status dump rather than actionable work items.

**Changes:**
- `CLAUDE.md` — replaced ~140 lines with an 11-line shim that imports `@AGENTS.md` and points to `@README.md`, `@DEVELOPMENT.md`, `@docs/README.md`.
- `AGENTS.md` — added "Agent instruction files" section documenting the canonical/shim relationship and the check script. Added `docs/archive/` gitignored note.
- `DEVELOPMENT.md` — added quick reference, repo orientation, and CI/CD sections (content relocated from `CLAUDE.md`).
- `README.md` — added "Contributor docs" section linking to `DEVELOPMENT.md`, `docs/README.md`, and `AGENTS.md`.
- `docs/README.md` — added `DEVELOPMENT.md` and `AGENTS.md` to the file-purpose list.
- `scripts/check-agent-instructions.mjs` — new CI check validating AGENTS.md canonical marker, CLAUDE.md shim shape (heading, imports, no code blocks, line cap).
- `package.json` — added `check:agent-instructions` script, wired it into `npm run check`.
- `docs/todo.md` — replaced monolithic "Full Codex support" section with four focused items: native hooks, provider-neutral LLM, capability detection, worktree system prompt.
- `src/prompts/prompt-templates.ts` — updated worktree system prompt example from `CLAUDE.md` to `AGENTS.md`.

**Files touched:** `AGENTS.md`, `CLAUDE.md`, `DEVELOPMENT.md`, `README.md`, `docs/README.md`, `docs/todo.md`, `package.json`, `scripts/check-agent-instructions.mjs`, `src/prompts/prompt-templates.ts`.

## Refactor: fix workspace→project/worktree rename oversights (2026-04-19)

**What:** Corrected identifiers that the prior rename pass mis-categorized, plus a handful of stale "workspace" leftovers.

**Why:** The bulk rename (ac1001b0) converted all "workspace" to "project", but several identifiers describe per-task git worktree state (branch, changes, detached HEAD, conflict state) — not the high-level project concept. Using "project" for these muddied the semantic distinction between the project (board/state) and its worktrees (per-task git isolation).

**Changes:**
- **→ worktree** (over-corrected from workspace→project): `RuntimeTaskProjectMetadata` → `RuntimeTaskWorktreeMetadata`, `runtimeTaskProjectMetadataSchema` → `runtimeTaskWorktreeMetadataSchema`, `TrackedTaskProject` → `TrackedTaskWorktree`, `CachedTaskProjectMetadata` → `CachedTaskWorktreeMetadata`, `loadTaskProjectMetadata` → `loadTaskWorktreeMetadata`, `ReviewTaskProjectSnapshot` → `ReviewTaskWorktreeSnapshot`, `useTaskProjectSnapshotValue` → `useTaskWorktreeSnapshotValue`, `useTaskProjectStateVersionValue` → `useTaskWorktreeStateVersionValue`, plus get/set/clear store functions and all local variable names referencing these types.
- **→ project** (stale workspace leftovers): `WORKSPACE_STATE_FILENAMES`, `WORKSPACE_STATE_PERSIST_DEBOUNCE_MS`, `WORKSPACE_ID` test constant.
- **→ worktree** (stale workspace leftover): `NOOP_FETCH_WORKSPACE_INFO` → `NOOP_FETCH_WORKTREE_INFO`.
- **biome.json**: Updated lint rule to reference `createProjectTrpcClient` (function was already renamed).

**Files touched:** 28 files across `src/`, `web-ui/src/`, `test/`, `biome.json`, `CHANGELOG.md`, `docs/implementation-log.md`.

## Refactor: complete workspace → project/worktree/workdir rename (2026-04-17)

**What:** Eliminated all remaining "workspace" references in source, tests, and config — except agent workspace-trust files where "workspace" is the agent's own terminology.

**Why:** The prior rename pass (709e05e7) covered files, directories, API routes, and wire protocol but left ~980 occurrences across 96 files: identifiers, string literals, Zod validation messages, comments, env vars, and test fixture IDs. These created confusion about whether "workspace" meant a project, a git worktree, or a working directory.

**Approach:** Categorized each identifier by its actual semantic role:
- **→ project**: state management, IDs, persistence, sync, settings scope, index entries, env vars
- **→ worktree**: task git worktree operations (`ensureTaskWorktree`, `cleanupTaskWorktree`, `taskWorktreeInfo`)
- **→ workdir**: file change queries (`getWorkdirChanges`, `loadWorkdirChanges`)
- **kept as workspace**: agent workspace trust (Claude/Codex concept)

Also fixed: `@runtime-task-worktree-path` Vite alias pointing to deleted `src/workspace/` directory, stale `workspace-state-query.ts` reference in `biome.json`, stale interface names in `docs/todo.md`.

**Files touched:** 106 files across `src/`, `web-ui/src/`, `test/`, `biome.json`, `web-ui/tsconfig.json`, `web-ui/vite.config.ts`, `web-ui/vitest.config.ts`, `docs/todo.md`, `CHANGELOG.md`.

## Refactor: app shell component decomposition and design guardrails (2026-04-17)

**What:** Split two large app-shell components (`project-navigation-panel.tsx` and `top-bar.tsx`) into focused sub-components, added four design/architecture docs, fixed a pre-existing TS error, and completed a stale workspace→project prop rename.

**Why:** Both components were 600+ lines with multiple independent concerns (drag-and-drop list, removal dialog, onboarding tips, shortcut controls, scope indicators). The design docs capture recurring architectural patterns (optimization-shaped architecture) observed during recent refactor work, giving future agents self-contained context for planned terminal and state-management refactors.

**Approach:** Mechanical extraction — no behavior changes except one minor improvement: the removal dialog now guards `onOpenChange` during pending removal to prevent closing mid-operation. The `isWorkspacePathLoading` prop was renamed to `isProjectPathLoading` at both the `TopBar` interface and the `ConnectedTopBar` call site to complete the workspace→project migration for this surface.

**Files touched:**
- `web-ui/src/components/app/project-navigation-panel.tsx` — gutted to 74L shell importing 4 new files
- `web-ui/src/components/app/project-navigation-list.tsx` — new: drag-and-drop project list + add button
- `web-ui/src/components/app/project-navigation-row.tsx` — new: single project row + skeleton + badge logic
- `web-ui/src/components/app/project-navigation-removal-dialog.tsx` — new: removal confirmation dialog
- `web-ui/src/components/app/project-navigation-sidebar-sections.tsx` — new: onboarding tips, shortcuts card, beta notice
- `web-ui/src/components/app/top-bar.tsx` — reduced to 176L shell importing 3 new files
- `web-ui/src/components/app/top-bar-scope-section.tsx` — new: back button, task title, project path, hints
- `web-ui/src/components/app/top-bar-project-shortcut-control.tsx` — new: project shortcut split-button + create dialog
- `web-ui/src/components/app/top-bar-prompt-shortcut-control.tsx` — new: prompt shortcut split-button
- `web-ui/src/components/app/git-branch-status-control.tsx` — new: git branch pill (moved from top-bar.tsx)
- `web-ui/src/components/app/connected-top-bar.tsx` — prop rename `isWorkspacePathLoading` → `isProjectPathLoading`
- `web-ui/src/components/app/index.ts` — barrel export updated
- `src/terminal/orphan-cleanup.ts` — added `if (!comm) continue` guard fixing TS2345/TS18048
- `docs/design-guardrails.md` — new: reusable rules for preventing optimization-shaped architecture
- `docs/design-weaknesses-roadmap.md` — new: ranked architectural weaknesses
- `docs/optimization-shaped-architecture-followups.md` — new: subsystem-level follow-up tracker
- `docs/terminal-architecture-refactor-brief.md` — new: self-contained terminal refactor planning brief
- `docs/README.md` — added refactor docs map
- `docs/todo.md` — added optimization follow-ups section, updated Phase 3 status
- `docs/plan-design-investigation.md` — marked item 4 done
- `CHANGELOG.md` — added entry
- `package-lock.json` — removed unused `mitt`, `neverthrow` entries

## Refactor: rename "workspace" to "project" throughout codebase (2026-04-17)

**What:** Unified the state-container concept under "project". Previously the backend used "workspace" while the UI/API layer used "project". All types, files, functions, variables, API routes, wire protocol strings, HTTP headers, WebSocket messages, and on-disk paths now consistently use "project". Renamed `src/workspace/` to `src/workdir/` for working directory operations. Agent workspace trust files left unchanged intentionally.

**Why:** The dual terminology was a constant source of confusion — the same concept had two names depending on which layer you were in. Grepping for "workspace" returned a mix of state-container references and agent trust references, making navigation harder.

**Approach:** Used forge to generate a spec, research inventory, and 8-task execution plan. The build phase used bulk `find | xargs sed` for the initial pass (~4900 occurrences across ~290 files), then manual cleanup of ~260 remaining local variables, interface members, comments, and error messages. Migration code was spec'd but dropped in favor of manual migration (3 known installations). Completeness verified with a grep that returns zero results outside the intentional workspace-trust exclusions.

**Key changes:**
- State files: `workspace-state*.ts` → `project-state*.ts`
- Server: `workspace-registry.ts` → `project-registry.ts`, metadata monitor/loaders renamed
- tRPC: `workspace` router → `project` router, all procedure files renamed
- API contracts: Zod schemas, wire protocol strings (`workspace_state_updated` → `project_state_updated`), HTTP header (`x-quarterdeck-workspace-id` → `x-quarterdeck-project-id`)
- Frontend: stores, hooks, providers, runtime queries, all local variables and props
- Working dir ops: `src/workspace/` → `src/workdir/`, functions from `*Workspace*` to `*Workdir*`
- On-disk path: `~/.quarterdeck/workspaces/` → `~/.quarterdeck/projects/`
- Documentation: `CLAUDE.md`, `AGENTS.md`, `docs/ui-layout-architecture.md`, `docs/web-ui-conventions.md`

**Files touched:** 289 files changed. 288 in the committed diff plus the lessons file. All tests pass (1535 total — 733 runtime, 802 web-ui), typecheck/lint/build clean.

## Enhancement: notification muting — "Mute project viewed" (2026-04-17)

**What:** Renamed "Mute focused project" to "Mute project viewed" and changed per-project notification suppression to only apply while the tab is visible. Defaulted review suppression to `true` for new users.

**Why:** The previous behavior muted sounds even when the user had tabbed away from Quarterdeck, defeating the purpose of audio notifications. The "focused" label was also misleading — it's about the project being viewed, not window focus.

**Approach:** Moved the `isTabVisible()` guard from inside `isEventSuppressedForProject` (which would have mixed browser concerns into a pure config predicate) to the `fireSound` call site in `use-audible-notifications.ts`. This keeps the domain function testable without DOM mocking and puts the visibility decision at the orchestration layer alongside the existing `areSoundsSuppressed` global gate.

**Files touched:**
- `src/config/config-defaults.ts` — `review` default changed to `true` in `DEFAULT_AUDIBLE_NOTIFICATION_SUPPRESS_CURRENT_PROJECT`
- `test/runtime/config/runtime-config-helpers.ts` — aligned hardcoded test fixture with new default
- `web-ui/src/components/settings/display-sections.tsx` — label and comment rename
- `web-ui/src/hooks/notifications/use-audible-notifications.ts` — added `isTabVisible()` guard at `fireSound` call site
- `web-ui/src/hooks/notifications/audible-notifications-suppress.test.tsx` — tests mock tab as visible and use `onlyWhenHidden: false` to test suppression in isolation

## Feature: scroll-to-line on text search result click (2026-04-17)

**What:** Clicking a text search result (Cmd+Shift+F) now scrolls the file content viewer to the matched line number.

**Why:** Previously, selecting a search result opened the file but left the user at the top — they had to manually scroll to find the match. This closes the loop on the text search UX.

**Approach:** Extended `onSelect` in `use-text-search.ts` to pass `match.line` alongside `match.path`. The line number flows through `pendingFileNavigation` in `App.tsx` → `useGitNavigation` → `FilesView` → `FileContentViewer`, which calls `virtualizer.scrollToIndex(lineNumber - 1)` after the file content loads.

**Files touched:**
- `web-ui/src/hooks/search/use-text-search.ts` — `onSelect` signature extended with optional `lineNumber`
- `web-ui/src/components/search/text-search-overlay.tsx` — passes line number through to `onSelect`
- `web-ui/src/App.tsx` — `pendingFileNavigation` state extended with `lineNumber`, wired to git navigation
- `web-ui/src/hooks/git/use-git-navigation.ts` — `NavigateToFileOptions` extended with `lineNumber`
- `web-ui/src/components/git/files-view.tsx` — passes `lineNumber` to `FileContentViewer`
- `web-ui/src/components/git/panels/file-content-viewer.tsx` — `useEffect` scrolls virtualizer to line on mount/change

## Feature: file finder (Cmd+P) and text search (Cmd+Shift+F) (2026-04-17)

**What:** Added two VS Code-style search overlays to the web UI — a file finder opened via Cmd+P for fuzzy filename search, and a text search opened via Cmd+Shift+F for full-text grep across the workspace using `git grep`.

**Why:** Users could only browse files via the tree sidebar and had no way to search file contents from the UI. Both features are standard IDE navigation patterns that significantly speed up file discovery in large worktrees.

**Approach:**

1. **Backend — text search endpoint** (`src/workspace/search-workspace-text.ts`): New `searchWorkspaceText()` function using `runGit` to execute `git grep -rn --null --no-color` with flags for case sensitivity (`-i`), fixed-string (`-F`) vs extended regex (`-E`), and `--` separator to prevent flag injection. Parses NUL-delimited output (`--null` avoids colon ambiguity in file paths), groups matches by file, truncates at configurable limit (default 100). Exit code 1 returns empty results; exit code 2 throws `TRPCError({ code: "BAD_REQUEST" })` with stderr message. Wired through standard workspace procedure pattern: Zod schemas in `workspace-files.ts`, method on `workspaceApi` interface in `app-router-context.ts`, implementation in `workspace-api-changes.ts`, query procedure in `workspace-procedures.ts`.

2. **Frontend — shared overlay shell** (`web-ui/src/components/search/search-overlay-shell.tsx`): Reusable component rendering a full-viewport backdrop with a centered floating panel. Escape key handled via capture-phase `keydown` listener on `document` (fires before the bubbling-phase `useEscapeHandler` in App.tsx that deselects tasks). Outside-click dismisses; panel click stops propagation. No Radix Dialog — avoids focus trap complications with hotkey toggle.

3. **Frontend — file finder** (`use-file-finder.ts` + `file-finder-overlay.tsx`): Hook uses `useDebouncedEffect` (150ms) to call existing `workspace.searchFiles` endpoint with request-ID race protection (same pattern as `task-prompt-composer.tsx`). Component renders auto-focused input, scrollable results with file name/path/changed-indicator, keyboard navigation with wrap-around, selected row highlighting and `scrollIntoView`.

4. **Frontend — text search** (`use-text-search.ts` + `text-search-overlay.tsx`): Hook manages query, case/regex toggles, `executeSearch()` triggered on Enter (minimum 2 characters), flat-index keyboard navigation across grouped results, and automatic re-search when toggles change. Component renders input with toggle buttons, match count summary with truncation indicator, results grouped by file with sticky headers, and inline match highlighting using regex split/match with try/catch for invalid patterns.

5. **Integration** (`use-app-hotkeys.ts` + `App.tsx`): Two new `useHotkeys` calls (`mod+p` with `preventDefault: true` to suppress browser print dialog, `mod+shift+f`), both guarded by `currentProjectId !== null`. App.tsx owns `isFileFinderOpen`/`isTextSearchOpen` state with mutual exclusion (opening one closes the other). File selection calls `git.navigateToFile({ targetView: "files", filePath })` via existing `pendingFileNavigation` mechanism. Both modals close on project switch via `searchOverlayResetRef`.

**Files touched:**
- `src/core/api/workspace-files.ts` — 4 new Zod schemas (request, match, file group, response) with inferred types
- `src/workspace/search-workspace-text.ts` — new, `searchWorkspaceText()` implementation
- `src/workspace/index.ts` — barrel export
- `src/trpc/app-router-context.ts` — `searchText` method on workspace API interface
- `src/trpc/workspace-api-changes.ts` — implementation in `createChangesOps`, added to `ChangesOps` pick
- `src/trpc/workspace-procedures.ts` — `searchText` query procedure
- `web-ui/src/components/search/search-overlay-shell.tsx` — new, shared overlay shell
- `web-ui/src/components/search/file-finder-overlay.tsx` — new, file finder component
- `web-ui/src/components/search/text-search-overlay.tsx` — new, text search component
- `web-ui/src/hooks/search/use-file-finder.ts` — new, file finder hook
- `web-ui/src/hooks/search/use-text-search.ts` — new, text search hook
- `web-ui/src/hooks/search/index.ts` — barrel export
- `web-ui/src/hooks/app/use-app-hotkeys.ts` — `mod+p` and `mod+shift+f` hotkey registration
- `web-ui/src/hooks/app/use-app-hotkeys.test.tsx` — added new required props to test harness
- `web-ui/src/App.tsx` — overlay state, toggle handlers, file navigation integration, project-switch cleanup
- `docs/todo.md` — added scroll-to-line and live preview pane follow-up items

**Verification:** Biome lint clean, TypeScript clean, 729 runtime tests pass, 787 web-ui tests pass. Commit fca96c38.

**Follow-up fixes (sanity review, commit f9cd214e):**
- `use-text-search.ts` — Added `requestIdRef` with stale-response guards to `executeSearch`, matching the pattern in `use-file-finder.ts`. Prevents overlapping searches (e.g. toggle-triggered re-search racing a manual search) from producing stale results. Removed dead `onDismiss` parameter and its ref from the hook interface.
- `text-search-overlay.tsx` — Replaced mutable `let flatIndex` counter (mutated inside `.map()` IIFE during render) with a precomputed `flatIndexStarts` array via `useMemo`, making the data flow explicit and safe under memoization/StrictMode.
- `use-file-finder.ts` — Removed dead `onDismiss` parameter from hook interface (dismissal handled entirely by `SearchOverlayShell`).
- `search-overlay-shell.tsx` — Stabilized Escape `keydown` listener with `onDismissRef` so it registers once on mount instead of re-attaching every render (the inline arrow `onDismiss` from App.tsx was causing needless listener churn).
- `file-finder-overlay.tsx` — Updated `useFileFinder` call site to drop removed `onDismiss` prop.

## Refactor: separate dedicated terminals from shared pool policy (2026-04-17)

**What:** Reassessed `web-ui/src/terminal/terminal-pool.ts` and kept the shared-slot allocation/lifecycle state machine intact, but extracted the dedicated-terminal registry into `web-ui/src/terminal/terminal-dedicated-registry.ts`. The new module now owns dedicated-terminal keying, home/detail task classification, dedicated slot creation/reuse, per-workspace disposal, dedicated iteration, and dedicated lookup helpers. `terminal-pool.ts` now stays focused on shared-slot role transitions, warmup/previous eviction timers, rotation, and the public shared-pool API, while still exposing the existing dedicated-terminal API through stable exports.

**Why:** This completed the `terminal-pool.ts` reassessment item from `docs/plan-csharp-readability-followups.md`. The review showed that most of the file's size is justified by the pool state machine: allocation policy, warmup promotion, `PREVIOUS` retention, timed eviction, and free-slot rotation are tightly coupled and safer to read together. The removable coupling was the separate dedicated-terminal lifecycle, which follows different ownership rules and was making the pool invariants harder to discover.

**Files touched:**
- `web-ui/src/terminal/terminal-pool.ts` — narrowed the module to shared-pool policy plus cross-terminal helpers, with dedicated concerns delegated out
- `web-ui/src/terminal/terminal-dedicated-registry.ts` — new dedicated-terminal ownership module for home/detail terminal lookup, reuse, disposal, and iteration
- `docs/plan-csharp-readability-followups.md` — marked the terminal-pool reassessment item done and recorded the conclusion
- `docs/todo.md` — removed the completed reassessment item
- `CHANGELOG.md` — added an unreleased refactor entry
- `docs/implementation-log.md` — recorded the reassessment result and extracted ownership boundary

**Verification:** `npm --prefix web-ui run test -- src/terminal/terminal-pool-acquire.test.ts src/terminal/terminal-pool-lifecycle.test.ts src/terminal/terminal-pool-dedicated.test.ts src/terminal/use-persistent-terminal-session.test.tsx`; `npm --prefix web-ui run typecheck`; `npx @biomejs/biome check web-ui/src/terminal/terminal-pool.ts web-ui/src/terminal/terminal-dedicated-registry.ts docs/plan-csharp-readability-followups.md docs/todo.md CHANGELOG.md docs/implementation-log.md`

**Commit:** Pending user-requested commit (current HEAD: `511a3075`).

## Refactor: split terminal slot hosting and visibility lifecycle (2026-04-17)

**What:** Refactored `web-ui/src/terminal/terminal-slot.ts` so the class now reads more clearly as the orchestrator over terminal collaborators instead of as the implementation home for each concern. Added `web-ui/src/terminal/slot-dom-host.ts` to own the persistent parking-root host element, stage-container attachment, visibility/reveal state, and parking transitions. Added `web-ui/src/terminal/slot-visibility-lifecycle.ts` to own the document visibility listener, tab-return repaint, and reconnect-on-return behavior for dead sockets. Inside `TerminalSlot`, grouped constructor work behind named helpers for xterm creation, addon wiring, socket manager creation, write-queue creation, IO forwarding, key handling, disconnect state reset, and restore application/finalization. Added focused unit coverage for the extracted collaborators while keeping the existing pool and persistent-session terminal tests green.

**Why:** This completed the `terminal-slot.ts` readability item from `docs/plan-csharp-readability-followups.md`. Before the refactor, DOM parking, xterm setup, reconnect-on-visibility logic, restore sequencing, and general slot orchestration were mixed together in one large class body and especially in a noisy constructor. Pulling the DOM-hosting and visibility lifecycle concerns into named collaborators makes reconnect, restore, and hosting responsibilities easier to find without changing the slot's runtime contract.

**Files touched:**
- `web-ui/src/terminal/terminal-slot.ts` — slimmed the slot into a clearer orchestrator with named setup and restore helpers
- `web-ui/src/terminal/slot-dom-host.ts` — new DOM-hosting and parking collaborator
- `web-ui/src/terminal/slot-visibility-lifecycle.ts` — new visibility refresh and reconnect collaborator
- `web-ui/src/terminal/slot-dom-host.test.ts` — regression coverage for staging, reveal/hide, and parking behavior
- `web-ui/src/terminal/slot-visibility-lifecycle.test.ts` — regression coverage for tab-return refresh and reconnect behavior
- `docs/plan-csharp-readability-followups.md` — marked the terminal-slot readability item done
- `docs/todo.md` — removed the completed terminal-slot readability item
- `CHANGELOG.md` — added an unreleased refactor entry
- `docs/implementation-log.md` — recorded the refactor scope and rationale

**Verification:** `npm --prefix web-ui run test -- src/terminal/slot-dom-host.test.ts src/terminal/slot-visibility-lifecycle.test.ts src/terminal/terminal-pool-acquire.test.ts src/terminal/terminal-pool-lifecycle.test.ts src/terminal/terminal-pool-dedicated.test.ts src/terminal/use-persistent-terminal-session.test.tsx`; `npm --prefix web-ui run typecheck`; `npx @biomejs/biome check web-ui/src/terminal/terminal-slot.ts web-ui/src/terminal/slot-dom-host.ts web-ui/src/terminal/slot-visibility-lifecycle.ts web-ui/src/terminal/slot-dom-host.test.ts web-ui/src/terminal/slot-visibility-lifecycle.test.ts`

**Commit:** Pending user-requested commit (current HEAD: `30ad3201`).

## Refactor: split runtime state hub coordination helpers (2026-04-17)

**What:** Refactored `src/server/runtime-state-hub.ts` so the main hub now reads primarily as high-level connection and broadcast coordination. Added `src/server/runtime-state-client-registry.ts` to own websocket client registration, workspace-scoped membership, disconnect cleanup, final error payload delivery, and shutdown termination. Added `src/server/runtime-state-message-batcher.ts` to own task-session summary batching, debug-log batching, timer cleanup, and terminal-manager subscription lifecycle. The hub now composes those collaborators with the existing workspace metadata monitor and snapshot/broadcast APIs, while preserving the public `RuntimeStateHub` surface. Added focused tests for the extracted collaborators under `test/runtime/server/`.

**Why:** This completed the `runtime-state-hub.ts` readability item from `docs/plan-csharp-readability-followups.md`. Before the refactor, websocket client bookkeeping, workspace client tracking, summary batching, debug-log batching, metadata-monitor integration, and high-level broadcast APIs were all interleaved inside one class. Splitting the client registry and batching concerns into named modules makes the main runtime hub substantially easier to navigate without changing websocket timing or workspace disposal behavior.

**Files touched:**
- `src/server/runtime-state-hub.ts` — slimmed the hub into a coordinator over extracted client-registry and batching helpers
- `src/server/runtime-state-client-registry.ts` — new websocket client bookkeeping and cleanup module
- `src/server/runtime-state-message-batcher.ts` — new summary/debug-log batching module
- `test/runtime/server/runtime-state-client-registry.test.ts` — regression coverage for workspace client tracking, targeted broadcasts, and disconnect cleanup
- `test/runtime/server/runtime-state-message-batcher.test.ts` — regression coverage for task-summary coalescing and debug-log batching
- `docs/plan-csharp-readability-followups.md` — marked the runtime-state-hub readability item done
- `docs/todo.md` — removed the completed runtime-state-hub readability item
- `CHANGELOG.md` — added an unreleased refactor entry
- `docs/implementation-log.md` — recorded the refactor scope and rationale

**Verification:** `npm run test -- test/runtime/server/runtime-state-client-registry.test.ts test/runtime/server/runtime-state-message-batcher.test.ts`; `npm run typecheck`; `npx @biomejs/biome check src/server/runtime-state-hub.ts src/server/runtime-state-client-registry.ts src/server/runtime-state-message-batcher.ts test/runtime/server/runtime-state-client-registry.test.ts test/runtime/server/runtime-state-message-batcher.test.ts`

**Commit:** Pending user-requested commit (current HEAD: `20cbc414`).

## Refactor: decompose project navigation panel into a composition hook (2026-04-17)

**What:** Refactored `web-ui/src/components/app/project-navigation-panel.tsx` so the sidebar panel now reads as a composition surface instead of keeping its local controller logic inline. Added `web-ui/src/hooks/project/use-project-navigation-panel.ts` to own optimistic project reorder state, drag/drop reorder handling, permission-request badge counts, and removal confirmation dialog state. In the component file, extracted the draggable list into `ProjectList` and `DraggableProjectRow`, gave the portal-backed drag rendering a named helper, and moved task badge derivation behind `buildTaskCountBadges()` so the row component stays focused on rendering and event wiring. Added a dedicated hook test file covering the new orchestration paths.

**Why:** This completed the `project-navigation-panel.tsx` readability item from `docs/plan-csharp-readability-followups.md`. Before the refactor, the panel mixed optimistic ordering, drag controller behavior, removal workflow state, badge derivation, and the full render tree in one component body. Pulling the stateful behavior into a named hook makes the main panel easier to scan top-to-bottom and makes the drag/removal rules easier to find in isolation.

**Files touched:**
- `web-ui/src/components/app/project-navigation-panel.tsx` — replaced inline orchestration with the new hook and slimmer view sections
- `web-ui/src/hooks/project/use-project-navigation-panel.ts` — new composition hook for reorder/removal/badge state
- `web-ui/src/hooks/project/use-project-navigation-panel.test.tsx` — regression coverage for the extracted hook behavior
- `web-ui/src/hooks/project/index.ts` — exported the new hook
- `docs/plan-csharp-readability-followups.md` — marked the project navigation panel item done
- `docs/todo.md` — removed the completed project navigation panel readability item
- `CHANGELOG.md` — added an unreleased refactor entry
- `docs/implementation-log.md` — recorded the refactor scope and rationale

**Verification:** `npm --prefix web-ui run test -- project-navigation-panel.test.tsx use-project-navigation-panel.test.tsx`; `npm --prefix web-ui run typecheck`

**Commit:** Pending user-requested commit (current HEAD: `b9e3418d`).

## Chore: dead code cleanup (2026-04-17)

**What:** Comprehensive sweep to remove dead code, orphaned files, unused dependencies, and vestigial barrel re-exports.

**Why:** Accumulated dead code from removed features (MCP integration, auto-update, task chat) and unused dependencies (`neverthrow`, `mitt`) were adding confusion and install weight with no benefit.

**What was removed:**

1. **Orphaned files:** `src/core/api/task-chat.ts` (88 lines — full API contract for a never-built task chat feature) and `web-ui/src/components/open-workspace-button.tsx` (110 lines — complete component rendered nowhere).

2. **Dead tRPC procedures:** `workspace.getGitSummary` and `workspace.notifyStateUpdated` — removed from router (`workspace-procedures.ts`), context interface (`app-router-context.ts`), and factory functions (`workspace-api-git-ops.ts`, `workspace-api-state.ts`). The frontend never called either; git operations go through `runGitSyncAction` and state notifications go through the single-writer `saveState` flow.

3. **Deprecated CLI stubs:** `mcp` and `update` subcommands that only printed deprecation warnings. The MCP integration and auto-update features they referenced no longer exist.

4. **Legacy env var:** `QUARTERDECK_TITLE_MODEL` — backward-compat alias for `QUARTERDECK_LLM_MODEL` in `src/title/llm-client.ts`. Removed from code, doc comment, and test.

5. **Unused npm dependencies:** `neverthrow` and `mitt` — zero imports anywhere in the codebase.

6. **Dead CSS:** `.kb-line-clamp-2` and `.kb-line-clamp-5` in `web-ui/src/styles/utilities.css` — only `.kb-line-clamp-1` was used.

7. **Barrel export pruning:** Removed re-exports with no external consumers — `parseTaskWorkspaceInfoRequest`, `parseWorkspaceStateSaveRequest`, 6 task mutation result/input types, `RuntimeAddTaskDependencyResult`, `RuntimeRemoveTaskDependencyResult`, `RuntimeTrashTaskResult` from `core/index.ts`; 6 internal path helpers from `state/index.ts`; `DEFAULT_SQUASH_MERGE_PROMPT_TEMPLATE` from `config/index.ts`.

**Files touched:**
- Deleted: `src/core/api/task-chat.ts`, `web-ui/src/components/open-workspace-button.tsx`
- Modified: `package.json`, `src/cli.ts`, `src/config/index.ts`, `src/core/api/index.ts`, `src/core/index.ts`, `src/state/index.ts`, `src/title/llm-client.ts`, `src/trpc/app-router-context.ts`, `src/trpc/workspace-api-git-ops.ts`, `src/trpc/workspace-api-state.ts`, `src/trpc/workspace-procedures.ts`, `web-ui/src/styles/utilities.css`, `test/runtime/title-generator.test.ts`

**Commit:** `82c5155d`

## Refactor: consolidate board rules behind the runtime board module (2026-04-17)

**What:** Refactored `web-ui/src/state/board-state.ts` so several browser-side wrappers now defer directly to `src/core/task-board-mutations.ts` instead of maintaining adjacent board-rule logic locally. `updateTask()` now builds a runtime update payload from the selected card and delegates to the runtime task updater; `removeTask()` and `clearColumnTasks()` now use `deleteTasksFromBoard()` for task/dependency cleanup; `toggleTaskPinned()` now routes through the runtime updater rather than mutating board cards inline. The follow-up cleanup in this slice also moved post-parse board canonicalization behind a new runtime helper, `canonicalizeTaskBoard()`: persisted dependency parsing in `board-state-parser.ts` now only trims and validates raw saved dependency records, while the runtime module owns the canonical rule pass that drops invalid links, reorients backlog-linked pairs, and removes duplicates after hydration. The browser file still owns browser-specific responsibilities: persisted-board parsing, drag/drop placement, browser UUID generation, and task metadata reconciliation (`branch`, `workingDirectory`).

**Why:** This completed the remaining board-related item from `docs/plan-csharp-readability-followups.md`. Before this change, readers still had to compare the runtime board mutation module with `web-ui/src/state/board-state.ts` to understand which task update/delete rules were authoritative. Delegating shared mutation behavior back to the runtime module makes ownership clearer: the core module is the canonical source of board mutation rules, and the browser layer is mostly an adapter around browser-only concerns.

**Files touched:**
- `src/core/task-board-mutations.ts` — added the runtime-owned `canonicalizeTaskBoard()` entry point for post-parse board cleanup
- `src/core/index.ts`, `src/state/workspace-state-index.ts` — exported and adopted the canonicalization helper so runtime hydration also reads through the named board-rules entry point
- `web-ui/src/state/board-state.ts` — routed task update/delete/pin wrappers and normalization cleanup through runtime board mutations
- `web-ui/src/state/board-state-parser.ts` — narrowed persisted dependency parsing to raw-record normalization instead of task-existence/domain cleanup
- `web-ui/src/state/board-state-mutations.test.ts`, `web-ui/src/state/board-state-normalization.test.ts`, `test/runtime/task-board-mutations.test.ts` — added regression coverage for the thinner browser adapters, parser boundary, and runtime canonicalization path
- `docs/todo.md` — removed the completed board-rule consolidation item
- `CHANGELOG.md` — added an unreleased refactor entry
- `docs/implementation-log.md` — recorded the refactor scope and rationale

**Verification:** `npm --prefix web-ui run test -- board-state-mutations.test.ts board-state-dependencies.test.ts board-state-drag.test.ts board-state-normalization.test.ts`; `npm run test -- test/runtime/task-board-mutations.test.ts`; `npm --prefix web-ui run typecheck`

**Commit:** Pending user-requested commit (current HEAD: `b9f398b1`).

## Refactor: extract board-state parser/schema helpers (2026-04-17)

**What:** Refactored the persisted board hydration path in `web-ui/src/state/board-state.ts` by moving raw `unknown` parsing into a new companion module, `web-ui/src/state/board-state-parser.ts`. The new module defines named `zod`-backed parser helpers for persisted board payloads, cards, dependencies, and task images, while preserving the existing permissive normalization semantics such as trimmed prompt/base-ref requirements, generated fallback ids, nullable branch handling, and filtering invalid images/dependencies. Updated `normalizeBoardData()` to consume those helpers instead of inlining long manual shape checks, and expanded `board-state-normalization.test.ts` with direct parser coverage.

**Why:** This completed the next C# readability follow-up item from `docs/plan-csharp-readability-followups.md`. The old hydration path mixed persistence-contract parsing with board assembly logic, forcing readers to infer accepted payload shapes from repeated `typeof`, `Array.isArray`, and ad hoc casts. Extracting named parser/schema helpers makes the accepted persisted shape discoverable beside `board-state.ts` and leaves the browser board module smaller and easier to scan.

**Files touched:**
- `web-ui/src/state/board-state.ts` — replaced inline normalization helpers with calls into the new parser module
- `web-ui/src/state/board-state-parser.ts` — new companion parser/schema module for persisted board payloads
- `web-ui/src/state/board-state-normalization.test.ts` — added parser-focused regression coverage
- `docs/todo.md` — removed the completed board-state parser/schema readability item
- `CHANGELOG.md` — added an unreleased refactor entry
- `docs/implementation-log.md` — recorded the refactor scope and rationale

**Verification:** `npm --prefix web-ui run test -- board-state-normalization.test.ts board-state-dependencies.test.ts`; `npm --prefix web-ui run typecheck`

**Commit:** Pending user-requested commit (current HEAD: `b9f398b1`).

## Refactor: extract App.tsx composition hooks (2026-04-17)

**What:** Refactored `web-ui/src/App.tsx` by moving three dense orchestration areas into named hooks under `web-ui/src/hooks/app/`: `use-app-side-effects.ts` (notification wiring, metadata sync, workspace persistence, hotkeys, cleanup, and pending-start effect), `use-app-action-models.ts` (card action callbacks, migrate dialog state, badge colors, detail session selection, and main-view/card-selection handlers), and `use-home-side-panel-resize.ts` (sidebar resize state + drag handling). Updated `hooks/app/index.ts` exports and rewired `App.tsx` to use the new composition hooks while keeping the JSX surface and provider structure intact.

**Why:** This completed the `App.tsx` readability item from the C# follow-up plan. `App.tsx` had accumulated several different responsibilities at once: context reads, global side effects, persistence wiring, callback assembly, badge derivation, and resize plumbing. Pulling those concerns into named hooks makes the file read more like a composition root and reduces the amount of local state a reader has to hold in their head.

**Files touched:**
- `web-ui/src/App.tsx` — removed large inline orchestration blocks and switched to the new composition hooks
- `web-ui/src/hooks/app/use-app-side-effects.ts` — new side-effect orchestration hook
- `web-ui/src/hooks/app/use-app-action-models.ts` — new action/view-model hook for card actions and app-level handlers
- `web-ui/src/hooks/app/use-home-side-panel-resize.ts` — new resize hook for the home side panel
- `web-ui/src/hooks/app/index.ts` — exported the new hooks
- `docs/todo.md` — removed the completed `App.tsx` readability item
- `CHANGELOG.md` — added an unreleased refactor entry
- `docs/implementation-log.md` — recorded the refactor scope and rationale

**Commit:** Pending user-requested commit (working tree only).

## Refactor: decompose CLI startup into named bootstrap phases (2026-04-17)

**What:** Refactored `src/cli.ts` so the runtime startup path is now expressed as a small pipeline of named helpers instead of one long `startServer()` function. Added helper functions for prefixed runtime warnings, lazy startup module loading, startup cleanup phases, orphaned agent cleanup, runtime bootstrap state creation, and runtime server handle creation. The lazy import boundary remains in place for command-style invocations, and the runtime startup order is unchanged.

**Why:** This completed the lowest-risk item from the C# readability follow-up plan. The existing startup logic was correct, but it required readers to scroll through one large procedural block to understand the boot sequence. The new helper structure makes the control flow more legible for developers used to bootstrapper/service initialization patterns.

**Files touched:**
- `src/cli.ts` — extracted the CLI startup pipeline into named helpers and simplified `startServer()`
- `docs/todo.md` — removed the completed CLI startup readability item from the C# follow-up section
- `CHANGELOG.md` — added an unreleased refactor entry for the CLI startup decomposition
- `docs/implementation-log.md` — recorded the change and rationale

**Commit:** Pending user-requested commit (working tree only).

## Feature: syntax highlighting in file browser (2026-04-17)

**What:** Added Prism-based syntax highlighting to two surfaces in the file browser: the plain code view (virtualized lines) and fenced code blocks inside the markdown preview.

**Why:** The diff viewer already had full Prism infrastructure (language resolution, grammar loading, token CSS). The file browser rendered plain monospace — adding highlighting was a small lift that reuses existing work.

**Approach:**

1. **File viewer code lines** (`file-content-viewer.tsx`): Resolves Prism language from file path via `resolvePrismLanguage`, builds a `highlightedLines` array in a `useMemo`, renders via `dangerouslySetInnerHTML` with the `kb-syntax` CSS class. Falls back to plain text for unsupported extensions.

2. **Markdown fenced code blocks** (`file-content-viewer.tsx`): Custom `MarkdownCodeBlock` component passed to react-markdown's `components.code` prop. Extracts the language from the `language-xxx` className, resolves via `resolvePrismLanguageByAlias` (handles short aliases like `ts`, `py`, `sh`), highlights with `Prism.highlight`.

3. **Shared infrastructure** (`syntax-highlighting.ts`, renamed from `diff-highlighting.ts`): Added `resolvePrismLanguageByAlias()` — checks `Prism.languages` directly for full names, falls back to `PRISM_LANGUAGE_BY_EXTENSION` for short aliases. Refactored `resolvePrismLanguage` to delegate to it internally. Re-exported through `diff-renderer.tsx` for backward compatibility.

4. **CSS** (`diff.css`): Collapsed duplicated token selectors using `:is(.kb-diff-text, .kb-syntax)` — reduced from 48 lines to 24. Adding future token groups now requires one rule, not two.

5. **Docs** (`ui-component-cheatsheet.md`): Updated stale path reference from `diff-highlighting.ts` to `syntax-highlighting.ts`.

**Files touched:**
- `web-ui/src/components/git/panels/file-content-viewer.tsx` — new imports, `MarkdownCodeBlock` component, `highlightedLines` memo, `dangerouslySetInnerHTML` rendering
- `web-ui/src/components/shared/syntax-highlighting.ts` — renamed from `diff-highlighting.ts`, added `resolvePrismLanguageByAlias`
- `web-ui/src/components/shared/diff-renderer.tsx` — updated import path, added `resolvePrismLanguageByAlias` re-export
- `web-ui/src/styles/diff.css` — collapsed token CSS with `:is()`, added `kb-syntax` class
- `docs/ui-component-cheatsheet.md` — updated stale path

**Verification:** TypeScript clean, Biome lint clean, all 86 web-ui test files / 787 tests pass.

## Fix: terminal restore snapshot renders at wrong dimensions (2026-04-16)

**What:** Fixed three related terminal rendering issues — garbled/half-wide content on initial connection, wrong dimensions after server restart, and post-restore scroll position jank.

**Why:** On initial connection (or after slot eviction), the server serialized the restore snapshot before the client's resize message updated the server-side `TerminalStateMirror`. The snapshot content was rendered at stale PTY dimensions (e.g. 120 cols instead of the actual container's 180 cols). Cursor-positioned output (agent status bars, prompts) doesn't reflow on client-side resize, so it stayed garbled. The "Re-sync terminal content" button in settings worked because by then the mirror was already at correct dimensions.

**Root cause:** Race condition between snapshot serialization and resize processing. `sendRestoreSnapshot()` calls `getSnapshot()` which awaits the mirror's operation queue. The client's resize message arrives on the same control socket but gets processed after the snapshot await started, so the resize operation is enqueued after `getSnapshot()` was already waiting — it serializes at old dimensions.

**Approach:**

1. **Server-side deferred snapshot** (`ws-server.ts`): Instead of calling `sendRestoreSnapshot()` immediately on control socket open, set a 100ms deferred timer. When the first resize message arrives, cancel the timer, apply the resize to the mirror (synchronously enqueuing onto the operation queue), then call `sendRestoreSnapshot()`. Since `getSnapshot()` awaits the queue, the resize executes before serialization. The 100ms fallback handles cases where no resize is needed (reconnecting idle sessions, dimensions already correct).

2. **Resize on control socket open** (`slot-socket-manager.ts`): Added `invalidateResize()` + `requestResize()` in the control socket `onopen` handler. `invalidateResize()` bumps the resize epoch so the request isn't deduped by `SlotResizeManager`. This ensures the server learns the actual container dimensions on every new connection — including after server restart or sleep/wake reconnect, where previously no resize was ever sent.

3. **Post-restore scroll guard** (`terminal-slot.ts`): Armed `pendingScrollToBottom` in `handleRestore()` after `scrollToBottom()`. The existing ResizeObserver callback in `SlotResizeManager` checks this one-shot flag and does fit+scroll synchronously, preventing a debounced reflow from undoing the scroll position after the terminal becomes visible. This is the same pattern `show()` already uses for the reveal path.

**Files touched:**
- `src/terminal/ws-server.ts` — deferred snapshot timer, resize-triggered snapshot, timer cleanup on socket close
- `web-ui/src/terminal/slot-socket-manager.ts` — invalidateResize + requestResize on control socket open
- `web-ui/src/terminal/terminal-slot.ts` — pendingScrollToBottom in handleRestore

## Refactor: runtime barrel exports (2026-04-16)

**What:** Added `index.ts` barrel files to 9 directories under `src/`: `core/`, `terminal/`, `workspace/`, `server/`, `config/`, `state/`, `trpc/`, `fs/`, `title/`. Each barrel re-exports the directory's public surface (types, classes, functions, constants used by files outside the directory). Updated ~150 import paths across `src/` and `test/` from specific module paths (e.g., `../core/api-contract`) to directory-level imports (e.g., `../core`). The original plan listed 8 directories; added `core/` (152 external imports, the most-imported directory) as a 9th. `commands/` (4 imports), `projects/` (0), and `prompts/` (1) were too low-traffic to justify barrels.

**Why:** Improve codebase navigability and reduce import path churn. With barrels, adding/renaming/moving a file within a directory doesn't require updating every external consumer — only the barrel. Matches the pattern already established on the frontend (`components/` and `hooks/` Phase 4 barrels).

**Vitest mock compatibility:** Three source files retain direct module imports instead of barrel imports: `src/fs/lock-cleanup.ts`, `src/workspace/task-worktree-lifecycle.ts`, `src/workspace/task-worktree-patch.ts`, and `src/terminal/claude-workspace-trust.ts`. Their test suites use `vi.mock()` targeting specific module paths (e.g., `../../src/state/workspace-state.js`). When the source imported through a barrel, vitest's module cache from prior tests in the same worker pool would supply the unmocked barrel module instead of the mock, causing test failures. Keeping direct imports for these files preserves mock isolation.

**Files touched:**
- 9 new `index.ts` barrel files (one per directory)
- ~85 source files in `src/` with updated import paths
- ~65 test files in `test/` with updated import paths
- `src/index.ts` — kept pointing at `./core/api-contract` (not `./core`) to preserve the package's intentionally narrow public API

**Verification:** TypeScript clean, Biome lint clean, all 72 test files / 700 tests pass.

## Refactor: git action toast helpers and useLoadingGuard (2026-04-16)

**Problem:** `use-git-actions.ts` (626 lines) and `use-branch-actions.ts` (520 lines) had extensive boilerplate: every `showAppToast` call specified `intent`, `icon`, `message`, and `timeout` inline, and every async mutation used a manual `useState(false)` + `if (isLoading) return` + `try/finally { setIsLoading(false) }` loading guard. The two files were inconsistent — `use-git-actions.ts` set `icon: "warning-sign"` on error toasts while `use-branch-actions.ts` omitted it; `use-git-actions.ts` used 7000ms timeouts while `use-branch-actions.ts` used Sonner's 5000ms default.

**Approach:** Two orthogonal helpers:

1. **Toast helpers** (`showGitErrorToast`, `showGitWarningToast`, `showGitSuccessToast`) in `hooks/git/git-actions.ts` — thin wrappers over `showAppToast` with standardized defaults (danger: `warning-sign` icon + 7000ms, success: no icon + 3000ms). The `showGitErrorToast` overload accepts an optional `action` button for the dirty-tree "Stash & Switch" case. Placed in `git-actions.ts` (the existing domain module) rather than a new file since the helpers are git-specific and the module already has pragmatic scope.

2. **`useLoadingGuard`** in `utils/react-use.ts` — returns `{ isLoading, run, reset }`. Uses both a `useRef` (synchronous double-click prevention — two rapid clicks could both see `isLoading === false` before either `setState` takes effect) and `useState` (for React re-renders). The return object is wrapped in `useMemo([isLoading, run, reset])` so identity only changes when `isLoading` flips, preventing cascading re-renders through dependency arrays. `reset()` is exposed for `resetGitActionState` which force-clears all loading flags on project switch.

**Files:** `web-ui/src/hooks/git/git-actions.ts` (+43 lines), `web-ui/src/hooks/git/use-git-actions.ts` (626→519 lines), `web-ui/src/hooks/git/use-branch-actions.ts` (520→493 lines), `web-ui/src/utils/react-use.ts` (+29 lines). Net ~56 line reduction. 787 web-ui tests pass, all typechecks clean.

## Extract `updateCardInBoard` helper — 2026-04-16

**What:** Added a private `updateCardInBoard(board, taskId, updater)` helper to `web-ui/src/state/board-state.ts` that encapsulates the repeated nested `columns.map → cards.map` pattern with `taskId` matching and `columnUpdated`/`updated` flag tracking. The updater callback returns a new `BoardCard` or `null` to signal no-op (for early-return-if-unchanged cases).

**Why:** Four functions (`updateTask`, `reconcileTaskWorkingDirectory`, `reconcileTaskBranch`, `toggleTaskPinned`) all duplicated the same 6-line scaffolding pattern. Completing a todo item from the runtime readability refactors plan.

**Files touched:**
- `web-ui/src/state/board-state.ts` — added `updateCardInBoard` helper (lines 60–80), refactored 4 call sites

**Verification:** TypeScript clean, all 67 board-state tests pass (5 test files).
