# Task Graph: Merge/Rebase Conflict Resolver

**Generated**: 2026-04-12
**Spec**: [spec.md](spec.md)
**Test Spec**: [test-spec.md](test-spec.md)
**Total tasks**: 15 (4 grade-1, 9 grade-2, 2 grade-3 decomposed into 4 grade-2 subtasks)

## Execution Order

```
T1: Schema extensions (grade 2)
T2: Conflict detection functions (grade 2) — depends on T1
T3: Conflict resolution functions + stop auto-abort (grade 2) — depends on T1, T2
T4: Map unmerged status code (grade 1) — depends on T1
T5: Phase 1 tests (grade 2) — depends on T2, T3, T4
T6: Metadata monitor conflict detection (grade 2) — depends on T2
T7: Frontend metadata store + hooks (grade 2) — depends on T1
T8: tRPC API endpoints (grade 2) — depends on T3
T9: Phase 3 tests (grade 1) — depends on T8
T10: Conflict resolution hook (grade 2) — depends on T7, T8
T11: Conflict resolution panel (grade 3 → decomposed)
  T11a: Panel shell — banner, action bar, layout (grade 2) — depends on T10
  T11b: File list + detail pane (grade 2) — depends on T11a
T12: GitView integration + branch actions (grade 2) — depends on T11a
T13: Conflict status badge in file tree (grade 1) — depends on T1
T14: UI tests (grade 2) — depends on T10, T11b, T12
T15: Integration tests (grade 2) — depends on T3, T8
```

## Tasks

### T1: Schema Extensions

- **Grade**: 2
- **Status**: pending
- **Depends on**: none
- **SDD Phase**: Phase 1, items 1-2
- **Files to modify**:
  - `src/core/api-contract.ts` — add "conflicted" to file status enum, add all new conflict schemas (runtimeConflictFileSchema, runtimeConflictStateSchema, request/response schemas for resolve/continue/abort/files), extend runtimeGitMergeResponseSchema with optional conflictState, add conflictState to runtimeTaskWorkspaceMetadataSchema, add homeConflictState to runtimeWorkspaceMetadataSchema
- **Description**: Add all Zod schemas and TypeScript types defined in the spec's Interface Contracts section. This is a single-file change to api-contract.ts. The extended file status enum, conflict state schema, all request/response schemas, and both metadata schema extensions go in this task. Export all types. No runtime logic — just type definitions.
- **Acceptance criteria**:
  - [ ] `npm run typecheck` passes
  - [ ] All new schemas importable from `src/core/api-contract.ts`
  - [ ] `runtimeWorkspaceFileStatusSchema` includes `"conflicted"`
  - [ ] `runtimeTaskWorkspaceMetadataSchema` has `conflictState: runtimeConflictStateSchema.nullable()`
  - [ ] `runtimeWorkspaceMetadataSchema` has `homeConflictState: runtimeConflictStateSchema.nullable()`
  - [ ] `runtimeGitMergeResponseSchema` has `conflictState: runtimeConflictStateSchema.optional()`
- **Outcome notes**:
- **Attempts**:

---

### T2: Conflict Detection Functions

- **Grade**: 2
- **Status**: pending
- **Depends on**: T1
- **SDD Phase**: Phase 1, item 4 (detection subset)
- **Files to modify**:
  - `src/workspace/git-sync.ts` — add `detectActiveConflict`, `getConflictedFiles`, `getConflictFileContent`, `getConflictState` functions
- **Description**: Implement the four conflict detection/query functions in git-sync.ts:
  - `detectActiveConflict(cwd)`: Check `.git/MERGE_HEAD` (merge) or `.git/rebase-merge/` (rebase). Return `{operation, sourceBranch, currentStep, totalSteps}` or `null`. For rebase, read `.git/rebase-merge/msgnum` and `.git/rebase-merge/end`. For merge, parse `.git/MERGE_MSG` with regex `/^Merge branch '([^']+)'/`.
  - `getConflictedFiles(cwd)`: Run `git ls-files -u`, parse tab-delimited output (`<mode> <object> <stage>\t<path>`), deduplicate paths. Return string array.
  - `getConflictFileContent(cwd, path)`: Run `git show :2:<path>` (ours) and `git show :3:<path>` (theirs). Return `{path, oursContent, theirsContent}`. Handle missing stages gracefully (return empty string or null).
  - `getConflictState(cwd, overrides?)`: Compose RuntimeConflictState from detectActiveConflict + getConflictedFiles. Accept optional `{operation, sourceBranch}` overrides.
  All functions are pure — no side effects, no state mutations.
