# Test Specification: Merge/Rebase Conflict Resolver

**Date**: 2026-04-12
**Companion SDD**: [spec.md](spec.md)
**Ticket**: None
**Adversarial Review Passes**: 2

## Test Strategy

Test the conflict resolver at three layers: git operations (unit tests with real git repos), tRPC endpoints (mocked git-sync), and UI components (mocked tRPC). Integration tests use real git repos to verify end-to-end conflict detection and resolution flows.

### Test Infrastructure

- **Framework**: Vitest 4.1.x
- **Test directories**: `test/runtime/` (runtime unit/integration), `web-ui/src/**/*.test.tsx` (UI co-located)
- **Run commands**: `npm run test:fast` (runtime), `npm run web:test` (UI)
- **CI integration**: `npm test` + `npm --prefix web-ui run test` in `.github/workflows/test.yml`

### Coverage Goals

- Every SDD requirement has at least one test
- Every error scenario in the Error Handling table has a test
- Every git operation (detect, resolve, continue, abort) tested with real git repos
- UI tests verify component rendering and user interaction flows

## Unit Tests

### Git Conflict Operations

**Test file**: `test/runtime/git-conflict.test.ts`
**Pattern to follow**: `test/runtime/git-commit.test.ts:39-71` (real git repo setup pattern)

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `detectActiveConflict returns null for clean repo` | No false positives on clean state |
| 2 | `detectActiveConflict detects active merge` | Finds `.git/MERGE_HEAD`, returns `{operation: "merge"}` |
| 3 | `detectActiveConflict detects active rebase` | Finds `.git/rebase-merge/`, returns `{operation: "rebase"}` with step counts |
| 4 | `getConflictedFiles lists all conflicted paths` | Parses `git ls-files -u` output correctly |
| 5 | `getConflictedFiles returns empty for resolved conflicts` | After `git add`, files no longer in list |
| 6 | `getConflictFileContent returns ours and theirs` | `git show :2:` and `:3:` content correct |
| 7 | `getConflictFileContent handles deleted-on-one-side` | Graceful error when stage doesn't exist |
| 8 | `resolveConflictFile with ours resolves correctly` | File content matches ours version, file staged |
| 9 | `resolveConflictFile with theirs resolves correctly` | File content matches theirs version, file staged |
| 10 | `continueMergeOrRebase completes merge` | After all resolved, commit created |
| 11 | `continueMergeOrRebase on rebase returns new conflicts` | Second round of conflicts detected |
| 12 | `continueMergeOrRebase on rebase completes when no more conflicts` | Rebase finishes, returns completed=true |
| 13 | `abortMergeOrRebase aborts merge` | Clean state restored, MERGE_HEAD gone |
| 14 | `abortMergeOrRebase aborts rebase` | Clean state restored, rebase-merge gone |
| 15 | `runGitMergeAction pauses on conflict instead of aborting` | Returns conflictState, repo still in merge state |
| 16 | `runGitMergeAction still aborts on non-conflict errors` | Non-conflict merge failure still aborts |
| 17 | `runGitMergeAction succeeds for clean merge` | Regression: no-conflict merge works as before |

#### Test Details

##### 1. `detectActiveConflict returns null for clean repo`

**Setup**: Create temp git repo with `createGitTestEnv()`, make an initial commit.
**Action**: Call `detectActiveConflict(repoPath)`
**Assertions**:
- Returns `null`

##### 2. `detectActiveConflict detects active merge`

**Setup**: Create repo with two branches that conflict on same file. Run `git merge branchB` (will fail with conflict).
**Action**: Call `detectActiveConflict(repoPath)`
**Assertions**:
- Returns `{operation: "merge", sourceBranch}` where sourceBranch matches branchB
- `currentStep` is `null` (merge has no steps)
- `totalSteps` is `null`

##### 3. `detectActiveConflict detects active rebase`

**Setup**: Create repo with two branches that conflict. Run `git rebase branchB` from branchA.
**Action**: Call `detectActiveConflict(repoPath)`
**Assertions**:
- Returns `{operation: "rebase"}`
- `currentStep` is a positive integer
- `totalSteps` is a positive integer >= `currentStep`

