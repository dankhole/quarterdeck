# Git Stash in Commit Panel — Implementation Specification

**Date**: 2026-04-12
**Adversarial Review Passes**: 1
**Test Spec**: [test-spec.md](test-spec.md)

<!-- Raw Intent (preserved for traceability, not for implementation agents):
Add git stash support to Quarterdeck, integrated into the existing commit sidebar panel (JetBrains-style). Users can stash changes alongside committing/discarding, browse and manage existing stashes, and get contextual "Stash & Retry" actions when checkout/pull operations are blocked by a dirty working tree. Partial stash via file selection, always include untracked, optional message. Stash pop/apply conflicts integrate with existing conflict resolution.
-->

## Goal

Add git stash as a first-class operation in the commit sidebar panel, giving users a "save my spot" action alongside commit and discard. The stash list appears in a collapsible section below the file list, and blocked checkout/pull operations offer one-click "Stash & Retry" recovery. This eliminates the need to drop to a terminal for stash operations and unblocks the common "dirty tree prevents checkout" workflow.

## Behavioral Change Statement

> **BEFORE**: The commit panel offers Commit and Discard. When checkout or pull fails due to uncommitted changes, the user must manually commit, discard, or open a terminal to run `git stash`. There is no stash visibility or management anywhere in the UI.
> **AFTER**: The commit panel gains a Stash button that stashes selected files (or all, with untracked always included) and an optional message input. A collapsible "Stashes" section below the file list shows the stash stack with pop/apply/drop actions and diff preview. When checkout or pull fails due to dirty tree, a "Stash & Retry" action auto-stashes and retries the operation.
> **SCOPE — all code paths affected**:
> 1. **Stash push**: commit panel Stash button → `use-commit-panel.ts` → tRPC `stashPush` → `git-sync.ts:stashPush()` → `git stash push`
> 2. **Stash list display**: metadata monitor → stash count in `RuntimeWorkspaceMetadata` → `workspace-metadata-store.ts` → commit panel badge; on-demand fetch → tRPC `stashList` → collapsible section
> 3. **Stash pop**: stash list Pop button → tRPC `stashPop` → `git-sync.ts:stashPop()` → `git stash pop`; on conflict → existing conflict detection activates
> 4. **Stash apply**: stash list Apply button → tRPC `stashApply` → `git-sync.ts:stashApply()` → `git stash apply`; on conflict → same
> 5. **Stash drop**: stash list Drop button → confirmation dialog → tRPC `stashDrop` → `git-sync.ts:stashDrop()` → `git stash drop`
> 6. **Stash diff preview**: stash entry click → tRPC `stashShow` → `git stash show -p` → rendered in diff viewer or inline
> 7. **Stash & checkout retry (dialog path)**: `checkout-confirmation-dialog.tsx` dirty_warning → "Stash & Switch" button → stash push → retry checkout
> 8. **Stash & checkout retry (direct path)**: `use-git-actions.ts:switchHomeBranch` → checkout fails → toast with "Stash & Switch" action → stash push → retry
> 9. **Stash & pull retry**: `GitActionErrorDialog` → "Stash & Pull" button → stash push → retry pull → auto-pop stash on success

## Hard Behavioral Constraints

### !1 — Partial stash respects file selection

When files are selected in the commit panel checkboxes, stash operates only on those files via `git stash push -- <paths>`. When no files are selected, stash operates on all changes. The existing file selection state is reused — no separate stash selection UI.

### !2 — Untracked files always included

Every stash push operation uses `--include-untracked`. There is no toggle for this. New files are common in agent workflows and must not be silently left behind.

**Clarification on partial stash**: When `--include-untracked` is combined with pathspecs (`git stash push --include-untracked -- <paths>`), git includes untracked files **only if they match the given pathspecs** — not all untracked files in the repo. This is the desired behavior: if the user selects specific files, only those files (tracked or untracked) are stashed.

### !3 — Stash pop conflict activates existing conflict resolution

