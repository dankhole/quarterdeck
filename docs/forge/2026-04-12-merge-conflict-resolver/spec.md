# Merge/Rebase Conflict Resolver — Implementation Specification

**Date**: 2026-04-12
**Branch**: TBD
**Ticket**: None
**Adversarial Review Passes**: 2
**Test Spec**: [test-spec.md](test-spec.md)

<!-- Raw Intent (preserved for traceability, not for implementation agents):
User wants merge/rebase conflict resolution in Quarterdeck. Today conflicts auto-abort and the user gets nothing. MVP: pause on conflict, show which files conflict, let user accept ours/theirs per-file or resolve manually in terminal, continue or abort. Support both merge and rebase (including multi-round rebase). Hijack the file-changes area in GitView. Make abort always visible with clear messaging. Detect in-progress conflicts on app reopen.
-->

## Goal

Add merge and rebase conflict resolution to Quarterdeck. Today, any merge that produces conflicts is immediately auto-aborted. The user should instead see a conflict resolution panel listing conflicted files with ours-vs-theirs previews, per-file resolution actions (accept ours, accept theirs, resolve manually), progress tracking, and the ability to continue or abort the operation. Both merge and rebase conflicts are supported, including multi-round rebase where new conflicts appear after continuing.

## Behavioral Change Statement

> **BEFORE**: Merge hits conflict → `git merge --abort` fires automatically → user sees error toast. No rebase support exists at all.
> **AFTER**: Merge or rebase hits conflict → operation pauses → GitView Uncommitted area replaced by a conflict resolution panel → user resolves per-file → continue completes the operation or (for rebase) may surface more conflicts → abort rolls back cleanly.
> **SCOPE — all code paths affected**:
> 1. **Merge trigger (home)**: `branch-selector-popover.tsx:348` → `use-branch-actions.ts:146` → `app-router.ts:430` → `workspace-api.ts:307` → `git-sync.ts:405-409` (auto-abort)
> 2. **Merge trigger (task)**: `card-detail-view.tsx:433` → same `use-branch-actions.ts:146` path with `taskId` → same `git-sync.ts:405-409`
> 3. **Metadata polling**: `workspace-metadata-monitor.ts:282-305` — computes `hasUnmergedChanges` (branch divergence, NOT conflicts). No detection of `.git/MERGE_HEAD` or `.git/rebase-merge/`.
> 4. **GitView Uncommitted**: `git-view.tsx:281` → `use-runtime-workspace-changes.ts` → `workspace-api.ts:loadChanges` → `get-workspace-changes.ts:55-63` — `mapNameStatus` maps `U` (unmerged) to `"unknown"`.
> 5. **File status schema**: `api-contract.ts:3-11` — `runtimeWorkspaceFileStatusSchema` has no `"conflicted"` value.
> 6. **Probe state**: `git-sync.ts:166` — `probeGitWorkspaceState` counts `u ` entries as `changedFiles` but no conflict flag.

## Hard Behavioral Constraints

### !1 — Never auto-abort on conflict

When a merge or rebase produces conflicts, the operation MUST pause in the conflicted state. The current `git merge --abort` at `git-sync.ts:409` must be removed. The only path to abort is the user clicking "Abort merge/rebase" in the UI.

### !2 — Conflict panel replaces normal GitView content when active

When a merge or rebase conflict is active, the GitView Uncommitted area MUST show the conflict resolution panel instead of the normal file tree + diff. The normal tabs (Uncommitted, Last Turn, Compare) are hidden during conflict resolution. The panel includes a clear banner identifying the operation type ("Merge in progress" / "Rebase in progress").

### !3 — Per-file resolution: ours, theirs, or manual

Each conflicted file offers exactly three actions: "Accept Ours" (`git checkout --ours <file> && git add <file>`), "Accept Theirs" (`git checkout --theirs <file> && git add <file>`), and "Resolve Manually" (user edits in terminal, file becomes resolved when `git add`ed). No inline editing of conflict markers in the UI.

### !4 — Abort always available with explicit messaging

An "Abort" button is always visible during conflict resolution. Its label/tooltip states what happens: "Abort merge — discards all resolutions and returns to pre-merge state" / "Abort rebase — discards ALL resolutions (including previously completed rounds) and returns to pre-rebase state".

### !5 — Rebase multi-round support

After the user resolves all files in a rebase round and clicks "Continue", `git rebase --continue` may surface new conflicts from the next commit. The conflict panel MUST refresh with the new set of conflicted files. Progress shows "Resolving commit N of M" when available.

### !6 — Conflict detection on app reopen

If Quarterdeck closes while a merge/rebase is in progress, the conflict panel MUST appear immediately on reopen. Detection is via `.git/MERGE_HEAD` (merge) or `.git/rebase-merge/` directory (rebase) existence, checked during metadata polling.

### !7 — Ours-vs-theirs preview uses git index stages

Conflict file previews show ours content (`git show :2:<path>`) vs theirs content (`git show :3:<path>`), NOT the raw conflict-marker text from the working tree. This provides a clean diff the user can understand.

## Functional Verification

