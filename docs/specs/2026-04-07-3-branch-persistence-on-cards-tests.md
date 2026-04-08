# Test Specification: Branch Persistence on Cards

**Date**: 2026-04-07
**Companion SDD**: [docs/specs/2026-04-07-3-branch-persistence-on-cards.md](./2026-04-07-3-branch-persistence-on-cards.md)
**Ticket**: #3
**Adversarial Review Passes**: 3

## Test Strategy

Tests are split across the runtime (Vitest) and web-ui (Vitest) layers, matching existing project conventions. The runtime tests cover worktree creation with branch checkout/fallback logic and board mutation behavior. The web-ui tests cover card normalization, reconciliation, slug generation, and board state updates. No new test infrastructure is needed.

### Test Infrastructure

- **Framework**: Vitest (both runtime and web-ui)
- **Test directories**: `test/runtime/` (runtime), `web-ui/src/**/*.test.ts` (web-ui unit tests)
- **Run commands**:
  - Runtime: `npm run test`
  - Web-UI: `npm run web:test`
  - All: `npm run test && npm run web:test`
- **CI integration**: `test.yml` runs build -> lint -> typecheck -> test -> web-ui test

### Coverage Goals

- Every SDD requirement has at least one test
- Branch checkout fallback paths are all covered
- Reconcile guard logic (don't overwrite non-null with null) is explicitly tested
- Existing resume-from-trash behavior is regression-tested

## Unit Tests

### Board State — Card Normalization & Reconciliation

**Test file**: `web-ui/src/state/board-state.test.ts` (add to existing or create)
**Pattern to follow**: See `test/runtime/task-board-mutations.test.ts` for board state test conventions.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `normalizeCard preserves string branch` | `branch: "feat/foo"` survives normalization |
| 2 | `normalizeCard preserves null branch` | `branch: null` normalizes to `null` |
| 3 | `normalizeCard defaults undefined for missing branch` | Missing `branch` field normalizes to `undefined` |
| 4 | `normalizeCard rejects non-string branch` | `branch: 123` normalizes to `undefined` |
| 5 | `reconcileTaskBranch updates card when branch differs` | Card with `branch: null` updated to `"feat/foo"` |
| 6 | `reconcileTaskBranch no-ops when branch matches` | Card with `branch: "feat/foo"` not updated when same value arrives |
| 7 | `reconcileTaskBranch does not overwrite non-null with null` | Card with `branch: "feat/foo"` unchanged when `null` arrives |
| 8 | `reconcileTaskBranch updates card when branch changes` | Card with `branch: "feat/old"` updated to `"feat/new"` |
| 8a | `reconcileTaskBranch updates card from undefined to string` | Card with `branch: undefined` updated to `"feat/foo"` (first capture) |
| 8b | `reconcileTaskBranch no-ops when incoming is undefined` | Card with `branch: "feat/foo"` unchanged when `undefined` arrives (no metadata available) |
| 9 | `updateTask preserves branch field` | Editing prompt/baseRef does not clear `branch` |

#### Test Details

##### 1. `normalizeCard preserves string branch`

**Setup**: Raw card object with `branch: "feat/foo"` and valid prompt/baseRef
**Action**: Call `normalizeCard(rawCard)`
**Assertions**:
- Result is not null
- `result.branch === "feat/foo"`

##### 2. `normalizeCard preserves null branch`

**Setup**: Raw card object with `branch: null`
**Action**: Call `normalizeCard(rawCard)`
**Assertions**:
- `result.branch === null`

##### 3. `normalizeCard defaults undefined for missing branch`

**Setup**: Raw card object without `branch` property
**Action**: Call `normalizeCard(rawCard)`
**Assertions**:
- `result.branch === undefined`

##### 5. `reconcileTaskBranch updates card when branch differs`

**Setup**: Board with one card in backlog, `branch: null`
**Action**: Call `reconcileTaskBranch(board, taskId, "feat/foo")`
**Assertions**:
- `result.updated === true`
- Card in result board has `branch: "feat/foo"`
- Card `updatedAt` is bumped

##### 7. `reconcileTaskBranch does not overwrite non-null with null`

**Setup**: Board with one card, `branch: "feat/foo"`
**Action**: Call `reconcileTaskBranch(board, taskId, null)`
**Assertions**:
- `result.updated === false`
- Card still has `branch: "feat/foo"`

##### 8a. `reconcileTaskBranch updates card from undefined to string`

**Setup**: Board with one card, `branch: undefined` (field not yet set)
**Action**: Call `reconcileTaskBranch(board, taskId, "feat/foo")`
**Assertions**:
- `result.updated === true`
- Card in result board has `branch: "feat/foo"`
- Card `updatedAt` is bumped

##### 8b. `reconcileTaskBranch no-ops when incoming is undefined`

**Setup**: Board with one card, `branch: "feat/foo"`
**Action**: Call `reconcileTaskBranch(board, taskId, undefined)`
**Assertions**:
- `result.updated === false`
- Card still has `branch: "feat/foo"`

### Board Mutations — Trash Behavior

**Test file**: `test/runtime/task-board-mutations.test.ts` (add to existing)
**Pattern to follow**: Existing tests in this file use `createBoard()` helper and `addTaskToColumn`.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 10 | `trashTaskAndGetReadyLinkedTaskIds preserves branch on trashed card` | Branch survives move to trash (client path) |
| 11 | `trashTaskAndGetReadyLinkedTaskIds clears workingDirectory but not branch` | workingDirectory is null, branch is intact |
| 11a | `shutdown-coordinator moveTaskToTrash preserves branch on trashed card` | Branch survives move to trash (shutdown path via `...removedCard` spread) |

#### Test Details

##### 10. `trashTaskAndGetReadyLinkedTaskIds preserves branch on trashed card`

**Setup**: Create board via `createBoard()`, add task to in_progress via `addTaskToColumn`, then directly set `branch: "feat/my-work"` on the card object in the board data. (`addTaskToColumn` does not accept `branch` until Phase 3, so the field must be set directly on the constructed board state.)
**Action**: Call `trashTaskAndGetReadyLinkedTaskIds(board, taskId)`
**Assertions**:
- Task is in trash column
- Task's `branch === "feat/my-work"`
- Task's `workingDirectory === null`

##### 11a. `shutdown-coordinator moveTaskToTrash preserves branch on trashed card`

**Setup**: Create board, add task to in_progress, directly set `branch: "feat/shutdown-work"` on the card object (same approach as test 10).
**Action**: Call `moveTaskToTrash(board, taskId)` from `shutdown-coordinator.ts`
**Assertions**:
- Task is in trash column
- Task's `branch === "feat/shutdown-work"`
- The `...removedCard` spread in the shutdown path preserves all card fields

### Branch Name Slug

**Test file**: `web-ui/src/utils/branch-utils.test.ts`

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 12 | `slugifyBranchName converts title to valid branch name` | `"Add Auth Middleware"` -> `"quarterdeck/add-auth-middleware"` |
| 13 | `slugifyBranchName handles special characters` | `"Fix bug #123 (urgent!)"` -> `"quarterdeck/fix-bug-123-urgent"` |
| 14 | `slugifyBranchName truncates long titles` | 100-char title truncated so total branch name (including `quarterdeck/` prefix) does not exceed 60 characters |
| 15 | `slugifyBranchName returns empty for empty/whitespace title` | `"   "` -> `""` |
| 16 | `slugifyBranchName handles all-special-char title` | `"!!!"` -> `""` |

#### Test Details

##### 12. `slugifyBranchName converts title to valid branch name`

**Setup**: None
**Action**: Call `slugifyBranchName("Add Auth Middleware")`
**Assertions**:
- Result is `"quarterdeck/add-auth-middleware"`

##### 15. `slugifyBranchName returns empty for empty/whitespace title`

**Setup**: None
**Action**: Call `slugifyBranchName("   ")`
**Assertions**:
- Result is `""`

### Task Draft — Branch Name in Creation

**Test file**: `test/runtime/task-board-mutations.test.ts`

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 17 | `addTaskToColumn sets branch from input` | `RuntimeCreateTaskInput` with `branch: "feat/new"` creates card with `branch: "feat/new"` |
| 18 | `addTaskToColumn omits branch when not provided` | `RuntimeCreateTaskInput` without `branch` creates card with `branch: undefined` |

## Integration Tests

### Worktree Creation — Branch-Aware Resume

**Test file**: `test/runtime/task-worktree.test.ts` (add to existing)
**Dependencies**: Git repository (tests use temp repos)
**Setup**: The existing test file creates temp git repos for worktree tests.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 19 | `ensureTaskWorktreeIfDoesntExist checks out existing branch when available` | Worktree created on named branch, not detached |
| 20 | `ensureTaskWorktreeIfDoesntExist recreates missing branch via -b` | Missing branch -> recreated via `-b` at saved commit |
| 21 | `ensureTaskWorktreeIfDoesntExist falls back to detached HEAD when branch locked` | Branch checked out elsewhere -> detached HEAD |
| 22 | `ensureTaskWorktreeIfDoesntExist creates new branch with -b when branch does not exist locally` | branch param with non-existent branch creates new branch via `-b` |
| 23a | `ensureTaskWorktreeIfDoesntExist falls back to detached when -b fails` | `-b` fails -> falls through to detached HEAD |
| 23b | `ensureTaskWorktreeIfDoesntExist falls back to detached when existing branch checkout fails` | Branch exists but checkout fails (e.g., locked) -> falls through to detached HEAD |

#### Test Details

##### 19. `ensureTaskWorktreeIfDoesntExist checks out existing branch when available`

**Setup**:
- Create temp git repo with initial commit
- Create branch `feat/test` pointing at HEAD
- Create a task patch file with the HEAD commit hash
**Action**: Call `ensureTaskWorktreeIfDoesntExist` with `branch: "feat/test"`
**Assertions**:
- Result `ok === true`
- Running `git branch --show-current` in worktree path returns `feat/test`
- Worktree is NOT in detached HEAD state

##### 20. `ensureTaskWorktreeIfDoesntExist recreates missing branch via -b`

**Setup**:
- Create temp git repo with initial commit
- No branch named `feat/gone` exists
- Create a task patch file with the HEAD commit hash
**Action**: Call `ensureTaskWorktreeIfDoesntExist` with `branch: "feat/gone"`
**Assertions**:
- Result `ok === true`
- Running `git branch --show-current` in worktree path returns `feat/gone` (branch recreated via `-b`)
- Branch `feat/gone` exists in `git branch --list`

##### 22. `ensureTaskWorktreeIfDoesntExist creates new branch with -b when branch does not exist locally`

**Setup**:
- Create temp git repo with initial commit
- No branch named `quarterdeck/my-feature` exists (verify with `git branch --list`)
**Action**: Call `ensureTaskWorktreeIfDoesntExist` with `branch: "quarterdeck/my-feature"` (no separate flag — the function detects non-existence via `git rev-parse --verify refs/heads/quarterdeck/my-feature` and uses `-b` automatically)
**Assertions**:
- Result `ok === true`
- `git branch --show-current` in the worktree returns `quarterdeck/my-feature`
- Branch exists in `git branch --list` in the main repo

##### 23a. `ensureTaskWorktreeIfDoesntExist falls back to detached when -b fails`

**Setup**:
- Create temp git repo with initial commit
- No branch named `quarterdeck/fail-branch` exists
- Make the `-b` path fail (e.g., by providing an invalid base commit, or mocking `runGit` to fail on the `-b` call)
**Action**: Call `ensureTaskWorktreeIfDoesntExist` with `branch: "quarterdeck/fail-branch"`
**Assertions**:
- Result `ok === true` (fallback succeeded)
- Running `git branch --show-current` in worktree path returns empty (detached HEAD)
- `quarterdeck/fail-branch` does NOT exist in `git branch --list`
- Partial worktree from the failed `-b` attempt was cleaned up (via `removeTaskWorktreeInternal` + `worktree prune`) before the detached fallback

##### 23b. `ensureTaskWorktreeIfDoesntExist falls back to detached when existing branch checkout fails`

**Setup**:
- Create temp git repo with initial commit
- Create branch `feat/locked` pointing at HEAD
- Lock `feat/locked` by checking it out in another worktree (so `git worktree add <path> feat/locked` fails)
**Action**: Call `ensureTaskWorktreeIfDoesntExist` with `branch: "feat/locked"`
**Assertions**:
- Result `ok === true` (fallback succeeded)
- Running `git branch --show-current` in worktree path returns empty (detached HEAD)
- Partial worktree from the failed checkout attempt was cleaned up (via `removeTaskWorktreeInternal` + `worktree prune`) before the detached fallback

## Edge Cases & Error Scenarios

| # | Test Name | Scenario | Expected Behavior | Review Finding |
|---|-----------|----------|-------------------|----------------|
| 24 | `resume with branch and no patch` | Branch exists, no patch file | Checkout branch, no patch apply, no error | Patch is optional |
| 25 | `resume with branch and patch on different commit` | Branch HEAD differs from patch commit | Checkout branch, attempt patch apply (best-effort), warn if fails — assert `result.warning` contains "could not be reapplied" | Commit divergence |
| 26 | `create with empty slugified branch name` | Title produces empty slug | Card created with `branch: undefined`, worktree uses detached HEAD | Empty slug guard |

## Regression Tests

Tests that ensure existing behavior isn't broken by the new implementation.

| # | Test Name | What Must Not Change | File Reference |
|---|-----------|---------------------|----------------|
| 28 | `existing resume-from-trash without branch works unchanged` | Detached HEAD + patch flow when `branch` is null/undefined | `task-worktree.ts:502-541` |
| 29 | `existing worktree creation without branch works unchanged` | `--detach` path when no branch provided | `task-worktree.ts:516` |
| 30 | `normalizeCard handles cards without branch field` | Existing persisted cards without `branch` load correctly | `board-state.ts:96-149` |
| 31 | `workingDirectory still cleared on trash` | `workingDirectory: null` on trash is not affected | `task-board-mutations.ts:537` |

## Test Execution Plan

### Phase 1: Schema + Auto-Capture + Display

1. **Write regression tests** — verify existing behavior before changing anything
   - Write: tests 28, 29, 30, 31
   - Run: `npm run test && npm run web:test` — all pass (baseline)
2. **Write unit tests** — define Phase 1 expected behavior
   - Write: tests 1-9, 8b, 11a
   - Run: `npm run web:test` — new tests FAIL (red)
3. **Implement Phase 1**
   - Run: `npm run test && npm run web:test` — all pass (green)

### Phase 2: Branch-Aware Resume

1. **Write integration tests** — define resume behavior
   - Write: tests 19, 20, 21, 22, 23a, 23b, 24, 25
   - Run: `npm run test` — new tests FAIL (red)
2. **Implement Phase 2**
   - Run: `npm run test` — all pass (green)
3. **Verify regression test 28 still passes**

### Phase 3: Create with Feature Branch

1. **Write unit tests** — define creation behavior
   - Write: tests 12-18, 26
   - Run: `npm run test && npm run web:test` — new tests FAIL (red)
2. **Implement Phase 3**
   - Run: `npm run test && npm run web:test` — all pass (green)
3. **Verify regression test 29 still passes**

### Commands

```bash
# Run all tests for this feature
npm run test && npm run web:test

# Run runtime tests only (includes worktree integration tests)
npm run test

# Run web-ui unit tests only (includes board state, normalization, slug)
npm run web:test

# Run specific test file
npx vitest run test/runtime/task-board-mutations.test.ts
npx vitest run test/runtime/task-worktree.test.ts

# Full pre-submit check
npm run check && npm run build
```

## Traceability Matrix

| SDD Requirement | Test(s) | Type |
|----------------|---------|------|
| Phase 1: branch field on card schema | 1, 2, 3, 4, 30 | Unit, Regression |
| Phase 1: normalizeCard handles branch | 1, 2, 3, 4 | Unit |
| Phase 1: reconcileTaskBranch auto-capture | 5, 6, 7, 8, 8a, 8b | Unit |
| Phase 1: reconcile guard (don't null non-null) | 7, 8b | Unit |
| Phase 1: updateTask preserves branch | 9 | Unit |
| Phase 1: trash preserves branch (client path) | 10, 11, 31 | Unit, Regression |
| Phase 1: trash preserves branch (shutdown path) | 11a | Unit |
| Phase 2: resume checks out existing branch | 19, 24 | Integration |
| Phase 2: resume recreates missing branch | 20 | Integration |
| Phase 2: resume falls back to detached HEAD (locked) | 21 | Integration |
| Phase 2: resume with patch on branch | 25 | Edge case |
| Phase 2: existing resume unchanged | 28 | Regression |
| Phase 3: slugifyBranchName | 12, 13, 14, 15, 16 | Unit |
| Phase 3: addTaskToColumn with branchName | 17, 18 | Unit |
| Phase 2: create new branch with -b | 22 | Integration |
| Phase 2: -b fallback to detached | 23a | Integration |
| Phase 2: existing branch checkout fallback | 23b | Integration |
| Phase 3: empty slug guard | 26 | Edge case |
| Phase 3: existing creation unchanged | 29 | Regression |