If `git stash pop` or `git stash apply` results in merge conflicts, the existing conflict detection system (`detectActiveConflict` → metadata polling → conflict resolution panel) activates. The stash entry is NOT removed on conflict (git's default behavior for `stash pop` on conflict). No new conflict handling code is needed — the existing system handles it.

### !4 — Stash stack is shared across worktrees

Git stash is shared across all worktrees. The UI must show the full stash list regardless of which context (home/task) is active. The "originating branch" label on each stash entry helps users distinguish stashes from different worktrees. Stash operations do not need worktree isolation — they operate on the shared stash stack.

### !5 — Drop requires confirmation

Dropping a stash entry is destructive and irreversible. A confirmation dialog must be shown before executing `git stash drop`.

### !6 — Stash & Retry is atomic for pull

The "Stash & Pull" flow must: (1) stash all changes, (2) pull, (3) auto-pop the stash on pull success. If pull fails after stash, the stash remains on the stack (user can pop manually). If pop fails (conflict), the conflict resolution panel activates and the stash entry remains.

### !7 — Polling suppression during stash mutations

Stash push, pop, apply, and drop operations must suppress the commit panel's file change polling (same pattern as commit/discard: `isMutating ? null : pollIntervalMs`). This prevents race conditions between the mutation and the polling cycle.

## Functional Verification

| # | What to do | Expected result | Code path verified |
|---|-----------|----------------|-------------------|
| 1 | With 5 uncommitted changes and no files selected, click Stash | All changes (tracked + untracked) stashed. File list clears. Stash appears in stash list section with badge "1". | Path 1, 2 |
| 2 | Check 2 of 5 changed files, click Stash | Only those 2 files stashed. Other 3 remain in file list. Stash list shows new entry. | Path 1 |
| 3 | Enter "WIP: feature X" in stash message, click Stash | Stash list shows "WIP: feature X" as the entry message | Path 1 |
| 4 | Create 3 stashes in different worktrees | Collapsible section shows all 3 with index, message, originating branch. Badge shows "3". | Path 2, !4 |
| 5 | Click Pop on a stash entry | Changes restored to working tree. Entry removed from stash list. Badge decrements. | Path 3 |
| 6 | Click Apply on a stash entry | Changes restored. Entry remains in stash list. Badge unchanged. | Path 4 |
| 7 | Click Drop on a stash entry | Confirmation dialog appears. On confirm: entry removed without applying. Badge decrements. | Path 5, !5 |
| 8 | Click a stash entry to preview | See diff of stashed changes (files changed, additions/deletions) | Path 6 |
| 9 | With dirty tree, open checkout dialog → click "Stash & Switch" | Changes stashed, branch switches, stash list shows new entry | Path 7 |
| 10 | With dirty tree, trigger `switchHomeBranch` failure → click "Stash & Switch" in toast | Changes stashed, branch switches | Path 8 |
| 11 | With dirty tree, attempt pull → click "Stash & Pull" in error dialog | Changes stashed, pull succeeds, stash auto-popped, changes restored | Path 9, !6 |
| 12 | Pop a stash that conflicts with current changes | Conflict resolution panel activates. Stash entry remains in list. | Path 3, !3 |
| 13 | Stash in task worktree, check home repo | Same stash visible in home repo stash list | !4 |
| 14 | Commit flow: select files, enter message, commit | Commit works identically to before. No regressions. | Regression |
| 15 | Discard all flow: click Discard All, confirm | Discard works identically to before. No regressions. | Regression |

## Current State

- `src/workspace/git-sync.ts:292-306` — Pull pre-checks `changedFiles > 0`, returns error string mentioning "stash" but stash is not implemented
- `src/workspace/git-sync.ts:334-386` — Checkout runs `git switch` directly, no dirty-tree pre-check, errors propagate as `{ok: false, error}`
- `web-ui/src/components/detail-panels/commit-panel.tsx:267-281` — Commit and Discard All buttons, no Stash
- `web-ui/src/hooks/use-commit-panel.ts:9-28` — `UseCommitPanelResult` interface with `commitFiles`, `discardAll`, `rollbackFile`, no stash methods
- `web-ui/src/components/detail-panels/checkout-confirmation-dialog.tsx:101-139` — `dirty_warning` variant shows only "Cancel" and "Proceed anyway"
- `web-ui/src/components/git-action-error-dialog.tsx:12-54` — Error dialog with only "Close" button
- `web-ui/src/hooks/use-git-actions.ts:384-433` — `switchHomeBranch` shows toast on failure, no recovery action
- `src/core/api-contract.ts:461-467` — `runtimeWorkspaceMetadataSchema` has no stash fields
- `src/server/workspace-metadata-monitor.ts:218-246` — `loadHomeGitMetadata` has no stash count

## Desired End State

- Commit panel has a Stash button that respects file selection and always includes untracked files
- Collapsible "Stashes" section in commit panel shows full stash list with pop/apply/drop/preview actions
- Stash count badge on the section header, auto-updating via metadata polling
- Checkout dirty_warning dialog offers "Stash & Switch" alongside "Cancel" and "Proceed anyway"
- `switchHomeBranch` failure path offers "Stash & Switch" via toast action
- Pull failure dialog offers "Stash & Pull" that auto-stashes, pulls, and auto-pops
- Stash pop/apply conflicts activate the existing conflict resolution panel
- Drop operations require confirmation dialog

## Out of Scope

- Stash branch (`git stash branch`) — creating a branch from a stash entry
- Stash rename — git doesn't support this natively
- Stash across worktrees — stash is already shared; no additional cross-worktree features
- Auto-stash on any operation other than checkout/pull
- Stash diff inline in the commit panel — preview navigates to compare tab or uses a popover summary
- Global stash indicator outside the commit panel (e.g., badge on task cards)

## Dependencies

- **No external dependencies** — all functionality uses git CLI commands via existing `runGit` helper
- **No new packages** — Radix Collapsible already available, sonner already available
- **No configuration** — no new config fields needed (stash is always available)

## Architecture & Approach

### Design Decisions

| Decision | Choice | Rationale | Alternative | Constraint |
|----------|--------|-----------|-------------|------------|
| Stash list data source | Count in metadata polling, full list on-demand | Minimizes polling overhead (one extra `git stash list --format=%gd` per tick). Full list only needed when section is expanded. | Full list in metadata polling — rejected because it adds data to every tick even when commit panel is closed | Stash count MUST be in metadata; full list MUST be fetched via separate tRPC query |
| Stash functions location | Add to `git-sync.ts` | All git operations live here. Stash is 5 small functions, not enough to warrant a separate module. | Separate `git-stash.ts` — rejected because it would be the only single-concern git module and adds unnecessary indirection | N/A |
| Stash list UI | Dedicated sub-component + hook | Stash list has its own data fetching (on-demand), state (expanded/collapsed, loading), and actions (pop/apply/drop). Mixing into `use-commit-panel` would bloat it. | Inline in commit panel — rejected, hook already 263 lines | New hook `use-stash-list.ts` + component `stash-list-section.tsx` |
| Toast action for stash & retry | Extend `showAppToast` with optional `action` | Sonner supports `action: {label, onClick}`. `showAppToast` currently doesn't pass it through. Small extension. | Use raw `toast()` — rejected per AGENTS.md (must use `showAppToast`) | `showAppToast` interface must be extended |
| Stash & Pull auto-pop | Pop after successful pull only | If pull fails, stash remains for manual recovery. If pop conflicts, conflict resolution handles it. Clean separation of concerns. | Always pop (even on pull failure) — rejected, would create confusing state | Pull success → pop. Pull failure → stash retained. Pop conflict → conflict panel. |

## Interface Contracts

### tRPC Endpoints (workspace router)

| Method | Endpoint | Input | Output |
|--------|----------|-------|--------|
| mutation | `stashPush` | `{ taskScope: RuntimeTaskWorkspaceInfoRequest | null, paths: string[], message?: string }` | `{ ok: boolean, error?: string }` |
| query | `stashList` | `{ taskScope: RuntimeTaskWorkspaceInfoRequest | null }` | `{ ok: boolean, entries: RuntimeStashEntry[], error?: string }` |
| mutation | `stashPop` | `{ taskScope: RuntimeTaskWorkspaceInfoRequest | null, index: number }` | `{ ok: boolean, conflicted: boolean, error?: string }` |
| mutation | `stashApply` | `{ taskScope: RuntimeTaskWorkspaceInfoRequest | null, index: number }` | `{ ok: boolean, conflicted: boolean, error?: string }` |
| mutation | `stashDrop` | `{ taskScope: RuntimeTaskWorkspaceInfoRequest | null, index: number }` | `{ ok: boolean, error?: string }` |
| query | `stashShow` | `{ taskScope: RuntimeTaskWorkspaceInfoRequest | null, index: number }` | `{ ok: boolean, diff?: string, error?: string }` |

### Zod Schemas (api-contract.ts)

```ts
// Stash entry — returned by stashList
export const runtimeStashEntrySchema = z.object({
  index: z.number(),          // 0, 1, 2...
  message: z.string(),         // "On main: WIP" or custom message
  branch: z.string(),          // originating branch name
  date: z.string(),            // ISO date string
});

// Stash push request
export const runtimeStashPushRequestSchema = z.object({
  taskScope: runtimeTaskWorkspaceInfoRequestSchema.nullable(),
  paths: z.array(z.string()),  // empty = stash all
  message: z.string().optional(),
});

// Stash action request (pop/apply/drop)
export const runtimeStashActionRequestSchema = z.object({
  taskScope: runtimeTaskWorkspaceInfoRequestSchema.nullable(),
  index: z.number(),
});

// Stash push response
export const runtimeStashPushResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

// Stash pop/apply response
export const runtimeStashPopApplyResponseSchema = z.object({
  ok: z.boolean(),
  conflicted: z.boolean(),
  error: z.string().optional(),
});

// Stash drop response
export const runtimeStashDropResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

// Stash show response
export const runtimeStashShowResponseSchema = z.object({
  ok: z.boolean(),
  diff: z.string().optional(),
  error: z.string().optional(),
});

// Stash list response
export const runtimeStashListResponseSchema = z.object({
  ok: z.boolean(),
  entries: z.array(runtimeStashEntrySchema),
  error: z.string().optional(),
});
```

### Metadata Extensions

```ts
// Add to runtimeWorkspaceMetadataSchema:
homeStashCount: z.number().int().nonnegative(),
```

Note: `stashCount` is NOT added to `runtimeTaskWorkspaceMetadataSchema`. Git stash is shared across all worktrees (!4), so every task's stash count equals `homeStashCount`. Adding it to task metadata would be redundant and would trigger a test fixture cascade (modifying 10+ mock files that construct `RuntimeTaskWorkspaceMetadata`). The UI always reads stash count from `homeStashCount` via the `useHomeStashCount()` selector hook.

## Implementation Phases

### Phase 1: Backend — Git Stash Operations

#### Overview

Add the core git stash functions to `git-sync.ts` and wire them through tRPC. This phase produces the backend API that all UI features depend on.

#### Changes Required

##### 1. Zod Schemas

**File**: `src/core/api-contract.ts`
**Action**: Add
**Location**: After the conflict resolution schemas (~line 308)
**Changes**:
- Add `runtimeStashEntrySchema` and `RuntimeStashEntry` type
- Add `runtimeStashPushRequestSchema`, `runtimeStashActionRequestSchema`
- Add `runtimeStashPushResponseSchema`, `runtimeStashPopApplyResponseSchema`, `runtimeStashDropResponseSchema`, `runtimeStashShowResponseSchema`, `runtimeStashListResponseSchema`
- Add `homeStashCount` to `runtimeWorkspaceMetadataSchema`
- Do NOT add `stashCount` to `runtimeTaskWorkspaceMetadataSchema` — stash is shared across worktrees (!4), so this would be redundant with `homeStashCount` and would cause a test fixture cascade

**Code Pattern to Follow**: See conflict schemas at `api-contract.ts:230-308`

##### 2. Git Stash Functions

**File**: `src/workspace/git-sync.ts`
**Action**: Add
**Location**: After `discardSingleFile()` (~line 974)
**Changes**:

- `stashPush(options: {cwd, paths?, message?})`: Validates all paths via `validateGitPath()` (same pattern as `commitSelectedFiles` at line 874). Builds `git stash push --include-untracked` args. If `paths` is non-empty, appends `-- ...paths`. If `message`, adds `-m <message>`. Returns `{ok, error?}`.
- `stashList(cwd)`: Runs `git stash list --format=%gd%x1f%gs%x1f%ci` (refname, subject, date). `%gd` produces `stash@{N}` (not a bare number); extract the index via `/^stash@\{(\d+)\}$/` regex. `%gs` produces the subject in format `On <branch>: <message>` (or `WIP on <branch>: <hash> <commit-msg>` for default messages); extract branch via `/^(?:On|WIP on) ([^:]+):/` regex — the branch name is the capture group. The remainder after `<branch>: ` is the message. Returns `{ok, entries}` with each entry as `{index: number, message: string, branch: string, date: string}`.
- `stashPop(options: {cwd, index})`: Runs `git stash pop stash@{<index>}`. Detects conflict from exit code + stderr. Returns `{ok, conflicted, error?}`.
- `stashApply(options: {cwd, index})`: Same as pop but `git stash apply`. Returns `{ok, conflicted, error?}`.
- `stashDrop(options: {cwd, index})`: Runs `git stash drop stash@{<index>}`. Returns `{ok, error?}`.
- `stashShow(options: {cwd, index})`: Runs `git stash show -p stash@{<index>}`. Returns `{ok, diff, error?}`.
- `stashCount(cwd)`: Runs `git --no-optional-locks stash list` and counts lines. Returns a number. This is the cheap operation used in metadata polling. Must use `--no-optional-locks` (same as existing `git status` calls in the probe) to avoid lock contention with concurrent agent git operations.

**Code Pattern to Follow**: See `commitSelectedFiles()` at `git-sync.ts:865-920` for the `runGit` → parse → return pattern.

##### 3. tRPC Routes

**File**: `src/trpc/workspace-api.ts`
**Action**: Add
**Location**: After the conflict resolution routes
**Changes**:
- `stashPush` mutation: normalizes taskScope, resolves CWD, validates paths via `validateGitPath()`, calls `stashPush()`, then `void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath)`
- `stashList` query: resolves CWD, calls `stashList()`
- `stashPop` mutation: resolves CWD, calls `stashPop()`, then `void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath)`. If `conflicted`, the metadata polling will detect the conflict.
- `stashApply` mutation: same as pop — resolves CWD, calls `stashApply()`, then `void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath)`
- `stashDrop` mutation: resolves CWD, calls `stashDrop()`, then `void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceScope.workspaceId, workspaceScope.workspacePath)`
- `stashShow` query: resolves CWD, calls `stashShow()`

**Code Pattern to Follow**: See `commitSelectedFiles` handler at `workspace-api.ts:504-534` for the taskScope resolution and broadcast pattern.

**File**: `src/trpc/app-router.ts`
**Action**: Add
**Location**: In the workspace router and context interface
**Changes**:
- Add method signatures to `RuntimeTrpcContext.workspaceApi` interface
- Add procedure definitions in the `workspace` router

##### 4. Metadata Monitor

**File**: `src/server/workspace-metadata-monitor.ts`
**Action**: Modify
**Location**: `loadHomeGitMetadata()` (line 218) and `loadTaskWorkspaceMetadata()` (line 265)
**Changes**:
- In `loadHomeGitMetadata`: call `stashCount(workspacePath)` **before** the stateToken comparison. Stash count is computed independently because `stateToken` is built from `git status` output, HEAD, branch, and file fingerprints — stash-only mutations (`stash drop`, `stash apply` on a clean tree) don't change any of these. The stash count must be compared separately: if only stash count changed (stateToken matches but stash count differs), bump `stateVersion` and return updated metadata with the new count. If stateToken also changed, proceed with the full metadata reload as before and include the new stash count.
- Do NOT add stash count to `loadTaskWorkspaceMetadata` — stash is shared across worktrees (!4), so `homeStashCount` is the single source. Computing it per-task would be redundant.
- Add `stashCount: number` field to `CachedHomeGitMetadata` interface for diff comparison.
- Update `buildWorkspaceMetadataSnapshot()` (line 207) to include `homeStashCount: entry.homeGit.stashCount` in the returned `RuntimeWorkspaceMetadata` object.
- Stash count is cheap (just `git stash list | wc -l` equivalent) so safe for polling

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] Type check passes: `npm run typecheck`
- [ ] Runtime tests pass: `npm test`