| # | What to do | Expected result | Code path verified |
|---|-----------|----------------|-------------------|
| 1 | Trigger a merge that produces a conflict (right-click branch → "Merge into current" where files differ) | Conflict resolution panel appears in GitView area. Banner: "Merge in progress". File list shows conflicted files. Normal tabs hidden. | Path 1, 2 |
| 2 | Click a conflicted file in the panel | Right pane shows ours-vs-theirs diff using existing diff renderer. "Ours" = left, "Theirs" = right. | Path 4, 5 |
| 3 | Click "Accept Ours" on a conflicted file | File status changes to "resolved". Progress indicator updates (e.g., "1 of 3 resolved"). | Path 1 |
| 4 | Click "Accept Theirs" on a conflicted file | Same as #3 but file content matches theirs version. | Path 1 |
| 5 | Click "Resolve Manually" on a conflicted file | Toast tells user to edit the file and run `git add` in terminal. File stays in list until metadata poll detects it's been staged. | Path 3, 6 |
| 6 | Resolve all conflicted files → click "Complete Merge" | Merge commit created. Conflict panel disappears. Normal GitView returns. Toast confirms merge. | Path 1 |
| 7 | Click "Abort Merge" with some files resolved | All resolutions discarded. Pre-merge state restored. Conflict panel disappears. Normal GitView returns. | Path 1 |
| 8 | Trigger a rebase that produces conflicts | Conflict panel appears. Banner: "Rebase in progress — commit 1 of N". Same file list and actions. | New rebase path |
| 9 | Resolve all files in rebase round 1 → click "Continue Rebase" → next commit has conflicts | Panel refreshes with new conflicted files. Banner: "Rebase in progress — commit 2 of N". | Path 5 constraint |
| 10 | Abort rebase mid-way (after resolving some rounds) | All rounds discarded. Pre-rebase state restored. Panel disappears. | Path 4 constraint |
| 11 | Close Quarterdeck while merge is in progress → reopen | Conflict panel appears immediately. Can continue resolving or abort. | Path 3, 6 |
| 12 | Trigger a merge with NO conflicts | Merge completes normally. No conflict panel. Toast confirms success. (Regression) | Path 1 |
| 13 | While conflict panel is active, workspace metadata polling continues | Metadata detects when manually-resolved files are staged. Progress updates automatically. | Path 3, 6 |

## Current State

- `src/workspace/git-sync.ts:405-409` — `runGitMergeAction`: runs `git merge --no-edit`, auto-aborts on failure with `git merge --abort`.
- `src/workspace/git-sync.ts:117-205` — `probeGitWorkspaceState`: parses porcelain v2, counts `u ` entries as `changedFiles` but no conflict flag.
- `src/workspace/get-workspace-changes.ts:55-63` — `mapNameStatus`: maps git status codes; `U` falls through to `"unknown"`.
- `src/server/workspace-metadata-monitor.ts:282-305` — `hasUnmergedChanges`: three-dot merge-base diff (branch divergence), NOT active conflicts.
- `src/core/api-contract.ts:3-11` — `runtimeWorkspaceFileStatusSchema`: no `"conflicted"` value.
- `src/core/api-contract.ts:228-235` — `runtimeGitMergeResponseSchema`: `{ok, branch, summary, output, error?}` — no conflict fields.
- `src/core/api-contract.ts:358-373` — `RuntimeTaskWorkspaceMetadata`: has `hasUnmergedChanges` (misleading name, means branch divergence).
- `web-ui/src/hooks/use-branch-actions.ts:146-167` — `handleMergeBranch`: calls mutate, shows toast on ok/error. No conflict handling.
- `web-ui/src/components/git-view.tsx:410-524` — `GitView` render: tabs + file tree + diff viewer. No conditional for conflict state.
- No rebase function, endpoint, or UI exists anywhere in the codebase.

## Desired End State

- Merge conflicts pause the operation and surface a conflict resolution panel
- Rebase is a supported operation with the same conflict resolution flow
- Users can resolve per-file (accept ours/theirs) or escape to terminal for manual resolution
- Conflict state persists across app restarts — reopening detects and resurfaces the panel
- Progress tracking shows resolved/total files and rebase commit progress
- Abort is always available with explicit consequences messaging
- Clean merges/rebases continue to work exactly as before (merge) or newly work (rebase)

## Out of Scope

- Inline editing of conflict markers in the UI
- Three-way diff (base/ours/theirs) — only ours-vs-theirs
- Per-hunk resolution (granularity is per-file)
- Cherry-pick conflict resolution
- Auto-merge (git already does this — only conflicted files reach the panel)
- Triggering rebase from the UI (can be added later — this spec handles conflict resolution when rebase happens via terminal or future UI)

## Dependencies

- **Teams**: None
- **Services**: None (pure git operations)
- **Data**: None
- **Timing**: None

## New Dependencies & Configuration

No new packages needed. All required functionality exists in the current stack.

| Dependency | Version | Already in project? | Why needed |
|-----------|---------|-------------------|------------|
| `diff` | 8.0.3 | Yes (web-ui) | Diff rendering for ours-vs-theirs |

