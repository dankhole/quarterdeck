# Research: Interactive Diff Base Ref Switcher

**Date**: 2026-04-07
**Branch**: HEAD (detached)

## Research Question

How can we improve the diff viewer by allowing the user to change what branch it diffs against, instead of the comparison being locked to the card's `baseRef` at creation time? Investigate a robust solution that ties into existing infrastructure.

## Summary

Today the diff viewer compares a task's worktree changes against the `baseRef` that was set when the card was created (e.g. `main`). This ref is baked into `BoardCard.baseRef` and flows unchanged through the entire pipeline — from the frontend hook, through the tRPC call, down to the `git diff` commands on the server. The comparison label in the `DiffToolbar` (added in `f7038f4`) already shows `branch → baseRef` but is purely static.

The infrastructure to make this interactive is largely already in place: a reusable `BranchSelectDropdown` component exists for task creation dialogs, the backend already accepts arbitrary refs via the `baseRef` parameter on the `workspace.getChanges` endpoint, and the `getWorkspaceChangesFromRef()` function diffs any ref against the working tree. The main work is (1) adding a "comparison ref override" concept to the frontend that defaults to `card.baseRef` but can be temporarily changed per-session, and (2) wiring the existing `BranchSelectDropdown` into the `DiffToolbar` in place of the static label.

## Detailed Findings

### 1. Current Diff Pipeline (end-to-end)

The diff data flow today:

```
BoardCard.baseRef (set at creation)
  ↓
CardDetailView reads selection.card.baseRef
  ↓
useRuntimeWorkspaceChanges(taskId, workspaceId, baseRef, mode, ...)
  ↓
trpcClient.workspace.getChanges.query({ taskId, baseRef, mode })
  ↓
workspace-api.ts: loadChanges()
  ↓
  mode === "working_copy" → getWorkspaceChanges(taskCwd)     // HEAD vs working tree
  mode === "last_turn"    → getWorkspaceChangesFromRef(...)   // checkpoint commit vs working tree
                          → getWorkspaceChangesBetweenRefs()  // checkpoint vs checkpoint
```

**Key observation**: In `working_copy` mode, the `baseRef` parameter is currently **not used for the actual git diff**. The function `getWorkspaceChanges()` always diffs `HEAD` vs working tree. The `baseRef` is only used for resolving the task's working directory (finding the right worktree). This means changing the comparison ref for `working_copy` mode would require using `getWorkspaceChangesFromRef()` instead of `getWorkspaceChanges()` when the override ref differs from `HEAD`.

In `last_turn` mode, `baseRef` is similarly used only for workspace resolution — the actual diff refs come from turn checkpoints.

### 2. Where baseRef Lives

- **Card schema** (`api-contract.ts:127`): `baseRef: z.string()` — required field on `RuntimeBoardCard`
- **Board state** (`board-state.ts`): Validated as non-empty string at parse time
- **Worktree creation** (`task-worktree.ts:436`): `ensureTaskWorktreeIfDoesntExist()` uses `baseRef` to `git rev-parse --verify {baseRef}^{commit}` and create the worktree from that commit
- **Workspace metadata** (`api-contract.ts:311`): `RuntimeTaskWorkspaceMetadata` includes `baseRef`

The `baseRef` on the card serves two distinct purposes:
1. **Worktree creation anchor** — which commit the worktree branch starts from
2. **Diff comparison target** — what to compare changes against

These should be decoupled for the feature to work. The card's `baseRef` should remain the worktree anchor, while the diff comparison ref should be independently selectable.

### 3. Backend Diff Functions Already Support Arbitrary Refs

`src/workspace/get-workspace-changes.ts` already has all three variants needed:

| Function | Signature | What it diffs |
|----------|-----------|---------------|
| `getWorkspaceChanges(cwd)` | HEAD vs working tree | Current default for `working_copy` |
| `getWorkspaceChangesFromRef({cwd, fromRef})` | `fromRef` vs working tree | Already used for `last_turn` running |
| `getWorkspaceChangesBetweenRefs({cwd, fromRef, toRef})` | `fromRef` vs `toRef` | Already used for `last_turn` done |

`getWorkspaceChangesFromRef` is the exact function needed — it diffs an arbitrary ref against the working tree, including untracked files. No new backend diff functions are required.

### 4. The tRPC Endpoint Already Accepts Any Ref