##### Behavioral

- [ ] tRPC endpoints callable via test or manual invocation
- [ ] Stash push/list/pop/apply/drop/show all work against a real git repo

---

### Phase 2: Frontend — Stash Button in Commit Panel

#### Overview

Add the Stash button to the commit panel alongside Commit/Discard. Wire it to the backend stash push endpoint. Add stash message input. This phase gives users the core "stash my changes" action.

#### Changes Required

##### 1. Commit Panel Hook

**File**: `web-ui/src/hooks/use-commit-panel.ts`
**Action**: Modify
**Location**: `UseCommitPanelResult` interface (line 9) and hook body
**Changes**:
- Add to `UseCommitPanelResult`: `stashChanges: () => Promise<void>`, `isStashing: boolean`, `stashMessage: string`, `setStashMessage: (msg: string) => void`
- Add `isStashing` to the `isMutating` union for polling suppression (line 49)
- Implement `stashChanges()`: collects selected paths (or empty array for all), calls `trpcClient.workspace.stashPush.mutate({taskScope, paths, message: stashMessage})`, shows toast on success/error, clears stash message on success

##### 2. Commit Panel UI

**File**: `web-ui/src/components/detail-panels/commit-panel.tsx`
**Action**: Modify
**Location**: After the commit message textarea (line 266), in the button bar (line 267-281)
**Changes**:
- Add an optional stash message input. This could be a small text input that appears when a "message" toggle is clicked, or share the commit message textarea (separate field is cleaner). A small collapsed input that expands on click is cleanest — avoids always-visible clutter.
- Add Stash button between Commit and Discard All:
  ```tsx
  <Button variant="default" size="sm" disabled={!hasFiles || isStashing} onClick={() => void stashChanges()}>
    {isStashing ? <Spinner size={14} /> : "Stash"}
  </Button>
  ```
