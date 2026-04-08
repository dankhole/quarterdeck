# Test Specification: Trash Confirmation & Worktree Notice

**Date**: 2026-04-07
**Companion SDD**: [docs/specs/2026-04-07-trash-confirmation-and-notice.md](2026-04-07-trash-confirmation-and-notice.md)
**Ticket**: #2
**Adversarial Review Passes**: 3

## Test Strategy

Testing covers three areas: (1) the new config field round-trip, (2) the confirmation dialog gating logic, and (3) the notice toast behavior. Tests prioritize the gating logic — ensuring the confirmation appears when it should and doesn't when it shouldn't — since incorrect gating is the highest-risk failure mode (either blocking all trash actions or silently skipping confirmation).

All tests use existing patterns: Vitest for both runtime and web-ui, `vi.mock()` for tRPC/config mocking, direct mutation function calls for board state logic.

### Test Infrastructure

- **Framework**: Vitest (runtime + web-ui unit tests)
- **Test directories**: `test/runtime/` (backend), `web-ui/src/**/*.test.{ts,tsx}` (frontend)
- **Run commands**:
  - Runtime: `npm run test:fast`
  - Web UI: `npm run web:test`
  - All: `npm run check`
- **CI integration**: `test.yml` runs all suites on Ubuntu (Node 20, 22) + macOS (Node 22)

### Coverage Goals

- Every config touchpoint has a round-trip test
- Every trash entry point (manual, drag, auto) is tested for correct dialog/notice behavior
- Edge cases: null snapshot, zero changedFiles, config toggle off, backlog column gating

## Unit Tests

### Config: `showTrashWorktreeNotice`

**Test file**: `test/runtime/config/runtime-config.test.ts`
**Pattern to follow**: Existing tests for `readyForReviewNotificationsEnabled` in the same file.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `showTrashWorktreeNotice defaults to true` | Default config state has `showTrashWorktreeNotice: true` |
| 2 | `showTrashWorktreeNotice persists false to global config` | Setting to false writes to `~/.quarterdeck/config.json` |
| 3 | `showTrashWorktreeNotice round-trips through save and load` | Save false → reload → value is false |

#### Test Details

##### 1. `showTrashWorktreeNotice defaults to true`

**Setup**: Load config with no existing config file (or empty global config).
**Action**: Call the config load function.
**Assertions**:
- `config.showTrashWorktreeNotice === true`

##### 2. `showTrashWorktreeNotice persists false to global config`

**Setup**: Load config, then update with `{ showTrashWorktreeNotice: false }`.
**Action**: Call the config update function, then read the global config file from disk.
**Assertions**:
- Parsed JSON contains `"showTrashWorktreeNotice": false`

##### 3. `showTrashWorktreeNotice round-trips through save and load`

**Setup**: Save config with `showTrashWorktreeNotice: false`.
**Action**: Reload config from disk.
**Assertions**:
- Reloaded `config.showTrashWorktreeNotice === false`

---

### Trash Confirmation Gating Logic

**Test file**: `web-ui/src/hooks/use-linked-backlog-task-actions.test.tsx`
**Pattern to follow**: Existing tests in this file (lines 180-324), especially the `performMoveTaskToTrash` tests.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `shows confirmation dialog when trashing card with uncommitted changes` | `onRequestTrashConfirmation` callback (passed to `useLinkedBacklogTaskActions`) is called with view model and card when `changedFiles > 0` |
| 2 | `skips confirmation when skipWorkingChangeWarning is true` | Auto-trash paths bypass dialog regardless of changedFiles |
| 3 | `skips confirmation when workspace snapshot is null` | Missing snapshot doesn't block trash |
| 4 | `skips confirmation when changedFiles is 0` | Clean workspace trashes immediately |
| 5 | `skips confirmation when changedFiles is null` | Unknown file count trashes immediately |
| 6 | `requestMoveTaskToTrash calls onRequestTrashConfirmation and not calling confirmMoveTaskToTrash leaves card in column` | After `requestMoveTaskToTrash` calls the confirmation callback, the card remains in its column; not calling `confirmMoveTaskToTrash` leaves it there |
| 7 | `calling confirmMoveTaskToTrash after onRequestTrashConfirmation trashes the card` | `performMoveTaskToTrash` is called when `confirmMoveTaskToTrash` is invoked with the captured card |
| 8 | `onRequestTrashConfirmation receives fromColumnId as third argument` | The confirmation callback is called with `fromColumnId` matching the column the card was in |

