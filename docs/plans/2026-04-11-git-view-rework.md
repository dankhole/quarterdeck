# Git View Rework — Implementation Plan

**Date**: 2026-04-11
**Spec**: `docs/specs/2026-04-11-git-view-rework.md`
**Total phases**: 7 (Backend → Data hooks → Layout → Shell → Uncommitted → Compare → Cleanup)

## Architecture Summary

The diff viewer moves from a sidebar panel (`SidebarId = "changes"`) to a main view (`MainViewId = "git"`). The new `GitView` component owns its own internal tab bar, integrated file tree, and all diff state that currently lives in `CardDetailView`. The backend gains nullable `taskId` + `fromRef`/`toRef` support for home-repo and branch-to-branch diffing.

---

## Phase 1: Backend — Nullable taskId + Ref-to-Ref Support

**Goal**: The `workspace.getChanges` endpoint accepts `taskId: null` (home repo) and optional `fromRef`/`toRef` (branch comparison). No frontend changes.

### T1.1 — Extend request schema

**File**: `src/core/api-contract.ts` (lines 25-30)

Current:
```typescript
export const runtimeWorkspaceChangesRequestSchema = z.object({
   taskId: z.string(),
   baseRef: z.string(),
   mode: z.enum(["working_copy", "last_turn"]).optional(),
});
```

Change to:
```typescript
export const runtimeWorkspaceChangesRequestSchema = z.object({
   taskId: z.string().nullable(),
   baseRef: z.string().optional(),
   mode: z.enum(["working_copy", "last_turn"]).optional(),
   fromRef: z.string().optional(),
   toRef: z.string().optional(),
});
```

The inferred `RuntimeWorkspaceChangesRequest` type auto-updates.

### T1.2 — Add ref validation utility

**File**: `src/workspace/get-workspace-changes.ts` (new function, near top)

```typescript
function validateRef(ref: string, label: string): void {
   if (ref.startsWith("-")) throw new Error(`Invalid ${label}: must not start with "-"`);
   if (ref.includes("..")) throw new Error(`Invalid ${label}: must not contain ".."`);
}
```

Same pattern as `listFilesAtRef` validation in the file browser.

### T1.3 — Refactor loadChanges for new code paths

**File**: `src/trpc/workspace-api.ts` (lines 288-326, the `loadChanges` function)

Current flow: `normalizeRequiredTaskWorkspaceScopeInput` → `resolveTaskWorkingDirectory` → branch on mode.

New flow with four code paths:

```typescript
loadChanges: async (workspaceScope, input) => {
   const mode = input.mode ?? "working_copy";

   // Path A: Ref-to-ref comparison (Compare tab)
   if (input.fromRef && input.toRef) {
      validateRef(input.fromRef, "fromRef");
      validateRef(input.toRef, "toRef");
      const cwd = input.taskId
         ? await resolveTaskWorkingDirectory({
              workspacePath: workspaceScope.workspacePath,
              taskId: input.taskId,
              baseRef: input.baseRef ?? "",
              mode,
           })
         : workspaceScope.workspacePath;
      return await getWorkspaceChangesBetweenRefs({ cwd, fromRef: input.fromRef, toRef: input.toRef });
   }

   // Path B: Home repo uncommitted (no task)
   if (!input.taskId) {
      return await getWorkspaceChanges(workspaceScope.workspacePath);
   }

   // Path C & D: Task-scoped (existing behavior, unchanged)
   const normalizedInput = normalizeRequiredTaskWorkspaceScopeInput(input);
   // ... rest of existing logic (resolveTaskWorkingDirectory, last_turn branching, etc.)
},
```

Key details:
- Path A handles both task-scoped and home-scoped ref-to-ref diffs
- Path B is new: home repo uncommitted changes (just `getWorkspaceChanges` against workspace root)
- Paths C & D are the existing `working_copy` and `last_turn` task-scoped flows — unchanged
- `normalizeRequiredTaskWorkspaceScopeInput` (lines 76-99) is only called for task-scoped paths where `taskId` is non-null, so it doesn't need modification

### T1.4 — Verify existing functions handle home repo paths

`getWorkspaceChanges`, `getWorkspaceChangesBetweenRefs`, and `getWorkspaceChangesFromRef` in `get-workspace-changes.ts` all take a `cwd` parameter and don't care whether it's a worktree or home repo. No changes needed — just verify with a manual test.

### Success criteria
- `npm run typecheck` passes
- `npm run test:fast` passes
- Manual: hit `workspace.getChanges` with `taskId: null` → returns home uncommitted changes
- Manual: hit with `fromRef: "main", toRef: "feat/x"` → returns branch diff