- The button is disabled when there are no files (nothing to stash) or when a stash operation is in progress

**Code Pattern to Follow**: See the Commit button at `commit-panel.tsx:268-270` for styling and loading state pattern.

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] Web UI type check passes: `npm run web:typecheck`
- [ ] Web UI tests pass: `npm run web:test`

##### Behavioral

- [ ] Stash button appears alongside Commit/Discard in the commit panel
- [ ] Clicking Stash with uncommitted changes stashes them and clears the file list
- [ ] Clicking Stash with selected files stashes only those files
- [ ] Stash button disabled when no uncommitted changes
- [ ] Loading spinner shown during stash operation
- [ ] Toast shown on success/failure

---

### Phase 3: Frontend — Stash List Section

#### Overview

Add the collapsible stash list section below the file list in the commit panel. Includes stash entries with metadata, pop/apply/drop actions, diff preview, and badge count. This is the main stash management UI.

#### Changes Required

##### 1. Stash List Hook

**File**: `web-ui/src/hooks/use-stash-list.ts` (NEW)
**Action**: Create
**Changes**:
- Hook: `useStashList(taskId, workspaceId)`
- Fetches stash list via `trpcClient.workspace.stashList.query({taskScope})` on-demand (not polling — triggered by expand and by stash count changes from metadata store)
- Reads `stashCount` from the `useHomeStashCount()` selector hook added in Phase 3 Section 4. Since stash is shared across worktrees (!4), `homeStashCount` is the single source of truth regardless of whether the user is in home or task context. A change in `homeStashCount` triggers a refetch of the full stash list when the section is expanded.
- Returns: `entries: RuntimeStashEntry[]`, `isLoading: boolean`, `popStash(index)`, `applyStash(index)`, `dropStash(index)`, `showStashDiff(index): Promise<string>`
- Each action calls the corresponding tRPC endpoint, shows toast, triggers refetch
- `dropStash` does NOT show confirmation dialog (that's the component's job)

