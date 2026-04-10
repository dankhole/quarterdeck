# Dual-Selection Sidebar Rework

**Date**: 2026-04-10
**Status**: Draft (not yet implemented)
**Depends on**: `feat/project-switcher-sidebar` (commit `ea1ec7fc`, merged with main at `33ba7e33`)

## Problem

After adding the Projects tab to the sidebar toolbar, the toolbar has 6 items (Home, Projects, divider, Board, Changes, Files) but the mental model is unclear. Some tabs control what's in the **main content area** (Home shows the board, Files shows a file viewer) while others control what's in the **sidebar** (Board shows the column context panel, Changes shows the diff tree). The user can't independently choose a main view and a sidebar — it's a single selection that conflates both.

## Goal

Split the toolbar into two independent selections:
1. **Main view** — what fills the large content area (board, agent terminal, file viewer)
2. **Sidebar** — what fills the narrow left panel (project list, task column, diff tree)

This makes it obvious what each icon controls and enables combinations that aren't possible today (e.g., agent terminal + project list sidebar, or board view + diff sidebar).

## End State

### Toolbar layout

```
 ┌─────────────┐
 │  Home        │  main view: board + shortcuts
 │  Terminal    │  main view: agent terminal (NEW)
 │  Files       │  main view: file content viewer
 │──────────────│  ← divider
 │  Projects    │  sidebar: project list + agent chat
 │  Board       │  sidebar: task column context
 │  Changes     │  sidebar: diff tree + file changes
 └──────────────┘
```

**Above the divider**: Main view selectors (what fills the big area)
**Below the divider**: Sidebar selectors (what fills the narrow left panel)

### Two independent state dimensions

```
mainView:  "home" | "terminal" | "files"
sidebar:   "projects" | "task_column" | "changes" | null
```

Both are persisted independently to localStorage. Selecting one does not clear the other. The sidebar can be collapsed (null) by clicking the active sidebar tab again.

### Auto-coupling rules

Certain actions create natural pairings. These are defaults, not locks — the user can always override by clicking a different tab.

| Action | Main view | Sidebar | Rationale |
|--------|-----------|---------|-----------|
| App opens fresh (no task) | home | projects | Natural starting point |
| Click Home icon | home | projects | Home and projects go together |
| Click a task from board view | terminal | task_column | See the agent + its column context |
| Click a task from project list | terminal | (unchanged) | Projects sidebar stays open |
| Task deselected | home | projects | Return to overview |
| Click Terminal icon | terminal | (unchanged) | Don't disrupt sidebar |
| Click Files icon | files | (unchanged) | Don't disrupt sidebar |

### Sidebar behavior

- Clicking an active sidebar tab collapses the sidebar (sets to null)
- Clicking a different sidebar tab switches the sidebar content
- Sidebar is resizable (existing `sidePanelRatio` behavior)
- "Board" and "Changes" sidebar tabs are disabled when no task is selected (existing behavior)
- "Projects" sidebar is always available

### Main view behavior

- Only one main view is active at a time
- "Home" shows the QuarterdeckBoard (kanban columns)
- "Terminal" shows the agent terminal panel (currently rendered inside CardDetailView)
- "Files" shows the file content viewer
- The bottom terminal pane (home shell, detail terminal) remains independent of this system

### Notification badges

Badges stay on the same icons they're on today:
- **Projects**: Orange when any cross-project task needs approval
- **Changes**: Red for uncommitted, blue for unmerged changes
- **Files**: Blue when behind base

## Current Architecture (context for implementation)

### How it works today (single SidebarTabId)

**State**: `SidebarTabId = "home" | "projects" | "task_column" | "changes" | "files"` — one value controls both what's in the sidebar AND what's in the main area.

**File: `web-ui/src/resize/use-card-detail-layout.ts`**
- `activeTab: SidebarTabId | null` — the one selection
- `lastTaskTab: TaskTabId` — remembers last task tab
- `handleTabChange()` — single handler for all tab clicks
- Auto-switch `useEffect` on `selectedTaskId` change
- `visualActiveTab` — derived highlight state for toolbar

**File: `web-ui/src/components/detail-panels/detail-toolbar.tsx`**
- 6 buttons in a single column with one divider
- All use the same `onTabChange` callback
- `ToolbarButton` highlights based on `visualActiveTab` (single value)

**File: `web-ui/src/App.tsx` (lines 1186-1500)**
The flex row layout:
```
<DetailToolbar /> | <Sidebar panel> | <Main content>
```

Sidebar rendering (App.tsx level, lines 1211-1321):
- `activeTab === "home" || "projects"` → `ProjectNavigationPanel`
- `activeTab === "files" && !selectedCard` → `ScopeBar + FileBrowserTreePanel`
- Otherwise → no App.tsx sidebar (CardDetailView may render its own)