- **Acceptance criteria**:
  - [ ] `npm run typecheck` passes
  - [ ] Functions exported from git-sync.ts
  - [ ] Each function uses `runGit` for git commands (following existing pattern)
  - [ ] `detectActiveConflict` checks filesystem for `.git/MERGE_HEAD` and `.git/rebase-merge/`
  - [ ] `getConflictedFiles` correctly deduplicates stage entries
- **Outcome notes**:
- **Attempts**:

---

### T3: Conflict Resolution Functions + Stop Auto-Abort

- **Grade**: 2
- **Status**: pending
- **Depends on**: T1, T2
- **SDD Phase**: Phase 1, items 3-4 (resolution subset)
- **Files to modify**:
  - `src/workspace/git-sync.ts` — modify `runGitMergeAction` to stop auto-aborting, add `resolveConflictFile`, `continueMergeOrRebase`, `abortMergeOrRebase` functions
- **Description**: Three new functions + modify one existing:
  - **Modify `runGitMergeAction`** (L405-418): After `git merge --no-edit` fails, run `git ls-files -u`. If output is non-empty → conflict, do NOT abort, call `getConflictState(repoRoot, {operation: "merge", sourceBranch: branchToMerge})`, return `{ok: false, conflictState, ...}`. If output is empty → other error, still abort as before.
  - **`resolveConflictFile(cwd, path, resolution)`**: For "ours": `git checkout --ours -- <path>` then `git add -- <path>`. For "theirs": same with `--theirs`. Return `{ok, error?}`.
  - **`continueMergeOrRebase(cwd)`**: Call `detectActiveConflict` to determine operation. Merge: `git commit --no-edit`. Rebase: `git -c core.editor=true rebase --continue`. If rebase surfaces new conflicts, return `{ok: false, completed: false, conflictState}`. If completed, return `{ok: true, completed: true}`. Always include `summary` from `getGitSyncSummary`.
  - **`abortMergeOrRebase(cwd)`**: Detect operation, run `git merge --abort` or `git rebase --abort`. Return `{ok, summary, error?}`.
- **Acceptance criteria**:
  - [ ] `npm run typecheck` passes
  - [ ] `runGitMergeAction` no longer calls `git merge --abort` when `git ls-files -u` has output
  - [ ] `runGitMergeAction` still aborts for non-conflict merge failures
  - [ ] `resolveConflictFile` stages the resolved file
  - [ ] `continueMergeOrRebase` creates merge commit or continues rebase
  - [ ] `abortMergeOrRebase` restores clean state
- **Outcome notes**:
- **Attempts**:

---

### T4: Map Unmerged Status Code

- **Grade**: 1
- **Status**: pending
- **Depends on**: T1
- **SDD Phase**: Phase 1, items 5-6
- **Files to modify**:
  - `src/workspace/get-workspace-changes.ts` — add `if (kind === "U") return "conflicted"` to `mapNameStatus`
  - `src/workspace/git-sync.ts` — add `unmergedFiles` count to `probeGitWorkspaceState` when `u ` lines encountered
- **Description**: Two small changes: (1) In `mapNameStatus` at L55-63, add a case for `"U"` returning `"conflicted"`. (2) In `probeGitWorkspaceState` at L166, when `u ` prefix lines are parsed, also increment a new `unmergedFiles` counter on the return type (alongside existing `changedFiles` increment).
- **Acceptance criteria**:
  - [ ] `npm run typecheck` passes
  - [ ] `mapNameStatus("U")` returns `"conflicted"`
  - [ ] Existing mappings (M/A/D/R/C) unchanged (regression)
- **Outcome notes**:
- **Attempts**:

---

### T5: Phase 1 Tests

