# Branch Persistence on Cards — Implementation Specification

**Date**: 2026-04-07
**Branch**: HEAD (detached)
**Ticket**: #3
**Adversarial Review Passes**: 3
**Test Spec**: [docs/specs/2026-04-07-3-branch-persistence-on-cards-tests.md](./2026-04-07-3-branch-persistence-on-cards-tests.md)

<!-- Raw Intent (preserved for traceability, not for implementation agents):
Feature #3: Branch persistence on cards. Two phases:
1. Persist branch name on cards via auto-capture from metadata monitor. On resume-from-trash, attempt to checkout the saved branch (fall back to detached HEAD). This also protects committed-but-unpushed agent work from git gc by keeping a named ref alive.
2. Optionally create a named feature branch at task creation time. Opt-in toggle on create-task form with auto-suggested editable branch name from task title.
User explicitly wants: local-only ref checks on resume (no remote fetch), always-fallback-to-detached-HEAD, auto-capture from metadata monitor fills in branch if empty, piggybacking on the workingDirectory data flow pattern.
-->

## Goal

Add a persistent `branch` field to board cards so that branch names survive server restarts and worktree cleanup. When resuming a trashed task, the system attempts to checkout the saved branch (falling back to detached HEAD), which preserves committed-but-unpushed agent work that would otherwise be lost to git gc. Additionally, allow users to optionally create a named feature branch at task creation time via an opt-in toggle with an auto-suggested, editable branch name.

## Current State

