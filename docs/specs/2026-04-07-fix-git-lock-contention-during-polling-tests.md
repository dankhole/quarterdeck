# Test Specification: Fix Git Lock Contention During Metadata Polling

**Date**: 2026-04-07
**Companion SDD**: [docs/specs/2026-04-07-fix-git-lock-contention-during-polling.md](./2026-04-07-fix-git-lock-contention-during-polling.md)
**Adversarial Review Passes**: 1

## Test Strategy

Verify that `probeGitWorkspaceState`, `getGitSyncSummary`, and `resolveRepoRoot` pass `--no-optional-locks` to all git commands they invoke. The primary verification is that the flag appears in the arguments passed to `runGit`. A secondary integration-style test verifies that git status output is still correct when the flag is present.

### Test Infrastructure

- **Framework**: Vitest
- **Test directories**: `test/runtime/`
- **Run command**: `npx vitest run test/runtime/git-sync-no-optional-locks.test.ts`
- **CI integration**: Included in `npm run test` which runs all vitest suites.

### Coverage Goals

- Every `runGit` call in `probeGitWorkspaceState`, `getGitSyncSummary`, and `resolveRepoRoot` includes `--no-optional-locks`.
- The flag does not break git command output parsing.
- Existing behavior (state token caching, error handling) is unchanged.

## Unit Tests

### git-sync `--no-optional-locks` flag

**Test file**: `test/runtime/git-sync-no-optional-locks.test.ts`
**Pattern to follow**: See `test/runtime/git-utils.test.ts` for established mocking conventions in this codebase (uses `vi.mock` for `node:child_process`).

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `probeGitWorkspaceState passes --no-optional-locks to git status` | The status command args include `--no-optional-locks` before the subcommand |
| 2 | `probeGitWorkspaceState passes --no-optional-locks to git rev-parse` | The rev-parse HEAD command args include `--no-optional-locks` |
| 3 | `getGitSyncSummary passes --no-optional-locks to git diff` | The diff command args include `--no-optional-locks` |
| 4 | `resolveRepoRoot passes --no-optional-locks to git rev-parse` | The rev-parse --show-toplevel command args include `--no-optional-locks` |
| 5 | `probeGitWorkspaceState output is unchanged with --no-optional-locks` | Status parsing still produces correct GitWorkspaceProbe data |

#### Test Details

##### 1. `probeGitWorkspaceState passes --no-optional-locks to git status`

**Setup**: Mock `execFile` from `node:child_process` (via `vi.mock`). Configure the mock to:
- Return valid `git rev-parse --show-toplevel` output (the cwd itself)
- Return valid `git status --porcelain=v2` output (a simple clean status with branch header)
- Return valid `git rev-parse --verify HEAD` output (a fake commit hash)
- Record all `execFile` calls for inspection

**Action**: Call `probeGitWorkspaceState("/fake/repo")`
**Assertions**:
- The `execFile` call whose args contain `"status"` also contains `"--no-optional-locks"` before `"status"` in the args array
- The function resolves successfully (no parse errors)

##### 2. `probeGitWorkspaceState passes --no-optional-locks to git rev-parse`

**Setup**: Same mock as test 1.
**Action**: Call `probeGitWorkspaceState("/fake/repo")`
**Assertions**:
- The `execFile` call whose args contain `"rev-parse"` and `"HEAD"` also contains `"--no-optional-locks"` before `"rev-parse"`

##### 3. `getGitSyncSummary passes --no-optional-locks to git diff`

**Setup**: Same mock setup as test 1. Call `getGitSyncSummary("/fake/repo", { probe: fakeProbe })` with a pre-built `GitWorkspaceProbe` object to bypass the internal `probeGitWorkspaceState` call and isolate this test to just the diff command. The probe should have `repoRoot: "/fake/repo"` and `untrackedPaths: []`.
**Action**: Call `getGitSyncSummary("/fake/repo", { probe: fakeProbe })`
**Assertions**:
- The `execFile` call whose args contain `"diff"` also contains `"--no-optional-locks"` before `"diff"`