- **Grade**: 2
- **Status**: pending
- **Depends on**: T2, T3, T4
- **SDD Phase**: Phase 1 (testing)
- **Files to modify**:
  - `test/runtime/git-conflict.test.ts` — NEW, all 17 git conflict operation unit tests
- **Description**: Write all unit tests from the test spec's "Git Conflict Operations" section. Use real git repos via `createGitTestEnv()` pattern from `test/runtime/git-commit.test.ts`. Extract a shared `createMergeConflictRepo()` helper that creates a repo with two branches conflicting on a file. Tests cover: detectActiveConflict (clean/merge/rebase), getConflictedFiles, getConflictFileContent, resolveConflictFile (ours/theirs), continueMergeOrRebase (merge/rebase/multi-round), abortMergeOrRebase, runGitMergeAction (pause on conflict, abort on non-conflict, clean merge regression), mapNameStatus.
- **Acceptance criteria**:
  - [ ] `npx vitest run test/runtime/git-conflict.test.ts` — all tests pass
  - [ ] At least 15 test cases covering all functions
  - [ ] Tests use real git repos, not mocks
- **Outcome notes**:
- **Attempts**:

---

### T6: Metadata Monitor Conflict Detection

- **Grade**: 2
- **Status**: pending
- **Depends on**: T2
- **SDD Phase**: Phase 2, items 1-2
- **Files to modify**:
  - `src/server/workspace-metadata-monitor.ts` — add conflict detection to task + home metadata polling, update equality comparators, extend CachedHomeGitMetadata
- **Description**: Wire conflict detection into the existing metadata polling cycle:
  - **Task metadata** (L282-305): After the existing `Promise.all`, call `detectActiveConflict(pathInfo.path)`. If active, also call `getConflictedFiles` to build full conflict state. Include as `conflictState` in returned metadata.
  - **areTaskMetadataEqual** (L115-131): Add `conflictState` comparison. Create `areConflictStatesEqual(a, b)` helper — null-safe, checks operation + conflictedFiles array equality + currentStep + totalSteps.
  - **CachedHomeGitMetadata** (L27-31): Add `conflictState: RuntimeConflictState | null` field.
  - **loadHomeGitMetadata** (L191-206): After state token check, call `detectActiveConflict` + conditionally `getConflictedFiles`. Store in cache.
  - **buildWorkspaceMetadataSnapshot** (L181-189): Include `homeConflictState: entry.homeGit.conflictState`.
  - **areWorkspaceMetadataEqual** (L133-151): Compare `homeConflictState` using same helper.
  - **createWorkspaceEntry / createEmptyWorkspaceMetadata**: Initialize conflictState to null.
- **Acceptance criteria**:
  - [ ] `npm run typecheck` passes
  - [ ] Task metadata includes `conflictState` when conflict detected
  - [ ] Home metadata includes `conflictState` when conflict detected
  - [ ] Equality comparators detect conflict state changes → broadcasts fire
  - [ ] No conflict → `conflictState` is null
- **Outcome notes**:
- **Attempts**:

---

### T7: Frontend Metadata Store + Hooks

- **Grade**: 2
- **Status**: pending
- **Depends on**: T1
- **SDD Phase**: Phase 2, items 4-5
- **Files to modify**:
  - `web-ui/src/types/board.ts` — add `conflictState: RuntimeConflictState | null` to `ReviewTaskWorkspaceSnapshot`
  - `web-ui/src/stores/workspace-metadata-store.ts` — map conflictState in `toTaskWorkspaceSnapshot`, update equality check, export `useConflictState(taskId)` and `useHomeConflictState()` hooks
- **Description**: Plumb conflict state from runtime metadata through to frontend hooks:
  - **board.ts**: Add `conflictState` field to `ReviewTaskWorkspaceSnapshot` interface. Import `RuntimeConflictState`.
  - **workspace-metadata-store.ts**: Map `conflictState` in `toTaskWorkspaceSnapshot`. Update snapshot equality to compare the new field. Export `useConflictState(taskId: string | null)` — subscribe to task metadata, return `conflictState` or null. Export `useHomeConflictState()` — track `homeConflictState` from workspace-level metadata via a module-level variable updated in existing metadata application function, exposed via `useSyncExternalStore`.