- **Card schema** (`src/core/api-contract.ts:117-131`): `runtimeBoardCardSchema` has no `branch` field. Cards store `baseRef` (the ref the worktree was created from).
- **Transient branch info** (`src/core/api-contract.ts:308-321`): `runtimeTaskWorkspaceMetadataSchema` has `branch: z.string().nullable()`, populated by polling `git status` on live worktrees. Never persisted to board state.
- **Metadata monitor** (`src/server/workspace-metadata-monitor.ts:253`): Reads branch from `probeGitWorkspaceState()` (`src/workspace/git-sync.ts:113-139`). Returns `null` for detached HEAD.
- **Worktree creation** (`src/workspace/task-worktree.ts:516`): Always `git worktree add --detach <path> <commit>`. No named branch.
- **Patch capture** (`src/workspace/task-worktree.ts:192-233`): Saves uncommitted changes + HEAD commit hash as `{taskId}.{commitHash}.patch`. No branch name recorded.
- **Resume flow** (`src/workspace/task-worktree.ts:502-541`): Finds patch by commit hash, creates detached worktree at that commit, applies patch.
- **Shutdown** (`src/server/shutdown-coordinator.ts:147-223`): Destroys worktrees for in-progress/review tasks after capturing patches.
- **Shutdown trash path** (`src/server/shutdown-coordinator.ts:16-54`): `moveTaskToTrash` uses `...removedCard` spread to construct the trashed card, which preserves all existing card fields.
- **Trash cleanup** (`src/core/task-board-mutations.ts:535-537`): Clears `workingDirectory` to `null` when trashing. Does not touch branch (field doesn't exist yet).
- **UI display** (`web-ui/src/components/board-card.tsx:244-245`): Shows `reviewWorkspaceSnapshot?.branch` from live metadata, falling back to abbreviated commit hash.

### Working Directory Pattern (template for this feature)

The `workingDirectory` field follows the single-writer pattern we will replicate:

1. **Schema**: Field on `runtimeBoardCardSchema` (`api-contract.ts:127`)
2. **Client type**: Mirrored on `BoardCard` (`web-ui/src/types/board.ts:49`)
3. **Normalization**: `normalizeCard` handles the field (`board-state.ts:139-144`)
4. **Client-side persistence**: `reconcileTaskWorkingDirectory` in `board-state.ts:517-548` — called from `App.tsx:195-199` on session start and `App.tsx:243-256` on metadata change
5. **Self-healing**: Metadata monitor detects drift, UI corrects via reconcile
6. **Trash clear**: `moveTaskToColumn` sets `workingDirectory: null` on trash (`task-board-mutations.ts:537`)

## Desired End State

1. **Cards persist a `branch` field** (nullable string). `null` means detached HEAD or no branch detected.
2. **Auto-capture**: When the metadata monitor detects a branch on a task's worktree, the UI receives it via the existing metadata subscription and persists it on the card — same reconcile pattern as `workingDirectory`.
3. **Display**: Cards show the persisted branch name even when the worktree is gone (trashed tasks, after restart). Falls back to commit hash only when branch is null.
4. **Resume from trash**: When resuming a trashed task with a saved branch:
   - Check if the branch exists locally (`git rev-parse --verify refs/heads/<branch>`)
   - If yes: `git worktree add <path> <branch>` (checks out existing branch)
   - If no: attempt `git worktree add -b <branch> <path> <commit>` (recreate the branch at the saved commit)
   - If either fails: fall back to current behavior (`git worktree add --detach <path> <commit>` + patch apply)
5. **Create with branch (opt-in)**: Task creation form has a "Create feature branch" toggle (default off). When on, shows an editable text field auto-populated with a slug from the task title (e.g., `quarterdeck/add-auth-middleware`). On task start, `git worktree add -b <branchName> <path> <commit>` instead of `--detach`.
6. **Branch preserved on trash**: Unlike `workingDirectory`, the `branch` field is NOT cleared when trashing — it's needed for the resume flow.

## Out of Scope

- Remote fetch on resume — local refs only. If the branch was pushed but gc'd locally, fall back to detached HEAD.
- Branch rename on worktree conflict — fall back to detached HEAD instead.
- PR creation from branch — future feature.
- Auto-creating branches for all tasks — this is opt-in only.
- Branch deletion after task completion.
- Inline create card (`web-ui/src/components/task-inline-create-card.tsx`) — this is a quick-add flow with minimal UI. The "Create feature branch" option is only available in the full task creation dialog. Inline-created tasks can still have their branch auto-captured by the metadata monitor if the agent creates one.
- Bulk task creation (`handleCreateTasks` in `web-ui/src/hooks/use-task-editor.ts`) — the bulk creation path does not support the `branchName` field. Bulk-created tasks use detached HEAD and can have their branch auto-captured later by the metadata monitor.

## Dependencies

- **Teams**: None — personal project.
- **Services**: None.
- **Data**: No migration needed — the new `branch` field is optional/nullable and `normalizeCard` handles missing fields gracefully.
- **Timing**: None.

## New Dependencies & Configuration

No new packages or configuration changes required.

## Architecture & Approach

Replicate the `workingDirectory` single-writer pattern: the server never writes `branch` to board state directly. The metadata monitor detects the branch, streams it to the UI via the existing `runtimeTaskWorkspaceMetadata` subscription, and the UI persists it on the card through a reconcile function. This respects the single-writer rule documented in AGENTS.md.

For resume, extend the worktree creation function with a branch-aware path: try named branch first, fall back to detached HEAD. The patch system remains as-is — it's orthogonal to branch checkout.

For create-with-branch, add a `branchName` field to the task draft that flows through to `ensureTaskWorktreeIfDoesntExist`, which uses `-b` instead of `--detach` when present.

### Design Decisions

| Decision | Choice | Rationale | Alternative Considered | Implementation Constraint |
|----------|--------|-----------|----------------------|--------------------------|
| Branch persistence location | Card field, client-written | Matches `workingDirectory` pattern; respects single-writer rule | Server-written via `mutateWorkspaceState` | MUST use reconcile pattern, MUST NOT write from server when UI is connected |
| Branch NOT cleared on trash | Keep branch value on trashed cards | Branch is needed for resume flow — clearing it defeats the purpose | Clear like `workingDirectory` | `moveTaskToColumn` MUST NOT null out `branch` on trash |
| Resume branch checkout | Local refs only, fallback to detached | User requested simplicity; avoids network calls during resume | Fetch from remote if local missing | MUST fall back silently to detached HEAD on any branch checkout failure |
| Create-with-branch naming | Auto-slug from title, editable | User requested auto-suggested + editable | Always auto-generate, no editing | MUST pre-populate field, MUST allow user to change it |
| Branch auto-capture | Reconcile from metadata monitor | Captures agent-created branches without server-side board writes | WebSocket broadcast like `task_title_updated` | MUST only update card branch when field is null or different from detected |

## Interface Contracts

### Schema Changes

**`runtimeBoardCardSchema`** — add field:
```ts
branch: z.string().min(1).nullable().optional(),
```
Three-state semantics matching `workingDirectory`: `string` (branch name), `null` (explicitly no branch / detached), `undefined` (not yet resolved).

**`TaskDraft`** — add field:
```ts
branchName?: string;
```
Only set when user opts into "Create feature branch" at creation time.

### Worktree Creation API

`ensureTaskWorktreeIfDoesntExist` gains an optional `branch?: string | null` parameter in its options object, threaded from `resolveTaskCwd` and `startTaskSession`. The combined branch control flow inside the function is:

1. If `branch` is set, check if the branch exists locally: `git rev-parse --verify refs/heads/<branch>`
2. **If EXISTS**: `git worktree add <path> <branch>` (checks out existing branch — resume path)
3. **If NOT exists**: `git worktree add -b <branch> <path> <commit>` (creates new branch — creation path)
4. **If either fails**: fall through to `git worktree add --detach <path> <commit>` (existing detached HEAD path)

This single parameter serves both resume (Phase 2, existing branch) and create (Phase 3, new branch). The branch existence check at step 1 determines which git operation is used — no separate flag is needed.

## Implementation Phases

### Phase 1: Schema + Auto-Capture + Display

#### Overview

Add the `branch` field to the card schema and wire up auto-capture from the metadata monitor. Cards display the persisted branch name. No behavior changes to worktree creation or resume yet.

#### Changes Required

##### 1. Runtime Card Schema

**File**: `src/core/api-contract.ts`
**Action**: Modify
**Location**: `runtimeBoardCardSchema` at line 117-131
**Changes**:
- Add `branch: z.string().min(1).nullable().optional()` after `workingDirectory`

##### 2. Client Card Type

**File**: `web-ui/src/types/board.ts`
**Action**: Modify
**Location**: `BoardCard` interface at line ~49
**Changes**:
- Add `branch?: string | null`

##### 3. Card Normalization

**File**: `web-ui/src/state/board-state.ts`
**Action**: Modify
**Location**: `normalizeCard` function at line 96-149
**Changes**:
- Add `branch?: unknown` to the cast object (line ~101-115)
- Add normalization in the return block: `branch: typeof card.branch === "string" ? card.branch : card.branch === null ? null : undefined`
- **Code Pattern to Follow**: See `workingDirectory` normalization at lines 139-144

##### 4. Reconcile Function

**File**: `web-ui/src/state/board-state.ts`
**Action**: Add
**Location**: After `reconcileTaskWorkingDirectory` (line 549)
**Changes**:
- Add `reconcileTaskBranch(board, taskId, branch)` function:
  - Find card by taskId across all columns
  - If card's `branch` already matches the incoming value, return `{ board, updated: false }`
  - Otherwise update card's `branch` and `updatedAt`, return updated board
  - Only update if incoming branch is a non-empty string (don't overwrite a known branch with null — the agent may have just detached temporarily)
- **Reconcile truth table** (card.branch x incoming):

| `card.branch` | incoming | result | reason |
|---|---|---|---|
| `undefined` | `"feat/foo"` | update to `"feat/foo"` | First capture |
| `null` | `"feat/foo"` | update to `"feat/foo"` | First capture |
| `"feat/foo"` | `"feat/foo"` | no-op | Already matches |
| `"feat/foo"` | `null` | no-op | Don't erase — agent may be temporarily detached |
| `"feat/foo"` | `"feat/bar"` | update to `"feat/bar"` | Agent switched branches |
| `"feat/foo"` | `undefined` | no-op | No metadata available |

- **Code Pattern to Follow**: See `reconcileTaskWorkingDirectory` at lines 517-548

##### 5. Metadata Subscription — Auto-Capture

**File**: `web-ui/src/App.tsx`
**Action**: Modify
**Location**: Metadata subscription `useEffect` at line ~243-256
**Changes**:
- The `subscribeToAnyTaskMetadata` callback receives a `taskId` (not a metadata object). Inside the callback, retrieve the snapshot via `getTaskWorkspaceSnapshot(taskId)` from `workspace-metadata-store`, then read `snapshot.branch`.
- After calling `reconcileTaskWorkingDirectory`, also call `reconcileTaskBranch` with `snapshot.branch`
- Only reconcile branch if `snapshot.branch` is a non-empty string (ignore null from detached HEAD — don't erase a previously captured branch)
- **Code Pattern to Follow**: See the existing `reconcileTaskWorkingDirectory` call in the same effect, which already calls `getTaskWorkspaceSnapshot(taskId)` to obtain `workingDirectory`

##### 6. Card Display — Persisted Branch

**File**: `web-ui/src/components/board-card.tsx`
**Action**: Modify
**Location**: Branch display at line ~244-245
**Changes**:
- Prefer `card.branch` (persisted) over `reviewWorkspaceSnapshot?.branch` (live metadata)
- Display logic: `card.branch ?? reviewWorkspaceSnapshot?.branch ?? headCommit?.slice(0,8)`
- This ensures branch name shows even when worktree is gone

##### 7. Detail View — Branch Display

**File**: `web-ui/src/components/card-detail-view.tsx`
**Action**: Modify
**Location**: Search for all references to `taskWorkspaceInfo?.branch` in this file and update each occurrence
**Changes**:
- Same priority: prefer `card.branch` over live metadata branch

##### 8. Update Task — Preserve Branch

**File**: `web-ui/src/state/board-state.ts`
**Action**: Verify (no code change needed)
**Location**: `updateTask` function at line 454-498
**Changes**:
- The `...card` spread at line 473 already preserves all existing card fields including `branch`. Verify that neither `updateTask` nor the `TaskDraft` interface introduces an explicit `branch` override that would clobber the persisted value. No code change is required — the spread handles it.

##### 9. Trash — Do NOT Clear Branch (Client Path)

**File**: `src/core/task-board-mutations.ts`
**Action**: Verify (no change needed)
**Location**: `moveTaskToColumn` at line 532-537
**Changes**:
- Verify that the `workingDirectory: null` spread on trash does NOT include `branch`. Since the field doesn't exist in the spread today, adding `branch` to the card schema won't accidentally clear it. Just confirm this.

##### 9a. Trash — Do NOT Clear Branch (Shutdown Path)

**File**: `src/server/shutdown-coordinator.ts`
**Action**: Verify (no change needed)
**Location**: `moveTaskToTrash` at line 16-54
**Changes**:
- Verify that the `...removedCard` spread preserves all existing card fields including `branch`. This is a separate code path from `moveTaskToColumn` — it runs during graceful shutdown to move in-progress/review tasks to trash. The spread-based construction preserves `branch` by default. No code change needed, just confirm both trash paths preserve the field.

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] Lint passes: `npm run lint`
- [ ] Typecheck passes: `npm run typecheck && npm run web:typecheck`
- [ ] Tests pass: `npm run test && npm run web:test`

##### Behavioral

- [ ] Start a task, let the agent create a branch. Verify the card's branch field is populated via metadata reconcile.
- [ ] Trash the task (shutdown or manual). Verify the card still shows the branch name.
- [ ] Restart the server. Verify the trashed card still shows the branch name (persisted in board state JSON).

**Checkpoint**: Pause here for verification before proceeding to Phase 2.

---

### Phase 2: Branch-Aware Resume from Trash

#### Overview

When resuming a trashed task, attempt to checkout the saved branch before falling back to detached HEAD + patch. This preserves committed-but-unpushed agent work that would otherwise be lost.

#### Changes Required

##### 1. Thread Branch Through Resume

**File**: `src/workspace/task-worktree.ts`
**Action**: Modify
**Location**: `ensureTaskWorktreeIfDoesntExist` at line 436-562
**Changes**:
- The `branch` parameter is already on the options object (added in the signature change above)
- After `git worktree prune` (line 513) and `mkdir` (line 515), BEFORE the existing `git worktree add --detach` (line 516), add the combined branch control flow:

```
if (options.branch) {
  // Step 1: Check if branch exists locally
  const branchCheck = await runGit(context.repoPath, ["rev-parse", "--verify", `refs/heads/${options.branch}`]);

  if (branchCheck.ok) {
    // Step 2: Branch EXISTS — checkout existing branch (resume path)
    const checkoutResult = await runGit(context.repoPath, ["worktree", "add", worktreePath, options.branch]);
    if (checkoutResult.ok) {
      await prepareNewTaskWorktree(context.repoPath, worktreePath);
      // Patch may have been captured at a different commit than the branch HEAD.
      // Apply is best-effort; failure produces a warning but does not abort the resume.
      if (storedPatch) {
        try {
          await applyTaskPatch(storedPatch.path, worktreePath);
          await rm(storedPatch.path, { force: true });
        } catch {
          warning = "Saved task changes could not be reapplied onto the branch.";
        }
      }
      // baseCommit is branchCheck.stdout (the branch HEAD commit) because the worktree
      // is now checked out at that commit. This is intentional — the branch tip IS the base.
      return { ok: true, path: worktreePath, baseRef: requestedBaseRef, baseCommit: branchCheck.stdout.trim(), warning };
    }
    // Checkout failed (e.g., locked by another worktree) — clean up partial worktree before fallback
    await removeTaskWorktreeInternal(context.repoPath, worktreePath);
    await runGit(context.repoPath, ["worktree", "prune"]);
    // fall through to detached
  } else {
    // Step 3: Branch NOT exists — create new branch (creation path)
    const createResult = await runGit(context.repoPath, [
      "worktree", "add", "-b", options.branch, worktreePath, baseCommit,
    ]);
    if (createResult.ok) {
      await prepareNewTaskWorktree(context.repoPath, worktreePath);
      // Apply saved patch if present — same best-effort logic as the existing-branch path.
      // This preserves uncommitted changes when resuming a trashed task whose branch was deleted.
      if (storedPatch) {
        try {
          await applyTaskPatch(storedPatch.path, worktreePath);
          await rm(storedPatch.path, { force: true });
        } catch {
          warning = "Saved task changes could not be reapplied onto the recreated branch.";
        }
      }
      // baseCommit retains its original value (not re-resolved) because `-b` creates the branch
      // at exactly that commit — the worktree HEAD IS baseCommit by construction.
      return { ok: true, path: worktreePath, baseRef: requestedBaseRef, baseCommit, warning };
    }
    // -b failed — clean up partial worktree before fallback
    await removeTaskWorktreeInternal(context.repoPath, worktreePath);
    await runGit(context.repoPath, ["worktree", "prune"]);
    // fall through to detached
  }
}
// Step 4: Existing detached HEAD path continues below (unchanged)...
```

##### 2. Thread Branch from Card to Worktree Creation

Three signatures change to thread the branch value from the persisted card down to worktree creation:

**File**: `src/workspace/task-worktree.ts`
**Action**: Modify

**Location**: `ensureTaskWorktreeIfDoesntExist` options object at line 436-439
**Changes**:
- Add `branch?: string | null` to the options type:
```ts
export async function ensureTaskWorktreeIfDoesntExist(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
	branch?: string | null;  // <-- add
}): Promise<RuntimeWorktreeEnsureResponse> {
```

**Location**: `resolveTaskCwd` options object at line 608-613
**Changes**:
- Add `branch?: string | null` to the options type and pass it through:
```ts
export async function resolveTaskCwd(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
	ensure?: boolean;
	branch?: string | null;  // <-- add
}): Promise<string> {
```
- In the `ensureTaskWorktreeIfDoesntExist` call at line 622, pass `branch: options.branch`:
```ts
const ensured = await ensureTaskWorktreeIfDoesntExist({
	cwd: options.cwd,
	taskId: options.taskId,
	baseRef: normalizedBaseRef,
	branch: options.branch,  // <-- add
});
```

**File**: `src/trpc/runtime-api.ts`
**Action**: Modify
**Location**: `taskSession.start` handler at line ~108-128
**Changes**:
- After `const persisted = existingCard?.workingDirectory ?? null;` (line 111), add:
```ts
const savedBranch = existingCard?.branch ?? null;
```
- In the `resolveTaskCwd` call at line 120-125, pass `branch: savedBranch`:

> **Note**: The `persistedExists` check at `runtime-api.ts:117-118` short-circuits past `resolveTaskCwd` when the worktree already exists on disk. This means `branch` is only threaded through the `resolveTaskCwd` -> `ensureTaskWorktreeIfDoesntExist` path (worktree recreation). This is correct and intentional: when the worktree already exists, there is no branch checkout decision to make — the worktree is already on whatever branch the agent is using, and the metadata monitor will capture it.
```ts
taskCwd = await resolveTaskCwd({
	cwd: workspaceScope.workspacePath,
	taskId: body.taskId,
	baseRef: body.baseRef,
	ensure: true,
	branch: savedBranch,  // <-- add
});
```

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] Tests pass: `npm run test`

##### Behavioral

- [ ] Create a task, let agent create branch `test-branch` and make commits. Trash the task.
- [ ] Resume from trash. Verify the worktree is checked out on `test-branch` (not detached HEAD).
- [ ] Verify committed agent work is present on the branch.
- [ ] If the branch was deleted before resume, verify fallback to detached HEAD + patch works.

**Checkpoint**: Pause here for verification before proceeding to Phase 3.

---

### Phase 3: Create Task with Feature Branch (Opt-In)

#### Overview

Add a "Create feature branch" toggle to the task creation form. When enabled, the worktree is created with a named branch instead of detached HEAD.

#### Changes Required

##### 1. Task Draft — Branch Name Field

**File**: `web-ui/src/state/board-state.ts`
**Action**: Modify
**Location**: `TaskDraft` interface at line 20-28
**Changes**:
- Add `branchName?: string` — the desired branch name at creation time

##### 2. Add Task — Persist Branch Name

The branch name flows through three layers with explicit field mapping:
- `TaskDraft.branchName` (web-ui board state) -> `RuntimeCreateTaskInput.branch` (runtime API contract) -> `RuntimeBoardCard.branch` (persisted card)

**File**: `src/core/task-board-mutations.ts`
**Action**: Modify
**Location**: `RuntimeCreateTaskInput` interface at line 11-22
**Changes**:
- Add `branch?: string` to the interface

**Location**: `addTaskToColumn` function at line 271-321
**Changes**:
- In the `task` object literal (line 291-304), add: `branch: input.branch || undefined,`

**File**: `web-ui/src/state/board-state.ts`
**Action**: Modify
**Location**: `addTaskToColumnWithResult` at line 272-299
**Changes**:
- In the `runtimeTaskState.addTaskToColumn` call (line 281-293), add `branch: draft.branchName` to the input object alongside `prompt`, `baseRef`, etc.

> **IMPORTANT: Coupling note** — Both `addTaskToColumn` in `task-board-mutations.ts` AND `addTaskToColumnWithResult` in `board-state.ts` construct card objects with explicit field lists (no spread from the input). Both MUST be updated to include `branch` or the field is silently dropped. Updating only one side will appear to work but the branch value will be lost.

##### 3. Task Editor Hook — Branch Name State

**File**: `web-ui/src/hooks/use-task-editor.ts`
**Action**: Modify
**Location**: Around line ~100 (state declarations)
**Changes**:
- Add `const [createFeatureBranch, setCreateFeatureBranch] = useState(false)`
- Add `const [branchName, setBranchName] = useState("")`
- In the create handler (~line 286-334): if `createFeatureBranch && branchName`, include `branchName` in the draft. After successful creation, reset `branchName` to `""` but preserve the `createFeatureBranch` toggle state for convenience (the user likely wants to create another branched task)
- In the cancel/reset handler: reset both `branchName` and `createFeatureBranch` to defaults
- Auto-generate branch name from title: when title changes and `createFeatureBranch` is true, update `branchName` with a slugified version (e.g., `quarterdeck/${slugify(title)}`)
- Expose `createFeatureBranch`, `setCreateFeatureBranch`, `branchName`, `setBranchName` in return object

##### 4. Branch Name Slug Utility

**File**: `web-ui/src/utils/branch-utils.ts`
**Action**: Create
**Changes**:
- Add `slugifyBranchName(title: string): string` — lowercase, replace spaces/special chars with hyphens, trim, prefix with `quarterdeck/`, truncate so the total branch name including the `quarterdeck/` prefix does not exceed 60 characters
- No external dependencies needed — simple regex replacement
- Export as named export for use in `use-task-editor.ts` and tests

##### 5. Create Task Dialog — Toggle + Input

**File**: `web-ui/src/components/task-create-dialog.tsx`
**Action**: Modify
**Location**: Options section, after `useWorktree` checkbox (~line 564-589)
**Changes**:
- Place immediately after the `useWorktree` checkbox, inside the same options section
- Only render the "Create feature branch" checkbox when `useWorktree` is checked (feature branches require a worktree). When `useWorktree` is unchecked, hide the toggle and clear `branchName` / reset `createFeatureBranch` to false. **Note**: Toggling `useWorktree` off intentionally clears the custom branch name. Re-enabling `useWorktree` and then `createFeatureBranch` will auto-generate a fresh branch name from the current title.
- Add a Radix checkbox "Create feature branch" with the same styling pattern as `useWorktree`
- When the feature branch checkbox is checked, show an editable text input below it pre-populated with the auto-generated branch name
- **Code Pattern to Follow**: See `useWorktree` checkbox at lines 564-589 and `startInPlanMode` at lines 500-512

##### 6. Worktree Creation — Branch Mode

**File**: `src/workspace/task-worktree.ts`
**Action**: Already implemented in Phase 2
**Changes**:
- No additional code changes needed. The combined branch control flow added in Phase 2 already handles both cases:
  - Branch exists locally -> `git worktree add <path> <branch>` (resume)
  - Branch does NOT exist locally -> `git worktree add -b <branch> <path> <commit>` (creation)
- When a user creates a task with a feature branch name, the card persists `branch` immediately. On session start, the branch won't exist locally yet, so the control flow takes the `-b` (create new branch) path.

##### 7. Thread Branch Name Through Session Start

**File**: `src/trpc/runtime-api.ts`
**Action**: Modify (extends Phase 2 changes)
**Location**: `taskSession.start` handler
**Changes**:
- Read `existingCard?.branch` — already done in Phase 2
- This flows through to `resolveTaskCwd` -> `ensureTaskWorktreeIfDoesntExist`, which now handles both resume (existing branch) and create (new branch via `-b`)

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] Full check passes: `npm run check`
- [ ] Tests pass: `npm run test && npm run web:test`