#### Test Details

##### 1. `shows confirmation dialog when trashing card with uncommitted changes`

**Setup**:
- Mock `getTaskWorkspaceSnapshot` to return `{ taskId: "task-1", changedFiles: 3, path: "/tmp/worktree", branch: "feat/test", isDetached: false, headCommit: "abc123", additions: 10, deletions: 5 }` (note: `taskId` must be present on the snapshot)
- Create a board with a card in `in_progress`
- Provide a mock `onRequestTrashConfirmation` callback

**Action**: Call `requestMoveTaskToTrash("task-1", "in_progress")` (no `skipWorkingChangeWarning`)

**Assertions**:
- `onRequestTrashConfirmation` was called once
- `onRequestTrashConfirmation` was called with a view model containing `taskTitle`, `fileCount: 3`, and `workspaceInfo`, the `BoardCard` as the second argument, and `"in_progress"` as the third argument (`fromColumnId`)
- `performMoveTaskToTrash` was NOT called (waiting for confirmation)

##### 2. `skips confirmation when skipWorkingChangeWarning is true`

**Setup**: Same as #1 (changedFiles > 0), but pass `{ skipWorkingChangeWarning: true }`.

**Action**: Call `requestMoveTaskToTrash("task-1", "in_progress", { skipWorkingChangeWarning: true })`

**Assertions**:
- `onRequestTrashConfirmation` was NOT called
- `performMoveTaskToTrash` was called (trash proceeds immediately)

##### 3. `skips confirmation when workspace snapshot is null`

**Setup**: Mock `getTaskWorkspaceSnapshot` to return `null`.

**Action**: Call `requestMoveTaskToTrash("task-1", "in_progress")`

**Assertions**:
- `onRequestTrashConfirmation` was NOT called
- `performMoveTaskToTrash` was called

##### 4. `skips confirmation when changedFiles is 0`

**Setup**: Mock snapshot with `changedFiles: 0`.

**Action**: Call `requestMoveTaskToTrash("task-1", "in_progress")`

**Assertions**:
- `onRequestTrashConfirmation` was NOT called
- `performMoveTaskToTrash` was called

##### 5. `skips confirmation when changedFiles is null`

**Setup**: Mock snapshot with `changedFiles: null`.

**Action**: Call `requestMoveTaskToTrash("task-1", "in_progress")`

**Assertions**:
- `onRequestTrashConfirmation` was NOT called
- `performMoveTaskToTrash` was called

##### 6. `requestMoveTaskToTrash calls onRequestTrashConfirmation and not calling confirmMoveTaskToTrash leaves card in column`

**Setup**: Same as #1. Provide a mock `onRequestTrashConfirmation` that captures its arguments.

**Action**: Call `requestMoveTaskToTrash("task-1", "in_progress")`. Verify `onRequestTrashConfirmation` was called. Do NOT call `confirmMoveTaskToTrash`.

**Assertions**:
- Card is still in `in_progress` column
- `stopTaskSession` was NOT called
- `cleanupTaskWorkspace` was NOT called

##### 7. `calling confirmMoveTaskToTrash after onRequestTrashConfirmation trashes the card`

**Setup**: Same as #1. Provide a mock `onRequestTrashConfirmation` that captures the `BoardCard` argument.

**Action**: Call `requestMoveTaskToTrash("task-1", "in_progress")`. Verify `onRequestTrashConfirmation` was called. Capture the `BoardCard` from the callback arguments. Then call `confirmMoveTaskToTrash(capturedCard)` and await completion.

**Assertions**:
- Card is moved to trash column
- `stopTaskSession` was called with the task ID
- `cleanupTaskWorkspace` was called with the task ID

##### 8. `onRequestTrashConfirmation receives fromColumnId as third argument`

**Setup**: Same as #1 (changedFiles > 0). Create a board with card in `in_progress`. Provide a mock `onRequestTrashConfirmation` that captures all arguments.

**Action**: Call `requestMoveTaskToTrash("task-1", "in_progress")`.