Main content (lines 1327-1500):
- `selectedCard && detailSession` → `CardDetailView` (handles everything)
- Otherwise → `TopBar + QuarterdeckBoard` (or file viewer, or git history, or loading)

**File: `web-ui/src/components/card-detail-view.tsx`**
- `isTaskSidePanelOpen = activeTab === "task_column" || "changes" || "files"` (line 427)
- When true, CardDetailView renders its OWN sidebar (ColumnContextPanel / DiffViewer / FileBrowser)
- The sidebar is inside CardDetailView's flex container, not at App.tsx level
- Main content: agent terminal (default), expanded diff, file viewer, or git history

**Key insight**: The sidebar is rendered in TWO different places depending on context:
- App.tsx renders sidebar for home/projects/files-without-task
- CardDetailView renders sidebar for task_column/changes/files-with-task

This split is the main complexity of the current system and the main thing the rework needs to address.

### Agent terminal panel

Currently the agent terminal is embedded inside `CardDetailView` as the default main content (lines 750-820). It only appears when a task is selected. The "Home" view shows the kanban board, not a terminal.

There's also a separate `useHomeSidebarAgentPanel` hook that renders a terminal in the home sidebar's "Quarterdeck Agent" tab — this is a different terminal (home agent session, not task session).

The rework would need to decide: does the new "Terminal" main view show the task's agent terminal (requiring a selected task) or the home agent terminal (always available)? Likely: show the task terminal when a task is selected, show the home agent terminal otherwise.

### ProjectNavigationPanel internal tabs

`ProjectNavigationPanel` has its own internal "Projects" / "Quarterdeck Agent" tab toggle (`activeSection` state, managed in App.tsx line 127). This is separate from the toolbar tabs. The agent section renders `agentSectionContent` (the home sidebar agent panel). This internal toggle would survive the rework unchanged.

## Implementation Approach

### Phase 1: Split state

**File: `use-card-detail-layout.ts`**

Replace:
```ts
type SidebarTabId = "home" | "projects" | "task_column" | "changes" | "files";
activeTab: SidebarTabId | null;
```

With:
```ts
type MainViewId = "home" | "terminal" | "files";
type SidebarId = "projects" | "task_column" | "changes";

mainView: MainViewId;           // never null — always showing something
sidebar: SidebarId | null;      // null = collapsed
```

New localStorage keys for each dimension. Migration: map old `activeTab` values to the new pair:
- `"home"` → `mainView: "home", sidebar: "projects"`
- `"projects"` → `mainView: (keep current), sidebar: "projects"`
- `"task_column"` → `mainView: "terminal", sidebar: "task_column"`
- `"changes"` → `mainView: "terminal", sidebar: "changes"`
- `"files"` → `mainView: "files", sidebar: (keep current)`

Replace `handleTabChange` with:
- `setMainView(view: MainViewId)` — with auto-coupling rules
- `setSidebar(id: SidebarId | null)` — toggle logic (click active = collapse)

Replace auto-switch `useEffect` with coupling rules triggered by task selection changes.

### Phase 2: Split toolbar

**File: `detail-toolbar.tsx`**

Two highlight states instead of one:
```ts
activeMainView: MainViewId;
activeSidebar: SidebarId | null;
onMainViewChange: (view: MainViewId) => void;
onSidebarChange: (id: SidebarId) => void;
```

Visual: two groups of buttons with a divider between them. Each group has its own active highlight. Sidebar buttons show a different highlight treatment (e.g., left border accent) vs main view buttons (filled background) to make the two dimensions visually distinct.

### Phase 3: Unify sidebar rendering

**File: `App.tsx` + `card-detail-view.tsx`**

Currently the sidebar is split between App.tsx and CardDetailView. The rework should unify this — render ALL sidebar content at the App.tsx level:
- `sidebar === "projects"` → `ProjectNavigationPanel` (always available)
- `sidebar === "task_column"` → `ColumnContextPanel` (needs selected task)
- `sidebar === "changes"` → `DiffToolbar + FileTreePanel + DiffViewerPanel` (needs selected task)

This means extracting the sidebar rendering from CardDetailView and hoisting it to App.tsx. CardDetailView becomes a pure main-content renderer (terminal, expanded diff, file viewer).

### Phase 4: Main view rendering

**File: `App.tsx`**

The main content area renders based on `mainView`:
- `"home"` → `QuarterdeckBoard` (existing board rendering)
- `"terminal"` → Agent terminal panel (extracted from CardDetailView)
- `"files"` → File content viewer (existing)

The bottom terminal pane remains independent — it's a secondary panel, not the main view.

### Phase 5: Terminal as main view

Extract the agent terminal from CardDetailView into a standalone component that can be rendered as a main view. When `mainView === "terminal"`:
- If a task is selected → show the task's agent terminal
- If no task selected → show the home agent terminal (from `useHomeSidebarAgentPanel`)
- The terminal receives the full main content width (minus sidebar if open)

