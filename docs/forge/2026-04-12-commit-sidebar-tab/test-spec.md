# Test Specification: Commit Sidebar Tab

**Date**: 2026-04-12
**Companion SDD**: [spec.md](spec.md)
**Ticket**: None
**Adversarial Review Passes**: 3

## Test Strategy

Backend git operations are tested with integration tests using real temp git repos (matching `test/runtime/git-history.test.ts` pattern). tRPC endpoint wiring is tested with mocked dependencies (matching `test/runtime/trpc/workspace-api.test.ts` pattern). Frontend components and hooks are tested with Vitest + jsdom unit tests.

### Test Infrastructure

- **Framework**: Vitest ^4.1.0 (runtime + web UI)
- **Runtime test directory**: `test/runtime/`, `test/integration/`, `test/utilities/`
- **Web UI test directory**: Co-located in `web-ui/src/` alongside source
- **Run commands**: `npm test` (runtime), `npm run web:test` (web UI), `npx vitest run <file>` (single file)
- **CI integration**: `test.yml` runs `npm test` + `npm --prefix web-ui run test`

### Coverage Goals

- Every backend git operation (commit, discard-file) has integration tests with real repos
- Every tRPC endpoint has wiring tests via workspace-api mocks
- Error cases (git failures, shared-checkout guard, validation) all tested
- Frontend hook logic (selection state, commit action, validation) tested
- Rollback (single-file discard) tested for both tracked and untracked files

## Unit Tests

### Backend: Git Operations (`commitSelectedFiles`, `discardSingleFile`)

**Test file**: `test/runtime/git-commit.test.ts` (NEW)
**Pattern to follow**: See `test/runtime/git-history.test.ts` — integration tests with real temp git repos using `createTempDir()` + `createGitTestEnv()`.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `commitSelectedFiles commits only specified paths` | Partial commit — only checked files are in the commit |
| 2 | `commitSelectedFiles handles untracked files` | `git add` works for new untracked files |
| 3 | `commitSelectedFiles returns commit hash` | Response includes the hash of the new commit |
| 4 | `commitSelectedFiles fails with empty paths array` | Validation — cannot commit with no files |
| 5 | `commitSelectedFiles fails with empty message` | Validation — cannot commit with blank message |
| 6 | `commitSelectedFiles rolls back staging on commit failure` | If commit fails after add, files are unstaged |
| 7 | `commitSelectedFiles rejects path traversal` | Paths with `..` are rejected |
| 8 | `discardSingleFile restores tracked modified file` | Modified file restored to HEAD state |
| 9 | `discardSingleFile removes untracked file` | Untracked file is deleted |
| 10 | `discardSingleFile restores tracked deleted file` | Deleted file restored from HEAD |
| 11 | `discardSingleFile handles staged file` | Staged file is unstaged and restored |
| 12 | `discardSingleFile rejects path traversal` | Paths with `..` are rejected |
| 13 | `discardSingleFile rejects renamed files` | Renamed files return error, not attempted |
| 14 | `discardSingleFile rejects copied files` | Copied files return error, not attempted |

#### Test Details

##### 1. `commitSelectedFiles commits only specified paths`

**Setup**: Create temp repo with 3 modified files (a.txt, b.txt, c.txt).
**Key test data**:
- Input paths: `["a.txt", "b.txt"]`
- Message: `"partial commit"`
**Action**: Call `commitSelectedFiles({ cwd, paths: ["a.txt", "b.txt"], message: "partial commit" })`
**Assertions**:
- `result.ok === true`
- `result.commitHash` is a 40-char hex string
- `git show --name-only HEAD` includes a.txt and b.txt but NOT c.txt
- `git status --porcelain` still shows c.txt as modified

##### 2. `commitSelectedFiles handles untracked files`

**Setup**: Create temp repo, add a new file (new.txt) without staging.
**Action**: Call `commitSelectedFiles({ cwd, paths: ["new.txt"], message: "add new file" })`
**Assertions**:
- `result.ok === true`
- `git show --name-only HEAD` includes new.txt
- `git status --porcelain` is clean (no remaining changes)

##### 3. `commitSelectedFiles returns commit hash`

**Setup**: Create temp repo with 1 modified file.
**Action**: Call `commitSelectedFiles({ cwd, paths: ["file.txt"], message: "test" })`
**Assertions**:
- `result.commitHash` matches `git rev-parse HEAD`

##### 6. `commitSelectedFiles rolls back staging on commit failure`

**Setup**: Create temp repo with 1 modified file. Mock `runGit` to fail on `git commit` but succeed on `git add` and `git reset`.
**Action**: Call `commitSelectedFiles({ cwd, paths: ["file.txt"], message: "test" })`
**Assertions**:
- `result.ok === false`
- `result.error` contains the failure message
- File is not staged (verify with `git diff --cached --name-only` — empty)