**Configuration changes**: None. No new config fields required.

## Architecture & Approach

The conflict resolver slots into existing infrastructure at every layer:

- **Git layer** (`git-sync.ts`): New functions alongside existing ones. Stop auto-aborting, add conflict file listing via `git ls-files -u` + `git show :2:/:3:` for ours/theirs content, add resolve/continue/abort operations.
- **Metadata layer** (`workspace-metadata-monitor.ts`): Add `.git/MERGE_HEAD` and `.git/rebase-merge/` existence checks to polling cycle. New fields on `RuntimeTaskWorkspaceMetadata`.
- **API layer** (`app-router.ts`, `workspace-api.ts`): New tRPC mutations following existing `workspaceProcedure` pattern.
- **UI layer** (`git-view.tsx` + new hook + new panel component): When conflict metadata is active, GitView conditionally renders the conflict panel instead of normal tabs.

### Design Decisions

| Decision | Choice | Rationale | Alternative Considered | Implementation Constraint |
|----------|--------|-----------|----------------------|--------------------------|
| Conflict detection | Check `.git/MERGE_HEAD` and `.git/rebase-merge/` in metadata polling | Handles reopen-mid-conflict for free; already polling every 2-10s | Dedicated WebSocket event only | Metadata schema MUST include conflict state fields |
| Ours/theirs content | `git show :2:<path>` / `git show :3:<path>` | Clean content without conflict markers; standard git index stages | Parse conflict markers from working tree | MUST NOT show raw conflict-marker text as the diff |
| Conflict panel location | Conditional render inside GitView | Reuses file tree + diff viewer infrastructure; natural location | New main view or modal | MUST replace normal GitView content, not overlay |
| Rebase trigger | No UI trigger in this spec | Rebase is a more advanced operation; resolution is the priority | Add rebase button to branch popover | Spec covers resolution only; future spec for rebase trigger |
| Immediate vs polled detection | Merge/rebase response returns conflict data immediately; metadata polling catches stale state | Instant feedback after user action; polling for reopen and manual resolution | Polling only (2-10s delay) | Merge response MUST include conflict data; metadata MUST also detect it |

## Interface Contracts

### New Zod Schemas (api-contract.ts)

```typescript
// Conflict file info returned by content fetch (only for unresolved files)
export const runtimeConflictFileSchema = z.object({
   path: z.string(),
   oursContent: z.string(),    // git show :2:<path>
   theirsContent: z.string(),  // git show :3:<path>
});
export type RuntimeConflictFile = z.infer<typeof runtimeConflictFileSchema>;

// Active conflict state — part of metadata
// NOTE: Only tracks currently-unresolved files. Once a file is `git add`ed, it
// disappears from `git ls-files -u` and the server has no memory of the original
// conflict set. Resolved-file tracking is done client-side in the hook.
export const runtimeConflictStateSchema = z.object({
   operation: z.enum(["merge", "rebase"]),
   sourceBranch: z.string().nullable(),       // branch being merged/rebased
   currentStep: z.number().int().nullable(),   // rebase: current commit number
   totalSteps: z.number().int().nullable(),    // rebase: total commits
   conflictedFiles: z.array(z.string()),       // paths still unresolved (from git ls-files -u)
});
export type RuntimeConflictState = z.infer<typeof runtimeConflictStateSchema>;

// Extended merge response
export const runtimeGitMergeResponseSchema = z.object({
   ok: z.boolean(),
   branch: z.string(),
   summary: runtimeGitSyncSummarySchema,
   output: z.string(),
   error: z.string().optional(),
   conflictState: runtimeConflictStateSchema.optional(), // present when ok=false and conflicts exist
});

// Conflict resolution request
export const runtimeConflictResolveRequestSchema = z.object({
   taskId: z.string().optional(),
   path: z.string(),
   resolution: z.enum(["ours", "theirs"]),
});

// Continue merge/rebase request
export const runtimeConflictContinueRequestSchema = z.object({
   taskId: z.string().optional(),
});

// Continue response — may have new conflicts (rebase)
export const runtimeConflictContinueResponseSchema = z.object({
   ok: z.boolean(),
   completed: z.boolean(),          // true if operation finished
   conflictState: runtimeConflictStateSchema.optional(), // present if new conflicts
   summary: runtimeGitSyncSummarySchema,
   output: z.string(),
   error: z.string().optional(),
});

// Abort request
export const runtimeConflictAbortRequestSchema = z.object({
   taskId: z.string().optional(),
});

// Abort response
export const runtimeConflictAbortResponseSchema = z.object({
   ok: z.boolean(),
   summary: runtimeGitSyncSummarySchema,
   error: z.string().optional(),
});

// Get conflict files with content
export const runtimeConflictFilesRequestSchema = z.object({
   taskId: z.string().optional(),
   paths: z.array(z.string()),   // which files to get content for
});
export const runtimeConflictFilesResponseSchema = z.object({
   ok: z.boolean(),
   files: z.array(runtimeConflictFileSchema),
   error: z.string().optional(),
});
```

### New tRPC Mutations (app-router.ts)

