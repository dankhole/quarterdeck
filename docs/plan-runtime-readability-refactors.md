# Runtime & Cross-Cutting Readability Refactors

Four focused refactors that eliminate repeated patterns, improve navigability, and make the codebase feel more like a well-structured C# solution. Each is independent — do them in any order, though the barrel exports are cheapest and the workspace-api pipeline has the highest payoff.

---

## 1. workspace-api.ts handler pipeline

**File:** `src/trpc/workspace-api.ts` (1,092 lines)

**Problem:** `createWorkspaceApi()` returns an object literal with ~35 handler methods spanning 900 lines. The majority follow one of three patterns, copy-pasted with variations:

**Pattern A — Simple git read** (loadGitSummary, loadGitLog, loadGitRefs, loadCommitDiff, stashList, stashShow):
```
resolve cwd → call worker → catch → return error shape
```

**Pattern B — Git mutation with metadata refresh** (discardGitChanges, commitSelectedFiles, discardFile, stashPush, stashPop, stashApply, stashDrop):
```
normalize taskScope → resolve cwd → optional shared-checkout guard → call worker → if ok, refreshGitMetadata → catch → return error shape
```

**Pattern C — Git mutation with full broadcast** (checkoutGitBranch, mergeBranch, rebaseBranch, resetToRef, createBranch, deleteBranch, renameBranch, cherryPickCommit, resolveConflictFile, continueConflictResolution, abortConflictResolution):
```
normalize input → optional task-scoped branch (resolve task cwd, call worker, requestTaskRefresh) → optional shared-checkout guard → call worker on home repo → if ok, broadcastStateUpdate → catch → return error shape
```

The boilerplate per handler is 15-30 lines. The actual unique logic per handler is 1-5 lines (the worker call and its arguments).

**What the refactor looks like:**

Extract higher-order helpers for each pattern. The handler implementations collapse to declarations:

```typescript
// Pattern A — read-only git operation
const loadGitSummary = gitReadHandler(
   async (cwd, _input) => {
      const summary = await getGitSyncSummary(cwd);
      return { ok: true, summary } satisfies RuntimeGitSummaryResponse;
   },
   (_input) => ({ ok: false, summary: { ...EMPTY_GIT_SUMMARY } }),
);

// Pattern B — git mutation with metadata refresh
const discardGitChanges = gitMutationHandler({
   resolveScope: (input) => normalizeOptionalTaskWorkspaceScopeInput(input),
   sharedCheckoutGuard: true,
   execute: async (cwd) => discardGitChanges({ cwd }),
   onSuccess: "refreshGitMetadata",
   errorFactory: createGitOutputErrorResponse,
});

// Pattern C — task-or-home with full broadcast
const mergeBranch = taskOrHomeHandler({
   normalizeInput: (input) => input.branch.trim(),
   validate: (branch) => branch ? null : "Branch name cannot be empty.",
   executeTask: async (cwd, branch) => runGitMergeAction({ cwd, branch }),
   executeHome: async (cwd, branch) => runGitMergeAction({ cwd, branch }),
   broadcastOnSuccess: (response) => response.ok || response.conflictState,
   errorFactory: createGitBranchErrorResponse,
});
```

The helpers themselves are ~30-50 lines each and live in the same file (or a companion `workspace-api-helpers.ts` if the file is cleaner that way). They encapsulate:
- `try/catch` with the error factory
- CWD resolution (task-scoped vs home)
- The shared-checkout guard (`hasActiveSharedCheckoutTask`)
- Post-success broadcast routing (`broadcastStateUpdate` vs `refreshGitMetadata` vs `requestTaskRefresh`)

**What stays as-is:** Handlers that don't fit a pattern — `loadChanges`, `loadFileDiff`, `saveState`, `loadState`, `getFileContent`, `listFiles` — have enough unique branching logic that forcing them into a pipeline would obscure rather than clarify. Leave them as explicit implementations. These are ~5-6 handlers out of ~35.

**Estimated scope:**
- Extract 3 helper functions (~120 lines total)
- Rewrite ~25 handlers from inline implementations to declarations (~25 lines each → ~5 lines each)
- Net reduction: ~400-500 lines
- The remaining ~6 complex handlers stay unchanged
- Test coverage: existing integration tests cover all handlers via tRPC calls — no new tests needed, just verify they pass

**Risk:** Low. Each handler's behavior is identical before and after — the refactor is purely mechanical. The error factories and broadcast routing are already extracted as functions; this just hoists the try/catch and CWD resolution into the pipeline.

---

## 2. board-state.ts `updateCardInBoard` helper

**File:** `web-ui/src/state/board-state.ts`

