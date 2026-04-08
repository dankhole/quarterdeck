# Trash Lifecycle

Reference for how tasks are trashed, what happens to worktrees and patches, and the confirmation/notice behaviors.

## 1. Trash Flow

Moving a card to trash follows this chain:

1. **UI entry points**: `handleMoveToTrash` (`web-ui/src/hooks/use-board-interactions.ts`), `handleMoveReviewCardToTrash`, drag-to-trash (`handleDragEnd`), auto-trash from review automation (`use-review-auto-actions.ts`)
2. **Animation layer**: `requestMoveTaskToTrashWithAnimation` (`web-ui/src/hooks/use-programmatic-card-moves.ts`) — tries animated move, falls back to direct
3. **Request handler**: `requestMoveTaskToTrash` (`web-ui/src/hooks/use-linked-backlog-task-actions.ts`) — checks for uncommitted changes (confirmation dialog), then proceeds or delegates
4. **Core logic**: `performMoveTaskToTrash` (`use-linked-backlog-task-actions.ts`) — updates board state via `trashTaskAndGetReadyLinkedTaskIds`, stops sessions, calls `cleanupTaskWorkspace`
5. **Backend cleanup**: `cleanupTaskWorkspace` (`web-ui/src/hooks/use-task-sessions.ts`) calls `workspace.deleteWorktree` tRPC mutation
6. **Worktree deletion**: `deleteTaskWorktree` (`src/workspace/task-worktree.ts`) — captures patch (best-effort), then removes worktree via `git worktree remove`

## 2. Patch Capture

When a worktree is deleted, Quarterdeck attempts to capture uncommitted work as a patch file before removal:

- **Location**: `~/.quarterdeck/trashed-task-patches/<taskId>.<headCommit>.patch`
- **Mechanism**: Best-effort `git diff` capture in `deleteTaskWorktree` (`src/workspace/task-worktree.ts`)
- **Scope**: Captures both staged and unstaged changes relative to HEAD
- **Failure handling**: If patch capture fails (e.g., corrupt worktree), the worktree is still removed — patch capture is best-effort

## 3. Confirmation Dialog

When a card is moved to trash via **intentional user action** (button, keyboard shortcut, drag-to-trash) AND the task has uncommitted changes (`changedFiles > 0` from `ReviewTaskWorkspaceSnapshot`), a confirmation dialog appears before the trash action proceeds.

**What it shows**:
- Task title and number of changed files
- Explanation that the worktree will be deleted and uncommitted work captured in a patch
- Workspace path (when available)
- "Cancel" and "Move to Trash Anyway" buttons

**When it does NOT appear**:
- `skipWorkingChangeWarning: true` (auto-trash scenarios)
- Workspace snapshot not available (not fetched yet — no blocking fetch on trash path)
- `changedFiles` is 0 or null
- Task is in the backlog column (never had an active worktree)

**Implementation**: `TaskTrashWarningDialog` (`web-ui/src/components/task-trash-warning-dialog.tsx`), wired through `use-board-interactions.ts` state and rendered in `App.tsx`.

**Drag rollback**: When a card is dragged to trash and the dialog appears, the optimistic board move is reverted on cancel.

## 4. Worktree Notice Toast

When a card is trashed manually and the confirmation dialog was NOT shown (no uncommitted changes or snapshot unavailable), an informational toast appears:

- **Message**: "Task workspace removed" with description about worktree deletion and patch capture
- **Action button**: "Don't show again" — sets `showTrashWorktreeNotice` to `false` in global config
- **Re-enable**: Settings dialog > Trash > "Show worktree notice when trashing tasks"
- **Column gating**: Only shown for tasks trashed from `in_progress` or `review` columns (backlog tasks never had a worktree)

**Config**: `showTrashWorktreeNotice` boolean in `~/.quarterdeck/config.json` (default: `true`).

**Interaction with confirmation dialog**: If the confirmation dialog is shown, the toast is NOT also shown — the dialog already communicates the same information.

## 5. Auto-Trash Scenarios

These pass `skipWorkingChangeWarning: true`, bypassing both the confirmation dialog and the notice toast:

- **Shutdown cleanup** (`src/server/shutdown-coordinator.ts`): Bulk-moves all running/review tasks to trash on server shutdown
- **Auto-review `move_to_trash`** (`web-ui/src/hooks/use-review-auto-actions.ts`): Auto-trash when task enters review with this mode
- **Auto-review commit/PR success** (`use-review-auto-actions.ts`): Auto-trash when `changedFiles === 0` after commit/PR

## 6. Clear Trash

"Clear Trash" permanently deletes all trashed cards. This is a separate flow from moving cards to trash:

- **Entry**: Trash column header "Clear" button
- **Confirmation**: `ClearTrashDialog` (`web-ui/src/components/clear-trash-dialog.tsx`) — shows task count, requires explicit confirm
- **Action**: Removes all cards from the trash column, stops any remaining sessions, cleans up workspaces
- **No worktree notice**: Cards in trash already had their worktrees deleted when they were first trashed

## 7. Restore from Trash

Cards can be dragged from trash back to the review column:

- **Mechanism**: Drag-to-review triggers `resumeTaskFromTrash` (`use-board-interactions.ts`)
- **Worktree recreation**: `ensureTaskWorkspace` creates a new worktree from the task's base ref
- **Patch restoration**: If a patch file exists for the task, it is applied to the new worktree during workspace setup
- **Session restart**: A new agent session is started with `resumeFromTrash: true`
