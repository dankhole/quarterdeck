# Test Specification: Git Stash in Commit Panel

**Date**: 2026-04-12
**Companion SDD**: [spec.md](spec.md)
**Adversarial Review Passes**: 1

## Test Strategy

Three test layers matching the existing patterns:
1. **Runtime unit tests** (real temp git repos) — verify git-sync stash functions against actual git
2. **Runtime tRPC tests** (mocked git-sync) — verify workspace-api route wiring, input validation, error handling
3. **Web UI hook tests** (mocked tRPC) — verify stash list hook behavior, state management

## Test Infrastructure

- **Framework**: Vitest 4.1
- **Runtime tests**: `test/runtime/` (real git repos via `createTempDir` + `createGitTestEnv`)
- **tRPC tests**: `test/runtime/trpc/` (vi.mock of git-sync module)
- **Web UI tests**: `web-ui/src/hooks/` (colocated, vi.mock of tRPC client)
- **Run commands**:
  - All runtime: `npm test`
  - Fast (no integration): `npm run test:fast`
  - Single file: `npx vitest run test/runtime/git-stash.test.ts`
  - Web UI: `npm run web:test`

## Unit Tests

### Git Stash Operations (git-sync.ts)

**Test file**: `test/runtime/git-stash.test.ts` (NEW)
**Pattern to follow**: See `test/runtime/git-commit.test.ts` for real-repo test setup.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `stashPush stashes all changes including untracked` | Full stash with --include-untracked |
| 2 | `stashPush stashes only selected paths` | Partial stash with -- <paths> |
| 3 | `stashPush includes custom message` | -m flag passes through |
| 4 | `stashPush returns error when nothing to stash` | Clean working tree edge case |
| 4b | `stashPush rejects invalid paths via validateGitPath` | Path traversal prevention |
| 5 | `stashList returns empty array for no stashes` | No stashes baseline |
| 6 | `stashList parses entries with index, message, branch, date` | Format parsing |
| 7 | `stashList handles multiple entries in stack order` | Index ordering |
| 8 | `stashPop restores changes and removes entry` | Standard pop |
| 9 | `stashPop detects conflict and retains entry` | Conflict detection |
| 10 | `stashApply restores changes and retains entry` | Apply vs pop difference |
| 11 | `stashApply detects conflict and retains entry` | Conflict on apply |
| 12 | `stashDrop removes entry without applying` | Standard drop |
| 13 | `stashDrop returns error for invalid index` | Out-of-range index |
| 14 | `stashShow returns diff for stash entry` | Diff output |
| 14b | `stashShow returns ok: false with no diff for invalid index` | Error path — diff is optional |
| 15 | `stashCount returns 0 for no stashes` | Count baseline |
| 16 | `stashCount returns correct count` | Count after push |

#### Test Details

##### 1. `stashPush stashes all changes including untracked`

**Setup**: Create temp git repo, commit initial file, create tracked change + untracked new file.
**Action**: `stashPush({ cwd, paths: [] })`
**Assertions**:
- Returns `{ ok: true }`
- `git status --porcelain` is empty (all changes stashed)
- `git stash list` shows 1 entry
- Pop the stash and verify both tracked change and untracked file are restored

##### 2. `stashPush stashes only selected paths`

**Setup**: Create temp git repo, commit 3 files, modify all 3.
**Action**: `stashPush({ cwd, paths: ["file1.txt", "file2.txt"] })`
**Assertions**:
- Returns `{ ok: true }`
- `git status --porcelain` shows only `file3.txt` as modified (the unstashed file)
- Pop the stash and verify `file1.txt` and `file2.txt` changes are restored

##### 4. `stashPush returns error when nothing to stash`

**Setup**: Create temp git repo with committed files, no modifications.
**Action**: `stashPush({ cwd, paths: [] })`
**Assertions**:
- Returns `{ ok: false, error: ... }` (git stash push fails on clean tree)

##### 6. `stashList parses entries with index, message, branch, date`

