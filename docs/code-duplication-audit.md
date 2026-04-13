# Code Duplication Audit

Audit date: 2026-04-13

Findings ordered by cleanup impact (estimated lines removed + reduced maintenance surface). Each item includes the specific files/lines involved and a consolidation approach.

---

## 1. Confirmation Dialogs — shared wrapper component

**Impact: High (~150 lines per dialog, 17 dialog files)**

17 confirmation dialog components share 95% identical structure: same Radix Dialog/AlertDialog imports, same `open/onCancel/onConfirm` prop shape, same `onOpenChange` close handler, same Cancel + Action footer layout. Several also reimplement a `confirmFiredRef` workaround for Radix AlertDialog's double-fire on close.

Files:
- `web-ui/src/components/task-trash-warning-dialog.tsx`
- `web-ui/src/components/hard-delete-task-dialog.tsx`
- `web-ui/src/components/clear-trash-dialog.tsx`
- `web-ui/src/components/detail-panels/delete-branch-dialog.tsx`
- `web-ui/src/components/detail-panels/checkout-confirmation-dialog.tsx`
- `web-ui/src/components/git-history/cherry-pick-confirmation-dialog.tsx`
- (11 more with the same pattern)

Additionally, 9 of these dialogs hand-write Tailwind button classes (`px-3 py-1.5 text-xs rounded-md bg-accent...`) instead of using the `Button` component from `ui/button.tsx`.

**Consolidation**: Create a `ConfirmationDialog` component that accepts title, description, confirmLabel, variant (danger/default), and `onCancel`/`onConfirm` callbacks. Includes the double-fire guard internally. Each current dialog file becomes ~10 lines of props.

---

## 2. tRPC Mutation Boilerplate — shared mutation hook + error utility

**Impact: High (30+ hooks, 42 identical catch blocks)**

Hooks like `use-branch-actions.ts`, `use-git-actions.ts`, `use-commit-panel.ts`, `use-stash-list.ts` all follow the same pattern:

```typescript
try {
   const trpcClient = getRuntimeTrpcClient(workspaceId);
   const result = await trpcClient.workspace.someMethod.mutate({ ... });
   if (result.ok) {
      showAppToast({ intent: "success", message: "Done" });
   } else {
      showAppToast({ intent: "danger", message: result.error ?? "Failed" });
   }
} catch (error) {
   showAppToast({ intent: "danger", message: error instanceof Error ? error.message : String(error) });
}
```

The error extraction pattern `error instanceof Error ? error.message : String(error)` appears 42 times across 19 files. `showAppToast` is called 154 times across 30 files, overwhelmingly in success/error pairs.

Specific examples:
- `web-ui/src/hooks/use-stash-list.ts:74-138` — 4 nearly identical stash operation wrappers (pop, apply, drop, save)
- `web-ui/src/hooks/use-branch-actions.ts:138-337` — checkout, merge, delete all follow the same shape
- `web-ui/src/hooks/use-git-actions.ts:353-529` — runGitAction, switchHomeBranch, discardHomeWorkingChanges
- `web-ui/src/hooks/use-commit-panel.ts:163-252` — doCommit, discardAll

**Consolidation**:
1. Extract `toErrorMessage(error: unknown): string` utility
2. Create `useTrpcMutation` hook or a `wrapMutation(fn, { successMsg, errorMsg })` helper that handles the try/catch + toast pattern
3. Consider `showSuccessToast(msg)` / `showErrorToast(msg)` wrappers with sensible defaults (timeout, intent)

---

## 3. Git Numstat/Diff Parsing — consolidate in git-utils.ts

**Impact: High (5 implementations across 3 files)**

Multiple implementations of parsing `git diff --numstat` output:

- `src/workspace/git-sync.ts:58-79` — `parseNumstatTotals()`: splits lines, parses additions/deletions, sums totals
- `src/workspace/get-workspace-changes.ts:218-238` — `readDiffStat()`: runs numstat + parses
- `src/workspace/get-workspace-changes.ts:240-265` — `readDiffStatBetweenRefs()`: same with two refs
- `src/workspace/get-workspace-changes.ts:267-287` — `readDiffStatFromRef()`: same with one ref
- `src/workspace/git-history.ts:319-361` — `parseCommitNumstatEntries()`: parses per-file + totals