**Assertions**:
- `onRequestTrashConfirmation` was called with third argument `"in_progress"` (the `fromColumnId`)
- `performMoveTaskToTrash` was NOT called

---

### Notice Toast Logic

**Test file**: `web-ui/src/hooks/use-linked-backlog-task-actions.test.tsx`
**Pattern to follow**: Same file, add tests alongside the confirmation tests.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `shows notice toast after trash when showTrashWorktreeNotice is true` | Toast displayed for manual trash with no uncommitted changes |
| 2 | `does not show notice toast when showTrashWorktreeNotice is false` | Config toggle suppresses the toast |
| 3 | `does not show notice toast when confirmation dialog was shown` | No double-notification |
| 4 | `does not show notice toast for auto-trash (skipWorkingChangeWarning)` | Auto-trash paths are silent |
| 5 | `don't show again action saves config` | Toast action callback calls saveConfig |
| 6 | `does not show notice toast when trashing from backlog column` | Backlog tasks never had a worktree — toast is irrelevant |

#### Test Details

##### 1. `shows notice toast after trash when showTrashWorktreeNotice is true`

**Setup**:
- Mock `getTaskWorkspaceSnapshot` to return `null` or `{ changedFiles: 0, ... }` (no uncommitted changes)
- Set `showTrashWorktreeNotice: true` in config props
- Mock `showAppToast`

**Action**: Call `requestMoveTaskToTrash("task-1", "in_progress")`, await completion.

**Assertions**:
- `showAppToast` was called with `message` containing "workspace removed" (or similar)
- `showAppToast` was called with an `action` object containing `label: "Don't show again"`

##### 2. `does not show notice toast when showTrashWorktreeNotice is false`

**Setup**: Same as #1 but `showTrashWorktreeNotice: false`.

**Action**: Call `requestMoveTaskToTrash`, await completion.

**Assertions**:
- `showAppToast` was NOT called

##### 3. `does not show notice toast when confirmation dialog was shown`

**Setup**: Mock snapshot with `changedFiles: 3`. Provide confirmation callback. `showTrashWorktreeNotice: true`.

**Action**: Call `requestMoveTaskToTrash`, then invoke confirm callback, await completion.

**Assertions**:
- `showAppToast` was NOT called (the dialog already communicated the information)

##### 4. `does not show notice toast for auto-trash (skipWorkingChangeWarning)`

**Setup**: `showTrashWorktreeNotice: true`, `skipWorkingChangeWarning: true`.

**Action**: Call `requestMoveTaskToTrash("task-1", "in_progress", { skipWorkingChangeWarning: true })`.

**Assertions**:
- `showAppToast` was NOT called

##### 5. `don't show again action saves config`

**Setup**: Mock `showAppToast` to capture the `action.onClick` callback. Mock `saveConfig`.

**Action**: Call `requestMoveTaskToTrash("task-1", "in_progress")`, await completion. Extract the `action.onClick` from the `showAppToast` call args. Invoke it with a synthetic mouse event.

**Assertions**:
- `saveConfig` was called with `{ showTrashWorktreeNotice: false }`

##### 6. `does not show notice toast when trashing from backlog column`

**Setup**:
- `showTrashWorktreeNotice: true`
- Mock `getTaskWorkspaceSnapshot` to return `null`
- Mock `showAppToast`

**Action**: Call `requestMoveTaskToTrash("task-1", "backlog")`, await completion.

**Assertions**:
- `showAppToast` was NOT called
- Task was trashed normally (no blocking)

---

### App Toaster Extension

**Test file**: `web-ui/src/components/app-toaster.test.ts` (new file)
**Pattern to follow**: Simple unit tests for the wrapper function.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `passes description to sonner options` | `description` field forwarded |
| 2 | `passes action to sonner options` | `action` object forwarded |
| 3 | `omits description and action when not provided` | Backward compatible — existing calls unchanged |

#### Test Details

##### 1. `passes description to sonner options`

**Setup**: Mock `sonner`'s `toast` function.

**Action**: Call `showAppToast({ message: "test", description: "details" })`.

**Assertions**:
- `toast` was called with second arg containing `description: "details"`

##### 2. `passes action to sonner options`

**Setup**: Mock `sonner`'s `toast` function.