- **Acceptance criteria**:
  - [ ] `npm run web:typecheck` passes
  - [ ] `useConflictState(taskId)` returns `RuntimeConflictState | null`
  - [ ] `useHomeConflictState()` returns `RuntimeConflictState | null`
  - [ ] Both hooks call `useSyncExternalStore` (not useState)
- **Outcome notes**:
- **Attempts**:

---

### T8: tRPC API Endpoints

- **Grade**: 2
- **Status**: pending
- **Depends on**: T3
- **SDD Phase**: Phase 3, items 1-3
- **Files to modify**:
  - `src/trpc/workspace-api.ts` — add `getConflictFiles`, `resolveConflictFile`, `continueConflictResolution`, `abortConflictResolution` methods; update `mergeBranch` to broadcast on conflict
  - `src/trpc/app-router.ts` — add 4 new `workspaceProcedure` routes
- **Description**: Expose conflict operations via tRPC following the `mergeBranch` pattern:
  - **workspace-api.ts**: Four new methods. Each resolves cwd from taskId (reuse existing pattern from `mergeBranch`). `getConflictFiles` calls `getConflictFileContent` per path. `resolveConflictFile` calls git-sync + broadcasts metadata update. `continueConflictResolution` calls `continueMergeOrRebase` + broadcasts. `abortConflictResolution` calls `abortMergeOrRebase` + broadcasts. Update `mergeBranch`: when response has `conflictState`, broadcast metadata update.
  - **app-router.ts**: Four new `workspaceProcedure` routes with `.input(schema).output(schema).mutation(...)`.
- **Acceptance criteria**:
  - [ ] `npm run typecheck` passes
  - [ ] All 4 new endpoints registered in app-router
  - [ ] `mergeBranch` broadcasts metadata on conflict
  - [ ] Each endpoint resolves cwd correctly for both task and home contexts
- **Outcome notes**:
- **Attempts**:

---

### T9: Phase 3 Tests

- **Grade**: 1
- **Status**: pending
- **Depends on**: T8
- **SDD Phase**: Phase 3 (testing)
- **Files to modify**:
  - `test/runtime/trpc/workspace-api-conflict.test.ts` — NEW, 6 tRPC endpoint tests
- **Description**: Write mocked tRPC endpoint tests following the pattern in `test/runtime/trpc/workspace-api.test.ts:29-56`. Mock git-sync functions via `vi.mock`. Test that each endpoint: (1) delegates to the correct git-sync function, (2) passes correct args, (3) broadcasts metadata update on resolve/continue/abort, (4) mergeBranch returns conflictState on conflict.
- **Acceptance criteria**:
  - [ ] `npx vitest run test/runtime/trpc/workspace-api-conflict.test.ts` — all pass
  - [ ] 6 test cases covering all endpoints
- **Outcome notes**:
- **Attempts**:

---

### T10: Conflict Resolution Hook

- **Grade**: 2
- **Status**: pending
- **Depends on**: T7, T8
- **SDD Phase**: Phase 4, item 1
- **Files to modify**:
  - `web-ui/src/hooks/use-conflict-resolution.ts` — NEW
- **Description**: Create the `useConflictResolution({taskId, projectId})` hook:
  - Call `useConflictState(taskId)` and `useHomeConflictState()` unconditionally (React rules). Select based on `taskId` nullability.
  - When `isActive` (conflict state non-null), load conflict file content via `trpc.workspace.getConflictFiles` for currently-selected or all files.
  - Expose mutation wrappers: `resolveFile(path, resolution)`, `continueResolution()`, `abortResolution()`.
  - Track `resolvedFiles` client-side: add optimistically on resolve, detect shrinkage in `conflictedFiles` across polls, **reset when `currentStep` changes** (rebase round advance) using a `useRef` for previous step.
  - Track `selectedPath` / `setSelectedPath`.
  - Track loading/error states.
  - Return `{ isActive, conflictState, conflictFiles, resolvedFiles, selectedPath, setSelectedPath, resolveFile, continueResolution, abortResolution, isLoading }`.
- **Acceptance criteria**:
  - [ ] `npm run web:typecheck` passes
  - [ ] Hook returns `isActive: false` when no conflict
  - [ ] Hook returns `isActive: true` with correct data when conflict active
  - [ ] `resolvedFiles` resets on `currentStep` change