---

## Phase 2: Frontend Data Hooks — Extend for New Modes

**Goal**: `useRuntimeWorkspaceChanges` (or a new hook) supports nullable `taskId` and `fromRef`/`toRef`. No visual changes.

### T2.1 — Extend useRuntimeWorkspaceChanges

**File**: `web-ui/src/runtime/use-runtime-workspace-changes.ts` (89 lines)

Current guard (line 30-32):
```typescript
if (!taskId || !workspaceId || !baseRef) {
   throw new Error("Missing workspace scope.");
}
```

Change: The hook needs to support three modes:
1. **Task uncommitted** (existing): `taskId` + `baseRef` + `mode`
2. **Home uncommitted** (new): `taskId: null` + `workspaceId`
3. **Ref-to-ref compare** (new): `workspaceId` + `fromRef` + `toRef` (optional `taskId`)

New signature:
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
   fromRef?: string | null,    // NEW: Compare tab source
   toRef?: string | null,      // NEW: Compare tab target
): UseRuntimeWorkspaceChangesResult
```

Updated guard:
```typescript
// Need workspaceId always. Need either taskId+baseRef (task mode) or just workspaceId (home mode)
if (!workspaceId) {
   throw new Error("Missing workspace scope.");
}
```

Updated request key (line 26):
```typescript
const requestKey = `${workspaceId}:${taskId ?? "__home__"}:${baseRef ?? "__none__"}:${mode}:${normalizedViewKey}:${fromRef ?? ""}:${toRef ?? ""}`;
```

Updated tRPC call (lines 35-39):
```typescript
return await trpcClient.workspace.getChanges.query({
   taskId: taskId ?? null,
   baseRef: baseRef ?? undefined,
   mode,
   ...(fromRef ? { fromRef } : {}),
   ...(toRef ? { toRef } : {}),
});
```

### T2.2 — Verify polling works for home context

The existing polling logic (lines 77-87) uses `hasWorkspaceScope` which checks `taskId && workspaceId && baseRef`. This needs to change to just check `workspaceId`:

```typescript
const hasWorkspaceScope = !!workspaceId;
```

With the old guard, home-context queries would never poll. The new guard ensures uncommitted changes in the home repo are polled too.

### Success criteria
- `npm run web:typecheck` passes
- Existing call sites in CardDetailView continue to work (they still pass taskId + baseRef)
- New parameters are optional with no breaking changes

---

## Phase 3: Layout System — Add "git", Remove "changes"

**Goal**: The toolbar shows a Git icon above the divider and no longer shows Changes below the divider. Clicking Git sets `mainView: "git"`. No git view component yet — just the layout plumbing.

### T3.1 — Update types in use-card-detail-layout.ts

**File**: `web-ui/src/resize/use-card-detail-layout.ts` (line 14-15)

```typescript
export type MainViewId = "home" | "terminal" | "files" | "git";
export type SidebarId = "projects" | "task_column";
```

### T3.2 — Update migration logic

**File**: `web-ui/src/resize/use-card-detail-layout.ts`

`loadMainView()` (lines 54-63): Add migration for `"changes"` → `"git"`:
```typescript
case "changes": return "git";  // Old sidebar value → new main view
```

`loadSidebar()` (lines 75-86): Remove `"changes"` from valid values. If stored value is `"changes"`, map to `"task_column"`:
```typescript
case "changes": return "task_column";
```

`loadLastSidebarTab()` (lines 93-101): If stored value is `"changes"`, return `"task_column"`:
```typescript
if (value === "changes") return "task_column";
```

### T3.3 — Update auto-coupling rules

**File**: `web-ui/src/resize/use-card-detail-layout.ts`

`setMainView` (lines 168-177): Add `"git"` case — no special coupling (like "terminal" and "files", it doesn't deselect task or force a sidebar):
```typescript
case "git": break; // No auto-coupling — sidebar stays as-is
```

Auto-switch on task selection (lines 206-231): When a task is selected and mainView is "git", keep it on "git" (don't auto-switch to terminal). The git view works in both task and no-task contexts:
```typescript
// When task selected:
if (mainView === "home") {
   // existing: switch to terminal + task_column
} else if (mainView === "files" || mainView === "git") {
   // Keep current main view, just ensure a sidebar is open
}
```

When task deselected: if on "git", stay on "git" (don't switch to home). The git view remains useful for home repo context:
```typescript
// When task deselected:
if (mainView === "terminal") {
   setMainView("home"); // terminal needs a task
} else {
   // "home", "files", "git" all work without a task — stay put
}
```

### T3.4 — Update visualSidebar

**File**: `web-ui/src/resize/use-card-detail-layout.ts` (lines 198-204)

Currently `visualSidebar` returns `null` when `mainView === "files"` (file tree replaces sidebar). The git view has its own integrated file tree too, so add the same treatment:
```typescript
if (mainView === "files" || mainView === "git") return null;
```

### T3.5 — Remove isDiffExpanded

**File**: `web-ui/src/resize/use-card-detail-layout.ts`

The `isDiffExpanded` parameter to `useCardDetailLayout` is no longer needed — the git view is always in the main content area. Remove it from the hook's input interface. (The old `isDiffExpanded` state in App.tsx can be removed in Phase 7 cleanup.)

Note: this may need to happen in Phase 7 if CardDetailView still references it during the transition.

### T3.6 — Update DetailToolbar

**File**: `web-ui/src/components/detail-panels/detail-toolbar.tsx`

Above divider — add Git button (after Files, lines 167-173):
```typescript
<MainViewButton
   viewId="git"
   activeMainView={activeMainView}
   onMainViewChange={onMainViewChange}
   icon={<GitCompareArrows size={18} />}
   label="Git"
   badgeColor={gitBadgeColor}