**Action**: Call `showAppToast({ message: "test", action: { label: "Undo", onClick: mockFn } })` where `mockFn` has signature `(event: React.MouseEvent<HTMLButtonElement>) => void`.

**Assertions**:
- `toast` was called with second arg containing `action: { label: "Undo", onClick: mockFn }`

##### 3. `omits description and action when not provided`

**Setup**: Mock `sonner`'s `toast` function.

**Action**: Call `showAppToast({ message: "test" })`.

**Assertions**:
- `toast` was called with second arg that does NOT contain `description` or `action` keys

---

### TaskTrashWarningDialog Component

**Test file**: `web-ui/src/components/task-trash-warning-dialog.test.tsx` (new file)
**Pattern to follow**: See `web-ui/src/components/clear-trash-dialog.tsx` usage in tests (if any), or standard Radix AlertDialog render tests.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `renders task title and file count` | Dialog content reflects view model |
| 2 | `calls onConfirm when Move to Trash Anyway is clicked` | Confirm callback fires |
| 3 | `calls onCancel when Cancel is clicked` | Cancel callback fires |
| 4 | `renders generic message when warning is null` | Graceful fallback |

#### Test Details

##### 1. `renders task title and file count`

**Setup**: Render `<TaskTrashWarningDialog open={true} warning={{ taskTitle: "Fix login bug", fileCount: 3, workspaceInfo: { path: "/tmp/wt", ... } }} onCancel={vi.fn()} onConfirm={vi.fn()} />`.

**Assertions**:
- Screen contains text "Fix login bug"
- Screen contains text "3 changed file(s)"

##### 2. `calls onConfirm when Move to Trash Anyway is clicked`

**Setup**: Render with `onConfirm` mock.

**Action**: Click "Move to Trash Anyway" button.

**Assertions**:
- `onConfirm` called once

##### 3. `calls onCancel when Cancel is clicked`

**Setup**: Render with `onCancel` mock.

**Action**: Click "Cancel" button.

**Assertions**:
- `onCancel` called once

##### 4. `renders generic message when warning is null`

**Note**: This tests a defensive robustness fallback. In practice, the dialog is never rendered with `warning: null` because the `trashWarningState` gating logic always provides a fully populated view model. This test ensures the component degrades gracefully if future code paths skip the view model construction.

**Setup**: Render with `warning={null}`.

**Assertions**:
- Screen contains text "uncommitted changes" (generic fallback)

### Settings Dialog: `showTrashWorktreeNotice` Toggle

**Test file**: `web-ui/src/components/runtime-settings-dialog.test.tsx` (existing file)
**Pattern to follow**: Existing tests for `readyForReviewNotificationsEnabled` toggle in the same file.

#### Test Cases

| # | Test Name | What It Verifies |
|---|-----------|------------------|
| 1 | `renders Trash section with worktree notice toggle` | Settings dialog shows the Trash heading and toggle |
| 2 | `toggle reflects config value` | When config has `showTrashWorktreeNotice: false`, toggle is unchecked |
| 3 | `toggling and saving persists the value` | Toggling the switch and saving includes `showTrashWorktreeNotice` in the save payload |

#### Test Details

##### 1. `renders Trash section with worktree notice toggle`

**Setup**: Render `<RuntimeSettingsDialog>` with default config.

**Assertions**:
- Screen contains text "Trash"
- Screen contains text "Show worktree notice when trashing tasks"
- The toggle is checked by default (config default is `true`)

##### 2. `toggle reflects config value`

**Setup**: Render with config `{ showTrashWorktreeNotice: false }`.

**Assertions**:
- The worktree notice toggle is unchecked

##### 3. `toggling and saving persists the value`

**Setup**: Render with config `{ showTrashWorktreeNotice: true }`. Mock `saveConfig`.

**Action**: Click the toggle (now unchecked). Click Save.

**Assertions**:
- `saveConfig` was called with an object containing `showTrashWorktreeNotice: false`

---

## Edge Cases & Error Scenarios