##### Behavioral

- [ ] Create a task with "Create feature branch" enabled. Verify branch name is auto-suggested from title.
- [ ] Edit the branch name before creating. Verify custom name is used.
- [ ] Start the task. Verify the worktree is on the named branch (not detached HEAD).
- [ ] Run `git branch` in the worktree — the named branch should appear.
- [ ] Create a task WITHOUT the toggle. Verify current detached HEAD behavior is unchanged.

---

## Error Handling

| Scenario | Expected Behavior | How to Verify |
|----------|------------------|---------------|
| Branch checkout fails (locked by another worktree) | Fall back to detached HEAD + patch | Delete worktree but keep branch ref, try resume |
| Branch no longer exists locally | Fall back to detached HEAD + patch | Delete branch, try resume |
| `git worktree add -b` fails (unexpected error) | Fall back to `git worktree add --detach` | Simulate by making the worktree path temporarily unwritable |
| Branch already exists when `-b` attempted | Not possible — the control flow checks existence first and routes to the checkout path | N/A — the existence check at step 1 prevents this |
| Slugified branch name is empty (title is all special chars) | Don't set `branchName` on draft — effectively no branch | Type a title like "!!!" and enable feature branch toggle |
| Metadata monitor returns `null` branch (detached HEAD) | Do NOT overwrite a previously captured non-null branch on the card | Let agent work on a branch, then detach HEAD manually |

