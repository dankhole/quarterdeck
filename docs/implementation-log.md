# Implementation Log

> Prior entries in `docs/implementation-archive/`: `implementation-log-through-0.9.4.md`, `implementation-log-through-2026-04-15.md`, `implementation-log-through-2026-04-12.md`.

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
