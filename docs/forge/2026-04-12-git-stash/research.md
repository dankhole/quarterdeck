---
project: git-stash
date: 2026-04-12
status: research
---

# Research: Git Stash in Commit Panel

## Critical Discovery: Stash is Shared Across Worktrees

Git stash is **NOT per-worktree** — it's shared across all worktrees in a repository. Tested empirically: a stash created in worktree A appears in worktree B's `git stash list`. This means:
- All task worktrees and the home repo see the same stash stack
- The UI should show the full stash list regardless of which context (home/task) is active
- The "originating branch" label on each stash entry is the main way users distinguish stashes from different worktrees
- Stash pop/apply in one worktree can apply a stash that was created in another — this is valid but may cause conflicts

## Data Flow Analysis

### Commit Flow (reference pattern for stash push)
1. `commit-panel.tsx:268` → `useCommitPanel.commitFiles()` (`use-commit-panel.ts:138`)
2. → `trpcClient.workspace.commitSelectedFiles.mutate({taskScope, paths, message})`
3. → `workspace-api.ts:504` handler → resolves task CWD, blocks shared-checkout commits
4. → `git-sync.ts:865` `commitSelectedFiles()` → `git add -- ...paths` → `git commit -m`
5. → On success: `broadcastRuntimeWorkspaceStateUpdated` → metadata monitor refresh → UI update

**Stash push follows this exact pattern** — replace `git add + commit` with `git stash push`.

### Pull Dirty-Tree Blocking (stash & retry injection point)
1. `use-git-actions.ts:345` `runGitAction("pull")`
2. → `trpcClient.workspace.runGitSyncAction.mutate({action: "pull"})`
3. → `git-sync.ts:298` **explicit pre-check**: `changedFiles > 0` → returns error string
4. → `use-git-actions.ts:356` sets `gitActionError` state
5. → `GitActionErrorDialog` renders with only a "Close" button

**Injection point**: `GitActionErrorDialog` needs a "Stash & Pull" action button when error is a dirty-tree pull failure.

### Checkout Dirty-Tree Blocking (two independent paths!)
**Path A**: `use-branch-actions.ts:190` `handleCheckoutBranch` → `resolveCheckoutDialogState` at `checkout-confirmation-dialog.tsx:209` → returns `{type: "dirty_warning"}` → dialog with only "Cancel" and "Proceed anyway"
**Path B**: `use-git-actions.ts:384` `switchHomeBranch` → calls tRPC directly, shows only a toast on failure — no dialog.

**Both paths need stash & retry.** Path A gets a "Stash & Switch" button in the dirty_warning dialog. Path B needs dirty-tree detection before the tRPC call.

### Conflict Resolution Activation (pattern for stash pop conflicts)
1. Git operation (merge/rebase) fails with unmerged files
2. `workspace-metadata-monitor.ts:218` → `detectActiveConflict()` checks `.git/MERGE_HEAD` or `.git/rebase-merge`
3. Conflict state flows through `RuntimeWorkspaceMetadata` → WebSocket → `workspace-metadata-store.ts`
4. `use-conflict-resolution.ts` reads from store → `isActive=true` → conflict panel mounts

**Stash pop conflicts**: `git stash pop` that conflicts leaves unmerged files. The existing conflict detection will pick this up via the metadata polling cycle. However, `stash pop` on conflict does NOT remove the stash entry (unlike successful pop). The stash pop endpoint should detect this and signal that the stash was retained.

### Metadata Polling (stash list data source)
- Server: `workspace-metadata-monitor.ts` polls at 10s (home), 2s (focused task), 5s (background tasks)
- Uses `stateToken` (composite of `git status` output + file fingerprints) to skip unchanged data
- Adding `git stash list` to the polling cycle would add one extra git command per tick
- Alternative: include stash count only (cheap), fetch full list on-demand when commit panel opens

### File Change Polling (mutation suppression)
- `use-commit-panel.ts:49`: `pollIntervalMs` = `null` when any mutation is in flight
- Stash push/pop operations must also suppress polling to prevent race conditions

## Files to Modify

### Backend (6 files)
| File | Change |
|------|--------|
| `src/workspace/git-sync.ts` | New functions: `stashPush()`, `stashList()`, `stashPop()`, `stashApply()`, `stashDrop()`, `stashShowDiff()` |
| `src/core/api-contract.ts` | New schemas: `RuntimeStashEntry`, stash request/response types; extend `RuntimeWorkspaceMetadata` with `homeStashCount`, extend `RuntimeTaskWorkspaceMetadata` with `stashCount` |
| `src/trpc/workspace-api.ts` | New endpoints: `stashPush`, `stashPop`, `stashApply`, `stashDrop`, `stashList`, `stashShowDiff` |
| `src/trpc/app-router.ts` | New procedure definitions in workspace router + context interface |
| `src/server/workspace-metadata-monitor.ts` | Add stash count to `loadHomeGitMetadata` and `loadTaskWorkspaceMetadata` |