##### 4. `resolveRepoRoot passes --no-optional-locks to git rev-parse`

**Setup**: Same mock setup as test 1. Note: `resolveRepoRoot` is a private (non-exported) function in `git-sync.ts`. It is tested indirectly through `probeGitWorkspaceState`, which calls it as its first step. The assertion targets the `execFile` call containing `--show-toplevel` to distinguish it from the `--verify HEAD` rev-parse call.
**Action**: Call `probeGitWorkspaceState("/fake/repo")` (which internally calls `resolveRepoRoot`)
**Assertions**:
- The `execFile` call whose args contain `"rev-parse"` and `"--show-toplevel"` also contains `"--no-optional-locks"` before `"rev-parse"`

##### 5. `probeGitWorkspaceState output is unchanged with --no-optional-locks`

**Setup**: Mock `execFile` to return realistic `git status --porcelain=v2` output:
```
# branch.oid abc123def456
# branch.head main
# branch.upstream origin/main
# branch.ab +2 -1
1 .M N... 100644 100644 100644 abc123 def456 src/file.ts
? untracked.txt
```
**Action**: Call `probeGitWorkspaceState("/fake/repo")`
**Assertions**:
- `result.currentBranch === "main"`
- `result.upstreamBranch === "origin/main"`
- `result.aheadCount === 2`
- `result.behindCount === 1`
- `result.changedFiles === 2`
- `result.untrackedPaths` contains `"untracked.txt"`

## Integration Tests

Not required. The change is a flag addition to existing git commands. The unit tests verify the flag is passed correctly, and the existing `git-sync` tests (if any) plus the behavioral success criteria in the SDD cover end-to-end behavior.

## Edge Cases & Error Scenarios

| # | Test Name | Scenario | Expected Behavior | Review Finding |
|---|-----------|----------|-------------------|----------------|
| 1 | (Covered by existing error handling tests) | `git status` fails with non-lock error | `probeGitWorkspaceState` throws, monitor catches and returns cached value | Existing behavior, no change needed |

## Regression Tests

| # | Test Name | What Must Not Change | File Reference |
|---|-----------|---------------------|----------------|
| 1 | Existing `git-utils.test.ts` tests | `runGit` behavior unchanged — it just receives different args | `test/runtime/git-utils.test.ts` |

## Test Execution Plan

### Phase 1: Add `--no-optional-locks` Flag

1. **Write unit tests** — define expected behavior
   - Write: tests 1-5 in `test/runtime/git-sync-no-optional-locks.test.ts`
   - Run: `npx vitest run test/runtime/git-sync-no-optional-locks.test.ts` — all FAIL (red)
2. **Implement the flag addition** in `src/workspace/git-sync.ts`
   - Run: `npx vitest run test/runtime/git-sync-no-optional-locks.test.ts` — all pass (green)
3. **Run full test suite** to verify no regressions
   - Run: `npm run test` — all pass

### Commands

```bash
# Run tests for this feature
npx vitest run test/runtime/git-sync-no-optional-locks.test.ts

# Run all runtime tests (includes regression)
npm run test

# Run with verbose output for debugging
npx vitest run test/runtime/git-sync-no-optional-locks.test.ts --reporter=verbose
```

## Traceability Matrix

| SDD Requirement | Test(s) | Type |
|----------------|---------|------|
| `probeGitWorkspaceState` uses `--no-optional-locks` on status | Test 1 | Unit |
| `probeGitWorkspaceState` uses `--no-optional-locks` on rev-parse | Test 2 | Unit |
| `getGitSyncSummary` uses `--no-optional-locks` on diff | Test 3 | Unit |
| `resolveRepoRoot` uses `--no-optional-locks` on rev-parse | Test 4 | Unit |
| Output parsing unchanged with flag present | Test 5 | Unit |