/>
```

Below divider — remove Changes button (lines 195-203): Delete the entire `<SidebarButton sidebarId="changes" .../>` block.

Update props interface (lines 8-18): Replace `hasUncommittedChanges`/`hasUnmergedChanges` with `gitBadgeColor`:
```typescript
interface DetailToolbarProps {
   // ... existing
   gitBadgeColor?: "red" | "blue";  // replaces hasUncommittedChanges + hasUnmergedChanges
   // remove: hasUncommittedChanges, hasUnmergedChanges
}
```

The badge logic moves to App.tsx (already computed there at lines 1223-1235). App.tsx derives `gitBadgeColor` and passes it directly.

### T3.7 — Add localStorage keys

**File**: `web-ui/src/storage/local-storage-store.ts`

```typescript
GitViewFileTreeRatio = "quarterdeck.git-view-file-tree-ratio",
GitViewActiveTab = "quarterdeck.git-view-active-tab",
```

Add `GitViewFileTreeRatio` to `LAYOUT_CUSTOMIZATION_LOCAL_STORAGE_KEYS` array (line 26-36).

### Success criteria
- `npm run web:typecheck` passes
- Toolbar shows Git icon above divider, no Changes below divider
- Clicking Git icon sets `mainView: "git"` (renders nothing yet — placeholder in Phase 4)
- Badge colors work on Git icon
- localStorage migration handles old `"changes"` value

---

## Phase 4: GitView Shell — Tab Bar + Integrated File Tree

**Goal**: A new `GitView` component that renders a tab bar and integrated file tree. No diff content yet — just the layout shell.

### T4.1 — Create GitView component

**File**: `web-ui/src/components/git-view.tsx` (new)

Props:
```typescript
interface GitViewProps {
   currentProjectId: string;
   selectedCard: CardSelection | null;  // null = home context
   sessionSummary: RuntimeSessionSummary | null;
}
```

Internal state:
```typescript
type GitViewTab = "uncommitted" | "last_turn" | "compare";

const [activeTab, setActiveTab] = useState<GitViewTab>(() => loadGitViewTab());
const [fileTreeVisible, setFileTreeVisible] = useState(true);
const [fileTreeRatio, setFileTreeRatio] = usePersistedRatio(
   LocalStorageKey.GitViewFileTreeRatio, 0.22, 0.12, 0.5
);
const [selectedPath, setSelectedPath] = useState<string | null>(null);
```

Layout:
```tsx
<div className="flex flex-col flex-1 min-h-0">
   {/* Tab bar */}
   <GitViewTabBar
      activeTab={activeTab}
      onTabChange={setActiveTab}
      isLastTurnDisabled={!selectedCard}
      fileTreeVisible={fileTreeVisible}
      onToggleFileTree={() => setFileTreeVisible(v => !v)}
   />

   {/* Content area: file tree + diff */}
   <div className="flex flex-1 min-h-0">
      {fileTreeVisible && (
         <>
            <FileTreePanel
               workspaceFiles={runtimeFiles}
               selectedPath={selectedPath}
               onSelectPath={setSelectedPath}
               panelFlex={`${fileTreeRatio} 1 0`}
            />
            <ResizeHandle ... />
         </>
      )}
      <div style={{ flex: `${1 - fileTreeRatio} 1 0`, minWidth: 0 }}>
         {/* Tab content rendered here — Phase 5, 6 */}
      </div>
   </div>