| Procedure | Input | Output | Description |
|-----------|-------|--------|-------------|
| `workspace.getConflictFiles` | `runtimeConflictFilesRequestSchema` | `runtimeConflictFilesResponseSchema` | Get ours/theirs content for specific conflicted files |
| `workspace.resolveConflictFile` | `runtimeConflictResolveRequestSchema` | `{ok, error?}` | Accept ours or theirs for a single file |
| `workspace.continueConflictResolution` | `runtimeConflictContinueRequestSchema` | `runtimeConflictContinueResponseSchema` | Continue merge (commit) or rebase (--continue) |
| `workspace.abortConflictResolution` | `runtimeConflictAbortRequestSchema` | `runtimeConflictAbortResponseSchema` | Abort merge or rebase |

### Extended Metadata Schema

```typescript
// Add to runtimeTaskWorkspaceMetadataSchema:
conflictState: runtimeConflictStateSchema.nullable(),  // null = no active conflict

// Add to runtimeWorkspaceMetadataSchema (for home repo conflicts):
homeConflictState: runtimeConflictStateSchema.nullable(),  // null = no active conflict
```

### Extended File Status

```typescript
// Add to runtimeWorkspaceFileStatusSchema:
export const runtimeWorkspaceFileStatusSchema = z.enum([
   "modified", "added", "deleted", "renamed", "copied", "untracked", "conflicted", "unknown",
]);
```

## Implementation Phases

### Phase 1: Schema & Git Conflict Operations

#### Overview

Add all new types to api-contract.ts and implement the core git conflict functions in git-sync.ts. This is the foundation — no UI or API wiring yet, but fully testable in isolation.

#### Changes Required

##### 1. File Status Schema Extension

**File**: `src/core/api-contract.ts`
**Action**: Modify
**Location**: `runtimeWorkspaceFileStatusSchema` at L3-11
**Changes**:
- Add `"conflicted"` to the enum values

##### 2. Conflict State Schema

**File**: `src/core/api-contract.ts`
**Action**: Modify
**Location**: After `runtimeGitMergeResponseSchema` (L228)
**Changes**:
- Add `runtimeConflictFileSchema`, `runtimeConflictStateSchema`, `runtimeConflictResolveRequestSchema`, `runtimeConflictContinueRequestSchema`, `runtimeConflictContinueResponseSchema`, `runtimeConflictAbortRequestSchema`, `runtimeConflictAbortResponseSchema`, `runtimeConflictFilesRequestSchema`, `runtimeConflictFilesResponseSchema` as defined in Interface Contracts above
- Extend `runtimeGitMergeResponseSchema` with optional `conflictState` field
- Add `conflictState: runtimeConflictStateSchema.nullable()` to `runtimeTaskWorkspaceMetadataSchema` (L358)
- Add `homeConflictState: runtimeConflictStateSchema.nullable()` to `runtimeWorkspaceMetadataSchema` (L375)

##### 3. Stop Auto-Aborting Merge

**File**: `src/workspace/git-sync.ts`
**Action**: Modify
**Location**: `runGitMergeAction` at L405-418
**Changes**:
- After `git merge --no-edit` fails, check if it's a conflict (vs other error): run `git ls-files -u` — if output is non-empty, it's a conflict
- If conflict: do NOT abort. Instead, call `getConflictState(repoRoot, {operation: "merge", sourceBranch: branchToMerge})` to build a `RuntimeConflictState` and return `{ok: false, conflictState, ...}`
- If not a conflict (other merge error): still abort as before

**Code Pattern to Follow**: The existing `runGitMergeAction` return structure at `git-sync.ts:411-417` — extend it, don't restructure.

**Note**: After this change, `runGitMergeAction` already returns `conflictState` in its response. The existing tRPC `mergeBranch` endpoint at `app-router.ts:430` passes through the full response shape, so conflict data flows to the caller immediately after Phase 1. Phase 3 adds broadcasting and additional endpoints, but the merge response itself works end-to-end after Phase 1.

##### 4. Conflict Detection & Resolution Functions

