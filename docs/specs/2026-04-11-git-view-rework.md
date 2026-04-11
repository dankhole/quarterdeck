# Git View Rework

**Date**: 2026-04-11
**Status**: Draft
**Depends on**: Dual-selection sidebar rework (shipped), file browser & scope bar (shipped), project switcher sidebar (shipped)
**Addresses**: Todo #4 (diffing portion), Todo #12 (interactive base ref switcher)
**Follow-ups**: Todo #27 (branch management in git view), Todo #28 (commit sidebar tab), Todo #29 ("compare against" context action)

## Problem

The diff viewer currently lives in the sidebar as the "Changes" tab (`SidebarId = "changes"`). This has several issues:

1. **Too cramped** — Diffs need horizontal space. The sidebar constrains file tree + diff content into a narrow panel, and "expanding" the diff takes over the full screen with no intermediate layout.
2. **Misleading tab name** — "All Changes" actually means uncommitted changes, and the `branch → baseRef` comparison label is inaccurate for that mode (it's just HEAD vs working tree).
3. **No branch-to-branch diffing** — There's no way to compare two arbitrary branches. The base ref switcher (todo #12) was designed as a small addition to the existing sidebar, but the real need is a proper comparison view.
4. **Task-scoped only** — The diff viewer only works when a task is selected. There's no way to view diffs on the home repo without selecting a task.

## Goal

Promote the diff viewer from a sidebar panel to a full **main view** called the **Git view**. This view has three internal tabs — **Uncommitted**, **Last Turn**, and **Compare** — with an integrated file tree panel. The Compare tab provides interactive branch-to-branch diffing with dual pill dropdowns, covering both todo #4's diffing scope and todo #12's base ref switcher.

## End State

### Toolbar change

```
┌─────────────┐
│  Home        │  main view: board + shortcuts
│  Terminal    │  main view: agent terminal
│  Files       │  main view: file content viewer
│  Git         │  main view: git diff viewer (NEW — replaces "Changes" sidebar)
│──────────────│  ← divider
│  Projects    │  sidebar: project list + agent chat
│  Board       │  sidebar: task column context
└─────────────┘
```

- `"git"` is added to `MainViewId`: `"home" | "terminal" | "files" | "git"`
- `"changes"` is removed from `SidebarId`: `"projects" | "task_column"`
- Icon: `GitCompareArrows` (from lucide-react), placed above the divider
- The git view icon inherits the existing Changes badge behavior (red for uncommitted, blue for unmerged)

### Layout

```
┌─────────────────────────────────────────────────────────┐
│  [Uncommitted]  [Last Turn]  [Compare]    [toolbar...]  │  ← tab bar
├────────────────┬────────────────────────────────────────┤
│                │                                        │
│   File tree    │        Diff content area               │
│   (toggleable) │        (DiffViewerPanel)               │
│                │                                        │
│                │                                        │
└────────────────┴────────────────────────────────────────┘
```

The file tree is an integrated left panel within the git view (not a sidebar tab). It is toggleable — the user can collapse it to give the diff full width.

---

## Hard Behavioral Constraints

These are non-negotiable requirements. All other details in this spec are implementation guidance that can flex.

### !1 — Git view is a main view, not a sidebar

The git view renders in the main content area, not the sidebar. Its icon is above the divider in the detail toolbar, conforming to all existing main view patterns (`MainViewId` type, filled-bg highlight, localStorage persistence). The `"changes"` sidebar tab is removed.

### !2 — Uncommitted tab is the default, with accurate naming

The first tab is named **"Uncommitted"** (not "All Changes"). It shows uncommitted changes (HEAD vs working tree). The misleading `branch → baseRef` comparison info line is removed from this tab — it's not a branch comparison, it's just uncommitted work.

### !3 — Last Turn tab is preserved as-is

The Last Turn tab continues to work exactly as it does today. It is the lowest priority in this work. If other features break Last Turn, that's acceptable for now — it should not block the rest of the implementation.

### !4 — Compare tab with dual pill dropdowns

The Compare tab is a branch-to-branch diff viewer with two pill dropdowns:

- **Left pill (source)**: Defaults to the task's working branch (or home repo's current branch if no task). This is the "what I'm looking at" side.
- **Right pill (target)**: Defaults to the task's base branch (e.g. `main`). If no task is selected, this starts blank — the user picks what to compare against.