</div>
```

### T4.2 — Create GitViewTabBar component

**File**: `web-ui/src/components/git-view.tsx` (inline, or separate file if large)

A horizontal bar with three tabs + right-aligned toolbar actions:
```tsx
<div className="flex items-center gap-1 px-3 h-9 border-b border-border bg-surface-1 shrink-0">
   <TabButton active={activeTab === "uncommitted"} onClick={() => onTabChange("uncommitted")}>
      Uncommitted
   </TabButton>
   <TabButton active={activeTab === "last_turn"} onClick={() => onTabChange("last_turn")}
      disabled={isLastTurnDisabled}>
      Last Turn
   </TabButton>
   <TabButton active={activeTab === "compare"} onClick={() => onTabChange("compare")}>
      Compare
   </TabButton>

   <div className="flex-1" />

   {/* Right side: file tree toggle */}
   <Tooltip content={fileTreeVisible ? "Hide file tree" : "Show file tree"}>
      <button onClick={onToggleFileTree} ...>
         <PanelLeft size={14} />
      </button>
   </Tooltip>
</div>
```

Tab button styling: Active gets `bg-surface-3 text-text-primary`, inactive gets `text-text-secondary hover:text-text-primary hover:bg-surface-2`. Disabled gets `opacity-35 cursor-not-allowed`.

### T4.3 — Wire into App.tsx

**File**: `web-ui/src/App.tsx`

In the main content rendering section (around lines 1445-1484), add a branch for `mainView === "git"`:

**No-task context** (around line 1457):
```typescript
mainView === "git" ? (
   <GitView
      currentProjectId={currentProjectId}
      selectedCard={null}
      sessionSummary={null}
   />
) : mainView === "files" ? (
   // existing file viewer
```

**Task context** — GitView is rendered inside CardDetailView's main content area (see T4.4).

### T4.4 — Wire into CardDetailView

**File**: `web-ui/src/components/card-detail-view.tsx`

In the main content rendering (the "right column" area, around lines 674-800), add a branch for `mainView === "git"`:

```typescript
mainView === "git" ? (
   <GitView
      currentProjectId={currentProjectId}
      selectedCard={selection}
      sessionSummary={sessionSummary}
   />
) : /* existing terminal/file rendering */
```

This means GitView renders in the same position as the terminal or expanded file viewer — it fills the main content area.

### T4.5 — Reset state on context switches

In GitView, reset relevant state when the task or project changes:
```typescript
// Reset on task change
useEffect(() => {
   setSelectedPath(null);
   // Don't reset activeTab — user's tab choice persists across task switches
}, [selectedCard?.card.id]);

// Reset on project change
useEffect(() => {
   setSelectedPath(null);
   setActiveTab("uncommitted");
}, [currentProjectId]);
```

### Success criteria
- GitView renders when clicking the Git toolbar icon
- Tab bar shows three tabs, Last Turn disabled when no task
- File tree toggle works (show/hide)
- File tree width is resizable and persisted
- Switching tasks clears file selection

---

## Phase 5: Uncommitted Tab — Extract from CardDetailView

**Goal**: The Uncommitted tab shows the same data as the old Changes sidebar, rendered in the GitView shell. This is the core extraction.

### T5.1 — Wire useRuntimeWorkspaceChanges in GitView

**File**: `web-ui/src/components/git-view.tsx`

For the Uncommitted tab:
```typescript
const taskId = selectedCard?.card.id ?? null;
const baseRef = selectedCard?.card.baseRef ?? null;

const { changes: workspaceChanges, isRuntimeAvailable } = useRuntimeWorkspaceChanges(
   activeTab === "uncommitted" ? taskId : null,    // Only fetch when tab is active
   currentProjectId,
   baseRef,
   "working_copy",
   taskWorkspaceStateVersion,
   activeTab === "uncommitted" && isDocumentVisible ? 1000 : null,  // Poll only when active
   null,  // viewKey
   true,  // clearOnViewTransition
);

const runtimeFiles = workspaceChanges?.files ?? null;
```

The `taskWorkspaceStateVersion` comes from the workspace metadata store — derive it the same way CardDetailView does (from `useTaskWorkspaceSnapshotValue`).

For **home repo context** (`taskId === null`): The Phase 2 hook changes allow this to work — it calls `workspace.getChanges` with `taskId: null`, which hits Path B in the backend.

### T5.2 — Render DiffViewerPanel in content area

**File**: `web-ui/src/components/git-view.tsx`

In the tab content area:
```typescript
{activeTab === "uncommitted" && (
   isWorkspaceChangesPending ? (
      <WorkspaceChangesLoadingPanel />
   ) : hasNoWorkspaceFileChanges ? (
      <WorkspaceChangesEmptyPanel />
   ) : (
      <DiffViewerPanel
         workspaceFiles={runtimeFiles}
         selectedPath={selectedPath}
         onSelectedPathChange={setSelectedPath}
         viewMode="split"
         comments={diffComments}
         onCommentsChange={setDiffComments}
      />
   )
)}
```

Note: No `onAddToTerminal` / `onSendToTerminal` props — those are task-terminal specific and can be wired later if needed.

### T5.3 — Connect FileTreePanel to uncommitted data

The file tree already receives `workspaceFiles` from T4.1. When the uncommitted tab is active, it shows uncommitted files. When compare tab is active, it shows compared files. The `runtimeFiles` variable just needs to be derived from whichever tab is active:

```typescript
const activeFiles = useMemo(() => {
   if (activeTab === "uncommitted") return uncommittedChanges?.files ?? null;
   if (activeTab === "compare") return compareChanges?.files ?? null;
   if (activeTab === "last_turn") return lastTurnChanges?.files ?? null;
   return null;
}, [activeTab, uncommittedChanges, compareChanges, lastTurnChanges]);
```

### T5.4 — Remove "All Changes" / comparison info line

The old `DiffToolbar` rendered a `branch → baseRef` comparison badge (lines 153-162 of card-detail-view.tsx). This is not rendered in the Uncommitted tab — the tab name "Uncommitted" is self-explanatory.

### Success criteria
- Uncommitted tab shows the same diff data as the old Changes sidebar
- Works for both task context and home repo context
- File tree shows changed files with diff stats
- Polling refreshes data every 1s when tab is visible
- No comparison label shown

---

## Phase 6: Compare Tab — Dual Pills + Browsing

**Goal**: The Compare tab shows a branch-to-branch diff with two interactive pill dropdowns and a browsing indicator.

### T6.1 — Create useGitViewCompare hook

**File**: `web-ui/src/hooks/use-git-view-compare.ts` (new)

Manages the Compare tab's state:
```typescript
interface UseGitViewCompareOptions {
   selectedCard: CardSelection | null;
   currentProjectId: string;
   homeGitSummary: RuntimeGitSyncSummary | null;
}

interface UseGitViewCompareResult {
   sourceRef: string | null;       // Left pill value
   targetRef: string | null;       // Right pill value
   defaultSourceRef: string | null; // Task branch or home current branch
   defaultTargetRef: string | null; // Task baseRef or null
   setSourceRef: (ref: string) => void;
   setTargetRef: (ref: string) => void;
   resetToDefaults: () => void;
   isBrowsing: boolean;            // sourceRef !== defaultSourceRef
   hasOverride: boolean;           // either pill differs from default
   openWithParams: (source?: string, target?: string) => void;  // External navigation
}
```

Default derivation:
```typescript
const defaultSourceRef = selectedCard
   ? (taskWorkspaceInfo?.branch ?? selectedCard.card.baseRef)
   : (homeGitSummary?.currentBranch ?? null);

const defaultTargetRef = selectedCard
   ? selectedCard.card.baseRef
   : null;
```

Browsing state:
```typescript
const isBrowsing = sourceRef !== null && sourceRef !== defaultSourceRef;
```

Reset on task/project change:
```typescript
useEffect(() => {
   setSourceRef(defaultSourceRef);
   setTargetRef(defaultTargetRef);
}, [selectedCard?.card.id, currentProjectId]);
```

### T6.2 — Create CompareBar component

**File**: `web-ui/src/components/git-view.tsx` (inline) or `web-ui/src/components/git-view-compare-bar.tsx`

Renders above the diff content when Compare tab is active:
```tsx
<div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface-1 shrink-0">
   {isBrowsing && (
      <span className="text-[11px] font-medium text-status-purple">Browsing</span>
   )}

   {/* Source pill (left) */}
   <BranchSelectorPopover
      isOpen={sourcePopoverOpen}
      onOpenChange={setSourcePopoverOpen}
      branches={branches}
      currentBranch={sourceRef}
      worktreeBranches={worktreeBranches}
      onSelectBranchView={(ref) => setSourceRef(ref)}
      onCheckoutBranch={() => {}}  // No checkout from compare
      trigger={<BranchPillTrigger label={sourceRef ?? "select branch"} />}
   />

   <ArrowRight size={12} className="text-text-tertiary shrink-0" />

   {/* Target pill (right) */}
   <BranchSelectorPopover
      isOpen={targetPopoverOpen}
      onOpenChange={setTargetPopoverOpen}
      branches={branches}
      currentBranch={targetRef}
      worktreeBranches={worktreeBranches}
      onSelectBranchView={(ref) => setTargetRef(ref)}
      onCheckoutBranch={() => {}}
      trigger={<BranchPillTrigger label={targetRef ?? "select branch"} />}
   />

   {hasOverride && (
      <Tooltip content="Return to context">
         <button onClick={resetToDefaults} ...>
            <CornerDownLeft size={13} />
         </button>
      </Tooltip>
   )}
</div>
```

Note on `BranchSelectorPopover` reuse: The existing component's `onSelectBranchView` callback is used here to set the ref, even though we're not entering "branch view" mode in the scope-bar sense. The callback name is slightly misleading but the behavior (select a ref, close popover) is exactly what we need. If this feels wrong, we can add an `onSelectRef` alias.

Note on `BranchPillTrigger` reuse: This is already a standalone presentational component (lines 150-162 of branch-selector-popover.tsx). It renders a pill with git branch icon + label + chevron. Perfect for the Compare tab pills.

### T6.3 — Wire compare data fetching

**File**: `web-ui/src/components/git-view.tsx`

```typescript
const {
   changes: compareChanges,
   isRuntimeAvailable: compareAvailable,
} = useRuntimeWorkspaceChanges(
   activeTab === "compare" ? (selectedCard?.card.id ?? null) : null,
   currentProjectId,
   selectedCard?.card.baseRef ?? null,
   "working_copy",  // Mode doesn't matter for ref-to-ref
   0,               // No stateVersion polling
   null,            // No interval polling for compare (branches don't change mid-session)
   `compare:${sourceRef}:${targetRef}`,  // viewKey for caching
   true,
   targetRef,       // fromRef (what we're comparing against)
   sourceRef,       // toRef (what we're looking at)
);
```

The `fromRef`/`toRef` mapping: `fromRef` is the target (base of comparison, e.g. `main`), `toRef` is the source (what has changes, e.g. `feat/x`). This matches `git diff fromRef toRef` semantics — "show what toRef has that fromRef doesn't."

### T6.4 — Render compare content

**File**: `web-ui/src/components/git-view.tsx`

```typescript
{activeTab === "compare" && (
   <>
      <CompareBar ... />
      {!sourceRef || !targetRef ? (
         <EmptyState message="Select a branch to compare against." />
      ) : compareChanges?.files?.length === 0 ? (
         <EmptyState message={`No differences between ${sourceRef} and ${targetRef}.`} />
      ) : (
         <DiffViewerPanel
            workspaceFiles={compareChanges?.files ?? null}
            selectedPath={selectedPath}
            onSelectedPathChange={setSelectedPath}
            viewMode="split"
            comments={diffComments}
            onCommentsChange={setDiffComments}
         />
      )}
   </>
)}
```

### T6.5 — Branch data for pills

The branch list comes from the existing `workspace.getGitRefs` endpoint (already used by `BranchSelectorPopover` in the file browser). Use the same `useBranchActions` hook pattern from App.tsx (lines 323-331):

```typescript
const branchActions = useBranchActions({
   workspaceId: currentProjectId,
   board,
   selectBranchView: () => {},  // Not using scope-bar style browsing
   homeGitSummary,
   skipHomeCheckoutConfirmation: false,
   skipTaskCheckoutConfirmation: false,
});
```

Or just call the tRPC endpoint directly for the branch list — `useBranchActions` does more than we need (checkout confirmation, etc.). Evaluate which approach is cleaner.

### T6.6 — External navigation API

**File**: `web-ui/src/hooks/use-git-view-compare.ts`

The `openWithParams` function:
```typescript
const openWithParams = useCallback((source?: string, target?: string) => {
   if (source) setSourceRef(source);
   if (target) setTargetRef(target);
}, []);
```

This is called from outside the git view. For now, expose it via a ref or context that App.tsx can access. The actual entry points (right-click "compare against", etc.) are todo #29 — this phase just ensures the infrastructure exists.

### Success criteria
- Compare tab shows two pill dropdowns with branch names
- Selecting branches shows the diff between them
- Changing left pill shows "Browsing" indicator
- Changing either pill shows "Return to context" button
- Reset button clears both pills to defaults
- No task selected: left pill shows home branch, right pill blank with "Select a branch" message
- Task selected: left pill shows task branch, right pill shows base branch

---

## Phase 7: Last Turn Tab + Cleanup

**Goal**: Re-home the Last Turn tab, clean up CardDetailView, remove dead code.

### T7.1 — Wire Last Turn tab in GitView

**File**: `web-ui/src/components/git-view.tsx`

The Last Turn tab reuses the exact same data flow as today, just re-homed:
```typescript
const lastTurnViewKey = useMemo(() => {
   if (activeTab !== "last_turn" || !sessionSummary) return null;
   return [
      sessionSummary.state ?? "none",
      sessionSummary.latestTurnCheckpoint?.commit ?? "none",
      sessionSummary.previousTurnCheckpoint?.commit ?? "none",
   ].join(":");
}, [activeTab, sessionSummary]);

const { changes: lastTurnChanges } = useRuntimeWorkspaceChanges(
   activeTab === "last_turn" ? (selectedCard?.card.id ?? null) : null,
   currentProjectId,
   selectedCard?.card.baseRef ?? null,
   "last_turn",
   taskWorkspaceStateVersion,
   activeTab === "last_turn" && isDocumentVisible ? 1000 : null,
   lastTurnViewKey,
   true,
);
```

Render: Same DiffViewerPanel pattern as Uncommitted tab but with `lastTurnChanges`.

### T7.2 — Remove diff code from CardDetailView

**File**: `web-ui/src/components/card-detail-view.tsx`

Remove:
- `DiffToolbar` inline component (lines 108-173)
- `sidebar === "changes"` rendering block (lines 586-649)
- Expanded diff rendering block (lines 674-738)
- Diff-related state: `diffMode`, `selectedPath` (for diff), `diffComments` (lines 277-281)
- `useRuntimeWorkspaceChanges` call (lines 409-418)
- `runtimeFiles` derivation (line 419)
- `isWorkspaceChangesPending`, `hasNoWorkspaceFileChanges` (lines 420-422)
- `handleToggleDiffExpand` (lines 474-479)
- `DETAIL_DIFF_POLL_INTERVAL_MS` constant (line 38)
- `lastTurnViewKey` computation (lines 401-408)

Keep:
- Everything related to the terminal, file browser, column context panel
- The `isDiffExpanded` prop can be removed from the interface (no longer needed)

### T7.3 — Remove isDiffExpanded from App.tsx

**File**: `web-ui/src/App.tsx`

Remove:
- `isDiffExpanded` state (line 899)
- Reset effect (lines 902-904)
- Props to CardDetailView: `isDiffExpanded`, `onDiffExpandedChange`
- Escape key handler for diff expanded (lines 978-982)
- Sidebar visibility guard `{!isDiffExpanded ? (...)}` (line 1215) — sidebar is always visible now

### T7.4 — Update sidebar rendering in App.tsx

**File**: `web-ui/src/App.tsx`

The `sidebar === "changes"` case in the sidebar rendering (if it exists at the App.tsx level) needs to be removed. From the research, it doesn't appear to render at the App.tsx level — it was only in CardDetailView. But verify and clean up any references.

### T7.5 — Remove detailDiffFileTreeRatio from layout hook

**File**: `web-ui/src/resize/use-card-detail-layout.ts`

Remove:
- `collapsedDetailDiffFileTreeRatio` and `expandedDetailDiffFileTreeRatio` state
- `detailDiffFileTreeRatio` and `setDetailDiffFileTreeRatio` from the exported API
- `isDiffExpanded` from the input interface

**File**: `web-ui/src/storage/local-storage-store.ts`

The old keys (`DetailDiffFileTreePanelRatio`, `DetailExpandedDiffFileTreePanelRatio`) can be removed from the enum and the `LAYOUT_CUSTOMIZATION_LOCAL_STORAGE_KEYS` array. The git view uses its own `GitViewFileTreeRatio` key.

### T7.6 — Update badge computation in App.tsx

**File**: `web-ui/src/App.tsx` (lines 1223-1235)

Currently passes `hasUncommittedChanges` and `hasUnmergedChanges` as separate props. Change to pass a single `gitBadgeColor`:

```typescript
const gitBadgeColor: "red" | "blue" | undefined = useMemo(() => {
   if (!selectedCard) return undefined;
   if ((selectedTaskWorkspaceSnapshot?.changedFiles ?? 0) > 0) return "red";
   if (unmergedChangesIndicatorEnabled && selectedTaskWorkspaceSnapshot?.hasUnmergedChanges) return "blue";
   return undefined;
}, [selectedCard, selectedTaskWorkspaceSnapshot, unmergedChangesIndicatorEnabled]);
```

Pass to `DetailToolbar`:
```typescript
<DetailToolbar
   // ... existing
   gitBadgeColor={gitBadgeColor}
   // remove: hasUncommittedChanges, hasUnmergedChanges
/>
```

### Success criteria
- Last Turn tab works with same behavior as before
- CardDetailView no longer renders any diff-related UI
- No `isDiffExpanded` state anywhere
- No dead localStorage keys
- `npm run check && npm run build` passes
- Full manual verification per the spec's verification plan

---

## Dependency Graph

```
Phase 1 (Backend) ──→ Phase 2 (Hooks) ──→ Phase 5 (Uncommitted tab)
                                       ──→ Phase 6 (Compare tab)
                                       ──→ Phase 7.1 (Last Turn tab)

Phase 3 (Layout) ──→ Phase 4 (Shell) ──→ Phase 5 + 6 + 7.1

Phase 7.2-7.6 (Cleanup) depends on Phase 5 + 6 + 7.1 being complete
```

**Parallelizable**: Phase 1 and Phase 3 can start simultaneously (backend vs frontend layout).

**Critical path**: Phase 1 → Phase 2 → Phase 5 (getting the first tab working end-to-end).

---

## Risk Areas

1. **useRuntimeWorkspaceChanges changes**: This hook is used by CardDetailView. Changing its signature (adding optional params, loosening the guard) must not break the existing call site. The new params are optional with no breaking changes — but test thoroughly.

2. **CardDetailView extraction (Phase 7.2)**: Removing the diff code from a 831-line file that handles multiple concerns. Risk of breaking terminal, file browser, or column context panel rendering. Do this incrementally — remove one block at a time and verify.

3. **Branch data for Compare tab pills**: The `BranchSelectorPopover` needs `RuntimeGitRef[]` from the `workspace.getGitRefs` endpoint. This data is currently fetched in a few places (scope bar, git history). The git view needs its own fetch or a shared data source. Evaluate whether `useBranchActions` (App.tsx pattern) is the right hook to reuse.

4. **Polling behavior**: The uncommitted tab polls every 1s. The compare tab should NOT poll (branch diffs are stable). The last turn tab polls every 1s. Make sure the `pollIntervalMs` is correctly gated by `activeTab`.

5. **Auto-coupling on task select**: When a user has the git view open and clicks a task, they should stay on the git view (not auto-switch to terminal). This is a behavioral change from the current flow where clicking a task always shows the terminal. Need to update the auto-switch logic carefully.

---

## Files Modified (Complete List)

### Backend
| File | Change |
|------|--------|
| `src/core/api-contract.ts` | Nullable taskId, optional baseRef, add fromRef/toRef to request schema |
| `src/trpc/workspace-api.ts` | New code paths in loadChanges for null taskId and ref-to-ref |
| `src/workspace/get-workspace-changes.ts` | Add validateRef utility |

### Frontend — New Files
| File | Purpose |
|------|---------|
| `web-ui/src/components/git-view.tsx` | Main GitView component with tab bar, file tree, content |
| `web-ui/src/hooks/use-git-view-compare.ts` | Compare tab state management |

### Frontend — Modified Files
| File | Change |
|------|--------|
| `web-ui/src/runtime/use-runtime-workspace-changes.ts` | Add fromRef/toRef params, loosen taskId guard |
| `web-ui/src/resize/use-card-detail-layout.ts` | Add "git" to MainViewId, remove "changes" from SidebarId, update coupling |
| `web-ui/src/components/detail-panels/detail-toolbar.tsx` | Add Git button, remove Changes button, update props |
| `web-ui/src/storage/local-storage-store.ts` | Add new keys, remove old diff keys |
| `web-ui/src/App.tsx` | Render GitView for mainView==="git", update badge computation, remove isDiffExpanded |
| `web-ui/src/components/card-detail-view.tsx` | Remove all diff-related code (DiffToolbar, changes sidebar, expanded diff) |

### Frontend — Unchanged (Reused As-Is)
| File | Why unchanged |
|------|---------------|
| `web-ui/src/components/detail-panels/diff-viewer-panel.tsx` | Reused by GitView with same props |
| `web-ui/src/components/detail-panels/file-tree-panel.tsx` | Reused by GitView with same props |
| `web-ui/src/components/detail-panels/branch-selector-popover.tsx` | Reused for Compare tab pills |
| `web-ui/src/components/detail-panels/scope-bar.tsx` | Not used by git view (different UX) |
| `web-ui/src/hooks/use-scope-context.ts` | Not used by git view (Compare tab has its own state) |

---

## Plan Corrections Log

(Empty — no corrections yet.)