**File**: `src/workspace/git-sync.ts`
**Action**: Modify (add functions)
**Location**: After `runGitMergeAction` (L427)
**Changes**:
- `detectActiveConflict(cwd)`: Check for `.git/MERGE_HEAD` (merge) or `.git/rebase-merge/` (rebase). Return `{operation, sourceBranch}` or `null`. For rebase, read `.git/rebase-merge/msgnum` and `.git/rebase-merge/end` for current/total step counts. For merge, read `.git/MERGE_MSG` to extract source branch name.
- `getConflictedFiles(cwd)`: Run `git ls-files -u`, parse output to get unique file paths with unresolved conflicts. Output format is tab-delimited: `<mode> <object> <stage>\t<path>` — parse the path from after the tab, deduplicate (each conflicted file has up to 3 stage entries). Returns string array of currently-unresolved paths. Files that have been `git add`ed no longer appear in `ls-files -u` output — resolved-file tracking is handled client-side.
- `getConflictFileContent(cwd, path)`: Run `git show :2:<path>` (ours) and `git show :3:<path>` (theirs). Return `{path, oursContent, theirsContent}`. Only call for files still in `git ls-files -u` — once resolved, index stages 2 and 3 are gone.
- `getConflictState(cwd, overrides?: {operation?, sourceBranch?})`: Compose `RuntimeConflictState` by calling `detectActiveConflict(cwd)` + `getConflictedFiles(cwd)`. When called from `runGitMergeAction`, pass `overrides` with the known operation and branch to avoid re-detecting. When called from metadata polling (no overrides), auto-detects everything from git state.
- `resolveConflictFile(cwd, path, resolution)`: If `"ours"`: `git checkout --ours -- <path> && git add -- <path>`. If `"theirs"`: `git checkout --theirs -- <path> && git add -- <path>`. Return `{ok, error?}`.
- `continueMergeOrRebase(cwd)`: Detect operation type. For merge: `git commit --no-edit` (merge commit). For rebase: `git -c core.editor=true rebase --continue` (the `core.editor=true` or env `GIT_EDITOR=true` prevents git from opening an interactive editor for the commit message). If rebase produces new conflicts, return the new conflict state. Return `RuntimeConflictContinueResponse`.
- `abortMergeOrRebase(cwd)`: Detect operation type. Run `git merge --abort` or `git rebase --abort`. Return `{ok, summary, error?}`.

##### 5. Map Unmerged Status Code

**File**: `src/workspace/get-workspace-changes.ts`
**Action**: Modify
**Location**: `mapNameStatus` at L55-63
**Changes**:
- Add: `if (kind === "U") return "conflicted";`

##### 6. Handle Unmerged in Probe

**File**: `src/workspace/git-sync.ts`
**Action**: Modify
**Location**: `probeGitWorkspaceState` at L166
**Changes**:
- When `u ` prefix lines are encountered, count them in a new `unmergedFiles` field on the return type (in addition to the existing `changedFiles` increment).

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run typecheck`
- [ ] Tests pass: `npm run test:fast`

##### Behavioral

- [ ] New git functions can be called from a test with a real git repo that has conflicts
- [ ] `detectActiveConflict` correctly identifies merge vs rebase state
- [ ] `getConflictedFiles` returns the right paths
- [ ] `resolveConflictFile` with "ours"/"theirs" actually resolves the file
- [ ] `continueMergeOrRebase` completes a merge or surfaces new rebase conflicts
- [ ] `abortMergeOrRebase` cleanly restores pre-operation state

**Checkpoint**: Pause here for verification before proceeding to Phase 2.

---

### Phase 2: Metadata Detection & WebSocket Broadcasting

#### Overview

Wire conflict detection into the metadata polling cycle so the UI can reactively discover conflict state. This handles the "reopen mid-conflict" scenario and the "resolve manually then metadata catches it" flow.

#### Changes Required

##### 1. Conflict State in Metadata Polling

**File**: `src/server/workspace-metadata-monitor.ts`
**Action**: Modify
**Location**: `loadTaskWorkspaceMetadata` around L282-305
**Changes**:
- After the existing `Promise.all` that computes summary/unmerged/treeDiff/behindBase, call `detectActiveConflict(pathInfo.path)` to check for active conflict
- If conflict detected, also call `getConflictedFiles(pathInfo.path)` to get the file list
- Include the result as `conflictState` in the returned metadata object

**Code Pattern to Follow**: The existing `hasUnmergedChanges` computation at L300-305 — add `conflictState` alongside it.

**IMPORTANT — update equality comparator**: `areTaskMetadataEqual` (L115-131) compares metadata field-by-field to suppress redundant broadcasts. After adding `conflictState` to the metadata object, this function MUST also compare `conflictState` — without it, metadata broadcasts will never fire when a task's conflict state changes, breaking conflict detection. Compare by checking `operation` + `conflictedFiles` array equality (same length + same elements) + `currentStep` + `totalSteps`, or by JSON-serializing both values. A null-safe helper `areConflictStatesEqual(a, b)` is recommended since the field is nullable.

##### 2. Home Repo Conflict Detection

**File**: `src/server/workspace-metadata-monitor.ts`
**Action**: Modify
**Location**: `CachedHomeGitMetadata` interface (L27-31), `loadHomeGitMetadata` function (L191-206), `buildWorkspaceMetadataSnapshot` (L181-189)
**Changes**:
- **Extend `CachedHomeGitMetadata`** (L27-31) to include `conflictState: RuntimeConflictState | null`. Without this field, there is nowhere to cache the detected conflict state between polls — `buildWorkspaceMetadataSnapshot` has nothing to read, and `loadHomeGitMetadata` has nowhere to write. Import `RuntimeConflictState` from `../core/api-contract`. Initialize to `null` in `createWorkspaceEntry` (L171-175).
- In `loadHomeGitMetadata`, call `detectActiveConflict(entry.workspacePath)` and if detected, also call `getConflictedFiles(entry.workspacePath)`. Store the result as `conflictState` in the returned `CachedHomeGitMetadata`.
- In `buildWorkspaceMetadataSnapshot`, include `homeConflictState: entry.homeGit.conflictState` in the returned `RuntimeWorkspaceMetadata` object (maps to the new `homeConflictState` schema field added in Phase 1).
- Update `areWorkspaceMetadataEqual` (L133-151) to compare `homeConflictState` — reuse the `areConflictStatesEqual` helper from item 1 above. Without this, metadata broadcasts won't fire when conflict state changes.
- Update `createEmptyWorkspaceMetadata` (L153-159) to include `homeConflictState: null`.

##### 3. Metadata Schema Already Extended (Phase 1)

The `conflictState` field was added to `runtimeTaskWorkspaceMetadataSchema` in Phase 1. No additional schema changes needed.

##### 4. Frontend Metadata Store

**File**: `web-ui/src/types/board.ts`
**Action**: Modify
**Location**: `ReviewTaskWorkspaceSnapshot` interface (L53-64)
**Changes**:
- Add `conflictState: RuntimeConflictState | null` to the `ReviewTaskWorkspaceSnapshot` interface
- Import `RuntimeConflictState` from `@/runtime/types`

**File**: `web-ui/src/stores/workspace-metadata-store.ts`
**Action**: Modify
**Location**: `toTaskWorkspaceSnapshot` function (L65-78), snapshot equality check
**Changes**:
- Map `conflictState` from `RuntimeTaskWorkspaceMetadata` into the snapshot
- Update the equality check to compare `conflictState` (deep-compare `conflictedFiles` array)
- Export a `useConflictState(taskId)` hook that returns the current conflict state for a task (or null)

##### 5. Home Conflict State Hook

**File**: `web-ui/src/stores/workspace-metadata-store.ts`
**Action**: Modify
**Changes**:
- Export a `useHomeConflictState()` hook that returns conflict state for the home repo (or null)

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run typecheck`
- [ ] Tests pass: `npm run test:fast`