**Problem:** Four exported functions repeat the same nested `.map()` pattern to find and update a single card by ID:

```typescript
// This exact structure appears in:
//   updateTask()           — line 472
//   reconcileTaskWorkingDirectory() — line 533
//   reconcileTaskBranch()  — line 582
//   toggleTaskPinned()     — line 662

let updated = false;
const columns = board.columns.map((column) => {
   let columnUpdated = false;
   const cards = column.cards.map((card) => {
      if (card.id !== taskId) return card;
      columnUpdated = true;
      updated = true;
      return { ...card, /* field-specific changes */ };
   });
   return columnUpdated ? { ...column, cards } : column;
});
if (!updated) return { board, updated: false };
return { board: withUpdatedColumns(board, columns), updated: true };
```

~20 lines of structural boilerplate per function, identical except for the spread expression.

**What the refactor looks like:**

Extract a single helper:

```typescript
function updateCardInBoard(
   board: BoardData,
   taskId: string,
   update: (card: BoardCard) => BoardCard | null,
): { board: BoardData; updated: boolean } {
   let updated = false;
   const columns = board.columns.map((column) => {
      let columnUpdated = false;
      const cards = column.cards.map((card) => {
         if (card.id !== taskId) return card;
         const next = update(card);
         if (!next || next === card) return card;
         columnUpdated = true;
         updated = true;
         return next;
      });
      return columnUpdated ? { ...column, cards } : column;
   });
   if (!updated) return { board, updated: false };
   return { board: withUpdatedColumns(board, columns), updated: true };
}
```

Each caller collapses to the unique part — the update expression:

```typescript
export function reconcileTaskBranch(board, taskId, branch) {
   // ... normalization / early returns ...
   return updateCardInBoard(board, taskId, (card) => {
      if ((card.branch ?? null) === normalizedBranch) return null;
      return { ...card, branch: normalizedBranch, updatedAt: Date.now() };
   });
}

export function toggleTaskPinned(board, taskId) {
   return updateCardInBoard(board, taskId, (card) => ({
      ...card,
      pinned: card.pinned ? undefined : true,
   }));
}
```

Return `null` from the updater to signal "no change" (keeps the existing early-return optimization where the column reference is preserved when no card in it changed).

**Estimated scope:**
- 1 new private helper (~15 lines)
- 4 functions simplified (each loses ~15 lines of boilerplate)
- Net reduction: ~45 lines
- Existing unit tests in `web-ui/tests/` cover all four functions — run `npm run web:test` to verify

**Risk:** Trivial. Pure mechanical extraction. The helper is private to the module.

---

## 3. Git action boilerplate in web-ui hooks

**Files:**
- `web-ui/src/hooks/git/use-git-actions.ts` (626 lines)
- `web-ui/src/hooks/git/use-branch-actions.ts` (520 lines)
- `web-ui/src/hooks/git/git-actions.ts` (existing domain module)
- `web-ui/src/utils/react-use.ts` (existing cross-cutting hooks)

**Problem A — Toast boilerplate:** `use-git-actions.ts` has 21 calls to `showAppToast` with the same shape:

```typescript
showAppToast({
   intent: "danger",
   icon: "warning-sign",
   message: `Could not switch to ${branch}. ${errorMessage}`,
   timeout: 7000,
});
```

The only things that vary are `message`, `timeout`, and occasionally `intent`. Five lines of noise per call site.

**Problem B — Loading guard boilerplate:** Five operations in `use-git-actions.ts` each manage a dedicated boolean loading flag with identical ceremony:

```typescript
const [isDiscardingHomeWorkingChanges, setIsDiscardingHomeWorkingChanges] = useState(false);
// ...
if (!currentProjectId || isDiscardingHomeWorkingChanges) return;
setIsDiscardingHomeWorkingChanges(true);
try { /* actual work */ }
finally { setIsDiscardingHomeWorkingChanges(false); }
```

This pattern repeats for `runningGitAction`, `isSwitchingHomeBranch`, `isDiscardingHomeWorkingChanges`, `isStashAndRetryingPull`. Same in `use-branch-actions.ts` for merge/delete/rebase/rename/reset dialog states.

**What the refactor looks like:**

**Part 1 — Toast helpers** in `hooks/git/git-actions.ts` (the companion domain module that already exists):

```typescript
export function showGitErrorToast(message: string, timeout = 7000): void {
   showAppToast({ intent: "danger", icon: "warning-sign", message, timeout });
}

export function showGitSuccessToast(message: string, timeout = 4000): void {
   showAppToast({ intent: "success", icon: "tick", message, timeout });
}

export function showGitWarningToast(message: string, timeout = 7000): void {
   showAppToast({ intent: "warning", icon: "warning-sign", message, timeout });
}
```