The parsing logic in each is nearly identical (split on `\n`, split on `\t`, parseInt additions/deletions). The callers differ only in which git command they run first.

Also: `countLines` in `git-sync.ts:51-56` and `toLineCount` in `get-workspace-changes.ts:66-71` are the exact same function with different names.

**Consolidation**: Add a shared `parseNumstat(stdout: string)` to `git-utils.ts` that returns per-file entries and totals. Callers just run their specific git command and pass stdout. Merge `countLines`/`toLineCount` into one.

---

## 4. File Fingerprinting — identical logic in two files

**Impact: Medium (two ~80-line blocks)**

Nearly identical interfaces and builder functions:

- `src/workspace/git-sync.ts:31-36` — `GitPathFingerprint` interface (path, size, mtimeMs, ctimeMs)
- `src/workspace/git-sync.ts:97-119` — `buildPathFingerprints()`: stats files, builds Map
- `src/workspace/get-workspace-changes.ts:48-53` — `FileFingerprint` interface (same shape)
- `src/workspace/get-workspace-changes.ts:110-137` — `buildFileFingerprints()`: same logic

**Consolidation**: Extract `FileFingerprint` + `buildFileFingerprints()` to a shared module (e.g. `src/workspace/file-fingerprint.ts` or add to `git-utils.ts`). Both consumers import it.

---

## 5. Git Repo Root Resolution — 5+ files, each with its own call

**Impact: Medium (scattered but adds up)**

`git rev-parse --show-toplevel` is called with bespoke error handling in:

- `src/workspace/git-sync.ts:222-228`
- `src/workspace/git-history.ts:46-50, 120-124, 404-408` (3 call sites)
- `src/workspace/get-workspace-changes.ts:361-364, 373-376, 433-436, 464-467` (4 call sites)
- `src/workspace/turn-checkpoints.ts`
- `src/state/workspace-state.ts:462-465` (`detectGitRoot`)

**Consolidation**: Add `getRepoRoot(cwd: string): Promise<string>` to `git-utils.ts`. All callers import it. Single error handling path.

---

## 6. Git Ref Validation — duplicate function

**Impact: Low (small but confusing)**

- `src/workspace/git-utils.ts:158-160` — `validateGitRef(ref)`: checks ref against injection patterns
- `src/workspace/get-workspace-changes.ts:27-30` — `validateRef(ref)`: same logic, different name

**Consolidation**: Delete `validateRef`, import `validateGitRef` from git-utils.

---

## 7. ANSI Stripping — two implementations across runtime/web-ui boundary

**Impact: Medium (correctness risk from divergent implementations)**

- Runtime: `src/terminal/output-utils.ts:1-45` — full state machine for stripping ANSI escape sequences
- Web-UI: `web-ui/src/terminal/terminal-prompt-heuristics.ts:1-17` — regex-based stripping (simpler, less complete)

The runtime version handles edge cases the regex version misses. Having two implementations means bugs get fixed in one but not the other.

**Consolidation**: Expose the runtime's `stripAnsi` via a path alias (like the existing `@runtime-contract` pattern) so web-ui can import it. Or extract to a tiny shared utility.

---

## 8. Git Error Formatting Round-Trip

**Impact: Medium (eliminates a regex hack)**

Runtime `src/workspace/git-utils.ts:67` wraps all git errors in `"Failed to run Git Command: {stderr}"` boilerplate. Web-UI `web-ui/src/utils/git-error.ts:19` regex-strips that exact prefix back out with `parseGitErrorForDisplay()`.

This is a formatting round-trip: the runtime adds noise, the UI removes it. The error would be more useful if it were user-friendly from the start.

**Consolidation**: Change `getGitCommandErrorMessage` to return just the meaningful error content. Remove the `parseGitErrorForDisplay` regex. If any consumer actually needs the verbose format, add it at the call site.

---

## 9. Path Normalization — 3-4 scattered implementations

**Impact: Medium (correctness risk on Windows)**

- `src/config/runtime-config.ts:305-308` — `normalizePathForComparison()`: resolve + backslash replace + lowercase on win32
- `src/commands/codex-hook-events.ts:98-100` — `normalizePathForComparison()`: backslash replace only (different behavior, same name!)
- `web-ui/src/utils/path-display.ts:1-3` — `normalizeDisplayPath()`: backslash replace
- `web-ui/src/utils/is-binary-file-path.ts:5-9` — `getPathBasename()`: backslash replace + basename