- **Outcome notes**:
- **Attempts**:

---

### T11a: Conflict Panel Shell — Banner, Action Bar, Layout

- **Grade**: 2
- **Status**: pending
- **Depends on**: T10
- **SDD Phase**: Phase 4, item 2 (layout subset)
- **Files to modify**:
  - `web-ui/src/components/detail-panels/conflict-resolution-panel.tsx` — NEW
- **Description**: Create the conflict resolution panel component with the outer shell:
  - **Banner**: Top bar with `bg-status-orange/10` background, `border-status-orange` left accent. Merge: "Merge in progress — N conflicts remaining". Rebase: "Rebase in progress — commit N of M — N conflicts remaining".
  - **Action bar**: "Abort [Merge/Rebase]" button (`variant="danger"`, always enabled). "Complete [Merge/Rebase]" button (`variant="primary"`, disabled when unresolved files exist, enabled when all resolved).
  - **Progress**: "N of M files resolved" text.
  - **Layout**: Full-height flex column. Banner at top, content area (left pane + right pane) in middle, action bar at bottom. Left/right split follows GitView's resizable pattern.
  - Accept all data and callbacks as props from the hook (the parent GitView will wire them).
- **Acceptance criteria**:
  - [ ] `npm run web:typecheck` passes
  - [ ] Component renders banner with correct operation text
  - [ ] Abort button always enabled
  - [ ] Complete button disabled when unresolved files > 0
  - [ ] Component is imported and rendered (not dead code)
- **Outcome notes**:
- **Attempts**:

---

### T11b: Conflict Panel File List + Detail Pane

- **Grade**: 2
- **Status**: pending
- **Depends on**: T11a
- **SDD Phase**: Phase 4, item 2 (content subset)
- **Files to modify**:
  - `web-ui/src/components/detail-panels/conflict-resolution-panel.tsx` — extend with file list and detail content
- **Description**: Add the two content panes inside the panel:
  - **File list (left pane)**: List of conflicted files. Each shows path + status icon (orange conflict icon if unresolved, green check if resolved). Click selects file. Follow `FileTreePanel` pattern.
  - **File detail (right pane)**: When a file is selected and unresolved, show ours-vs-theirs diff via `DiffViewerPanel`. Construct a single-element `RuntimeWorkspaceFileChange[]` with `{path, status: "conflicted", oldText: oursContent, newText: theirsContent, additions: 0, deletions: 0}`. Pass empty `comments` Map and no-op `onCommentsChange`. Below the diff, render three action buttons: "Accept Ours" (calls `resolveFile(path, "ours")`), "Accept Theirs" (calls `resolveFile(path, "theirs")`), "Resolve Manually" (shows toast: "Edit {filename} in the terminal and run `git add {filename}` when done. The conflict panel will update automatically.").
  - When selected file is resolved, show a simple "File resolved" indicator.
- **Acceptance criteria**:
  - [ ] `npm run web:typecheck` passes
  - [ ] File list renders all conflicted files with status icons
  - [ ] Clicking a file shows its ours-vs-theirs diff
  - [ ] Accept Ours/Theirs buttons call resolveFile with correct args
  - [ ] Resolve Manually shows instructional toast
- **Outcome notes**:
- **Attempts**:

---

### T12: GitView Integration + Branch Actions

- **Grade**: 2
- **Status**: pending
- **Depends on**: T11a
- **SDD Phase**: Phase 4, items 3-4, 6
- **Files to modify**:
  - `web-ui/src/components/git-view.tsx` — add conditional render for conflict panel
  - `web-ui/src/hooks/use-branch-actions.ts` — handle conflict response, add onConflictDetected callback
- **Description**: Two integration points:
  - **GitView** (L410-524): Import `useConflictResolution` hook. Call it with `taskId` and `currentProjectId`. At the top of the render, if `conflictResolution.isActive`, return `<ConflictResolutionPanel>` with all hook state as props, replacing the entire normal layout (tabs + file tree + diff).
  - **use-branch-actions.ts** (L146-167): Add `onConflictDetected?: () => void` to `UseBranchActionsOptions` (L12-31). In `handleMergeBranch`, after mutate, check if response has `conflictState`. If yes: show `toast.info("Merge has conflicts — resolve in the Git view")`, call `onConflictDetected?.()`. Do NOT show error toast. Wire `onConflictDetected` from App.tsx call site to `() => setMainView("git")`.