##### 8. `discardSingleFile restores tracked modified file`

**Setup**: Create temp repo, modify a tracked file.
**Action**: Call `discardSingleFile({ cwd, path: "file.txt", fileStatus: "modified" })`
**Assertions**:
- `result.ok === true`
- File content matches HEAD version
- `git status --porcelain` no longer lists the file

##### 9. `discardSingleFile removes untracked file`

**Setup**: Create temp repo, add an untracked file.
**Action**: Call `discardSingleFile({ cwd, path: "new.txt", fileStatus: "untracked" })`
**Assertions**:
- `result.ok === true`
- File no longer exists on disk
- `git status --porcelain` no longer lists the file

##### 10. `discardSingleFile restores tracked deleted file`

**Setup**: Create temp repo with a tracked file (deleted.txt), then delete it via `fs.unlink`.
**Key test data**:
- Input path: `"deleted.txt"`
- Input fileStatus: `"deleted"`
**Action**: Call `discardSingleFile({ cwd, path: "deleted.txt", fileStatus: "deleted" })`
**Assertions**:
- `result.ok === true`
- File exists on disk again (verify with `fs.existsSync`)
- File content matches HEAD version (verify via `git show HEAD:deleted.txt`)
- `git status --porcelain` no longer lists deleted.txt

##### 11. `discardSingleFile handles staged file`

**Setup**: Create temp repo with a tracked file, modify it, then stage the modification via `git add`.
**Key test data**:
- Input path: `"staged.txt"`
- Input fileStatus: `"modified"` (the status from the working copy perspective)
**Action**: Call `discardSingleFile({ cwd, path: "staged.txt", fileStatus: "modified" })`
**Assertions**:
- `result.ok === true`
- File content matches HEAD version (the modification is reverted)
- `git diff --cached --name-only` does NOT include staged.txt (file is unstaged)
- `git status --porcelain` no longer lists the file

Note: `git restore --source=HEAD --staged --worktree -- <path>` handles both the staged index entry and the working tree in a single command, which is why the `"modified"` status works for staged files too.

##### 13. `discardSingleFile rejects renamed files`

**Setup**: No repo needed — the function should reject before running any git commands.
**Action**: Call `discardSingleFile({ cwd, path: "bar.txt", fileStatus: "renamed" })`
**Assertions**:
- `result.ok === false`
- `result.error` contains "renamed" or "Cannot rollback"

##### 14. `discardSingleFile rejects copied files`

**Setup**: No repo needed.
**Action**: Call `discardSingleFile({ cwd, path: "copy.txt", fileStatus: "copied" })`
**Assertions**:
- `result.ok === false`
- `result.error` contains "copied" or "Cannot rollback"

### Backend: Workspace API Handlers

**Test file**: `test/runtime/trpc/workspace-api.test.ts` (EXTEND)
**Pattern to follow**: Existing tests in this file mock the git-sync functions and test the handler logic (scope resolution, shared-checkout guard, broadcast).

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `commitSelectedFiles resolves home cwd when no taskId` | Home context routing |
| 2 | `commitSelectedFiles resolves task worktree cwd` | Task context routing |
| 3 | `commitSelectedFiles blocks shared-checkout tasks` | Safety guard |
| 4 | `commitSelectedFiles broadcasts state update on success` | WebSocket notification |
| 5 | `commitSelectedFiles returns error on git failure` | Error propagation |
| 6 | `discardFile resolves cwd and calls discardSingleFile` | Basic routing |
| 7 | `discardFile blocks shared-checkout tasks` | Safety guard |
| 8 | `discardFile broadcasts state update on success` | WebSocket notification |

### Frontend: Commit Panel Hook (`useCommitPanel`)

**Test file**: `web-ui/src/hooks/use-commit-panel.test.ts` (NEW)
**Pattern to follow**: Test hook logic with `renderHook` from `@testing-library/react`.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `initializes all files as selected` | Default selection state |
| 2 | `toggleFile toggles individual file selection` | Single file toggle |
| 3 | `toggleAll selects all when some unchecked` | Select-all from partial |
| 4 | `toggleAll deselects all when all checked` | Deselect-all |
| 5 | `canCommit is false when no files selected` | Validation |
| 6 | `canCommit is false when message is empty` | Validation |
| 7 | `canCommit is true when files selected and message present` | Validation |
| 8 | `syncs selection state when file list changes` | New files added as checked, removed files dropped |

## Edge Cases & Error Scenarios