##### Behavioral

- [ ] Create a git repo with conflicts, point metadata monitor at it → `conflictState` populated in metadata
- [ ] Resolve all conflicts externally, monitor next poll → `conflictState` becomes null
- [ ] Reopen scenario: start with a repo already in conflict state → first metadata poll returns conflict info

**Checkpoint**: Pause here for verification before proceeding to Phase 3.

---

### Phase 3: tRPC API Endpoints

#### Overview

Expose conflict operations via tRPC mutations, following the existing `workspaceProcedure` pattern. The UI will call these to resolve files, continue, and abort.

#### Changes Required

##### 1. Workspace API Methods

**File**: `src/trpc/workspace-api.ts`
**Action**: Modify
**Location**: After existing `mergeBranch` method (~L356)
**Changes**:
- `getConflictFiles(input)`: Resolve cwd from taskId, call `getConflictFileContent` for each path, return `RuntimeConflictFilesResponse`.
- `resolveConflictFile(input)`: Resolve cwd, call `resolveConflictFile` from git-sync, broadcast metadata update.
- `continueConflictResolution(input)`: Resolve cwd, call `continueMergeOrRebase` from git-sync. If completed, broadcast workspace state update. If new conflicts, broadcast metadata update. Return response.
- `abortConflictResolution(input)`: Resolve cwd, call `abortMergeOrRebase` from git-sync, broadcast workspace state update.

**Code Pattern to Follow**: `mergeBranch` at `workspace-api.ts:307-356` — same cwd resolution, same broadcast pattern.

##### 2. tRPC Router Procedures

**File**: `src/trpc/app-router.ts`
**Action**: Modify
**Location**: After `mergeBranch` route (~L435)
**Changes**:
- Add four new `workspaceProcedure` routes: `getConflictFiles`, `resolveConflictFile`, `continueConflictResolution`, `abortConflictResolution`
- Each uses `.input(schema).output(schema).mutation(async ({ ctx, input }) => ctx.workspaceApi.method(input))`

##### 3. Update Merge Handler