##### 2. Stash List Component

**File**: `web-ui/src/components/detail-panels/stash-list-section.tsx` (NEW)
**Action**: Create
**Changes**:
- Component: `StashListSection({ taskId, workspaceId, stashCount })`
- Uses Radix `Collapsible.Root` for expand/collapse
- Header: "Stashes" label with badge count from `stashCount` prop (from metadata store). Chevron icon for expand/collapse.
- When expanded: calls `useStashList` hook, renders entry list
- Each entry row: index badge, message text (truncated), originating branch pill, relative date
- Context menu per entry (Radix ContextMenu): Pop, Apply, Drop, Show Diff
- Drop action triggers confirmation AlertDialog before calling `dropStash(index)`
- Show Diff opens a Radix Popover anchored to the entry row, rendering the diff output in a `<pre className="text-xs font-mono whitespace-pre overflow-auto max-h-80 p-3 bg-surface-1 rounded-md">` block. The popover has a max-width of `min(600px, 90vw)`. This avoids navigating away from the commit panel for a quick preview.

**Code Pattern to Follow**: See `project-navigation-panel.tsx:394-411` for Radix Collapsible pattern. See `commit-panel.tsx:69-142` for Radix ContextMenu pattern.

##### 3. Wire into Commit Panel

**File**: `web-ui/src/components/detail-panels/commit-panel.tsx`
**Action**: Modify
**Location**: After the discard confirmation dialog (~line 314)
**Changes**:
- Import `StashListSection`
- Read `stashCount` from metadata store (via the workspace metadata store hooks)
- Render `<StashListSection taskId={taskId} workspaceId={workspaceId} stashCount={stashCount} />` below the existing file list and action buttons