## Rollback Strategy

- **Phase 1 rollback**: Remove `branch` field from schema. Existing persisted board state with the field will be silently dropped by `normalizeCard` (returns `undefined` for unknown fields).
- **Phase 2 rollback**: Revert the branch checkout path in `ensureTaskWorktreeIfDoesntExist`. Resume falls back to existing detached HEAD + patch behavior.
- **Phase 3 rollback**: Remove the toggle/input from the create dialog and `branchName` from `TaskDraft`. Tasks create with detached HEAD as before.
- **Full rollback**: Revert all phases. No data migration needed — the `branch` field is optional and ignored if the code doesn't read it.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Branch locked by stale worktree registration | Low | Low | `git worktree prune` already runs before creation (line 513); fallback to detached HEAD |
| Agent detaches HEAD mid-work, nulling out branch | Medium | Low | Reconcile only updates branch when incoming value is non-empty string |
| Branch name slug collision (two tasks with same title) | Low | Low | Second task's `git worktree add -b` fails, falls back to detached HEAD; user can edit name |
| Persisted branch name becomes stale (branch deleted externally) | Medium | Low | Resume checks `refs/heads/<branch>` before attempting checkout; fallback to detached HEAD |

## Implementation Notes / Gotchas

- **Single-writer rule**: The `branch` field MUST be written by the client via the reconcile pattern. Never call `mutateWorkspaceState` to set `branch` from the server when a UI client is connected.
- **Don't clear branch on trash**: Unlike `workingDirectory` (cleared in `task-board-mutations.ts:537`), `branch` must survive trashing — it's the whole point.
- **Reconcile guard**: Only update `branch` when the incoming metadata value is a non-empty string. Don't overwrite `"feat/foo"` with `null` just because the worktree is temporarily in detached HEAD state.
- **`-b` vs checkout**: `git worktree add -b <name> <path> <commit>` creates a NEW branch. `git worktree add <path> <name>` checks out an EXISTING branch. Phase 2 uses the latter (resume), Phase 3 uses the former (create). The code must distinguish between these.
- **Invalid branch names**: If the user edits the branch name in the create dialog to include invalid git ref characters (e.g., spaces, `..`, `~`, `^`, `:`, `\`), the `git worktree add -b` command will fail and the detached HEAD fallback handles it gracefully. No client-side validation of git ref syntax is required for v1 — the slug utility produces valid names by default, and manual edits that break naming are caught by the git fallback.
- **Biome formatting**: Indent with tabs, width 3, line width 120.

## References

- **GitHub Issue**: #3
- **Research**: `docs/research/2026-04-07-branch-persistence-on-cards.md`
- **Prior art (workingDirectory pattern)**: `web-ui/src/state/board-state.ts:517-548`, `web-ui/src/App.tsx:195-256`
- **Prior art (task_title_updated broadcast)**: `src/core/api-contract.ts:379-386`, `src/server/runtime-state-hub.ts:256-276`
- **Test Spec**: `docs/specs/2026-04-07-3-branch-persistence-on-cards-tests.md`
