# Interactive Diff Base Ref Switcher — Implementation Plan

## Overview

Allow users to interactively change the branch that the diff viewer compares against, instead of being locked to the card's `baseRef` at creation time. The override is ephemeral (session-scoped, not persisted to the card), avoiding single-writer conflicts. This also introduces remote branch support in the branch data pipeline and a new compact branch dropdown component.

## Current State

- The diff viewer compares a task's worktree against `card.baseRef` which is set at card creation and never changes (`api-contract.ts:127`).
- In `working_copy` mode, `loadChanges()` (`workspace-api.ts:305-340`) ignores the `baseRef` param entirely — it always calls `getWorkspaceChanges(taskCwd)` which diffs HEAD vs working tree.
- `getWorkspaceChangesFromRef()` (`get-workspace-changes.ts:457-498`) already supports diffing an arbitrary ref against the working tree — it just isn't wired up for `working_copy` mode.
- The `DiffToolbar` (`card-detail-view.tsx:167-176`) renders a static pill: `{branch} → {baseRef}` with no interactivity.
- `detectGitBranches()` (`workspace-state.ts:456-473`) only fetches local branches (`refs/heads`). Remote branches are available via `getGitRefs()` (`git-history.ts:118-215`) but not exposed to task-creation or diff workflows.
- `useRuntimeWorkspaceChanges` (`use-runtime-workspace-changes.ts:14-118`) builds a request key from `workspaceId`, `taskId`, `baseRef`, `mode`, and `viewKey` — adding a new param will naturally trigger refetch.

## Desired End State

- The `baseRef` portion of the DiffToolbar comparison label is an interactive pill that opens a searchable branch dropdown.
- Users can select any local or remote branch to diff against. Remote branches appear last in the dropdown.
- When the comparison ref differs from the card's `baseRef`, the pill shows a blue tint and a reset (✕) button.
- The override resets automatically when switching tasks (React unmount).
- In `last_turn` mode, a small explanation box indicates the feature is partially supported and may be deprecated.
- A new `detectGitBranchesV2()` function fetches both local and remote branches; the old function is deprecated.

## Out of Scope

- **Tag support** in the dropdown — not needed per research decisions.
- **Persisting the comparison ref** to the card (Option B from research) — avoids single-writer conflicts.
- **Changing the worktree creation anchor** — `card.baseRef` retains its original purpose.
- **Modifying `last_turn` mode diff logic** — `comparisonRef` is ignored in `last_turn` mode since checkpoints define the comparison.

## Dependencies

- **Teams**: None — self-contained feature.
- **Services**: None — uses existing git CLI commands.
- **Data**: None — no migrations or schema changes to persisted state.
- **Timing**: None — can ship independently.

## Implementation Approach

Frontend-only override (Option A from research doc). A `comparisonRef` state variable in `CardDetailView` defaults to `card.baseRef` but can be temporarily changed via the toolbar dropdown. The backend gets a new optional `comparisonRef` field on the request schema that routes to `getWorkspaceChangesFromRef()` when provided. A new `CompactBranchDropdown` component provides the inline pill-style trigger. Remote branches are made available by creating `detectGitBranchesV2()` alongside the deprecated original.

---

## Phase 1: Backend — `comparisonRef` Support

### Overview

Add the `comparisonRef` parameter to the API contract and update the server-side diff routing to use it. Create `detectGitBranchesV2()` for remote branch support.

### Changes Required

#### 1. API Contract — Add `comparisonRef` Field

**File**: `src/core/api-contract.ts`
**Lines**: 25-29

Add `comparisonRef: z.string().optional()` to `runtimeWorkspaceChangesRequestSchema`:

```typescript
export const runtimeWorkspaceChangesRequestSchema = z.object({
   taskId: z.string(),
   baseRef: z.string(),
   mode: z.enum(["working_copy", "last_turn"]).optional(),
   comparisonRef: z.string().optional(),
});
```

The inferred `RuntimeWorkspaceChangesRequest` type will automatically pick up the new field.

#### 2. Server Diff Routing — Use `comparisonRef` in `working_copy` Mode

**File**: `src/trpc/workspace-api.ts`
**Lines**: 335-340 (the `working_copy` fallthrough at the end of `loadChanges`)

Replace the unconditional `getWorkspaceChanges(taskCwd)` call with:

```typescript
if (normalizedInput.comparisonRef) {
   return await getWorkspaceChangesFromRef({
      cwd: taskCwd,
      fromRef: normalizedInput.comparisonRef,
   });
}
return await getWorkspaceChanges(taskCwd);
```

When `comparisonRef` is provided, use `getWorkspaceChangesFromRef()` which diffs the specified ref against the working tree (including untracked files). When absent, preserve existing behavior.