##### 4. Metadata Store

**File**: `web-ui/src/stores/workspace-metadata-store.ts`
**Action**: Modify
**Changes**:
- Add `homeStashCount: number` to the store state
- Add `useHomeStashCount()` selector hook — this is the single source for stash count in the UI, regardless of home/task context (!4)
- Update `replaceWorkspaceMetadata` to extract `homeStashCount` from the metadata snapshot and diff against previous value to emit changes

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] Web UI type check passes: `npm run web:typecheck`

##### Behavioral

- [ ] Collapsible "Stashes" section appears below file list in commit panel
- [ ] Badge count shows current stash count
- [ ] Section collapsed by default, expands to show stash entries
- [ ] Pop removes entry from list and restores changes
- [ ] Apply restores changes but keeps entry in list
- [ ] Drop shows confirmation, then removes entry without applying
- [ ] Context menu appears on right-click
- [ ] Stash count updates when stashes are created/popped/dropped from any worktree

---

### Phase 4: Frontend — Stash & Retry for Checkout

#### Overview

Add "Stash & Switch" recovery to both checkout paths: the checkout confirmation dialog (dirty_warning variant) and the `switchHomeBranch` toast failure path.

#### Changes Required

##### 1. Checkout Confirmation Dialog

**File**: `web-ui/src/components/detail-panels/checkout-confirmation-dialog.tsx`
**Action**: Modify
**Location**: `dirty_warning` block (line 101-139)
**Changes**:
- Add a third button: "Stash & Switch" between Cancel and "Proceed anyway"
- The button's onClick: calls a new `onStashAndCheckout` callback prop
- Styling: use `bg-accent` (blue) to distinguish from the orange "Proceed anyway"
- Add loading state for the stash-and-checkout operation

**Props change**: Add `onStashAndCheckout?: () => void` and `isStashingAndCheckingOut?: boolean` to the component props.

##### 2. Branch Actions Hook

**File**: `web-ui/src/hooks/use-branch-actions.ts`
**Action**: Modify
**Changes**:
- Add `stashAndCheckout(branch, scope, checkoutTaskId?, checkoutBaseRef?)` function: builds `taskScope` from the hook's `options.taskId` and `options.baseRef` — `const taskScope = options.taskId && options.baseRef ? { taskId: options.taskId, baseRef: options.baseRef } : null` (same pattern as `refsQueryFn` at line 85). Calls `trpcClient.workspace.stashPush.mutate({taskScope, paths: []})`, then on success calls `performCheckout(branch, scope, checkoutTaskId, checkoutBaseRef)`
- Pass `onStashAndCheckout` callback to the checkout dialog that calls `stashAndCheckout` with the dialog's branch/scope/taskId/baseRef
- Handle errors: if stash fails, show error toast and stay on dialog. If checkout fails after stash, show error toast (stash is already saved, user can pop manually).

##### 3. Checkout Response Schema — add `dirtyTree` field

**File**: `src/core/api-contract.ts`
**Action**: Modify
**Location**: `runtimeGitCheckoutResponseSchema` (line 205)
**Changes**:
- Add `dirtyTree: z.boolean().optional()` to `runtimeGitCheckoutResponseSchema`. When the checkout fails because of uncommitted changes, the backend sets `dirtyTree: true`.