The `workspace.getChanges` procedure (`app-router.ts:377`) accepts `{ taskId, baseRef, mode }` where `baseRef` is a `z.string()`. The server does not validate that `baseRef` matches the card — it's used only for workspace directory resolution. The actual diff comparison ref could be passed as an additional parameter.

### 5. Existing Branch Selection Infrastructure

**`BranchSelectDropdown`** (`web-ui/src/components/branch-select-dropdown.tsx`):
- Wraps `SearchSelectDropdown` with a `GitBranch` icon
- Supports fuzzy search via `fzf`
- Takes `BranchSelectOption[]` (value/label pairs)
- Used in `TaskCreateDialog` and `TaskInlineCreateCard` for setting `baseRef` at creation

**`useTaskBranchOptions`** (`web-ui/src/hooks/use-task-branch-options.ts`):
- Derives options from `RuntimeGitRepositoryInfo` (from workspace state)
- Puts currentBranch first, then default branch, then others
- Returns `{ branchOptions, defaultTaskBranchRef }`

**`SearchSelectDropdown`** (`web-ui/src/components/search-select-dropdown.tsx`):
- Built on `@radix-ui/react-popover`
- Full keyboard navigation, fuzzy search, selected indicator
- `matchTargetWidth` option for sizing

### 6. The DiffToolbar Comparison Label

Defined inline in `card-detail-view.tsx` (lines 112-187), the `DiffToolbar` component renders a static label:

```tsx
<div className="inline-flex items-center gap-1 ...">
    <GitCompareArrows size={12} />
    <span>{branch ?? "working copy"}</span>
    <ArrowRight size={10} />
    <span>{baseRef}</span>
</div>
```

This label receives `baseRef` and `branch` as props from `CardDetailView`. Making the `baseRef` portion clickable/interactive is the UI entry point for the feature.

### 7. Two Branch Data Sources

| Source | Data shape | Scope | Where used |
|--------|-----------|-------|------------|
| `RuntimeGitRepositoryInfo.branches` | `string[]` (local names only) | Workspace root repo | Task creation dialogs |
| `getGitRefs()` → `RuntimeGitRef[]` | Rich objects with type, hash, upstream, ahead/behind | Any repo (workspace or worktree) | Git history view |

For the diff comparison switcher, the simpler `branches` array from workspace state is sufficient — it's already available in the component tree and powers the existing `BranchSelectDropdown`. Remote refs could be added later.

## Proposed Approach

### Option A: Frontend-Only Override (Recommended)

Add a `comparisonRef` state to `CardDetailView` that defaults to `card.baseRef` but can be overridden via the toolbar dropdown. This override is ephemeral (not persisted to the card) — it resets when switching tasks or refreshing.

**Changes needed:**

1. **`card-detail-view.tsx`**: Add `comparisonRef` state, wire it to `useRuntimeWorkspaceChanges` and `DiffToolbar`
2. **`DiffToolbar`** (inline in `card-detail-view.tsx`): Replace the static `baseRef` label with `BranchSelectDropdown` (or a compact variant)
3. **`workspace-api.ts`**: Add a `comparisonRef` parameter to `loadChanges()`. When present and different from `HEAD`, use `getWorkspaceChangesFromRef` instead of `getWorkspaceChanges` for `working_copy` mode
4. **`api-contract.ts`**: Add optional `comparisonRef: z.string().optional()` to `runtimeWorkspaceChangesRequestSchema`

**Advantages:**
- No mutation of persisted board state — avoids single-writer concerns
- Reuses existing `BranchSelectDropdown` and `useTaskBranchOptions`
- Backend already has `getWorkspaceChangesFromRef` — just needs a new code path in `loadChanges()`
- The override naturally resets on task switch (state scoped to `CardDetailView`)

### Option B: Persistent Card-Level Override

Add a `comparisonRef` field to `BoardCard` and persist it. This would survive page refreshes but requires board state mutation (single-writer concerns per AGENTS.md).

**Not recommended** because:
- Mutating `BoardCard.baseRef` would affect worktree creation, not just diffs
- Adding a separate `comparisonRef` to the card bloats the schema for what's essentially a UI preference
- Triggers the single-writer conflict risk documented in AGENTS.md

### Detailed Design for Option A

#### API Contract Change

```typescript
// api-contract.ts
export const runtimeWorkspaceChangesRequestSchema = z.object({
    taskId: z.string(),
    baseRef: z.string(),
    mode: z.enum(["working_copy", "last_turn"]).optional(),
    comparisonRef: z.string().optional(),  // NEW: override diff target
});
```