##### 8. `resolveConflictFile with ours resolves correctly`

**Setup**: Create merge conflict on `file.txt`. Ours has "our content", theirs has "their content".
**Action**: Call `resolveConflictFile(repoPath, "file.txt", "ours")`
**Assertions**:
- Returns `{ok: true}`
- `fs.readFileSync("file.txt")` contains "our content" (not conflict markers)
- `git ls-files -u` no longer lists `file.txt`
- `git diff --cached --name-only` includes `file.txt` (staged)

##### 15. `runGitMergeAction pauses on conflict instead of aborting`

**Setup**: Create repo with conflicting branches.
**Action**: Call `runGitMergeAction({cwd: repoPath, branch: "branchB"})`
**Assertions**:
- Returns `{ok: false, conflictState: {operation: "merge", conflictedFiles: [...]}}`
- `.git/MERGE_HEAD` still exists (NOT aborted)
- `conflictState.conflictedFiles` contains the conflicted file paths

##### 16. `runGitMergeAction still aborts on non-conflict errors`

**Setup**: Try to merge a branch that doesn't exist, or merge with uncommitted changes.
**Action**: Call `runGitMergeAction({cwd: repoPath, branch: "nonexistent"})`
**Assertions**:
- Returns `{ok: false, error: "..."}`
- `conflictState` is undefined
- `.git/MERGE_HEAD` does NOT exist

### tRPC Conflict Endpoints

**Test file**: `test/runtime/trpc/workspace-api-conflict.test.ts`
**Pattern to follow**: `test/runtime/trpc/workspace-api.test.ts:29-56` (mocked git-sync pattern)

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `getConflictFiles returns file content` | Delegates to git-sync, returns correct shape |
| 2 | `resolveConflictFile calls resolveConflictFile` | Correct args passed through |
| 3 | `continueConflictResolution calls continueMergeOrRebase` | Correct delegation |
| 4 | `abortConflictResolution calls abortMergeOrRebase` | Correct delegation |
| 5 | `mergeBranch returns conflictState on conflict` | Extended response includes conflict data |
| 6 | `resolveConflictFile broadcasts metadata update` | State hub broadcast called |

### File Status Mapping

**Test file**: `test/runtime/get-workspace-changes.test.ts`
**Pattern to follow**: Inline tests for `mapNameStatus`

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `mapNameStatus returns conflicted for U status` | New "conflicted" mapping works |
| 2 | `mapNameStatus still returns correct values for M/A/D/R/C` | Regression: existing mappings unchanged |

### Conflict Resolution UI

**Test file**: `web-ui/src/hooks/use-conflict-resolution.test.ts`
**Pattern to follow**: `web-ui/src/hooks/use-commit-panel.test.ts`

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `isActive is false when no conflict state` | Hook returns inactive by default |
| 2 | `isActive is true when conflict state present` | Metadata conflict state triggers active |
| 3 | `resolveFile calls trpc mutation` | Correct args passed |
| 4 | `continueResolution calls trpc mutation` | Correct delegation |
| 5 | `abortResolution calls trpc mutation` | Correct delegation |
| 6 | `resolvedFiles resets when currentStep changes` | Rebase advancing to next commit clears stale resolved state |

### Conflict Resolution Panel

**Test file**: `web-ui/src/components/detail-panels/conflict-resolution-panel.test.tsx`
**Pattern to follow**: `web-ui/src/components/detail-panels/diff-viewer-panel.test.tsx`

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `renders merge banner when operation is merge` | "Merge in progress" text visible |
| 2 | `renders rebase banner with step count` | "Rebase in progress — commit N of M" |
| 3 | `renders file list with conflict status` | Files shown with unresolved/resolved indicators |
| 4 | `shows ours-vs-theirs diff when file selected` | Diff viewer rendered with correct content |
| 5 | `Accept Ours button calls resolveFile` | Callback invoked with correct args |
| 6 | `Accept Theirs button calls resolveFile` | Callback invoked with correct args |
| 7 | `Complete button disabled when unresolved files exist` | Button disabled state correct |
| 8 | `Complete button enabled when all files resolved` | Button enabled |
| 9 | `Abort button always enabled` | Not disabled by resolution state |
| 10 | `Abort button shows consequence text` | Tooltip/label describes what abort does |

