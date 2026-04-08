# Trash Confirmation & Worktree Notice — Implementation Specification

**Date**: 2026-04-07
**Branch**: HEAD
**Ticket**: #2
**Adversarial Review Passes**: 3
**Test Spec**: [docs/specs/2026-04-07-trash-confirmation-and-notice-tests.md](2026-04-07-trash-confirmation-and-notice-tests.md)

<!-- Raw Intent (preserved for traceability, not for implementation agents):
When a card is trashed, show an informational toast/dialog explaining that the worktree is deleted but uncommitted work is captured in a patch file. Include a "don't show again" option. Add a way to re-enable it in settings. Show a confirmation dialog when trashing cards that have uncommitted changes. Use existing patterns and infrastructure. No side effects — trash behavior itself stays the same.
-->

## Goal

Improve the trash experience with two complementary behaviors: (1) an informational notice explaining that the worktree is deleted and uncommitted work is captured in a patch, with a "don't show again" dismissal that persists via the config system, and (2) a confirmation dialog when trashing cards that have uncommitted changes. The existing trash mechanics (session stop, worktree delete, patch capture) remain unchanged.

## Current State

### Trash Flow

Moving a card to trash follows this chain:

1. **UI entry points**: `handleMoveToTrash` (`web-ui/src/hooks/use-board-interactions.ts:749`), `handleMoveReviewCardToTrash` (`:762`), drag-to-trash (`handleDragEnd` `:608-621`), auto-trash from review automation (`use-review-auto-actions.ts:165,200`)
2. **Animation layer**: `requestMoveTaskToTrashWithAnimation` (`web-ui/src/hooks/use-programmatic-card-moves.ts:192`) — tries animated move, falls back to direct
3. **Request handler**: `requestMoveTaskToTrash` (`web-ui/src/hooks/use-linked-backlog-task-actions.ts:177`) — accepts `skipWorkingChangeWarning` option but both branches (true/false) execute identically
4. **Core logic**: `performMoveTaskToTrash` (`use-linked-backlog-task-actions.ts:103`) — updates board state via `trashTaskAndGetReadyLinkedTaskIds`, stops sessions, calls `cleanupTaskWorkspace`
5. **Backend cleanup**: `cleanupTaskWorkspace` (`web-ui/src/hooks/use-task-sessions.ts:231`) calls `workspace.deleteWorktree` tRPC mutation
6. **Worktree deletion**: `deleteTaskWorktree` (`src/workspace/task-worktree.ts:564`) — captures patch (best-effort), then removes worktree via `git worktree remove`
7. **Patch storage**: Saved to `~/.quarterdeck/trashed-task-patches/<taskId>.<headCommit>.patch` (`task-worktree.ts:226-232`)

### Auto-Trash Scenarios (no user action)

These pass `skipWorkingChangeWarning: true`:
- **Shutdown cleanup** (`src/server/shutdown-coordinator.ts:56-94`): bulk-moves all running/review tasks to trash on server shutdown
- **Auto-review `move_to_trash`** (`web-ui/src/hooks/use-review-auto-actions.ts:165-184`): auto-trash when task enters review with this mode
- **Auto-review commit/PR success** (`use-review-auto-actions.ts:200-222`): auto-trash when `changedFiles === 0` after commit/PR

### Existing Components

- **`TaskTrashWarningDialog`** (`web-ui/src/components/task-trash-warning-dialog.tsx:42`): Orphaned component, never imported or rendered. Shows task title, file count, workspace path, and guidance for preserving work. Accepts `TaskTrashWarningViewModel` with `taskTitle`, `fileCount`, `workspaceInfo`.
- **`ClearTrashDialog`** (`web-ui/src/components/clear-trash-dialog.tsx:15`): Working confirmation for "Clear Trash" (permanent deletion). Already follows the AlertDialog pattern.
- **`skipWorkingChangeWarning` plumbing**: The option exists in `requestMoveTaskToTrash` (`use-linked-backlog-task-actions.ts:196`) and is forwarded through `use-programmatic-card-moves.ts:221` and `use-board-interactions.ts:616`. Currently a no-op guard.

### Workspace Metadata

- **`ReviewTaskWorkspaceSnapshot`** (`web-ui/src/types/board.ts:73`): Has `changedFiles`, `path`, `branch`, `isDetached`, `headCommit`. Populated when tasks are in review or when the diff viewer is opened.
- **`getTaskWorkspaceSnapshot(taskId)`** (`web-ui/src/stores/workspace-metadata-store.ts:236`): Synchronous read from the metadata store. Returns `null` if the snapshot hasn't been fetched yet.
- **`RuntimeTaskWorkspaceInfoResponse`** (`src/core/api-contract.ts:487-496`): Has `path`, `exists`, `baseRef`, `branch`, `isDetached`, `headCommit`. Does NOT have `changedFiles`.