**File**: `src/trpc/workspace-api.ts`
**Action**: Modify
**Location**: `mergeBranch` handler around L340-355
**Changes**:
- When `runGitMergeAction` returns `{ok: false, conflictState: ...}`, broadcast metadata update (so UI reacts to conflict state) instead of just returning error.

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run typecheck`
- [ ] Tests pass: `npm run test:fast`

##### Behavioral

- [ ] tRPC `getConflictFiles` returns ours/theirs content for conflicted files
- [ ] tRPC `resolveConflictFile` with "ours" resolves the file
- [ ] tRPC `continueConflictResolution` completes a merge
- [ ] tRPC `abortConflictResolution` restores clean state
- [ ] After resolution/abort, workspace metadata broadcast fires

**Checkpoint**: Pause here for verification before proceeding to Phase 4.

---

### Phase 4: Conflict Resolution UI

#### Overview

Build the frontend conflict resolution panel and integrate it into GitView. This is the user-facing layer — all backend infrastructure is in place from Phases 1-3.

#### Changes Required

##### 1. Conflict Resolution Hook

**File**: `web-ui/src/hooks/use-conflict-resolution.ts` (NEW)
**Action**: Add
**Changes**:
- `useConflictResolution(taskId, projectId)` hook that:
  - Reads conflict state from metadata store: when `taskId` is non-null, use `useConflictState(taskId)`; when `taskId` is null (home repo scope), use `useHomeConflictState()`. The hook must call both hooks unconditionally (React rules of hooks) and select the appropriate value based on `taskId`.
  - Provides `conflictFiles` (loaded via `trpc.workspace.getConflictFiles`)
  - Provides `resolveFile(path, resolution)` → calls `trpc.workspace.resolveConflictFile.mutate`
  - Provides `continueResolution()` → calls `trpc.workspace.continueConflictResolution.mutate`
  - Provides `abortResolution()` → calls `trpc.workspace.abortConflictResolution.mutate`
  - Tracks loading/error states for each operation
  - Tracks `resolvedFiles` client-side: when `conflictState.conflictedFiles` shrinks between metadata polls (a file disappeared from `ls-files -u`), the hook moves that path into a local `resolvedFiles` set. When the user calls `resolveFile()`, add the path to `resolvedFiles` optimistically. Reset `resolvedFiles` on abort, when `conflictState` becomes null, **or when `conflictState.currentStep` changes** (rebase advancing to the next commit). The same file path can conflict in multiple rebase rounds — without resetting on step change, files resolved in round N would incorrectly show as "resolved" in round N+1. Track the previous `currentStep` value via a `useRef` and compare on each render/effect.
  - Exposes `selectedPath` / `setSelectedPath` for file selection
  - Reloads conflict files when conflict state changes (metadata poll detects manual resolution)
  - Returns `{ isActive, conflictState, conflictFiles, resolvedFiles, selectedPath, setSelectedPath, resolveFile, continueResolution, abortResolution, isLoading }`

**Code Pattern to Follow**: `use-commit-panel.ts:28-257` — same hook+component split, same tRPC mutation pattern.

##### 2. Conflict Resolution Panel Component

**File**: `web-ui/src/components/detail-panels/conflict-resolution-panel.tsx` (NEW)
**Action**: Add
**Changes**:
- Renders when `useConflictResolution.isActive` is true
- **Banner**: Top bar with operation type and status. Merge: "Merge in progress — N conflicts remaining". Rebase: "Rebase in progress — commit N of M — N conflicts remaining". Background color: `bg-status-orange/10` with `border-status-orange` accent.
- **Action bar**: "Abort [Merge/Rebase]" button (danger variant, always visible). "Complete [Merge/Rebase]" button (primary variant, enabled when all files resolved).
- **File list** (left pane): Reuses `FileTreePanel` pattern. Each file shows path + resolution status (unresolved: orange conflict icon, resolved: green check). Clicking selects the file.
- **File detail** (right pane): When a file is selected:
  - If unresolved: shows ours-vs-theirs diff. Construct a single-element `RuntimeWorkspaceFileChange[]` array with `{path, status: "conflicted", oldText: oursContent, newText: theirsContent, additions: 0, deletions: 0}` and pass to `DiffViewerPanel` with `selectedPath` set, `comments` as an empty Map, and `onCommentsChange` as a no-op. The panel handles the single file naturally — header/expand/collapse are minimal overhead for one entry. Below the diff, three buttons: "Accept Ours", "Accept Theirs", "Resolve Manually".
  - If resolved: shows the resolved content as a normal diff (vs base or just the content).
- **Progress**: "N of M files resolved" text near the action bar.

**Code Pattern to Follow**: 
- File tree: `file-tree-panel.tsx:1-131`
- Diff viewer: `diff-viewer-panel.tsx` — pass `workspaceFiles` with `oursContent`/`theirsContent` mapped to `oldText`/`newText`
- Banner styling: similar to the compare bar in `git-view.tsx:449-461`
- Button patterns: `Button` from `@/components/ui/button` with `variant="danger"` for abort, `variant="primary"` for continue

##### 3. GitView Integration

**File**: `web-ui/src/components/git-view.tsx`
**Action**: Modify
**Location**: Render section at L410-524
**Changes**:
- Import and call `useConflictResolution` hook at the top of GitView
- Before the normal tab bar + content, add a conditional: if `conflictResolution.isActive`, render `<ConflictResolutionPanel>` instead of the entire normal layout (tabs + content)
- Pass all hook state to the panel component as props

##### 4. Branch Actions — Handle Conflict Response

**File**: `web-ui/src/hooks/use-branch-actions.ts`
**Action**: Modify
**Location**: `handleMergeBranch` at L146-167
**Changes**:
- After `trpc.workspace.mergeBranch.mutate`, check if response has `conflictState`
- If conflict: show an informational toast ("Merge has conflicts — resolve in the Git view") and switch to GitView. Do NOT show error toast.
- Existing success/error paths unchanged

##### 5. Conflict Status Badge in File Tree

**File**: `web-ui/src/components/detail-panels/file-tree-panel.tsx`
**Action**: Modify
**Changes**:
- Add rendering for `"conflicted"` file status — orange badge with "C" or conflict icon, matching existing status badge pattern for M/A/D/R

##### 6. Navigate to GitView on Conflict

**File**: `web-ui/src/hooks/use-branch-actions.ts`
**Action**: Modify
**Location**: `UseBranchActionsOptions` interface (L12-31)
**Changes**:
- Add `onConflictDetected?: () => void` to `UseBranchActionsOptions`. Call sites that want navigation pass `() => setMainView("git")`. The hook itself does not import or depend on view state — it just calls the callback.
- In `handleMergeBranch`, when the response has `conflictState`, call `onConflictDetected?.()` after showing the informational toast.

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run typecheck && npm run web:typecheck`
- [ ] Tests pass: `npm run test:fast && npm run web:test`