- **Acceptance criteria**:
  - [ ] `npm run web:typecheck` passes
  - [ ] When conflict active, GitView shows conflict panel instead of tabs
  - [ ] When no conflict, GitView shows normal tabs (regression)
  - [ ] Merge with conflict shows info toast and navigates to Git view
  - [ ] Merge without conflict shows success toast (regression)
- **Outcome notes**:
- **Attempts**:

---

### T13: Conflict Status Badge in File Tree

- **Grade**: 1
- **Status**: pending
- **Depends on**: T1
- **SDD Phase**: Phase 4, item 5
- **Files to modify**:
  - `web-ui/src/components/detail-panels/file-tree-panel.tsx` — add rendering for "conflicted" status
- **Description**: Add visual treatment for `"conflicted"` file status in `FileTreePanel`. Follow existing status badge pattern (M = modified, A = added, D = deleted, R = renamed). For conflicted: orange badge with "C" text, matching `text-status-orange` color. This is a 1-line addition to the status badge rendering switch.
- **Acceptance criteria**:
  - [ ] `npm run web:typecheck` passes
  - [ ] Files with `"conflicted"` status show orange "C" badge
  - [ ] Existing status badges unchanged (regression)
- **Outcome notes**:
- **Attempts**:

---

### T14: UI Tests

- **Grade**: 2
- **Status**: pending
- **Depends on**: T10, T11b, T12
- **SDD Phase**: Phase 4 (testing)
- **Files to modify**:
  - `web-ui/src/hooks/use-conflict-resolution.test.ts` — NEW, 6 hook tests
  - `web-ui/src/components/detail-panels/conflict-resolution-panel.test.tsx` — NEW, 10 panel tests
- **Description**: Write all UI tests from the test spec:
  - **Hook tests**: isActive false/true, resolveFile/continue/abort call tRPC, resolvedFiles resets on currentStep change.
  - **Panel tests**: merge banner, rebase banner with steps, file list rendering, ours-vs-theirs diff, Accept Ours/Theirs buttons, Complete button disabled/enabled, Abort button always enabled, abort consequence text.
  Mock tRPC client and metadata store. Follow `use-commit-panel.test.ts` and `diff-viewer-panel.test.tsx` patterns.
- **Acceptance criteria**:
  - [ ] `npm run web:test` passes
  - [ ] 16 test cases total
- **Outcome notes**:
- **Attempts**:

---

### T15: Integration Tests

- **Grade**: 2
- **Status**: pending
- **Depends on**: T3, T8
- **SDD Phase**: All phases (end-to-end verification)
- **Files to modify**:
  - `test/runtime/git-conflict-integration.test.ts` — NEW, 5 integration tests
- **Description**: Write all integration tests from the test spec using real git repos (no mocks):
  1. Full merge conflict resolution flow (merge → detect → resolve all → continue → clean)
  2. Full rebase conflict resolution with multiple rounds (rebase via direct `execFileSync('git', ['rebase', 'main'])` → resolve round 1 → continue → resolve round 2 → complete)
  3. Abort mid-resolution restores clean state
  4. Rebase abort after multiple rounds restores original state
  5. Conflict detection on already-conflicted repo
  6. Manual resolution detected by metadata polling (external git add detected)
- **Acceptance criteria**:
  - [ ] `npx vitest run test/runtime/git-conflict-integration.test.ts` — all pass
  - [ ] Tests use real git repos with actual conflicts
  - [ ] Each test verifies full end-to-end flow
- **Outcome notes**:
- **Attempts**:

---

## Plan Corrections Log

| Correction | Type | Task | What changed |
|-----------|------|------|-------------|
| | | | |

## Summary

- **Completed**: 15 of 15 tasks
- **Stuck**: 0
- **Skipped**: 0
- **Plan corrections**: 0
- **Total build attempts**: 15
- **Verify phase fixes**: 2 (worktree git-dir resolution, onConflictDetected wiring)