| # | Test Name | Scenario | Expected Behavior | SDD Reference |
|---|-----------|----------|-------------------|---------------|
| 1 | `commit with all files selected` | User selects all files and commits | All files committed, empty state shown | !4 |
| 2 | `commit with single file` | Only one file checked | Single file committed, others remain | !4 |
| 3 | `commit empty message rejected` | Empty or whitespace-only message | Commit button disabled, no API call | !5 |
| 4 | `rollback untracked file` | Right-click rollback on untracked file | File deleted, removed from list | Verification #9 |
| 5 | `rollback modified file` | Right-click rollback on modified file | File restored to HEAD, removed from list | Verification #9 |
| 6 | `shared-checkout commit blocked` | Task without isolated worktree | Error toast, commit prevented | !3 |
| 7 | `shared-checkout discard blocked` | Task without isolated worktree | Error toast, discard prevented | !3 |
| 8 | `git commit failure shows toast` | Corrupt index or conflict | Error toast, files unchanged | !5 |
| 9 | `path traversal rejected` | Path contains `..` | Error returned, operation blocked | Error handling |
| 10 | `empty file list shows empty state` | No uncommitted changes | "No uncommitted changes" message, buttons disabled | Verification #18 |

## Regression Tests

| # | Test Name | What Must Not Change | File Reference |
|---|-----------|---------------------|----------------|
| 1 | `existing discard-all endpoint still works` | Full discard via `discardGitChanges` unchanged | `git-sync.ts:377-417` |
| 2 | `workspace.getChanges still returns correct data` | File list endpoint unchanged | `get-workspace-changes.ts:371-427` |
| 3 | `sidebar toggle between projects and board works` | Existing sidebar tabs unaffected | `use-card-detail-layout.ts:164` |
| 4 | `git view uncommitted tab still renders` | Git view not broken by new props | `git-view.tsx` |

## Test Execution Plan

### Phase 1: Backend

1. **Write integration tests** for `commitSelectedFiles` and `discardSingleFile` in `test/runtime/git-commit.test.ts`
   - Run: `npx vitest run test/runtime/git-commit.test.ts` — all FAIL (functions don't exist)
2. **Implement Phase 1** (git-sync functions, schemas, endpoints)
   - Run: `npx vitest run test/runtime/git-commit.test.ts` — all pass
3. **Extend workspace-api tests** in `test/runtime/trpc/workspace-api.test.ts`
   - Run: `npx vitest run test/runtime/trpc/workspace-api.test.ts` — all pass

### Phase 2: Frontend Infrastructure

1. **No dedicated tests** — verified by type check + build + manual smoke test
   - Run: `npm run build && npm run web:typecheck`

### Phase 3: Frontend UI

1. **Write hook tests** in `web-ui/src/hooks/use-commit-panel.test.ts`
   - Run: `cd web-ui && npx vitest run src/hooks/use-commit-panel.test.ts` — FAIL then pass after implementation

### Phase 4: Context Menu & Navigation

1. **Manual verification** — context menu interactions are best verified via UI testing
   - Build passes, type check passes, lint passes

### Commands

```bash
# Run all backend tests for this feature
npx vitest run test/runtime/git-commit.test.ts test/runtime/trpc/workspace-api.test.ts

# Run frontend hook tests
cd web-ui && npx vitest run src/hooks/use-commit-panel.test.ts

# Run all tests (full suite)
npm test && npm run web:test

# Type check everything
npm run typecheck && npm run web:typecheck
```

## Traceability Matrix

| SDD Requirement | Test(s) | Type |
|----------------|---------|------|
| Phase 1: commitSelectedFiles | `git-commit.test.ts` #1-7 | Integration |
| Phase 1: discardSingleFile | `git-commit.test.ts` #8-14 | Integration |
| Phase 1: tRPC endpoint wiring | `workspace-api.test.ts` #1-8 | Unit (mocked) |
| Phase 1: Shared-checkout guard | `workspace-api.test.ts` #3, #7 | Unit |
| Phase 3: Selection state | `use-commit-panel.test.ts` #1-4, #8 | Unit |
| Phase 3: Commit validation | `use-commit-panel.test.ts` #5-7 | Unit |
| !3: Shared-checkout safety | Edge cases #6, #7 | Integration + Unit |
| !4: Partial commit | `git-commit.test.ts` #1, Edge case #1-2 | Integration |
| !5: Error handling | Edge cases #3, #8, #9 | Integration + Unit |
| !6: Auto-refresh | `workspace-api.test.ts` #4, #8 (broadcast) | Unit |
| Regression: existing discard | Regression #1 | Integration |
| Regression: existing changes endpoint | Regression #2 | Integration |