**Setup**: Create temp git repo, create a change, stash with message "test stash".
**Action**: `stashList(cwd)`
**Assertions**:
- Returns `{ ok: true, entries: [{ index: 0, message: "test stash", branch: "main", date: <valid ISO> }] }`

##### 9. `stashPop detects conflict and retains entry`

**Setup**: Create temp git repo. Create file `a.txt` with content "A". Commit. Change `a.txt` to "B", stash. Change `a.txt` to "C", stage.
**Action**: `stashPop({ cwd, index: 0 })`
**Assertions**:
- Returns `{ ok: false, conflicted: true }`
- `git stash list` still shows 1 entry (not removed)
- Git repo is in conflicted state (`git ls-files -u` shows unmerged)

### No-Optional-Locks Coverage

**Test file**: `test/runtime/git-sync-no-optional-locks.test.ts` (EXTEND)
**Changes**: Add `stashCount` to the assertions. `stashCount` runs `git --no-optional-locks stash list` (used in metadata polling) and must use the `--no-optional-locks` flag to avoid lock contention. Other stash functions (`stashPush`, `stashPop`, etc.) are user-initiated mutations and do NOT need `--no-optional-locks`.

### Workspace API Stash Endpoints

**Test file**: `test/runtime/trpc/workspace-api-stash.test.ts` (NEW)
**Pattern to follow**: See `test/runtime/trpc/workspace-api-conflict.test.ts` for vi.mock pattern.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `stashPush resolves task CWD and calls stashPush` | Task-scoped stash wiring |
| 2 | `stashPush uses home repo for null taskScope` | Home-scoped stash wiring |
| 3 | `stashPush broadcasts state update on success` | Verifies `deps.broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath)` is called |
| 4 | `stashList returns entries from git-sync` | Query pass-through |
| 5 | `stashPop calls stashPop and broadcasts` | Mutation + broadcast |
| 6 | `stashApply calls stashApply and broadcasts` | Mutation + broadcast |
| 7 | `stashDrop calls stashDrop and broadcasts` | Mutation + broadcast |
| 8 | `stashShow returns diff` | Query pass-through |
| 9 | `stash endpoints handle errors gracefully` | Try/catch fallback |

## Web UI Hook Tests

### useStashList Hook

**Test file**: `web-ui/src/hooks/use-stash-list.test.ts` (NEW)
**Pattern to follow**: See `web-ui/src/hooks/use-commit-panel.test.ts` for tRPC mock pattern.

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `fetches stash list on mount when expanded` | Initial data fetch |
| 2 | `refetches when stash count changes` | Metadata-driven refresh |
| 3 | `popStash calls tRPC and refetches` | Pop action wiring |
| 4 | `applyStash calls tRPC and refetches` | Apply action wiring |
| 5 | `dropStash calls tRPC and refetches` | Drop action wiring |

## Edge Cases & Error Scenarios

| # | Test Name | Scenario | Expected Behavior |
|---|-----------|----------|-------------------|
| 1 | `stashPush with empty paths array stashes all` | `paths: []` | Equivalent to `git stash push --include-untracked` |
| 2 | `stashPop on empty stack returns error` | No stashes exist | `{ ok: false, error: ... }` |
| 3 | `stashDrop with stale index returns error` | Another client dropped the stash | `{ ok: false, error: ... }` |
| 4 | `stashPush partial with untracked files` | Selected paths include a new untracked file | File is stashed (--include-untracked covers it) |
| 5 | `stashList on repo with no commits` | Brand new repo | `{ ok: true, entries: [] }` or graceful error |

## Regression Tests

| # | Test Name | What Must Not Change |
|---|-----------|---------------------|
| 1 | `commitSelectedFiles still works` | Existing commit flow unaffected by stash additions |
| 2 | `discardGitChanges still works` | Existing discard flow unaffected |
| 3 | `runGitSyncAction pull still blocks on dirty tree` | Pull dirty-tree check unchanged (backend path) |
| 4 | `existing metadata polling still works` | Added homeStashCount doesn't break metadata schema (no changes to task metadata schema — stashCount is NOT added to runtimeTaskWorkspaceMetadataSchema) |