### Config System

- **Global config**: `~/.quarterdeck/config.json` (`src/config/runtime-config.ts:14`)
- **Project config**: `<project>/.quarterdeck/config.json` (`runtime-config.ts:23`)
- **Boolean toggle reference pattern**: `readyForReviewNotificationsEnabled` — default at `:57`, global shape `:18`, state `:33`, update input `:45`, API response `api-contract.ts:554`, API save `api-contract.ts:570`, settings dialog `runtime-settings-dialog.tsx:289,405,658-667`
- **Settings save flow**: `runtime-settings-dialog.tsx` local state → `save()` → `use-runtime-config.ts` → tRPC `runtime.saveConfig` → `runtime-config.ts:530` merge + persist

### Toast System

- **`showAppToast`** (`web-ui/src/components/app-toaster.ts:15`): Wraps Sonner's `toast()`. Supports `intent` (danger/warning/success/primary/none), plain string `message`, auto-dismiss `timeout`.
- **Current limitation**: No examples of `toast.custom()`, action buttons, `description`, or persistent toasts in the codebase. Sonner supports all of these natively.

## Desired End State

### Behavior 1: Trash Worktree Notice (educational, dismissible)

When a card is moved to trash via **intentional user action** (button click, keyboard shortcut, drag-to-trash), an informational toast appears explaining:
- The worktree has been deleted
- Uncommitted work was captured in a patch file (if applicable)
- A "Don't show again" action button on the toast

This notice does NOT appear for:
- Auto-trash scenarios (shutdown, auto-review automation) — these already pass `skipWorkingChangeWarning: true`
- Clear Trash (cards are already in trash, worktrees already deleted)
- Tasks trashed from the `backlog` column — these never had an active worktree, so there is nothing to explain about worktree deletion or patch capture

The notice is controlled by a global config boolean `showTrashWorktreeNotice` (default: `true`). When the user clicks "Don't show again", the config is set to `false`. The settings dialog has a toggle to re-enable it.

### Behavior 2: Uncommitted Changes Confirmation (protective, optional)

When a card is moved to trash via **intentional user action** AND the task has uncommitted changes (`changedFiles > 0` from `ReviewTaskWorkspaceSnapshot`), a confirmation dialog appears BEFORE the trash action:
- Shows the task title and number of changed files
- Explains the worktree will be deleted and uncommitted work captured in a patch
- Shows the workspace path
- "Cancel" and "Move to Trash Anyway" buttons (matching existing `TaskTrashWarningDialog` pattern)