Each 5-line toast call becomes a one-liner: `showGitErrorToast(\`Could not switch to ${branch}. ${msg}\`)`.

**Part 2 — `useLoadingGuard`** in `utils/react-use.ts`:

```typescript
export function useLoadingGuard(): [boolean, (fn: () => Promise<void>) => Promise<void>] {
   const [loading, setLoading] = useState(false);
   const run = useCallback(async (fn: () => Promise<void>) => {
      if (loading) return;
      setLoading(true);
      try { await fn(); }
      finally { setLoading(false); }
   }, [loading]);
   return [loading, run] as const;
}
```

Each operation replaces its `useState` + guard + try/finally with:

```typescript
const [isDiscarding, runDiscard] = useLoadingGuard();
// later:
await runDiscard(async () => {
   const trpcClient = getRuntimeTrpcClient(currentProjectId);
   const payload = await trpcClient.workspace.discardGitChanges.mutate(null);
   // ... handle payload ...
});
```

The `currentProjectId` guard stays inline — that's domain logic, not boilerplate.

**Estimated scope:**
- 3 toast helpers added to `git-actions.ts` (~10 lines)
- 1 hook added to `react-use.ts` (~12 lines)
- ~21 toast call sites simplified in `use-git-actions.ts`
- ~5 loading patterns simplified across both git hook files
- Net reduction: ~100-150 lines across the two hook files
- Add unit tests for `useLoadingGuard` in `web-ui/tests/`

**Risk:** Low. Toast helpers are a pure rename. `useLoadingGuard` replaces a pattern that's already in use — the behavior is identical. The `loading` value in the dependency array of `useCallback` ensures the guard check reads current state (matching the existing `if (isDiscarding) return` pattern that reads from the closure).

---

## 4. Runtime barrel exports

**Directories:** `src/terminal/`, `src/server/`, `src/workspace/`, `src/state/`, `src/config/`, `src/trpc/`, `src/fs/`, `src/title/`

**Problem:** Only `src/core/api/` and `src/index.ts` have barrel files. Every other import reaches directly into a module's internals:

```typescript
import { TerminalSessionManager } from "../terminal/session-manager";
import { resolveTaskWorkingDirectory } from "../workspace/task-worktree";
import { getGitSyncSummary } from "../workspace/git-probe";
```

There's no distinction between "public API of this module" and "internal implementation detail." In C# terms, everything is `public` — there's no `internal` keyword equivalent.

**What the refactor looks like:**

Add an `index.ts` to each directory that re-exports the public surface:

```typescript
// src/terminal/index.ts
export { TerminalSessionManager } from "./session-manager";
export type { TerminalSessionEntry } from "./session-manager-types";
export { TerminalStore } from "./terminal-store";
// ... only what other modules actually import
```

Then update imports across the codebase:

```typescript
// Before
import { TerminalSessionManager } from "../terminal/session-manager";
// After
import { TerminalSessionManager } from "../terminal";
```

**How to build each barrel:**
1. For each directory, grep for what other directories import from it
2. Those imports are the public surface — re-export them from `index.ts`
3. Everything else is internal (not re-exported)
4. Update import paths across the codebase

**What this buys you:**
- Open `terminal/index.ts` → see the entire public API at a glance (like viewing a C# namespace in Solution Explorer)
- Refactoring internals (renaming files, splitting modules) doesn't break consumers — they import from the barrel
- grep for `from "../terminal"` to find all consumers of the terminal module

**Estimated scope:**
- ~8 new `index.ts` files, each 5-20 lines
- ~100-150 import path updates across the codebase (mechanical find-and-replace)
- No logic changes, no behavior changes
- Verify with `npm run typecheck && npm run test`

**Risk:** None. Pure re-exports. The TypeScript compiler will catch any missed re-exports or broken paths.

**Suggested order:** Start with `terminal/` and `workspace/` — they have the most consumers and the biggest payoff. `fs/` and `title/` are small (1-4 files each) and can be done last.

| Directory | Approx. public exports | Approx. consumers |
|-----------|----------------------|-------------------|
| `terminal/` | 8-10 | 15+ imports across server/, trpc/, commands/ |
| `workspace/` | 15-20 | 20+ imports across trpc/, server/, terminal/ |
| `server/` | 5-8 | 10+ imports across trpc/, cli.ts |
| `config/` | 4-6 | 10+ imports across server/, trpc/, commands/ |
| `state/` | 3-4 | 8+ imports across server/, workspace/, trpc/ |
| `trpc/` | 3-4 | 5+ imports from server/, cli.ts |
| `fs/` | 2-3 | 5+ imports |
| `title/` | 1-2 | 2 imports |