## Test Execution Plan

### Phase 1: Backend

1. Write `test/runtime/git-stash.test.ts` — tests 1-16 (all FAIL initially)
2. Implement git-sync stash functions → tests pass
3. Write `test/runtime/trpc/workspace-api-stash.test.ts` — tests 1-9
4. Implement tRPC routes → tests pass
5. Extend `git-sync-no-optional-locks.test.ts` → passes

### Phase 2: Commit Panel Stash Button

1. No new test files — the stash button wiring is tested implicitly via Phase 1 backend tests and manual verification
2. Extend `web-ui/src/hooks/use-commit-panel.test.ts` if needed for new hook interface

### Phase 3: Stash List

1. Write `web-ui/src/hooks/use-stash-list.test.ts` — tests 1-5
2. Implement hook → tests pass

### Phase 4-5: Stash & Retry

#### Backend Tests

**Test file**: `test/runtime/git-stash.test.ts` (extend)

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 17 | `runGitCheckoutAction returns dirtyTree: true on dirty working tree` | Structured dirty-tree detection for checkout |
| 18 | `runGitSyncAction pull returns dirtyTree: true on dirty working tree` | Structured dirty-tree detection for pull |

##### 17. `runGitCheckoutAction returns dirtyTree: true on dirty working tree`

**Setup**: Create temp git repo, commit initial file, create branch "other", switch back to main, modify a tracked file (don't commit).
**Action**: `runGitCheckoutAction({ cwd, branch: "other" })`
**Assertions**:
- Returns `{ ok: false, dirtyTree: true, ... }`

##### 18. `runGitSyncAction pull returns dirtyTree: true on dirty working tree`

**Setup**: Create temp git repo with a remote, modify a tracked file (don't commit).
**Action**: `runGitSyncAction({ cwd, action: "pull" })`
**Assertions**:
- Returns `{ ok: false, dirtyTree: true, ... }`

#### Manual Verification

Checkout dialog and pull recovery flows are integration-heavy UI interactions. The backend structured fields (`dirtyTree`) are tested above. The UI wiring is verified manually.

### Commands

```bash
# Run all stash-related tests
npx vitest run test/runtime/git-stash.test.ts test/runtime/trpc/workspace-api-stash.test.ts

# Run web UI stash tests
cd web-ui && npx vitest run src/hooks/use-stash-list.test.ts

# Run all tests
npm test && npm run web:test

# Run with verbose
npx vitest run test/runtime/git-stash.test.ts --reporter=verbose
```

## Traceability Matrix

| SDD Requirement | Test(s) | Type |
|----------------|---------|------|
| Phase 1: stashPush | git-stash #1-4 | Unit |
| Phase 1: stashList | git-stash #5-7 | Unit |
| Phase 1: stashPop | git-stash #8-9 | Unit |
| Phase 1: stashApply | git-stash #10-11 | Unit |
| Phase 1: stashDrop | git-stash #12-13 | Unit |
| Phase 1: stashShow | git-stash #14, #14b | Unit |
| Phase 1: stashCount | git-stash #15-16 | Unit |
| Phase 1: tRPC wiring | workspace-api-stash #1-9 | Unit (mocked) |
| Phase 1: no-optional-locks | git-sync-no-optional-locks (extended) | Unit |
| Phase 3: stash list hook | use-stash-list #1-5 | Unit (mocked) |
| !3 conflict on pop | git-stash #9, #11 | Unit |
| !4 shared stash stack | git-stash #7 (multiple entries) | Unit |
| !5 drop confirmation | Stash list component (manual) | Manual |
| !6 stash & pull atomic | Phase 5 orchestration (manual) | Manual |
| !7 polling suppression | use-commit-panel isStashing in isMutating | Unit |
| Phase 4: dirtyTree checkout | git-stash #17 | Unit |
| Phase 5: dirtyTree pull | git-stash #18 | Unit |
| Regression: commit | Existing git-commit tests | Regression |
| Regression: discard | Existing workspace-api tests | Regression |