### Frontend (8-9 files)
| File | Change |
|------|--------|
| `web-ui/src/hooks/use-commit-panel.ts` | Add `stashChanges()`, `isStashing`, stash message state |
| `web-ui/src/components/detail-panels/commit-panel.tsx` | Stash button in action bar, collapsible stash list section below file list |
| `web-ui/src/hooks/use-stash-list.ts` | **NEW** — dedicated hook for stash list data, pop/apply/drop actions, loading states |
| `web-ui/src/components/detail-panels/stash-list-section.tsx` | **NEW** — collapsible stash list sub-component with entry rows, context menu, diff preview |
| `web-ui/src/stores/workspace-metadata-store.ts` | Store and emit stash count per workspace |
| `web-ui/src/components/detail-panels/checkout-confirmation-dialog.tsx` | Add "Stash & Switch" button to `dirty_warning` variant |
| `web-ui/src/components/git-action-error-dialog.tsx` | Add "Stash & Retry" button for dirty-tree pull failures |
| `web-ui/src/hooks/use-git-actions.ts` | Wire stash-and-retry for pull errors; add stash-before-checkout to `switchHomeBranch` |
| `web-ui/src/hooks/use-branch-actions.ts` | Wire stash-then-checkout in `performCheckout` |

### Tests (3-4 new files)
| File | Pattern |
|------|---------|
| `test/runtime/git-stash.test.ts` | **NEW** — Pattern B (real temp repos) for git-sync stash functions |
| `test/runtime/trpc/workspace-api-stash.test.ts` | **NEW** — Pattern A (vi.mock) for workspace-api stash endpoints |
| `web-ui/src/hooks/use-stash-list.test.ts` | **NEW** — Pattern D (trpc mock) for stash list hook |
| `test/runtime/git-sync-no-optional-locks.test.ts` | Extend to cover stash commands |

## Existing Patterns to Follow

### Component + Hook pattern
- Component: `commit-panel.tsx` renders UI, destructures hook result
- Hook: `use-commit-panel.ts` owns state, tRPC calls, returns typed interface

### Collapsible section (Radix)
```tsx
<Collapsible.Root open={expanded} onOpenChange={setExpanded}>
  <Collapsible.Trigger asChild><button>...</button></Collapsible.Trigger>
  <Collapsible.Content>...</Collapsible.Content>
</Collapsible.Root>
```
Example: `project-navigation-panel.tsx:394-411`

### Action buttons
`Button variant="primary" size="sm"` with inline `<Spinner size={14} />` for loading.
Example: `commit-panel.tsx:268-270`

### Confirmation dialogs (AlertDialog)
`AlertDialog > AlertDialogHeader > AlertDialogBody > AlertDialogFooter` with Cancel + Action buttons.
Example: `commit-panel.tsx:285-314` (Discard All confirmation)

### Toasts
Must use `showAppToast()` from `app-toaster.ts`, never `toast` directly.
For action buttons: sonner's `action` property (see `use-linked-backlog-task-actions.ts:272-283`)

### tRPC route structure
Three layers: schema (api-contract.ts) → context interface (app-router.ts) → implementation (workspace-api.ts)

### Git operation error handling
`runGit(cwd, args)` from `git-utils.ts:36` returns `{ok, stdout, stderr, output}`.
Domain functions return `{ok, error?, ...data}`. workspace-api.ts wraps in try/catch.
After success: `broadcastRuntimeWorkspaceStateUpdated`.

### Zod schema convention
```ts
export const runtimeFooSchema = z.object({ ... });
export type RuntimeFoo = z.infer<typeof runtimeFooSchema>;
```

## Design Decision: Stash Count vs Full List in Metadata Polling

**Option A**: Include only `stashCount: number` in metadata polling. Fetch full stash list on-demand when commit panel opens.
- Pro: Minimal overhead on the 2-10s polling cycle (just `git stash list | wc -l`)
- Pro: Badge count updates automatically
- Con: Stash list not immediately available when panel opens (needs a fetch)

**Option B**: Include full `stashEntries: StashEntry[]` in metadata polling.
- Pro: Immediate display when panel opens
- Con: Extra data on every poll tick, even when commit panel is closed

**Recommendation**: Option A — stash count in metadata polling, full list fetched on-demand. The badge count is what matters for the collapsed section header, and the full list is only needed when the section is expanded.