#### Server-Side Change (workspace-api.ts)

In `loadChanges()`, when `mode === "working_copy"`:
- If `comparisonRef` is provided and differs from the worktree HEAD, use `getWorkspaceChangesFromRef({ cwd: taskCwd, fromRef: comparisonRef })`
- Otherwise, keep existing behavior: `getWorkspaceChanges(taskCwd)`

For `last_turn` mode, `comparisonRef` would be ignored (checkpoints define the comparison).

#### Frontend Changes

```
CardDetailView
  ├── comparisonRef state (defaults to card.baseRef)
  ├── DiffToolbar
  │   └── BranchSelectDropdown (compact variant, replaces static label)
  │       ├── shows current comparisonRef
  │       └── onSelect → setComparisonRef
  └── useRuntimeWorkspaceChanges(taskId, wsId, card.baseRef, mode, ..., comparisonRef)
      └── passes comparisonRef to tRPC query
```

The `DiffToolbar` would need a compact trigger style for the dropdown — the current `BranchSelectDropdown` uses a full-width button, but here it should render as an inline pill/chip that opens on click.

#### Reset Behavior

- Switching tasks: `comparisonRef` resets to `card.baseRef` (natural React unmount/remount)
- Switching modes (working_copy ↔ last_turn): could optionally reset, or preserve the override
- A "Reset to default" option in the dropdown would restore `card.baseRef`

## Code References

- `src/core/api-contract.ts:25-30` — `runtimeWorkspaceChangesRequestSchema` (needs `comparisonRef` field)
- `src/core/api-contract.ts:117-131` — `runtimeBoardCardSchema` (baseRef is here, should not be modified)
- `src/trpc/workspace-api.ts:305-340` — `loadChanges()` (needs comparisonRef routing logic)
- `src/workspace/get-workspace-changes.ts:457-498` — `getWorkspaceChangesFromRef()` (already exists, key enabler)
- `src/workspace/get-workspace-changes.ts:366-422` — `getWorkspaceChanges()` (current default for working_copy)
- `web-ui/src/components/card-detail-view.tsx:112-187` — `DiffToolbar` component (needs interactive dropdown)
- `web-ui/src/components/card-detail-view.tsx:441` — `useRuntimeWorkspaceChanges` call site
- `web-ui/src/components/branch-select-dropdown.tsx` — Reusable branch selector (reuse for toolbar)
- `web-ui/src/hooks/use-task-branch-options.ts` — Branch option derivation hook (reuse as-is)
- `web-ui/src/runtime/use-runtime-workspace-changes.ts` — Workspace changes hook (needs comparisonRef param)
- `web-ui/src/components/search-select-dropdown.tsx` — Generic searchable dropdown (underlying primitive)
- `docs/planned-features.md:34` — This feature is already listed as a planned improvement

## Architecture & Patterns

- **Single-writer rule**: The recommended approach avoids mutating board state from the server, keeping the comparison ref as ephemeral frontend state
- **Existing reuse**: `BranchSelectDropdown` + `useTaskBranchOptions` + `getWorkspaceChangesFromRef` cover ~80% of the needed infrastructure
- **Cache invalidation**: The `useRuntimeWorkspaceChanges` hook builds a `requestKey` from all parameters — adding `comparisonRef` to the key will naturally trigger refetch on change
- **Backend flexibility**: The three `getWorkspaceChanges*` functions already handle any ref combination; the server just needs routing logic

## Related

- `docs/planned-features.md:34` — "Interactive base ref switcher" listed as planned feature
- `docs/research/2026-04-06-file-browser-and-detail-toolbar-improvements.md` — Related toolbar research

## Decisions

1. **Remote branches**: Yes, include them — but they should appear **last** in the dropdown, below local branches.
2. **Compact dropdown design**: Build a **new reusable compact branch dropdown** component. The existing `BranchSelectDropdown` (full toolbar button style) is not suitable for the inline pill/chip context.
3. **Tag support**: No. Not needed. *(Note: could be revisited later if requested.)*
4. **Last-turn mode**: Mark it as **partially supported** in the UI. Add a subtle indicator asking users to reach out if they use/like the feature — otherwise it may be cut in a future release.
5. **Override indicator UX**: When the comparison ref differs from the card's `baseRef`, show a **subtle color change** on the pill and a **small reset button** to restore the default.