Note: `normalizeRequiredTaskWorkspaceScopeInput` (lines 76-99) should pass through `comparisonRef` unchanged. Verify it doesn't strip unknown fields.

#### 3. Branch Detection V2 — Include Remote Branches

**File**: `src/state/workspace-state.ts`
**Lines**: 456-473

Add deprecation JSDoc to the existing `detectGitBranches()`:

```typescript
/**
 * @deprecated Use detectGitBranchesV2() which includes remote branches.
 * Kept for backwards compatibility with callers that only need local branches.
 */
```

Create `detectGitBranchesV2()` below it:

```typescript
function detectGitBranchesV2(cwd: string): { local: string[]; remote: string[] } {
   // Local branches: refs/heads
   const localResult = spawnSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd, ... });
   const local = localResult.stdout.toString().trim().split("\n").filter(Boolean);

   // Remote branches: refs/remotes, excluding HEAD pointers
   const remoteResult = spawnSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/remotes"], { cwd, ... });
   const remote = remoteResult.stdout.toString().trim().split("\n")
      .filter(name => name && !name.endsWith("/HEAD"));

   return { local, remote };
}
```

#### 4. Update `RuntimeGitRepositoryInfo` Schema

**File**: `src/core/api-contract.ts`
**Lines**: 155-160

Add an optional `remoteBranches` field to `runtimeGitRepositoryInfoSchema`:

```typescript
export const runtimeGitRepositoryInfoSchema = z.object({
   currentBranch: z.string().nullable(),
   defaultBranch: z.string().nullable(),
   branches: z.array(z.string()),
   remoteBranches: z.array(z.string()).optional(),
});
```

Optional so existing callers are unaffected.

#### 5. Wire V2 into Workspace State Loading

**File**: `src/state/workspace-state.ts`
**Function**: `detectGitRepositoryInfo()` (lines 492-508)

Switch from `detectGitBranches()` to `detectGitBranchesV2()` and populate both `branches` and `remoteBranches`:

```typescript
const { local, remote } = detectGitBranchesV2(cwd);
return {
   currentBranch,
   defaultBranch,
   branches: local,
   remoteBranches: remote,
};
```

### Success Criteria

#### Automated

- [ ] Typecheck passes: `npm run typecheck`
- [ ] Tests pass: `npm run test:fast`
- [ ] Lint passes: `npm run lint`

#### Manual

- [ ] Hit the `workspace.getChanges` endpoint with `comparisonRef` set to a valid branch — verify it returns a diff against that ref instead of HEAD.
- [ ] Hit the endpoint without `comparisonRef` — verify existing behavior is unchanged.
- [ ] Verify `remoteBranches` appears in the workspace state response when branches exist.

**Checkpoint**: Pause here for verification before proceeding to Phase 2.

---

## Phase 2: Frontend Hook + Data Plumbing

### Overview

Thread `comparisonRef` through the frontend data layer — the React hook, tRPC call, and branch options derivation.

### Changes Required

#### 1. Add `comparisonRef` to `useRuntimeWorkspaceChanges`

**File**: `web-ui/src/runtime/use-runtime-workspace-changes.ts`
**Lines**: 14-23 (signature), 26 (request key), 35-39 (tRPC call)

Add `comparisonRef` as a new parameter (after `viewKey`):

```typescript
export function useRuntimeWorkspaceChanges(
   taskId: string | null,
   workspaceId: string | null,
   baseRef: string | null,
   mode: RuntimeWorkspaceChangesMode = "working_copy",
   stateVersion = 0,
   pollIntervalMs: number | null = null,
   viewKey: string | null = null,
   clearOnViewTransition = true,
   comparisonRef?: string | null,    // NEW
): UseRuntimeWorkspaceChangesResult
```

Include in request key (line 26):

```typescript
const requestKey = `${workspaceId}:${taskId}:${baseRef}:${mode}:${normalizedViewKey}:${comparisonRef ?? "__default__"}`;
```

Pass to tRPC call (lines 35-39):

```typescript
return await trpcClient.workspace.getChanges.query({
   taskId,
   baseRef,
   mode,
   ...(comparisonRef ? { comparisonRef } : {}),
});
```

#### 2. Create `useDiffBranchOptions` Hook

**File**: `web-ui/src/hooks/use-diff-branch-options.ts` (new file)

A variant of `useTaskBranchOptions` that includes remote branches and is tailored for the diff toolbar context:

```typescript
export function useDiffBranchOptions(workspaceGit: RuntimeGitRepositoryInfo | null): {
   branchOptions: BranchSelectOption[];
}
```

Ordering:
1. Current branch first, labeled "(current)"
2. Default branch (e.g. `main`), labeled "(default)" if different from current
3. Remaining local branches alphabetically
4. Separator / section heading: "Remote"
5. Remote branches from `workspaceGit.remoteBranches`, alphabetically