## Integration Tests

### End-to-End Merge Conflict Resolution

**Test file**: `test/runtime/git-conflict-integration.test.ts`
**Dependencies**: Real git repo (no mocks)
**Setup**: Create repo with two branches, both modifying same file(s).

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `full merge conflict resolution flow` | Merge → detect → resolve all → continue → clean state |
| 2 | `full rebase conflict resolution with multiple rounds` | Rebase → resolve round 1 → continue → resolve round 2 → complete |
| 3 | `abort mid-resolution restores clean state` | Merge → resolve some → abort → all changes gone |
| 4 | `rebase abort after multiple rounds restores original state` | Rebase → resolve round 1 → continue → abort → original state |
| 5 | `conflict detection on already-conflicted repo` | Start with repo in conflict → detectActiveConflict works |

#### Test Details

##### 1. `full merge conflict resolution flow`

**Setup**:
```
init repo → commit file.txt "base"
create branchA → modify file.txt to "version A" → commit
checkout main → modify file.txt to "version B" → commit
```
**Action**:
```
runGitMergeAction({cwd, branch: "branchA"})
  → assert ok=false, conflictState present
getConflictedFiles(cwd) → assert ["file.txt"]
getConflictFileContent(cwd, "file.txt")
  → assert oursContent contains "version B", theirsContent contains "version A"
resolveConflictFile(cwd, "file.txt", "theirs")
  → assert ok=true
continueMergeOrRebase(cwd)
  → assert ok=true, completed=true
```
**Assertions**:
- Final file content is "version A" (theirs)
- `git log --oneline` shows merge commit
- `.git/MERGE_HEAD` does not exist
- `detectActiveConflict` returns null

##### 2. `full rebase conflict resolution with multiple rounds`

**Setup**:
```
init repo → commit file.txt "base"
create branchA → commit1: modify file.txt to "A1" → commit2: modify file.txt to "A2"
checkout main → modify file.txt to "B" → commit
checkout branchA → git rebase main (produces conflicts)
```
**Action**:
```
Round 1:
  detectActiveConflict → rebase, step 1
  getConflictedFiles → ["file.txt"]
  resolveConflictFile(cwd, "file.txt", "theirs")
  continueMergeOrRebase → may produce new conflict
Round 2 (if conflicts):
  detectActiveConflict → rebase, step 2
  resolveConflictFile(cwd, "file.txt", "theirs")
  continueMergeOrRebase → completed=true
```
**Assertions**:
- Rebase completed successfully
- `.git/rebase-merge/` does not exist
- Git log shows rebased commits

## Edge Cases & Error Scenarios

| # | Test Name | Scenario | Expected Behavior | Review Finding |
|---|-----------|----------|-------------------|----------------|
| 1 | `binary file conflict returns error for content` | Conflict on a binary file | `getConflictFileContent` returns error for content, path still listed | Error handling table |
| 2 | `resolve file with invalid path` | Path doesn't exist or has special chars | Returns `{ok: false, error}` | Input validation |
| 3 | `continue with unresolved files` | Call continue before all files resolved | Returns `{ok: false, error}`, stays in conflict state | Error handling table |
| 4 | `abort on already-clean repo` | Call abort when no merge/rebase active | Returns `{ok: true}` or graceful no-op | Edge case |
| 5 | `multiple conflicted files, resolve some, abort` | Three files conflict, resolve two, abort | All three reverted, clean state | Partial resolution abort |
| 6 | `deleted-on-one-side conflict` | File deleted in ours, modified in theirs | `getConflictFileContent` returns empty string for deleted side | Error handling table |

## Regression Tests

| # | Test Name | What Must Not Change | File Reference |
|---|-----------|---------------------|----------------|
| 1 | `clean merge still succeeds` | No-conflict merge works as before | `git-sync.ts:runGitMergeAction` |
| 2 | `mapNameStatus existing mappings unchanged` | M/A/D/R/C mappings still correct | `get-workspace-changes.ts:55-63` |
| 3 | `metadata polling still computes hasUnmergedChanges` | Branch divergence detection unaffected | `workspace-metadata-monitor.ts:300-305` |
| 4 | `pull ff-only still works` | Pull path unchanged | `git-sync.ts:300-305` |
| 5 | `probe still counts unmerged as changedFiles` | Existing behavior preserved | `git-sync.ts:166` |

