# Branch Display Desync on Task Cards

**Date**: 2026-04-08  
**Context**: The branch name shown on task cards gets out of sync with the actual branch the agent is on. Other metadata (file count, additions/deletions) updates correctly in real-time.

---

## Root Cause

The branch display uses a different precedence than every other live metadata field.

### How other fields work (correct)

File count, additions, and deletions read directly from `reviewWorkspaceSnapshot`, which is updated every ~1 second by the server-side metadata monitor polling git state:

```tsx
// board-card.tsx — always shows live data
const reviewChangeSummary = reviewWorkspaceSnapshot
    ? { filesLabel: ..., additions: ..., deletions: ... }
    : null;
```

### How the branch works (broken)

The branch prioritizes the persisted `card.branch` value over live metadata:

```tsx
// board-card.tsx:258
const effectiveBranch = card.branch ?? reviewWorkspaceSnapshot?.branch ?? null;
```

Because `??` short-circuits on the first non-nullish value, a stale `card.branch` string will always win over the correct `reviewWorkspaceSnapshot?.branch`.

---

## Why card.branch becomes stale

`card.branch` is updated by `reconcileTaskBranch` (in `board-state.ts`), which runs via a `subscribeToAnyTaskMetadata` subscription in `App.tsx:278-291`. The reconciliation fires when the metadata store emits a change, then updates the board via `setBoard`. The updated board is persisted to the server after a 120ms debounce.

The race condition:

1. Metadata monitor detects a branch change → broadcasts `workspace_metadata_updated`
2. UI reconciles `card.branch` in React state via `setBoard`
3. **Before** the 120ms persist debounce fires, a `workspace_state_updated` arrives with a different revision (e.g., from a worktree migration via `mutateWorkspaceState`)
4. `applyWorkspaceState` sees a higher revision → `shouldHydrateBoard = true` → replaces the entire board from the server-side disk snapshot
5. The disk snapshot still has the **old** `card.branch` (UI hadn't persisted yet)
6. No new `workspace_metadata_updated` arrives (git state didn't change since the last poll) → the reconciliation subscription doesn't re-fire
7. `card.branch` stays stale indefinitely until the next git change triggers a metadata update

---

## Affected Locations

The same `card.branch ?? liveMetadata?.branch` precedence exists in three places:

| File | Line | Context |
|------|------|---------|
| `web-ui/src/components/board-card.tsx` | 258 | Card branch label on the board |
| `web-ui/src/components/card-detail-view.tsx` | 686 | DiffToolbar branch in changes panel |
| `web-ui/src/components/card-detail-view.tsx` | 791 | DiffToolbar branch in expanded diff view |

---

## Fix

Flip the precedence in all three locations so live metadata takes priority, with the persisted card value as fallback:

```tsx
// Before (card.branch wins — can be stale)
card.branch ?? reviewWorkspaceSnapshot?.branch ?? null
selection.card.branch ?? taskWorkspaceInfo?.branch ?? null

// After (live metadata wins — always current)
reviewWorkspaceSnapshot?.branch ?? card.branch ?? null
taskWorkspaceInfo?.branch ?? selection.card.branch ?? null
```

### Scenario validation

| Scenario | snapshot.branch | card.branch | Before | After |
|----------|----------------|-------------|--------|-------|
| In sync | `"feat/new"` | `"feat/new"` | `"feat/new"` | `"feat/new"` |
| Stale card (the bug) | `"feat/new"` | `"feat/old"` | `"feat/old"` **wrong** | `"feat/new"` **fixed** |
| Detached HEAD | `null` | `"feat/old"` | `"feat/old"` | `"feat/old"` (fallback) |
| Backlog / no metadata | N/A (`null`) | `"feat/old"` | `"feat/old"` | `"feat/old"` (fallback) |
| Worktree deleted | `null` | `"feat/old"` | `"feat/old"` | `"feat/old"` (fallback) |
| No branch anywhere | `null` | `undefined` | `null` | `null` |

The only changed behavior is the "stale card" row — the actual bug.

---

## What this doesn't change

- **`reconcileTaskBranch` stays**: Still needed to persist `card.branch` to disk (so it's correct on reload and available as a fallback). The race condition in the reconciliation cycle still exists but is no longer user-visible.
- **Server-side worktree creation unaffected**: `runtime-api.ts:115` reads `existingCard?.branch` from the persisted board on disk — this is a separate read path from the display.
- **`DiffToolbar` uses branch for display only**: Tooltip text and label, no logic branches on the value.
- **Existing `reconcileTaskBranch` tests unaffected**: Unit tests remain valid since the reconciliation write path is unchanged.

---

## Related code

- `src/server/workspace-metadata-monitor.ts` — Polls git state every 1 second, broadcasts `workspace_metadata_updated`
- `web-ui/src/stores/workspace-metadata-store.ts` — `replaceWorkspaceMetadata` updates both `taskWorkspaceInfoByTaskId` and `taskWorkspaceSnapshotByTaskId`
- `web-ui/src/App.tsx:278-291` — `subscribeToAnyTaskMetadata` listener that calls `reconcileTaskBranch`
- `web-ui/src/state/board-state.ts:559-605` — `reconcileTaskBranch` implementation
- `web-ui/src/hooks/use-workspace-sync.ts:118-123` — `shouldHydrateBoard` logic that can replace the board