**File**: `src/workspace/git-sync.ts`
**Action**: Modify
**Location**: `runGitCheckoutAction()` error path (line 370)
**Changes**:
- When `commandResult.ok` is false, detect dirty tree from stderr: `const dirtyTree = /(?:local changes|uncommitted changes|overwritten by checkout)/i.test(commandResult.error ?? "")`. Include `dirtyTree` in the failure response.

##### 4. Home Branch Switch (toast path)

**File**: `web-ui/src/hooks/use-git-actions.ts`
**Action**: Modify
**Location**: `switchHomeBranch` (line 384-433)
**Changes**:
- On checkout failure, check `payload.dirtyTree` (the structured boolean from the response schema) rather than fragile stderr string matching
- If `dirtyTree`: show toast with "Stash & Switch" action via `showAppToast` with action button
- The action callback: calls `trpcClient.workspace.stashPush.mutate({taskScope: null, paths: []})`, then retries `switchHomeBranch`

##### 5. Extend showAppToast

**File**: `web-ui/src/components/app-toaster.ts`
**Action**: Modify
**Changes**:
- Add optional `action?: { label: string; onClick: () => void }` to `AppToastProps`
- Pass it through to sonner's `toast()` call as the `action` property

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] Web UI type check passes: `npm run web:typecheck`

##### Behavioral

- [ ] Checkout confirmation dialog shows "Stash & Switch" button in dirty_warning state
- [ ] Clicking "Stash & Switch" stashes changes and completes checkout
- [ ] `switchHomeBranch` failure with dirty tree shows toast with "Stash & Switch" action
- [ ] Both paths: if stash fails, error is shown and checkout is not attempted

---

### Phase 5: Frontend — Stash & Retry for Pull

#### Overview

Add "Stash & Pull" recovery to the pull failure flow.

#### Changes Required

##### 1. Git Action Error Dialog

**File**: `web-ui/src/components/git-action-error-dialog.tsx`
**Action**: Modify
**Changes**:
- Add optional `onStashAndRetry?: () => void` and `isStashAndRetrying?: boolean` props
- When `onStashAndRetry` is provided, render a "Stash & Pull" button alongside "Close":
  ```tsx
  <Button variant="primary" size="sm" disabled={isStashAndRetrying} onClick={onStashAndRetry}>
    {isStashAndRetrying ? <Spinner size={14} /> : "Stash & Pull"}
  </Button>
  ```

##### 2. Pull Response Schema — add `dirtyTree` field

**File**: `src/core/api-contract.ts`
**Action**: Modify
**Location**: `runtimeGitSyncResponseSchema` (line 189)
**Changes**:
- Add `dirtyTree: z.boolean().optional()` to `runtimeGitSyncResponseSchema`. When the pull is blocked by uncommitted changes, the backend sets `dirtyTree: true`.

**File**: `src/workspace/git-sync.ts`
**Action**: Modify
**Location**: `runGitSyncAction()` dirty-tree early return (line 298-306)
**Changes**:
- In the `changedFiles > 0` early return for pull, add `dirtyTree: true` to the response object.

##### 3. Git Actions Hook

**File**: `web-ui/src/hooks/use-git-actions.ts`
**Action**: Modify
**Location**: `runGitAction` error handling (line 356-366)
**Changes**:
- Add `stashAndRetryPull()` function: (1) stash all changes via `trpcClient.workspace.stashPush.mutate({taskScope: null, paths: []})`, (2) retry pull, (3) on pull success: auto-pop stash via `trpcClient.workspace.stashPop.mutate({taskScope: null, index: 0})`, (4) on pop conflict: conflict panel activates, toast informs user
- Detect dirty-tree pull failure: check `gitActionError.dirtyTree` (the structured boolean from the response schema added above) rather than fragile string matching on the error message
- Pass `onStashAndRetry` to `GitActionErrorDialog` when `gitActionError.dirtyTree === true`
- Add `isStashAndRetryingPull` loading state

##### 4. Wire into App.tsx

**File**: `web-ui/src/App.tsx`
**Action**: Modify
**Location**: Where `GitActionErrorDialog` is rendered (~line 1801-1807)
**Changes**:
- Pass the new `onStashAndRetry` and `isStashAndRetrying` props from `useGitActions` return value

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] Web UI type check passes: `npm run web:typecheck`

##### Behavioral

- [ ] Pull failure due to dirty tree shows "Stash & Pull" button in error dialog
- [ ] Clicking "Stash & Pull" stashes changes, pulls, and auto-pops stash
- [ ] If pull succeeds but pop conflicts, conflict panel activates
- [ ] If stash fails, error shown and pull not attempted
- [ ] Pull failures NOT due to dirty tree show only "Close" (no stash button)

---

## Error Handling