| # | Test Name | Scenario | Expected Behavior | Test File | Review Finding |
|---|-----------|----------|-------------------|-----------|----------------|
| 1 | `trash from backlog with no worktree shows no dialog or toast` | Task was never started, no worktree exists | Trashes immediately, no dialog, no toast (backlog column is excluded from both) | `use-linked-backlog-task-actions.test.tsx` | Baseline edge case |
| 2 | `drag-to-trash with uncommitted changes shows confirmation and cancel reverts` | User drags a card with changes to trash column | Confirmation dialog shown (drag uses same `requestMoveTaskToTrash` path). Cancel handler calls `moveTaskToColumn(board, taskId, fromColumnId)` to revert the optimistic move. Card returns to original column. | `use-board-interactions.test.tsx` | Drag path parity + rollback (Finding #5) |
| 3 | `trash from backlog skips toast even when notice is enabled` | Task in backlog, `showTrashWorktreeNotice: true`, snapshot null | Trashes immediately, no toast (backlog column gating) | `use-linked-backlog-task-actions.test.tsx` | Column gating edge case |
| 4 | `handleMoveToTrash bails when trashWarningState.open is true` | User clicks trash button while confirmation dialog is open | `handleMoveToTrash` returns immediately without starting another trash flow | `use-board-interactions.test.tsx` | Finding #2 — loading guard |
| 5 | `moveSelectionIfOptimisticMoveIsConfirmed not called when confirmation fires` | Drag-to-trash with optimisticMoveApplied + uncommitted changes | `setSelectedTaskId` is NOT called when `onRequestTrashConfirmation` fires; it IS called when `confirmMoveTaskToTrash` runs | `use-linked-backlog-task-actions.test.tsx` | Finding #1 — selection timing |

## Regression Tests

Tests that ensure existing behavior isn't broken.

| # | Test Name | What Must Not Change | File Reference |
|---|-----------|---------------------|----------------|
| 1 | `existing trash tests still pass` | All current trash behavior (session stop, worktree delete, board state update) | `web-ui/src/hooks/use-linked-backlog-task-actions.test.tsx:180-324` |
| 2 | `clear trash still works` | ClearTrashDialog flow unchanged | `web-ui/src/hooks/use-board-interactions.test.tsx:428+` |
| 3 | `auto-trash paths unchanged` | Shutdown and auto-review trash behavior unaffected | `test/integration/shutdown-coordinator.integration.test.ts:98` |
| 4 | `existing config fields unaffected` | Adding new config field doesn't change defaults of other fields | `test/runtime/config/runtime-config.test.ts` |

## Test Execution Plan

### Phase 1: Config

1. **Write regression tests** — verify existing config fields still load correctly
   - Run: `npm run test:fast` — all pass (baseline)
2. **Write unit tests** — `showTrashWorktreeNotice` defaults and persistence tests
   - Run: `npm run test:fast` — new tests FAIL (field doesn't exist yet)
3. **Implement Phase 1**
   - Run: `npm run test:fast` — all pass

### Phase 2: Confirmation Dialog

1. **Write regression tests** — verify existing trash tests still pass
   - Run: `npm run web:test` — all pass (baseline)
2. **Write unit tests** — gating logic tests (8 cases) + dialog component tests (4 cases) + settings dialog tests (3 cases)
   - Run: `npm run web:test` — new tests FAIL (gating logic not implemented)
3. **Implement Phase 2**
   - Run: `npm run web:test` — all pass

### Phase 3: Notice Toast

1. **Write unit tests** — toast logic tests (6 cases) + app-toaster extension tests (3 cases)
   - Run: `npm run web:test` — new tests FAIL
2. **Implement Phase 3**
   - Run: `npm run web:test` — all pass
3. **Full suite**: `npm run check` — all pass

### Commands

```bash
# Run all tests for this feature
npm run check

# Run runtime config tests only
npx vitest run test/runtime/config/runtime-config.test.ts

# Run web UI tests related to trash (both files)
npx vitest run --config web-ui/vitest.config.ts web-ui/src/hooks/use-linked-backlog-task-actions.test.tsx
npx vitest run --config web-ui/vitest.config.ts web-ui/src/hooks/use-board-interactions.test.tsx

# Run app-toaster tests
npx vitest run --config web-ui/vitest.config.ts web-ui/src/components/app-toaster.test.ts

# Run dialog component tests
npx vitest run --config web-ui/vitest.config.ts web-ui/src/components/task-trash-warning-dialog.test.tsx

# Run settings dialog tests
npx vitest run --config web-ui/vitest.config.ts web-ui/src/components/runtime-settings-dialog.test.tsx

# Run with verbose output
npm run test -- --reporter=verbose
npm run web:test -- --reporter=verbose
```

## Traceability Matrix

| SDD Requirement | Test(s) | Type |
|----------------|---------|------|
| Phase 1: Config default `true` | `showTrashWorktreeNotice defaults to true` | Unit |
| Phase 1: Config persists to global file | `showTrashWorktreeNotice persists false to global config` | Unit |
| Phase 1: Config round-trip | `showTrashWorktreeNotice round-trips through save and load` | Unit |
| Phase 2: Dialog shown when changedFiles > 0 | `shows confirmation dialog when trashing card with uncommitted changes` | Unit |
| Phase 2: Dialog skipped for auto-trash | `skips confirmation when skipWorkingChangeWarning is true` | Unit |
| Phase 2: Dialog skipped when snapshot null | `skips confirmation when workspace snapshot is null` | Unit |
| Phase 2: Dialog skipped when changedFiles 0 | `skips confirmation when changedFiles is 0` | Unit |
| Phase 2: Dialog skipped when changedFiles null | `skips confirmation when changedFiles is null` | Unit |
| Phase 2: Cancel preserves card | `requestMoveTaskToTrash calls onRequestTrashConfirmation and not calling confirmMoveTaskToTrash leaves card in column` | Unit |
| Phase 2: Confirm trashes card | `calling confirmMoveTaskToTrash after onRequestTrashConfirmation trashes the card` | Unit |
| Phase 2: fromColumnId passed to callback | `onRequestTrashConfirmation receives fromColumnId as third argument` | Unit |
| Phase 2: Drag cancel reverts optimistic move | `drag-to-trash with uncommitted changes shows confirmation and cancel reverts` (edge case #2) | Edge case |
| Phase 3: Toast shown for manual trash | `shows notice toast after trash when showTrashWorktreeNotice is true` | Unit |
| Phase 3: Toast suppressed by config | `does not show notice toast when showTrashWorktreeNotice is false` | Unit |
| Phase 3: No toast when dialog shown | `does not show notice toast when confirmation dialog was shown` | Unit |
| Phase 3: No toast for auto-trash | `does not show notice toast for auto-trash` | Unit |
| Phase 3: No toast for backlog column | `does not show notice toast when trashing from backlog column` | Unit |
| Phase 3: Don't show again saves config | `don't show again action saves config` | Unit |
| Phase 3: Toast supports description | `passes description to sonner options` | Unit |
| Phase 3: Toast supports action | `passes action to sonner options` | Unit |
| Phase 3: Toast backward compat | `omits description and action when not provided` | Unit |
| Dialog component: renders correctly | `renders task title and file count` | Unit |
| Dialog component: confirm callback | `calls onConfirm when Move to Trash Anyway is clicked` | Unit |
| Dialog component: cancel callback | `calls onCancel when Cancel is clicked` | Unit |
| Dialog component: null warning | `renders generic message when warning is null` | Unit |
| Phase 1: Settings toggle renders | `renders Trash section with worktree notice toggle` | Unit |
| Phase 1: Settings toggle reflects config | `toggle reflects config value` | Unit |
| Phase 1: Settings toggle persists | `toggling and saving persists the value` | Unit |
| Edge: backlog task no worktree | `trash from backlog with no worktree shows no dialog or toast` | Edge case |
| Edge: backlog column gating | `trash from backlog skips toast even when notice is enabled` | Edge case |
| Edge: drag-to-trash with changes | `drag-to-trash with uncommitted changes shows confirmation and cancel reverts` | Edge case |
| Edge: loading guard when dialog open | `handleMoveToTrash bails when trashWarningState.open is true` | Edge case |
| Edge: selection not shifted prematurely | `moveSelectionIfOptimisticMoveIsConfirmed not called when confirmation fires` | Edge case |
| Regression: existing trash behavior | `existing trash tests still pass` | Regression |
| Regression: clear trash unchanged | `clear trash still works` | Regression |
| Regression: auto-trash unchanged | `auto-trash paths unchanged` | Regression |
| Regression: other config fields | `existing config fields unaffected` | Regression |