Both pills use the existing `BranchSelectorPopover` component (or a compact variant of it). Branch list includes local and remote branches.

A **"Return to context"** button appears whenever either pill has been changed from its default. Clicking it resets both pills to their defaults.

### !5 — Browsing indicator on Compare tab

When the **left pill** (source branch) is changed away from the task's/home branch, the view enters **"Browsing"** mode — visually indicated the same way the file browser indicates browsing (purple accent, "Browsing" label). This means the user is looking at a different branch's changes, not their own.

When only the **right pill** (comparison target) is changed, the view is **not** in browsing mode. The user is still looking at their own branch, just comparing against a different target. The "Return to context" button is shown, but no "Browsing" indicator.

### !6 — Compare tab is parameterized and externally navigable

The Compare tab can be opened with pre-set branch parameters from other parts of the UI. This enables future entry points like "compare local against [branch]" (todo #29) without requiring the user to manually navigate and select branches.

When opened with parameters:
- If the source branch matches the task's/home branch, the view is in normal mode with the "Return to context" button visible (since the target was set externally).
- If the source branch does NOT match the task's/home branch, the view enters browsing mode per !5.

### !7 — Works without a task selected

When no task is selected, the git view operates on the **home repo** context:
- **Uncommitted tab**: Shows uncommitted changes in the home repo working tree.
- **Compare tab**: Left pill defaults to the home repo's current branch. Right pill starts blank — user selects what to compare against.
- **Last Turn tab**: Disabled or hidden (no task = no agent turns).

### !8 — Integrated file tree

The file tree is part of the git view layout, not a sidebar panel. It shows changed files for the active tab (uncommitted files, last turn files, or branch comparison files). It is toggleable (collapsible to give the diff full width) and resizable. Its width is persisted independently to localStorage.

---

## Detailed Behavior

### Tab bar

A horizontal tab bar at the top of the git view, left-aligned. Three tabs:

| Tab | Label | Default | Data source |
|-----|-------|---------|-------------|
| Uncommitted | `Uncommitted` | Yes (selected on open) | `getWorkspaceChanges(cwd)` — HEAD vs working tree |
| Last Turn | `Last Turn` | No | Existing last-turn checkpoint diffing (unchanged) |
| Compare | `Compare` | No | `getWorkspaceChangesFromRef` or `getWorkspaceChangesBetweenRefs` |

The tab bar also contains toolbar actions on the right side:
- File tree toggle button (show/hide the integrated file tree)
- Existing diff view controls that make sense in context (e.g., expand/collapse all)

### Uncommitted tab

Shows uncommitted changes in the current context (task worktree or home repo).

- **File tree**: Lists files with uncommitted changes, with diff stats (+/-).
- **Diff content**: Shows the unified diff for the selected file.
- **No comparison label**: Unlike the old "All Changes" tab, there is no `branch → baseRef` info line. The context is clear from the tab name.
- **Polling**: Refreshes on the existing poll interval to pick up new changes as the agent works.
- **Data flow**: Same as the existing `working_copy` mode in `useRuntimeWorkspaceChanges`, just re-homed into the git view.

### Last Turn tab

Preserved from the current implementation with minimal changes.

- Continues using the existing `last_turn` mode with checkpoint-based diffing.
- The turn selector (if any) stays as-is.
- **Disabled when no task is selected** (agent turns don't exist without a task).
- No new features, no new bugs. If this tab breaks during the rework, it's acceptable to ship with it degraded and fix in follow-up.

### Compare tab

The new branch-to-branch comparison view.

**Layout:**
```
┌──────────────────────────────────────────────────────────────────┐
│  [source-pill ▾]  →  [target-pill ▾]   [↩ Return to context]   │  ← comparison bar
├────────────────┬─────────────────────────────────────────────────┤
│   File tree    │   Diff content                                  │
│   (changed     │   (DiffViewerPanel)                            │
│    files)      │                                                 │
└────────────────┴─────────────────────────────────────────────────┘
```

**Comparison bar:**
- Left pill: Source branch (what you're diffing FROM). Defaults to task branch or home current branch.
- Arrow icon (`ArrowRight` or `GitCompareArrows`) between pills.
- Right pill: Target branch (what you're diffing AGAINST). Defaults to task base branch. Blank if no task.
- "Return to context" button: Appears when either pill deviates from defaults. Resets both to defaults.
- "Browsing: {branch}" label: Appears when left pill is not the task's/home branch (per !5).

**Pill dropdowns:**
- Reuse `BranchSelectorPopover` (existing component with FZF fuzzy search, local/remote grouping, worktree-locked indicators).
- If the existing popover is too large for inline pill use, create a compact variant that shares the same popover content but has a smaller trigger.

**Data source:**
- When both pills are set: `getWorkspaceChangesBetweenRefs({ cwd, fromRef: target, toRef: source })` — note: git diff direction means "from target to source" shows what source added relative to target.
- The backend `workspace.getChanges` endpoint needs a new parameter (or a new endpoint) to support arbitrary ref-to-ref diffing without requiring a task. See Backend Changes section.

**Empty states:**
- Right pill blank (no task, user hasn't picked a target): Show a message like "Select a branch to compare against."
- No changes between branches: Show "No differences between {source} and {target}."

### Context resolution

The git view needs to know its operating context even though it's a main view, not tied to a sidebar selection:

| State | Context | Left pill default | Right pill default |
|-------|---------|-------------------|---------------------|
| Task selected | Task worktree | Task's working branch | Task's `baseRef` |
| No task selected | Home repo | Home current branch | (blank) |

When switching tasks, the Compare tab resets its pills to the new task's defaults (same pattern as scope bar reset on task change).

When switching projects, all git view state resets (same cleanup path as existing scope bar / file browser project switch cleanup).

### Auto-coupling rules

When the git view is opened:
- If a task is selected, the git view shows that task's context by default.
- If no task is selected, it shows the home repo context.

When a task is selected while the git view is active:
- The Uncommitted tab switches to the new task's uncommitted changes.
- The Compare tab resets pills to the new task's branch defaults.
- The Last Turn tab becomes available.

When a task is deselected while the git view is active:
- The Uncommitted tab switches to home repo uncommitted changes.
- The Compare tab resets — left pill to home branch, right pill blank.
- The Last Turn tab becomes disabled.

### Badge on Git icon

The git view toolbar icon inherits the badge behavior from the old Changes sidebar tab:
- **Red badge**: Uncommitted changes exist in the selected task's worktree (or home repo if no task).
- **Blue badge**: Unmerged changes (task branch has commits not on base branch).
- Badge data flows through the same `useTaskWorkspaceSnapshotValue` path as today.

---

## Backend Changes

### New: Workspace-scoped diff endpoint (or extended existing)

The current `workspace.getChanges` endpoint requires `taskId`. The git view needs to diff in two new contexts:

1. **Home repo uncommitted changes** (no task): Same as `getWorkspaceChanges(workspacePath)` but without task resolution.
2. **Arbitrary ref-to-ref comparison** (Compare tab): `getWorkspaceChangesBetweenRefs({ cwd, fromRef, toRef })` against either the task worktree or home repo.

**Approach**: Extend the existing `workspace.getChanges` endpoint to accept nullable `taskId` and optional `fromRef`/`toRef` parameters (same pattern used for `listFiles` in the file browser rework):

```typescript
export const runtimeWorkspaceChangesRequestSchema = z.object({
   taskId: z.string().nullable(),     // null = home repo
   baseRef: z.string().optional(),    // only needed for task resolution
   mode: z.enum(["working_copy", "last_turn"]).optional(),
   fromRef: z.string().optional(),    // Compare tab: target branch
   toRef: z.string().optional(),      // Compare tab: source branch
});
```

Server-side routing in `loadChanges()`:
- `taskId === null` + no `fromRef`/`toRef`: `getWorkspaceChanges(workspacePath)` (home uncommitted)
- `taskId === null` + `fromRef` + `toRef`: `getWorkspaceChangesBetweenRefs({ cwd: workspacePath, fromRef, toRef })` (home branch comparison)
- `taskId` set + no `fromRef`/`toRef`: existing behavior (task uncommitted or last turn)
- `taskId` set + `fromRef` + `toRef`: `getWorkspaceChangesBetweenRefs({ cwd: taskCwd, fromRef, toRef })` (task branch comparison)

### Input sanitization

`fromRef` and `toRef` must not start with `-` and must not contain `..` (same validation as `ref` in the file browser's `listFilesAtRef`).

---

## Frontend Changes

### New: `MainViewId` update

**File**: `web-ui/src/resize/use-card-detail-layout.ts`

```typescript
export type MainViewId = "home" | "terminal" | "files" | "git";
```

### Remove: `"changes"` from `SidebarId`

**File**: `web-ui/src/resize/use-card-detail-layout.ts`

```typescript
export type SidebarId = "projects" | "task_column";
```

Migration: If localStorage has `"changes"` as the saved sidebar, map it to `sidebar: "task_column"` (or `null`) and set `mainView: "git"`.

### New: Git view component

**File**: `web-ui/src/components/git-view.tsx` (new)

Top-level component rendered by App.tsx when `mainView === "git"`. Owns:
- Internal tab state (`"uncommitted" | "last_turn" | "compare"`)
- Compare tab pill state (source ref, target ref)
- File tree toggle and resize state
- File selection state (which file's diff is shown)

Renders:
- Tab bar with Uncommitted / Last Turn / Compare
- Integrated file tree panel (left, toggleable)
- Diff content area (right, `DiffViewerPanel`)
- Compare bar (only in Compare tab)

### New: `useGitViewContext` hook

**File**: `web-ui/src/hooks/use-git-view-context.ts` (new)

Manages the git view's derived context:
- Resolves operating context (task vs home) from selection state
- Manages Compare tab pill defaults and reset behavior
- Manages browsing state (per !5)
- Exposes `openCompareTab(sourceRef?, targetRef?)` for external navigation (per !6)

### Extracted: Diff components from CardDetailView

The following are currently rendered inside `CardDetailView` when `sidebar === "changes"`:
- `DiffToolbar` (inline in `card-detail-view.tsx`)
- `FileTreePanel` usage with diff file data
- `DiffViewerPanel` usage

These move into the git view component. `CardDetailView` loses its changes sidebar rendering entirely.

### Updated: DetailToolbar

**File**: `web-ui/src/components/detail-panels/detail-toolbar.tsx`

- Add `"git"` button above the divider with `GitCompareArrows` icon
- Remove `"changes"` button from below the divider
- Git button badge: same red/blue badge logic previously on Changes
- Git button enabled: always (works in both task and no-task contexts)

### Updated: App.tsx main content rendering

When `mainView === "git"`, render the new `GitView` component in the main content area. Pass it:
- Current task selection (card, workspace info) or null
- Home repo git info (current branch, workspace path)
- A callback for external navigation (so other components can open Compare with params)

### Updated: localStorage keys

**File**: `web-ui/src/storage/local-storage-store.ts`

- Add `GitViewFileTreePanelRatio` for the integrated file tree width
- Add `GitViewActiveTab` for persisting which internal tab was last active
- Existing `DetailDiffFileTreePanelRatio` and `DetailExpandedDiffFileTreePanelRatio` can be removed or repurposed

---

## Scope Exclusions

These are explicitly NOT part of this work:

- **Branch management** (switching, pulling, merging) — Todo #27, follow-up
- **Commit sidebar tab** (JetBrains-style commit panel) — Todo #28, follow-up
- **"Compare against" context action** (right-click on branches) — Todo #29, follow-up. The infrastructure (parameterized Compare tab entry, !6) is built here, but the UI entry points are deferred.
- **Server-side commit** from the diff viewer — Todo #11, follow-up (lives in #28)
- **Cherry-pick / land commits** — Todo #5, follow-up
- **Independent sidebar widths per panel** — Todo #21, follow-up
- **Performance optimization** for large diffs — Todo #3, separate concern
- **Markdown rendering** in file viewer — Todo #15, separate concern

---

## Migration & Backwards Compatibility

- Users who had `"changes"` as their active sidebar tab will be migrated to `mainView: "git"` on first load.
- The git view opens on the Uncommitted tab by default, which shows the same data as the old Changes sidebar — users see the same information, just in a better layout.
- The `isDiffExpanded` state (full-screen diff mode) may be removed or repurposed. The git view is always "expanded" in the sense that it has the full main content area. If retaining a "focus mode" (hide file tree, maximize diff), the file tree toggle serves this purpose.

---

## Verification Plan

### Toolbar & navigation
1. Git icon appears above the divider in the detail toolbar with `GitCompareArrows` icon
2. "Changes" no longer appears below the divider
3. Clicking Git icon switches main view to git view; sidebar (if open) is unaffected
4. Git icon shows red badge when uncommitted changes exist
5. Git icon shows blue badge when unmerged changes exist
6. Git icon is enabled even when no task is selected

### Uncommitted tab
7. Opens by default when entering the git view
8. Shows uncommitted changes for the selected task's worktree
9. With no task selected, shows uncommitted changes for the home repo
10. File tree shows changed files with diff stats
11. Selecting a file shows its diff in the content area
12. No `branch → baseRef` comparison info line is shown
13. Changes refresh on poll interval as agent works

### Last Turn tab
14. Shows the same last-turn checkpoint diff behavior as before
15. Disabled/hidden when no task is selected
16. Turn selector (if any) works as before

### Compare tab
17. Left pill defaults to task's working branch (or home current branch)
18. Right pill defaults to task's base branch (or blank if no task)
19. Both pills open branch selector with FZF search, local/remote grouping
20. Selecting branches in both pills shows the diff between them
21. "Return to context" button appears when either pill is changed from default
22. Clicking "Return to context" resets both pills to defaults and diff updates
23. Changing left pill away from task/home branch shows "Browsing" indicator
24. Changing only right pill does NOT show "Browsing" indicator
25. Empty state when right pill is blank: "Select a branch to compare against"
26. Empty state when no differences: "No differences between {source} and {target}"

### Context switching
27. Select a different task while on git view → Uncommitted shows new task's changes, Compare pills reset
28. Deselect task while on git view → switches to home repo context, Last Turn disabled
29. Switch projects → all git view state resets
30. Open git view with no task selected → Uncommitted shows home changes, Compare right pill blank

### File tree
31. File tree is integrated within the git view (not a sidebar)
32. File tree is toggleable (show/hide button in tab bar)
33. File tree is resizable (drag handle)
34. File tree width persists to localStorage independently
35. File tree content updates per active tab (uncommitted files vs compare files)

### External navigation (infrastructure for todo #29)
36. Calling `openCompareTab(targetRef)` from code switches to git main view, opens Compare tab, sets target pill to the given ref
37. Calling `openCompareTab(sourceRef, targetRef)` sets both pills; if source differs from task branch, shows browsing indicator

### Migration
38. User with `"changes"` in localStorage opens app → migrated to `mainView: "git"`, Uncommitted tab
39. Sidebar no longer shows "Changes" option — no broken UI from stale localStorage