| Scenario | Expected Behavior | How to Verify |
|----------|------------------|---------------|
| `git stash push` fails (nothing to stash) | Toast: "Nothing to stash" | Stash with no changes |
| `git stash push -- <paths>` fails (paths not found) | Toast: error message from git | Stash with invalid paths (edge case) |
| `git stash pop` conflicts | `{ok: false, conflicted: true}`. Stash entry retained. Conflict detection activates via metadata polling. | Pop stash that conflicts with current changes |
| `git stash pop` fails (not a conflict) | Toast: error message from git. Stash entry retained. | Pop stash on a repo in bad state |
| `git stash drop` on invalid index | Toast: error message from git | Drop with stale index (another client dropped it first) |
| Stash & Pull: stash succeeds but pull fails | Toast: pull error. Stash remains on stack for manual recovery. | Pull with dirty tree when remote has force-pushed |
| Stash & Pull: pull succeeds but pop conflicts | Conflict panel activates. Toast: "Pull succeeded. Stash applied with conflicts — resolve them to complete." | Pull when remote changes conflict with stashed changes |
| Stash & Checkout: stash succeeds but checkout fails | Toast: checkout error. Stash remains on stack. User stays on current branch. | Checkout to branch that doesn't exist (race condition) |
| Network error during tRPC call | Standard tRPC error handling. Toast: generic error. | Kill server during stash operation |

## Rollback Strategy

- **Phase 1 rollback**: Revert added schemas, git-sync functions, tRPC routes, metadata monitor changes. No data migration to undo.
- **Phase 2 rollback**: Revert commit panel changes. Backend endpoints become unused but harmless.
- **Phase 3 rollback**: Delete new files (`use-stash-list.ts`, `stash-list-section.tsx`). Revert commit panel and metadata store changes.
- **Phase 4 rollback**: Revert checkout dialog, branch actions, git actions, and toast changes.
- **Phase 5 rollback**: Revert error dialog, git actions, and App.tsx changes.
- **Full rollback**: `git revert` the entire branch. No database or config state to clean up.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Stash count polling adds latency to metadata cycle | Low | Low | `git stash list` is fast (<10ms). Piggybacked on existing polling, not a new timer. |
| Stash & Pull auto-pop creates confusing conflict state | Medium | Medium | Clear toast messaging: "Pull succeeded. Stash applied with conflicts — resolve them to complete." |
| Shared stash stack causes confusion across worktrees | Medium | Low | Originating branch label on each entry. All entries always visible. |
| Partial stash (`git stash push -- <paths>`) edge cases with untracked files | Low | Medium | Always include `--include-untracked`. Test partial stash with mix of tracked/untracked. |

## Implementation Notes / Gotchas

- **`git stash push` with paths requires `--` separator**: Always use `git stash push --include-untracked [-m <msg>] -- <paths>` to avoid path/flag ambiguity.
- **`git stash pop` on conflict does NOT remove the entry**: This is git's default behavior. The stash entry remains on the stack. The `stashPop` return value must signal `conflicted: true` so the UI knows the entry wasn't removed.
- **Stash index 0 is always the most recent**: After pop/drop, all indices shift. The UI should refetch the stash list after any mutation rather than trying to adjust indices locally.
- **`--no-optional-locks` on polling commands**: The metadata monitor's stash count query should use `--no-optional-locks` (same as existing `git status` calls) to avoid lock contention with concurrent agent git operations. See `git-sync-no-optional-locks.test.ts`.
- **`showAppToast` not `toast`**: Per AGENTS.md, all toasts must go through `showAppToast`. The action button extension is a small change to this wrapper.
- **Radix Collapsible + forwardRef**: If the Collapsible.Trigger uses `asChild`, the child component must use `forwardRef` and spread rest props (per AGENTS.md Radix gotcha).
- **Board state single-writer rule**: Stash operations are server-side git commands that don't modify board state. They broadcast `workspace_metadata_updated` which updates the metadata store (not the board state reducer). No conflict with the single-writer rule.
- **Radix AlertDialog double-fire on drop confirmation**: The stash drop confirmation dialog is a controlled `AlertDialog`. Per AGENTS.md, Radix fires `onOpenChange(false)` for ALL close reasons (cancel, confirm, ESC, overlay click). If the confirm handler mutates state asynchronously and `onOpenChange` also runs cleanup, use a `useRef` flag to prevent the cancel path from firing after confirm. See `trashWarningConfirmedRef` in `use-board-interactions.ts` for the reference pattern.

## References

- **Related files**: `git-sync.ts`, `workspace-api.ts`, `api-contract.ts`, `commit-panel.tsx`, `use-commit-panel.ts`, `checkout-confirmation-dialog.tsx`, `git-action-error-dialog.tsx`, `use-git-actions.ts`, `use-branch-actions.ts`, `workspace-metadata-monitor.ts`, `workspace-metadata-store.ts`
- **Prior art**: Conflict resolution (same component+hook pattern, same metadata polling integration)
- **Test Spec**: [test-spec.md](test-spec.md)