This confirmation does NOT appear when:
- `skipWorkingChangeWarning: true` (auto-trash scenarios)
- The workspace snapshot is not available (snapshot is null — we don't block on fetching it)
- `changedFiles` is `0` or `null`

This reuses and revives the existing orphaned `TaskTrashWarningDialog` component with minor adjustments to its copy.

### Interaction Between the Two Behaviors

- If the confirmation dialog is shown (uncommitted changes), the notice toast is NOT also shown (the dialog already communicates the same information).
- If no confirmation is needed (no uncommitted changes or snapshot unavailable), the notice toast is shown (unless dismissed via "don't show again").

## Out of Scope

- Changing what trash actually does (session stop, worktree delete, patch capture remain identical)
- Per-project settings — this is global only (matches the simplicity goal)
- Individual card deletion from trash
- Showing patch file path in the notification (the patch system is best-effort and the path is an implementation detail)
- Fetching workspace changes on-demand before trash (if the snapshot isn't already populated, we skip the confirmation — no new tRPC calls on the trash hot path)
- Changes to auto-trash behavior (shutdown, auto-review)
- Changes to "Clear Trash" flow

## Dependencies

None. No new packages, no infrastructure changes, no external dependencies. Everything uses existing patterns and libraries already in the project.

## Architecture & Approach

### Design Decisions

| Decision | Choice | Rationale | Alternative Considered | Implementation Constraint |
|----------|--------|-----------|----------------------|--------------------------|
| Notice mechanism | Sonner toast with action button | Lightweight, non-blocking, follows existing toast pattern. Sonner natively supports `action` — just not used yet in this codebase. | AlertDialog | Toast is less intrusive for an educational message. Dialog would be annoying on every trash. |
| Confirmation mechanism | Revive `TaskTrashWarningDialog` | Component already exists with correct UI structure. Reusing it avoids creating new components. | New dialog component | Must NOT create a new dialog — the existing one is already fit for purpose. |
| Config scope | Global only | Simpler. One boolean toggle. The "don't show again" concept is personal preference, not project-specific. | Per-project toggle | Would require touching project config paths — unnecessary complexity. |
| Uncommitted changes detection | Use existing `ReviewTaskWorkspaceSnapshot` from metadata store | Already populated for active tasks. Synchronous read, no network call. | Fetch `workspace.getChanges` on trash | Would add latency to every trash action and a new tRPC call on the hot path. Violates "no side effects" requirement. |
| Auto-trash exclusion | Use existing `skipWorkingChangeWarning` option | Plumbing already exists. Auto-trash paths already set it to `true`. | New option flag | Unnecessary — the existing flag has exactly the right semantics. |

## Implementation Phases

### Phase 1: Config — Add `showTrashWorktreeNotice` Global Setting

#### Overview

Add the new boolean setting following the `readyForReviewNotificationsEnabled` pattern exactly. This phase has no visible UI behavior change — it just wires the config value end-to-end.

#### Changes Required

##### 1. Backend Config Definition

**File**: `src/config/runtime-config.ts`
**Action**: Modify
**Changes**:
- Add default constant: `const DEFAULT_SHOW_TRASH_WORKTREE_NOTICE = true;` (after line 57)
- Add to `RuntimeGlobalConfigFileShape` (after line 18): `showTrashWorktreeNotice?: boolean;`
- Add to `RuntimeConfigState` (after line 33): `showTrashWorktreeNotice: boolean;`
- Add to `RuntimeConfigUpdateInput` (after line 45): `showTrashWorktreeNotice?: boolean;`
- Add normalization in the global config load function (near line 258): `normalizeBoolean(globalConfig?.showTrashWorktreeNotice, DEFAULT_SHOW_TRASH_WORKTREE_NOTICE)`
- Add to global config save merge (near line 307): same pattern as `readyForReviewNotificationsEnabled`
- Add to project config normalize/to-response/merge functions (near lines 445, 511, 542): same pattern
- Add to global config update merge/dirty-check/persist (near lines 607, 618, 630): same pattern

**Code Pattern to Follow**: Trace every occurrence of `readyForReviewNotificationsEnabled` in this file and replicate for `showTrashWorktreeNotice`.

##### 2. API Contract

**File**: `src/core/api-contract.ts`
**Action**: Modify
**Changes**:
- Add to `runtimeConfigResponseSchema` (after line 554): `showTrashWorktreeNotice: z.boolean(),`
- Add to `runtimeConfigSaveRequestSchema` (after line 570): `showTrashWorktreeNotice: z.boolean().optional(),`

##### 3. Settings Dialog

**File**: `web-ui/src/components/runtime-settings-dialog.tsx`
**Action**: Modify
**Changes**:
- Add local state (near line 289): `const [showTrashWorktreeNotice, setShowTrashWorktreeNotice] = useState(true);`
- Add sync from config in useEffect (near line 405): `setShowTrashWorktreeNotice(config?.showTrashWorktreeNotice ?? true);`
- Add to dirty check `hasUnsavedChanges` (near line 367): `if (showTrashWorktreeNotice !== initialShowTrashWorktreeNotice) { return true; }` — where `initialShowTrashWorktreeNotice` is `config?.showTrashWorktreeNotice ?? true` (defined alongside the other `initial*` constants near line 353)
- Add to save payload (near line 509): `showTrashWorktreeNotice,`
- Add RadixSwitch toggle in the **Global** settings section, under a "Trash" heading (near the Notifications section at line 656):
  ```
  <h6>Trash</h6>
  <label> Show worktree notice when trashing tasks
    <RadixSwitch.Root checked={showTrashWorktreeNotice} onCheckedChange={setShowTrashWorktreeNotice} ... />
  </label>
  ```

**Code Pattern to Follow**: Copy the `readyForReviewNotificationsEnabled` toggle structure at lines 656-667.

##### 4. Frontend Config Types

**File**: `web-ui/src/runtime/use-runtime-config.ts`
**Action**: Modify
**Changes**:
- Add to save input type (near line 84): `showTrashWorktreeNotice?: boolean;`

**File**: `web-ui/src/runtime/runtime-config-query.ts`
**Action**: Modify
**Changes**:
- Add to the `saveRuntimeConfig` input type (near line 24): `showTrashWorktreeNotice?: boolean;`

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] Runtime tests pass: `npm run test:fast`
- [ ] Web UI tests pass: `npm run web:test`
- [ ] Typecheck passes: `npm run typecheck && npm run web:typecheck`

##### Behavioral

- [ ] Open Settings dialog → "Trash" section visible under Global settings with "Show worktree notice when trashing tasks" toggle
- [ ] Toggle off → save → reopen dialog → toggle is off
- [ ] Check `~/.quarterdeck/config.json` has `"showTrashWorktreeNotice": false`

**Checkpoint**: Verify config round-trips before proceeding.

---

### Phase 2: Revive `TaskTrashWarningDialog` for Uncommitted Changes Confirmation

#### Overview

Wire the existing orphaned `TaskTrashWarningDialog` into the trash flow. When a user intentionally trashes a card that has uncommitted changes, the dialog appears before the trash action proceeds. This uses the existing `skipWorkingChangeWarning` guard that's already plumbed through the trash flow.

#### Changes Required

##### 1. Update Dialog Copy

**File**: `web-ui/src/components/task-trash-warning-dialog.tsx`
**Action**: Modify
**Changes**:
- Replace the dialog copy with the following exact values:
  - **Title** (`AlertDialogTitle`): `"Trash task with uncommitted changes?"`
  - **Description** (`AlertDialogDescription`): Keep existing dynamic text: `"${warning.taskTitle} has ${warning.fileCount} changed file(s)."` (already correct)
  - **Body paragraph** (the `<p>` below the description): `"Moving to Trash will delete this task's worktree. Uncommitted work will be captured in a patch file and can be recovered if you restore the task."`
  - **Guidance**: Replace `getTrashWarningGuidance` with a single-line return: `["The patch file is saved automatically — no action needed to preserve your work."]`
- Keep the existing structure: `AlertDialog` with `AlertDialogTitle`, `AlertDialogDescription`, Cancel button, "Move to Trash Anyway" danger button
- Keep the `TaskTrashWarningViewModel` interface — it already has the right shape (`taskTitle`, `fileCount`, `workspaceInfo`). When `workspaceInfo` is `null` (realistic for in-progress tasks that haven't been reviewed), the existing conditional rendering (line 72-76) simply omits the path block — this is acceptable behavior.

##### 2. Wire Dialog into `use-board-interactions`

**File**: `web-ui/src/hooks/use-board-interactions.ts`
**Action**: Modify
**Changes**:
- Add state for the trash warning dialog: `const [trashWarningState, setTrashWarningState] = useState<{ open: boolean; warning: TaskTrashWarningViewModel | null; card: BoardCard | null; fromColumnId: BoardColumnId | null; optimisticMoveApplied: boolean }>(...)`
  - Stores the full `BoardCard` (not just `taskId`) because `confirmMoveTaskToTrash` requires a `BoardCard` argument
  - Stores `fromColumnId` so the cancel handler can revert an optimistic drag-to-trash move
  - Stores `optimisticMoveApplied` so `confirmMoveTaskToTrash` can update selection correctly (see Finding #1)
- **Loading guard integration**: `handleMoveToTrash` and `handleMoveReviewCardToTrash` must check `trashWarningState.open` in addition to `moveToTrashLoadingByIdRef` and bail early if the dialog is already open. When the confirmation branch fires, `requestMoveTaskToTrashWithAnimation` resolves immediately (clearing the loading flag), but the dialog is still awaiting user input. Without this guard, the trash button would be re-clickable while the dialog is open. Example:
  ```typescript
  if (moveToTrashLoadingByIdRef.current[taskId] || trashWarningState.open) {
    return;
  }
  ```
- Import `TaskTrashWarningViewModel` from `task-trash-warning-dialog.tsx`
- Import `getTaskWorkspaceSnapshot` from `workspace-metadata-store.ts`
- Import `getTaskWorkspaceInfo` from `workspace-metadata-store.ts` (for the `workspaceInfo` field)

##### 3. Activate the `skipWorkingChangeWarning` Guard

**File**: `web-ui/src/hooks/use-linked-backlog-task-actions.ts`
**Action**: Modify
**Location**: `requestMoveTaskToTrash` at line 177

**New option on `useLinkedBacklogTaskActions` parameter object**:
```typescript
onRequestTrashConfirmation?: (viewModel: TaskTrashWarningViewModel, card: BoardCard, fromColumnId: BoardColumnId) => void;
```
This callback is provided by the parent (`use-board-interactions`) and is called when confirmation is needed. It receives the view model (for the dialog UI), the `BoardCard` (so the parent can pass it to `confirmMoveTaskToTrash` on confirm), and the `fromColumnId` (so the parent can revert an optimistic drag-to-trash move on cancel).

**Rename `_fromColumnId` to `fromColumnId`**: The second parameter of `requestMoveTaskToTrash` (line 178) currently has an underscore prefix because it was unused. Remove the underscore — it is now used for both column gating (toast, Phase 3) and passed to the confirmation callback (for drag rollback on cancel).

**Changes to `requestMoveTaskToTrash`**:
- When `skipWorkingChangeWarning` is falsy (manual user action):
  - Read `getTaskWorkspaceSnapshot(taskId)` synchronously
  - If `snapshot?.changedFiles != null && snapshot.changedFiles > 0`:
    - Build a `TaskTrashWarningViewModel` from the snapshot and card data
    - For the `workspaceInfo` field, use `getTaskWorkspaceInfo(taskId)` (no `baseRef` argument — omitting it skips the baseRef equality check and returns the info regardless of baseRef)
    - Call `onRequestTrashConfirmation(viewModel, selection.card, fromColumnId)` and return without trashing
    - **Do NOT call `moveSelectionIfOptimisticMoveIsConfirmed()` in this branch** — the user hasn't confirmed, so the detail panel selection must not shift. On cancel, the card reverts to its original column and the existing selection remains valid. On confirm, `confirmMoveTaskToTrash` calls `moveSelectionIfOptimisticMoveIsConfirmed()` as part of its execution (see below).
  - If snapshot is null or `changedFiles <= 0`: call `moveSelectionIfOptimisticMoveIsConfirmed()`, then proceed to `performMoveTaskToTrash` as before
- When `skipWorkingChangeWarning` is true: call `moveSelectionIfOptimisticMoveIsConfirmed()`, then proceed directly (no change from current behavior)

**Changes to `confirmMoveTaskToTrash`**:
- After the dialog confirm handler calls `confirmMoveTaskToTrash`, it must call `moveSelectionIfOptimisticMoveIsConfirmed()` before `performMoveTaskToTrash`. To enable this, `confirmMoveTaskToTrash` must accept an optional `optimisticMoveApplied` flag and run the selection update when it's true:
  ```typescript
  confirmMoveTaskToTrash: async (task: BoardCard, currentBoard?: BoardData, optimisticMoveApplied?: boolean) => {
    if (optimisticMoveApplied) {
      setSelectedTaskId((currentSelectedTaskId) =>
        currentSelectedTaskId === task.id
          ? getNextDetailTaskIdAfterTrashMove(currentBoard ?? boardRef.current, task.id)
          : currentSelectedTaskId,
      );
    }
    await performMoveTaskToTrash(task, currentBoard);
  },
  ```
- The confirm handler in `use-board-interactions` passes `optimisticMoveApplied` through from the stored `trashWarningState`.

**Call site in `use-board-interactions.ts`**: Pass `onRequestTrashConfirmation` when constructing `useLinkedBacklogTaskActions`, setting the dialog state. The callback must also receive and store the `optimisticMoveApplied` flag so the confirm handler can pass it through:
```typescript
onRequestTrashConfirmation: (viewModel, card, fromColumnId) => {
  setTrashWarningState({ open: true, warning: viewModel, card, fromColumnId, optimisticMoveApplied: !!options?.optimisticMoveApplied });
},
```
Note: `onRequestTrashConfirmation` signature extends to include the `optimisticMoveApplied` context implicitly via the closure over `options` in `requestMoveTaskToTrash`. Alternatively, the callback signature can be extended with a fourth boolean parameter — the implementer should choose whichever is cleaner.

**Drag rollback on cancel**: When `handleDragEnd` applies an optimistic board move to the trash column (line 608-609), the card is already visually in trash before `requestMoveTaskToTrash` runs. If the confirmation dialog fires and the user clicks Cancel, the optimistic move must be reverted. The cancel handler in `use-board-interactions` must call `moveTaskToColumn(board, taskId, fromColumnId)` (from `board-state.ts`) using the `fromColumnId` stored in `trashWarningState`:
```typescript
// Cancel handler
setBoard((currentBoard) => {
  const reverted = moveTaskToColumn(currentBoard, trashWarningState.card.id, trashWarningState.fromColumnId);
  return reverted.moved ? reverted.board : currentBoard;
});
setTrashWarningState({ open: false, warning: null, card: null, fromColumnId: null, optimisticMoveApplied: false });
```

##### 4. Render the Dialog

**File**: `web-ui/src/App.tsx`
**Action**: Modify
**Location**: Adjacent to the existing `<ClearTrashDialog>` render (near line 1142 in App.tsx)
**Why App.tsx**: `useBoardInteractions` is called in `App.tsx` (line 638). The hook returns `trashWarningState` (added in step 2), and `App.tsx` renders the dialog using that state — exactly like the existing `ClearTrashDialog` pattern where `isClearTrashDialogOpen` state lives in App.tsx and the dialog is rendered there.
**Changes**:
- Import `TaskTrashWarningDialog` from `@/components/task-trash-warning-dialog`
- Add `trashWarningState` and `handleCancelTrashWarning` / `handleConfirmTrashWarning` to the destructured return of `useBoardInteractions`
- Render `<TaskTrashWarningDialog>` adjacent to `<ClearTrashDialog>`, passing state from `trashWarningState`
- On confirm: call `confirmMoveTaskToTrash` with the stored `card`, then close the dialog
- On cancel: revert optimistic move using stored `fromColumnId` (see drag rollback above), then close the dialog

**Code Pattern to Follow**: See how `ClearTrashDialog` is wired — `handleOpenClearTrash` (`use-board-interactions.ts:846`) opens it, `handleConfirmClearTrash` (`:853`) runs the action, `App.tsx:1142-1147` renders the dialog. Same state-management pattern.

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] All tests pass: `npm run check`

##### Behavioral

- [ ] Create a task → start it → make changes in the worktree → trash it → confirmation dialog appears showing file count and workspace path
- [ ] Click "Cancel" → task stays in its column (or returns to its original column if dragged to trash), nothing happens
- [ ] Click "Move to Trash Anyway" → task moves to trash, worktree deleted, patch captured
- [ ] Trash a task with no changes (or from backlog with no worktree) → no dialog, trashes immediately
- [ ] Auto-trash via review automation → no dialog shown

**Checkpoint**: Verify dialog appears correctly before proceeding.

---

### Phase 3: Add Trash Worktree Notice Toast

#### Overview

Show an informational Sonner toast after a card is successfully trashed (when the confirmation dialog was NOT shown), explaining that the worktree was deleted and work was captured in a patch. The toast includes a "Don't show again" action button.

#### Changes Required

##### 1. Extend `showAppToast` to Support Action Buttons

**File**: `web-ui/src/components/app-toaster.ts`
**Action**: Modify
**Changes**:
- Add optional `description` and `action` fields to `AppToastProps`:
  ```typescript
  description?: string;
  action?: { label: string; onClick: (event: React.MouseEvent<HTMLButtonElement>) => void };
  ```
  Sonner's `Action` type uses `label: React.ReactNode` and `onClick: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void`. We narrow `label` to `string` for our use case but match the `onClick` signature to avoid a type mismatch.
- Pass them through to Sonner's options object:
  ```typescript
  if (props.description) options.description = props.description;
  if (props.action) options.action = { label: props.action.label, onClick: props.action.onClick };
  ```
- Sonner natively supports both `description` and `action` — this just exposes them through the wrapper.

##### 2. Show Notice Toast After Trash

**File**: `web-ui/src/hooks/use-linked-backlog-task-actions.ts`
**Action**: Modify
**Location**: Inside `requestMoveTaskToTrash` (line 177), after `await performMoveTaskToTrash(...)` returns (near line 203 in the current code). NOT inside `performMoveTaskToTrash` itself — `performMoveTaskToTrash` is shared between the request and confirm paths.
**Changes**:
- After `performMoveTaskToTrash` returns in the `requestMoveTaskToTrash` non-confirmation branch, if:
  - `skipWorkingChangeWarning` is falsy (manual user action), AND
  - The confirmation dialog was NOT shown for this trash action (no uncommitted changes — this is the branch where we fell through the snapshot check), AND
  - The config value `showTrashWorktreeNotice` is `true`, AND
  - `fromColumnId` is `in_progress` or `review` (not `backlog`) — backlog tasks never had a worktree, so the notice is irrelevant
- The two code paths naturally separate toast vs. no-toast: `requestMoveTaskToTrash` is the only path that shows the toast. `confirmMoveTaskToTrash` (called after the dialog) calls `performMoveTaskToTrash` directly and skips the toast because the dialog already communicated the same information.
- Then show a toast:
  ```typescript
  showAppToast({
    intent: "none",
    message: "Task workspace removed",
    description: "The worktree was deleted. Uncommitted work was captured in a patch file.",
    action: {
      label: "Don't show again",
      onClick: (_event) => saveConfig({ showTrashWorktreeNotice: false }),
    },
    timeout: 7000,
  });
  ```
- The `showTrashWorktreeNotice` config value needs to be accessible in this hook. It can be passed as a prop from the parent (same pattern as other config values passed through `use-board-interactions`), or read from the config query cache.
- **Config freshness**: `showTrashWorktreeNotice` must be read fresh at toast-display time (i.e., when `requestMoveTaskToTrash` runs), not captured at hook initialization. If passed as a prop, it is automatically fresh because React re-renders with the latest value. If read from the query cache, use the cache getter inside the callback. This ensures that clicking "Don't show again" on one toast takes effect immediately for the next trash action without waiting for a re-render cycle.

##### 3. Wire Config Value to the Hook

**File**: `web-ui/src/hooks/use-board-interactions.ts` or `web-ui/src/App.tsx`
**Action**: Modify
**Changes**:
- Pass `showTrashWorktreeNotice` from the runtime config down to `useLinkedBacklogTaskActions` (or wherever the toast is shown)
- Pass a `saveConfig` callback (or a focused `dismissTrashWorktreeNotice` callback) so the "Don't show again" action can persist the preference

**Code Pattern to Follow**: See how `readyForReviewNotificationsEnabled` is read from config in `App.tsx:172` and passed to hooks.

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] All tests pass: `npm run check`

##### Behavioral

- [ ] Trash a task with no uncommitted changes → toast appears: "Task workspace removed" with description and "Don't show again" button
- [ ] Click "Don't show again" → toast dismisses, setting saved
- [ ] Trash another task → no toast appears
- [ ] Go to Settings → "Trash" section → toggle "Show worktree notice" back on → trash a task → toast appears again
- [ ] Trash a task WITH uncommitted changes → confirmation dialog shown, NO toast after confirming
- [ ] Auto-trash (shutdown, auto-review) → no toast

**Checkpoint**: Full feature complete.

---

### Phase 4: Documentation — Current Flow & New Behavior

#### Overview

Document the complete trash lifecycle in `docs/trash-lifecycle.md`, covering both the existing mechanics and the new confirmation/notice behaviors.

#### Changes Required

##### 1. Create Trash Lifecycle Doc

**File**: `docs/trash-lifecycle.md`
**Action**: Create
**Target length**: ~150–250 lines. This is a concise reference doc, not an exhaustive walkthrough.
**Primary source**: Extract from the "Current State" section of this SDD — do not re-research the codebase from scratch.
**Changes**:
- **Section 1: Trash Flow** — Document the complete chain from UI action to worktree deletion, with `file:line` references (use the "Current State" section of this spec as the source)
- **Section 2: Patch Capture** — Explain the best-effort patch capture, where patches are stored, and how restore-from-trash uses them
- **Section 3: Confirmation Dialog** — When it appears (uncommitted changes on manual trash), what it shows, how to confirm/cancel
- **Section 4: Worktree Notice** — When the toast appears (manual trash, no uncommitted changes, notice enabled), the "Don't show again" behavior, and how to re-enable via settings
- **Section 5: Auto-Trash Scenarios** — Shutdown cleanup, auto-review modes. No confirmation or notice for these.
- **Section 6: Clear Trash** — Permanent deletion flow with its own confirmation dialog
- **Section 7: Restore from Trash** — How cards are restored and worktrees recreated

##### 2. Update Planned Features

**File**: `docs/planned-features.md`
**Action**: Modify
**Changes**:
- Update item #2 to reflect the simplified scope: informational notice + confirmation dialog, not configurable worktree deletion behavior
- Add a link to the trash lifecycle doc and this spec

#### Success Criteria

- [ ] `docs/trash-lifecycle.md` exists and covers all 7 sections
- [ ] `docs/planned-features.md` #2 is updated

## Error Handling

| Scenario | Expected Behavior | How to Verify |
|----------|------------------|---------------|
| `getTaskWorkspaceSnapshot` returns `null` | Skip confirmation dialog, proceed to trash directly (with notice toast if enabled, subject to column gating) | Trash a backlog task that was never started |
| Config save fails on "Don't show again" | Toast dismisses normally, error logged to console. Next trash will still show the notice (config wasn't persisted). | Simulate config save failure in dev tools |
| `TaskTrashWarningDialog` rendered with `warning: null` | Dialog shows generic message ("This task has uncommitted changes.") — this is already handled in the existing component (line 67-69) | Should not happen in practice but component handles it gracefully |

## Rollback Strategy

- **Phase 1 rollback**: Remove the config field from all 6 files. No data migration needed — unknown keys in `config.json` are harmlessly ignored on load.
- **Phase 2 rollback**: Remove dialog wiring. The `TaskTrashWarningDialog` component can stay (it was already orphaned before).
- **Phase 3 rollback**: Remove toast call and `app-toaster.ts` changes.
- **Full rollback**: Revert all phases. The trash flow returns to its previous behavior (immediate trash, no confirmation, no notice).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `ReviewTaskWorkspaceSnapshot` not populated for in_progress tasks | Medium | Low | If snapshot is null, skip confirmation. The notice toast still educates. No blocking fetch. |
| Confirmation dialog effectively review-only | Medium | Low | `ReviewTaskWorkspaceSnapshot` is typically only populated when a task enters review or the diff viewer is opened. In-progress tasks rarely have a snapshot, so the confirmation dialog will rarely appear for them. This is acceptable — the notice toast still informs the user, and adding a blocking fetch to populate the snapshot would violate the "no new tRPC calls on trash hot path" constraint. |
| Toast "Don't show again" fires but config save races with next trash | Low | Low | Config save is async but fast (local file write). Worst case: one extra toast. |

## Implementation Notes / Gotchas

- **`RequestMoveTaskToTrashOptions` is duplicated in 3 files**: The interface exists in `use-linked-backlog-task-actions.ts:16`, `use-programmatic-card-moves.ts:7`, and `use-review-auto-actions.ts:20`. No changes to this interface are needed — the new `onRequestTrashConfirmation` callback is on the `useLinkedBacklogTaskActions` parameter object, not on the options interface. The duplication is pre-existing and out of scope for this spec.
- **Board state single-writer rule**: The confirmation dialog does NOT modify board state — it only gates the existing `performMoveTaskToTrash` call. No new `mutateWorkspaceState` calls from the server.
- **`skipWorkingChangeWarning` is the key control point**: All auto-trash paths already set this to `true`. The confirmation dialog and notice toast both check this flag. No need to add new flags.
- **Dialog state ownership**: The dialog open/close state should live in `use-board-interactions` (or be lifted to the component that renders the dialog), NOT in `use-linked-backlog-task-actions`. The linked-backlog hook should call a callback to request the dialog, and the parent decides whether to show it.
- **`getTaskWorkspaceSnapshot` and `getTaskWorkspaceInfo` read from different stores**: `getTaskWorkspaceSnapshot` reads from the workspace metadata store (populated when tasks enter review or when the diff viewer is opened). `getTaskWorkspaceInfo` reads from the runtime workspace info cache (populated during session lifecycle). It is expected that `workspaceInfo` may be `null` while `snapshot` exists, or vice versa — they are independently populated. When `workspaceInfo` is null, the dialog simply omits the workspace path block (existing conditional rendering at line 72-76).
- **Don't fetch workspace changes on trash**: The whole point of using the existing `ReviewTaskWorkspaceSnapshot` is that it's already in memory. Do NOT add a `workspace.getChanges` call to the trash path — that would add latency and a network call to every trash action.
- **Sonner action buttons**: Sonner's `Action` type takes `{ label: React.ReactNode, onClick: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void }`. The button renders inside the toast. When clicked, the toast auto-dismisses. This is built-in Sonner behavior, no custom rendering needed. Note: `React.MouseEvent<HTMLButtonElement>` is equivalent to `React.MouseEvent<HTMLButtonElement, MouseEvent>` since `MouseEvent` is the default second generic parameter — either form is acceptable in our `AppToastProps`.
- **Programmatic move resolution timing with confirmation dialog**: When the confirmation dialog fires, `resolvePendingProgrammaticTrashMove` resolves before the user confirms/cancels, which technically allows new programmatic moves. This is acceptable because the confirmation dialog is a modal `AlertDialog` that blocks all background user interaction (clicks, drags, keyboard shortcuts). No conflicting drag operations can start while the modal is open.

## References

- **Planned feature**: `docs/planned-features.md` #2
- **Orphaned dialog**: `web-ui/src/components/task-trash-warning-dialog.tsx`
- **Config pattern**: `readyForReviewNotificationsEnabled` across 6 files (see Phase 1)
- **Patch capture**: `src/workspace/task-worktree.ts:192-233`
- **Workspace snapshot**: `web-ui/src/stores/workspace-metadata-store.ts:236` (`getTaskWorkspaceSnapshot`)
- **Toast wrapper**: `web-ui/src/components/app-toaster.ts:15`
- **Test Spec**: `docs/specs/2026-04-07-trash-confirmation-and-notice-tests.md`