## Test Execution Plan

### Phase 1: Schema & Git Operations

1. **Write regression tests** — verify existing merge behavior:
   - Write: `clean merge still succeeds`, `mapNameStatus existing mappings unchanged`
   - Run: `npm run test:fast` — all pass
2. **Write unit tests** — define conflict operation behavior:
   - Write: All 17 tests in "Git Conflict Operations" section
   - Run: `npm run test:fast` — fail (functions don't exist yet)
3. **Implement Phase 1**
   - Run: `npm run test:fast` — all pass

### Phase 2: Metadata Detection

1. **Write tests** — metadata conflict detection:
   - Write: Integration test `conflict detection on already-conflicted repo`
   - Run: `npm run test:fast` — fail
2. **Implement Phase 2**
   - Run: `npm run test:fast` — all pass

### Phase 3: tRPC Endpoints

1. **Write unit tests** — endpoint delegation:
   - Write: All 6 tests in "tRPC Conflict Endpoints" section
   - Run: `npm run test:fast` — fail
2. **Implement Phase 3**
   - Run: `npm run test:fast` — all pass

### Phase 4: UI

1. **Write UI tests** — hook and component:
   - Write: All tests in "Conflict Resolution UI" and "Conflict Resolution Panel" sections
   - Run: `npm run web:test` — fail
2. **Implement Phase 4**
   - Run: `npm run web:test` — all pass
3. **Write integration tests** — end-to-end flows:
   - Write: All 5 integration tests
   - Run: `npm run test` — all pass

### Commands

```bash
# Run all conflict-related tests
npx vitest run test/runtime/git-conflict.test.ts test/runtime/git-conflict-integration.test.ts test/runtime/trpc/workspace-api-conflict.test.ts

# Run single test file
npx vitest run test/runtime/git-conflict.test.ts

# Run web-ui conflict tests
cd web-ui && npx vitest run src/hooks/use-conflict-resolution.test.ts src/components/detail-panels/conflict-resolution-panel.test.tsx

# Run all tests
npm run test && npm run web:test
```

## Traceability Matrix

| SDD Requirement | Test(s) | Type |
|----------------|---------|------|
| !1 — Never auto-abort | `runGitMergeAction pauses on conflict`, `still aborts on non-conflict errors` | Unit |
| !2 — Conflict panel replaces GitView | `renders merge banner`, `renders rebase banner` | UI Unit |
| !3 — Per-file ours/theirs/manual | `resolveConflictFile with ours`, `resolveConflictFile with theirs`, `Accept Ours button`, `Accept Theirs button` | Unit + UI |
| !4 — Abort always available | `Abort button always enabled`, `abortMergeOrRebase aborts merge/rebase`, `abort mid-resolution restores clean state` | Unit + UI + Integration |
| !5 — Rebase multi-round | `continueMergeOrRebase on rebase returns new conflicts`, `full rebase with multiple rounds`, `resolvedFiles resets when currentStep changes` | Unit + Integration + UI |
| !6 — Conflict detection on reopen | `detectActiveConflict detects active merge/rebase`, `conflict detection on already-conflicted repo` | Unit + Integration |
| !7 — Ours-vs-theirs via index stages | `getConflictFileContent returns ours and theirs`, `shows ours-vs-theirs diff` | Unit + UI |
| Phase 1: Schema extension | `mapNameStatus returns conflicted for U`, regression tests | Unit |
| Phase 2: Metadata detection | `conflict detection on already-conflicted repo`, regression `hasUnmergedChanges` | Integration + Regression |
| Phase 3: tRPC endpoints | All tRPC endpoint tests | Unit |
| Phase 4: UI panel | All panel + hook tests | UI Unit |
| Error: binary file | `binary file conflict returns error` | Edge case |
| Error: continue with unresolved | `continue with unresolved files` | Edge case |
| Error: abort clean repo | `abort on already-clean repo` | Edge case |