## Files to Modify

| File | Change |
|------|--------|
| `web-ui/src/resize/use-card-detail-layout.ts` | Replace single `activeTab` with `mainView` + `sidebar` state |
| `web-ui/src/components/detail-panels/detail-toolbar.tsx` | Split into two button groups with independent highlights |
| `web-ui/src/App.tsx` | Unify sidebar rendering at App level, split main content by `mainView` |
| `web-ui/src/components/card-detail-view.tsx` | Remove sidebar rendering, become pure main content |
| `web-ui/src/storage/local-storage-store.ts` | Add new localStorage keys for `mainView` and `sidebar` |
| `web-ui/src/hooks/use-home-sidebar-agent-panel.tsx` | May need refactoring if agent terminal becomes a main view |

## Files NOT Modified

| File | Reason |
|------|--------|
| `web-ui/src/components/project-navigation-panel.tsx` | Sidebar content component, reused as-is |
| `web-ui/src/components/detail-panels/column-context-panel.tsx` | Sidebar content component, reused as-is |
| Backend (`src/`) | No backend changes needed |

## Open Questions

1. **Should "Terminal" be a main view icon or implicit?** Today the terminal appears automatically when you select a task. Making it an explicit icon means you could view the board while a task is selected (instead of always seeing the terminal). Is that useful or confusing?

2. **What happens to the Home view when a task is selected?** Today, clicking Home deselects the task. In the new model, could you view the board (main: home) while keeping a task selected? Or should selecting "home" as main view always deselect?

3. **How does the expanded diff work?** Today `isDiffExpanded` hides the toolbar entirely and the diff fills the screen. Does this survive the rework, or does expanding the diff just switch to `mainView: "files"` (or a new "diff" main view)?

4. **Scope of the file browser**: Today the Files tab works in both home context (browsing the main repo) and task context (browsing the task worktree). With two state dimensions, does the file content viewer (main view) always show files from the sidebar's scope? Or does it need its own scope selector?

5. **Git history panel**: Currently a toggle that replaces the main content. Does it become a main view option, or stay as a modal overlay?

## Verification Plan

### Toolbar layout and visual
1. Toolbar shows two groups: Home, Terminal, Files (main view) above divider; Projects (FolderKanban), Board, Changes below divider
2. Two distinct highlight treatments: filled bg for active main view button, left-border accent for active sidebar button
3. Disabled states: Terminal, Board, and Changes icons greyed out when no task selected

### Main view behavior
4. Open app fresh → main: home (board), sidebar: projects (project list)
5. Click a task from board → main: terminal (agent), sidebar: task_column
6. Click Home → main: home, sidebar: projects, **task deselected**
7. Click Files main view → main: files, file tree in sidebar area
8. Select a task while on Files → main switches to terminal (auto-coupling fires from files view too)

### Sidebar behavior
9. Click Projects sidebar icon (task selected) → sidebar: projects, terminal stays, task stays selected
10. Click Projects again → sidebar collapses (toggle behavior)
11. Click active sidebar icon (changes) → sidebar collapses

### Task lifecycle
12. Press Escape → task deselected, main: home, sidebar: projects
13. Terminal icon is greyed out after deselect (no task selected)
14. Select a task → main: terminal (agent), sidebar: task_column

### Projects sidebar
15. Projects sidebar shows ProjectNavigationPanel with project list, add button, agent tab
16. Switch projects in the sidebar → board reloads, task deselects
17. Task count badges on project rows (B, IP, R, T) update in real-time as tasks are created/started/completed

### Persistence
18. localStorage round-trips correctly on refresh (both mainView and sidebar dimensions)
19. Click Projects tab, refresh → reopens on Projects tab
20. Migration: old `quarterdeck.detail-active-panel` values correctly mapped on first load

### Badges and resize
21. Badge notifications on correct icons: Projects=orange (cross-project approval needed), Changes=red (uncommitted)/blue (unmerged), Files=blue (behind base)
22. Resize handles work for sidebar in all main/sidebar combinations

## Estimated Scope

This is a **medium-large refactor** touching the core layout system. The main risk is the sidebar rendering unification (Phase 3) — extracting sidebar content from CardDetailView while preserving all the diff viewer, file browser, and scope bar behavior. The terminal extraction (Phase 5) is also non-trivial since the agent terminal has deep integration with session management, PTY connections, and bottom pane state.

Recommend breaking into 2-3 PRs:
1. State split + toolbar split (Phases 1-2) — can ship with auto-coupling rules that approximate current behavior
2. Sidebar unification (Phase 3) — biggest risk, should be its own PR
3. Terminal as main view (Phases 4-5) — depends on Phase 3