##### Behavioral

- [ ] Trigger merge conflict → conflict panel appears in GitView with banner and file list
- [ ] Click file → ours-vs-theirs diff shown
- [ ] Accept Ours → file marked resolved, progress updates
- [ ] Accept Theirs → file marked resolved, progress updates  
- [ ] All resolved → Complete Merge → merge commit created, panel disappears
- [ ] Abort → clean state, panel disappears
- [ ] Rebase conflict → panel with "commit N of M" progress
- [ ] Continue rebase → new round of conflicts appears if present

##### Manual

- [ ] Visual polish: banner is clear and noticeable, abort button is prominent
- [ ] Abort messaging explicitly states consequences
- [ ] Reopen mid-conflict → panel appears immediately

**Checkpoint**: Feature complete. Run `npm run check && npm run build` for final verification.

---

## Error Handling

| Scenario | Expected Behavior | How to Verify |
|----------|------------------|---------------|
| `git show :2:<path>` fails (file doesn't exist at stage 2) | Show error in diff pane: "Could not load 'ours' content for this file" | Create conflict with deleted file |
| `git checkout --ours` fails | Show toast with git error message, file stays unresolved | Mock git failure in test |
| `git merge --abort` fails | Show toast "Abort failed: [error]. The repo may be in an inconsistent state." | Unlikely but handle |
| `git rebase --continue` fails (not all conflicts resolved) | Show toast "Cannot continue — N files still have conflicts" | Try to continue with unresolved files |
| Network error during tRPC mutation | Toast with retry suggestion. Conflict state persists (git state on disk). | Kill server, try resolve |
| Binary file conflict | Show "Binary file conflict — resolve manually in terminal" instead of diff | Create conflict with a binary file |

## Rollback Strategy

- **Phase 1 rollback**: Revert schema changes in api-contract.ts and new functions in git-sync.ts. Restore auto-abort in `runGitMergeAction`.
- **Phase 2 rollback**: Revert metadata monitor changes. Remove `conflictState` from metadata schema.
- **Phase 3 rollback**: Remove new tRPC routes. Revert workspace-api changes.
- **Phase 4 rollback**: Delete new UI files. Revert git-view.tsx integration.
- **Full rollback**: `git revert` the merge commit(s). All changes are additive except the auto-abort removal in Phase 1.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Repo left in conflict state if user abandons Quarterdeck | Medium | Low — detected on reopen | Phase 2 metadata detection handles this |
| `getConflictFileContent` slow for large files | Low | Medium — UI hangs | Load file content lazily (only selected file). Could add size check and skip content for files > 1MB. |
| Rebase step count parsing fails | Low | Low — cosmetic | Gracefully degrade to "Rebase in progress" without step numbers |
| `mapNameStatus` "conflicted" breaks other file list consumers | Low | Medium | All consumers already have an "unknown" fallback; "conflicted" is more informative |

## Implementation Notes / Gotchas

- **`hasUnmergedChanges` is NOT conflict detection.** It means "branch diverges from base ref". Do not confuse or reuse it. The new `conflictState` field is independent.
- **`git diff --name-status HEAD` during conflict** shows unmerged files with `U` status. The `mapNameStatus` fix in Phase 1 handles this, but be aware that `getWorkspaceChanges` may return weird results during active conflict (conflict markers as file content). The conflict panel uses its own data source (`:2:` and `:3:` stages), not `getWorkspaceChanges`.
- **Board state single-writer rule**: All conflict state is in workspace metadata (read-only from UI's perspective). The UI doesn't write conflict state to board state. Resolution actions are tRPC mutations that modify git state, not board state.
- **Rebase `.git/rebase-merge/msgnum` and `end`**: These files contain the current and total step numbers as plain text. They don't exist during a merge. Gracefully handle missing files.
- **`git rebase --continue` needs `GIT_EDITOR=true`**: Without this, git opens an editor for the commit message. Pass env var `GIT_EDITOR=true` or use `--no-edit` equivalent.
- **Session reconciliation** (`src/terminal/session-reconciliation.ts`): Consider whether the reconciliation sweep should detect orphaned conflict states. For now, the metadata monitor handles this — if a conflict is active, it shows in metadata. If it's resolved externally, metadata reflects that. No reconciliation change needed.

## References

- **Related files**: `src/workspace/git-sync.ts`, `src/core/api-contract.ts`, `src/server/workspace-metadata-monitor.ts`, `web-ui/src/components/git-view.tsx`
- **Prior art**: Commit sidebar panel (`use-commit-panel.ts` / `commit-panel.tsx`) — closest UI pattern
- **Test Spec**: [test-spec.md](test-spec.md)