Two functions with the **same name** (`normalizePathForComparison`) doing **different things** is a bug waiting to happen.

**Consolidation**: Create a single `normalizePath` utility with clear semantics (always normalizes separators, optionally lowercases for comparison). Put it in a shared location. Remove the duplicates.

---

## 10. JSON File Read with ENOENT Handling — 3 implementations

**Impact: Low-Medium**

- `src/state/workspace-state.ts:236-252` — `readJsonFile()`: read + JSON.parse + ENOENT fallback
- `src/config/runtime-config.ts:388-395` — `readRuntimeConfigFile()`: same pattern
- `src/fs/locked-file-system.ts:60-69` — `readFileIfExists()`: same pattern

Related: ENOENT type-guard checking (`error.code === 'ENOENT'`) is reimplemented in 5+ files. `workspace-state.ts` has `isNodeErrorWithCode()` but nothing else imports it.

**Consolidation**: Extract `readJsonFileOrDefault<T>(path, fallback): Promise<T>` and `isNodeError(err, code)` to a shared fs utility. All three consumers (and the 5+ ad-hoc ENOENT checks) use it.

---

## 11. `runGitCapture` vs shared git execution

**Impact: Low**

`src/state/workspace-state.ts:448-460` has `runGitCapture()` using `spawnSync` instead of the shared `runGit`/`getGitStdout` from `git-utils.ts`. This is the only sync git caller.

**Consolidation**: If the sync requirement is real, add `getGitStdoutSync` to `git-utils.ts`. If not, switch to async. Either way, don't have a one-off reimplementation.

---

## 12. `useLatestRef` Pattern — 25+ hooks

**Impact: Low (small per-instance, high frequency)**

25+ hooks manually do:
```typescript
const optionsRef = useRef(options);
optionsRef.current = options;
```

Examples:
- `web-ui/src/hooks/use-shell-auto-restart.ts:33-46`
- `web-ui/src/hooks/use-review-auto-actions.ts:37-54`
- `web-ui/src/hooks/use-workspace-sync.ts:70-86`

**Consolidation**: Add a `useLatestRef<T>(value: T): MutableRefObject<T>` hook (3 lines). Replace all manual instances.

---

## 13. Request ID Cancellation Pattern — 3 hooks

**Impact: Low**

Three hooks implement identical request-ID-increment + stale-check logic:
- `web-ui/src/runtime/use-trpc-query.ts:36, 53-54, 60`
- `web-ui/src/hooks/use-workspace-sync.ts:74, 139-140, 146-150`
- `web-ui/src/components/task-prompt-composer.tsx`

**Consolidation**: Extract `useRequestId()` hook that returns `{ nextId(), isStale(id) }`.

---

## 14. Task Auto Review Mode Stubs — likely dead code

**Impact: Low (cleanup)**

`web-ui/src/types/board.ts:13-21` defines:
- `DEFAULT_TASK_AUTO_REVIEW_MODE` constant
- `resolveTaskAutoReviewMode()` — always returns same value
- `getTaskAutoReviewCancelButtonLabel()` — always returns same value

The runtime has actual resolution logic in `src/core/task-board-mutations.ts:37-42`. The web-ui stubs appear to be scaffolding that was never completed or dead code that was never removed.

**Consolidation**: Either wire up the real resolution (import from runtime via alias) or remove the stubs and inline the constants where used.

---

## Cleanup Order

Suggested sequence, balancing impact with risk:

| Phase | Items | Status |
|-------|-------|--------|
| 1 | #6 (validateRef), #14 (dead stubs) | **Done** |
| 2 | #3 (numstat parsing), #4 (fingerprinting), #5 (repo root) | **Done** |
| 3 | #10 (isNodeError), #11 (runGitSync) | **Done** — #9 (path normalization) skipped, divergent semantics are intentional |
| 2 partial | #2 (toErrorMessage utility) | **Done** — 18 files updated |
| 4 | #1 (ConfirmationDialog) | Remaining — needs visual testing |
| 5 | #12 (useLatestRef), #13 (request ID) | Skipped — too few instances (~10 and 3) to justify the abstraction |
| 6 | #7 (ANSI strip), #8 (git error format) | Remaining — cross-boundary, needs both sides updated together |
