# Implementation Log

> Prior entries in `docs/implementation-archive/`: `implementation-log-through-0.9.4.md`, `implementation-log-through-2026-04-15.md`, `implementation-log-through-2026-04-12.md`.

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

**What:** Refactored `web-ui/src/state/board-state.ts` so several browser-side wrappers now defer directly to `src/core/task-board-mutations.ts` instead of maintaining adjacent board-rule logic locally. `updateTask()` now builds a runtime update payload from the selected card and delegates to the runtime task updater; `removeTask()` and `clearColumnTasks()` now use `deleteTasksFromBoard()` for task/dependency cleanup; `toggleTaskPinned()` now routes through the runtime updater rather than mutating board cards inline. The browser file still owns browser-specific responsibilities: persisted-board parsing, drag/drop placement, and task metadata reconciliation (`branch`, `workingDirectory`).

**Why:** This completed the remaining board-related item from `docs/plan-csharp-readability-followups.md`. Before this change, readers still had to compare the runtime board mutation module with `web-ui/src/state/board-state.ts` to understand which task update/delete rules were authoritative. Delegating shared mutation behavior back to the runtime module makes ownership clearer: the core module is the canonical source of board mutation rules, and the browser layer is mostly an adapter around browser-only concerns.

**Files touched:**
- `web-ui/src/state/board-state.ts` — routed task update/delete/pin wrappers through runtime board mutations and removed duplicated dependency cleanup logic
- `web-ui/src/state/board-state-mutations.test.ts` — added regression coverage for remove-task, clear-column, and toggle-pinned browser adapters
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