Uses the `recommendedOptionValues` + `recommendedHeading` props on `SearchSelectDropdown` to create the local/remote sections, OR returns structured data that the `CompactBranchDropdown` can split into sections.

### Success Criteria

#### Automated

- [ ] Typecheck passes: `npm run web:typecheck`
- [ ] Web UI tests pass: `npm run web:test`

#### Manual

- [ ] Verify that changing `comparisonRef` in the hook call triggers a new tRPC request (can test via browser devtools network tab).

**Checkpoint**: Pause here for verification before proceeding to Phase 3.

---

## Phase 3: Compact Branch Dropdown Component

### Overview

Build a new `CompactBranchDropdown` component — a pill-styled trigger that opens a searchable branch picker. This is a reusable component, not a one-off for the DiffToolbar.

### Changes Required

#### 1. `CompactBranchDropdown` Component

**File**: `web-ui/src/components/compact-branch-dropdown.tsx` (new file)

**Props**:

```typescript
interface CompactBranchDropdownProps {
   options: BranchSelectOption[];
   remoteOptions?: BranchSelectOption[];
   selectedValue: string;
   defaultValue?: string;        // card.baseRef — used for override detection
   onSelect: (value: string) => void;
   onReset?: () => void;         // called when reset button clicked
   className?: string;
}
```

**Rendering**:
- Built on `SearchSelectDropdown` with heavy trigger customization via `buttonClassName` and `buttonStyle`.
- Trigger is styled as an inline pill matching the existing DiffToolbar aesthetic: `inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs cursor-pointer`.
- Shows a small `ChevronDown` (10px) after the branch name.
- When `selectedValue !== defaultValue` (override active):
  - Pill gets a blue tint: `bg-accent/15 text-accent` (using the accent token).
  - A small `X` reset button appears after the pill.
- Dropdown content: local branches first, then "Remote" section heading with remote branches.
- Uses `matchTargetWidth={false}` so the dropdown can be wider than the pill trigger.
- Uses fuzzy search from `SearchSelectDropdown` as-is.

**Key design decisions**:
- The trigger replaces only the `baseRef` text portion of the DiffToolbar pill — the `GitCompareArrows`, branch name, and arrow are still rendered by `DiffToolbar` around it.
- The reset button is outside the dropdown trigger to avoid accidental opens.

### Success Criteria

#### Automated

- [ ] Typecheck passes: `npm run web:typecheck`
- [ ] Lint passes: `npm run lint`

#### Manual

- [ ] Component renders as a compact inline pill in a test harness or Storybook-like setup.
- [ ] Dropdown opens on click, fuzzy search works, selection updates the pill text.
- [ ] Override indicator (blue tint) appears when a non-default branch is selected.
- [ ] Reset button restores the default value and removes the blue tint.

**Checkpoint**: Pause here for verification before proceeding to Phase 4.

---

## Phase 4: Wire into DiffToolbar + Last-Turn Notice

### Overview

Connect the new component into the actual `CardDetailView` and `DiffToolbar`, add the `comparisonRef` state management, and add the last-turn partial support notice.

### Changes Required

#### 1. Add `comparisonRef` State to `CardDetailView`

**File**: `web-ui/src/components/card-detail-view.tsx`
**Near line**: 441 (where `useRuntimeWorkspaceChanges` is called)

Add state that defaults to `card.baseRef` and resets on card change:

```typescript
const [comparisonRef, setComparisonRef] = useState(selection.card.baseRef);

// Reset when switching cards
useEffect(() => {
   setComparisonRef(selection.card.baseRef);
}, [selection.card.id, selection.card.baseRef]);
```

Pass to the hook:

```typescript
const { changes: workspaceChanges, isRuntimeAvailable } = useRuntimeWorkspaceChanges(
   selection.card.id,
   currentProjectId,
   selection.card.baseRef,
   diffMode,
   taskWorkspaceStateVersion,
   pollIntervalMs,
   lastTurnViewKey,
   true,
   comparisonRef,   // NEW
);
```

#### 2. Update `DiffToolbar` Props and Rendering

**File**: `web-ui/src/components/card-detail-view.tsx`
**Lines**: 112-187

Add new props to `DiffToolbar`:

```typescript
{
   // existing props...
   branchOptions: BranchSelectOption[];
   remoteBranchOptions: BranchSelectOption[];
   comparisonRef: string;
   defaultComparisonRef: string;    // card.baseRef
   onComparisonRefChange: (ref: string) => void;
   onComparisonRefReset: () => void;
}
```

Replace the static baseRef label (lines 167-176) with `CompactBranchDropdown`:

```tsx
<div className="inline-flex items-center gap-1 ml-1 px-1.5 py-0.5 rounded-md text-xs text-text-secondary bg-surface-1">
   <GitCompareArrows size={12} />
   <span>{branch ?? "working copy"}</span>
   <ArrowRight size={10} />
   <CompactBranchDropdown
      options={branchOptions}
      remoteOptions={remoteBranchOptions}
      selectedValue={comparisonRef}
      defaultValue={defaultComparisonRef}
      onSelect={onComparisonRefChange}
      onReset={onComparisonRefReset}
   />
</div>
```

#### 3. Wire Branch Options from `useDiffBranchOptions`

**File**: `web-ui/src/components/card-detail-view.tsx`

Call `useDiffBranchOptions` in `CardDetailView` and pass the options down to `DiffToolbar`:

```typescript
const { branchOptions } = useDiffBranchOptions(workspaceGit);
```

The `workspaceGit` (`RuntimeGitRepositoryInfo`) is already available in the component tree — trace how it flows from `useWorkspaceSync` or the workspace state stream.

#### 4. Last-Turn Mode Explanation Box

**File**: `web-ui/src/components/card-detail-view.tsx`
**In `DiffToolbar`**, when `mode === "last_turn"`:

Render a small info box below or beside the mode toggle buttons:

```tsx
{mode === "last_turn" && (
   <div className="flex items-center gap-1.5 ml-2 px-2 py-1 rounded-md text-[11px] text-text-tertiary bg-surface-1">
      <Info size={12} />
      <span>
         Last Turn view is experimental and may be removed.{" "}
         <a href="https://github.com/dankhole/quarterdeck/issues"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline">
            Let us know
         </a>{" "}
         if you find it useful.
      </span>
   </div>
)}
```

### Success Criteria

#### Automated

- [ ] Full build succeeds: `npm run build`
- [ ] All checks pass: `npm run check`
- [ ] Web UI tests pass: `npm run web:test`

#### Manual

- [ ] Open a task's detail view — the comparison label shows the card's `baseRef` in a clickable pill with a small chevron.
- [ ] Click the pill — a dropdown opens with local branches first, then remote branches under a "Remote" heading.
- [ ] Select a different branch — the diff updates to show changes against that branch; the pill turns blue; a reset (✕) button appears.
- [ ] Click reset — the diff reverts to comparing against `card.baseRef`; the blue tint disappears.
- [ ] Switch to a different task — the comparison ref resets to that card's `baseRef`.
- [ ] Switch to "Last Turn" mode — the explanation box appears with a link to the issues page.
- [ ] The comparison ref dropdown is disabled or hidden in "Last Turn" mode (since checkpoints define the diff).
- [ ] Page refresh — the override is gone, back to `card.baseRef` (ephemeral state confirmed).

**Checkpoint**: Feature complete — run full validation.

---

## Risks

- **Invalid ref selection**: User selects a branch that doesn't exist in the worktree's remote. `getWorkspaceChangesFromRef` will fail with a git error. **Mitigation**: Catch the error in `loadChanges()` and return an empty response with an error message that the UI can display (e.g. "Branch not found in this worktree").
- **Performance with many remote branches**: Repos with hundreds of remote branches could make the dropdown slow. **Mitigation**: `SearchSelectDropdown` already uses `fzf` fuzzy search which is fast; the popover virtualizes if needed. Monitor and add virtualization later if needed.
- **Stale branch list**: The branch list only refreshes on workspace state changes, not continuously. A newly pushed remote branch won't appear until the next state refresh. **Mitigation**: Acceptable for v1 — the 1-second metadata poller triggers state updates on git changes, and users can refresh manually.

## References

- Research doc: `docs/research/2026-04-07-interactive-diff-base-ref-switcher.md`
- Planned features: `docs/planned-features.md:34`
- API contract: `src/core/api-contract.ts:25-29` (request schema), `155-160` (git repo info schema)
- Server diff routing: `src/trpc/workspace-api.ts:305-340`
- Core diff functions: `src/workspace/get-workspace-changes.ts:366-498`
- Branch detection: `src/state/workspace-state.ts:456-508`
- DiffToolbar: `web-ui/src/components/card-detail-view.tsx:112-187`
- Hook call site: `web-ui/src/components/card-detail-view.tsx:441-450`
- Frontend hook: `web-ui/src/runtime/use-runtime-workspace-changes.ts:14-118`
- Branch dropdown: `web-ui/src/components/branch-select-dropdown.tsx`
- Search dropdown: `web-ui/src/components/search-select-dropdown.tsx`
- Branch options hook: `web-ui/src/hooks/use-task-branch-options.ts`
- Git refs (remote branch source): `src/workspace/git-history.ts:118-215`
