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
