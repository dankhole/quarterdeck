# UI Layout Architecture

Source of truth for how the browser UI is structurally composed. Read this before adding a new main view, sidebar panel, or internal tab.

**Last updated**: 2026-04-12 (after commit sidebar panel, git view rework, dual-selection sidebar, scope bar + file browser, project switcher sidebar)

---

## Mental Model

The UI has two independent selection dimensions, rendered as two groups of buttons in a vertical toolbar:

```
┌─────────────┐
│  Home        │  ← main view (left-border accent when active)
│  Terminal    │
│  Files       │
│  Git         │
│──────────────│  ← divider
│  Projects    │  ← sidebar (filled bg when active)
│  Board       │
│  Commit      │
└──────────────┘
```

**Main view** controls what fills the large content area (right side).
**Sidebar** controls what fills the narrow left panel (collapsible).

These are independent — changing one does not clear the other, with a few auto-coupling exceptions (documented below).

---

## Type Definitions

All defined in `web-ui/src/resize/use-card-detail-layout.ts`:

```typescript
type MainViewId = "home" | "terminal" | "files" | "git";
type SidebarId  = "projects" | "task_column" | "commit";
```

The `"git"` main view has its own internal sub-tabs, defined in `web-ui/src/components/git-view.tsx`:

```typescript
type GitViewTab = "uncommitted" | "last_turn" | "compare";
```

---

## Component Hierarchy

```
App.tsx
├── DetailToolbar                          # Vertical icon bar (always rendered)
│   ├── MainViewButton × 4                 # Home, Terminal, Files, Git
│   └── SidebarButton × 3                  # Projects, Board, Commit
│
├── [Sidebar panel]                        # Conditional — rendered at App.tsx level OR inside CardDetailView
│   ├── (home + projects sidebar) → ProjectNavigationPanel
│   ├── (home + sidebar=commit) → CommitPanel (home/repo context)
│   └── (task selected + sidebar=task_column) → ColumnContextPanel (inside CardDetailView)
│
├── [Main content]                         # Conditional on selection state
│   ├── (task selected) → CardDetailView   # Owns task-context layout
│   │   ├── [Left panel]                   # Task-scoped sidebar (sidebar=task_column or sidebar=commit)
│   │   │   ├── ColumnContextPanel
│   │   │   └── CommitPanel (task/worktree context)
│   │   │
│   │   └── [Right panel]                  # Task-scoped main content
│   │       ├── (mainView=git) → GitView (internal file tree)
│   │       ├── (mainView=files) → FilesView (internal ScopeBar + file tree + content viewer)
│   │       └── (mainView=terminal|home) → AgentTerminalPanel + optional bottom terminal
│   │
│   └── (no task) → Top-level main content
│       ├── (mainView=git) → GitView
│       ├── (mainView=files) → FilesView
│       └── (mainView=home) → QuarterdeckBoard
```

### Key structural insight

The sidebar is rendered in **two different places** depending on whether a task is selected:

- **No task**: App.tsx renders the sidebar directly (ProjectNavigationPanel, or home-context FileBrowserTreePanel).
- **Task selected**: `CardDetailView` renders its own left panel (task-scoped FileBrowserTreePanel or ColumnContextPanel).

This split exists because task-scoped sidebar panels need access to task context (workspace info, scope resolution, branch actions) that `CardDetailView` already manages. The `mainView === "git"` view suppresses the sidebar highlight — it has an integrated tree panel that replaces the sidebar visually. The `mainView === "files"` view (`FilesView`) also has an integrated tree panel but does **not** suppress the sidebar, allowing the Board/Projects sidebar to coexist alongside it.

---

## State Management

### Hook: `useCardDetailLayout()`

Location: `web-ui/src/resize/use-card-detail-layout.ts`

The single hook that owns all layout state. Called in `App.tsx`, results threaded down as props.

**Returns:**
| Field | Type | Description |
|-------|------|-------------|
| `mainView` | `MainViewId` | Current main content view |
| `sidebar` | `SidebarId \| null` | Current sidebar (null = collapsed) |
| `setMainView(view, callbacks?)` | function | Switch main view, with auto-coupling |
| `toggleSidebar(id)` | function | Toggle sidebar (click active = collapse) |
| `visualMainView` | `MainViewId` | Toolbar highlight for main view buttons |
| `visualSidebar` | `SidebarId \| null` | Toolbar highlight for sidebar buttons |
| `lastSidebarTab` | `SidebarId` | Remembers last task-tied sidebar for re-open |
| `sidePanelRatio` | `number` | Sidebar width as ratio of container |
| `setSidePanelRatio` | function | Update sidebar width |
| `resetToDefaults` | function | Reset all ratios to defaults |

**Initial state on mount**: Always starts at `home` + `projects` (view state is transient, not restored across tab reopens). localStorage is written for within-session auto-coupling but not read on mount.

### Auto-coupling rules

These fire automatically when state changes. They are defaults, not locks — the user can always override.

| Trigger | Main view | Sidebar | Other |
|---------|-----------|---------|-------|
| `setMainView("home")` | home | projects | Deselects task via callback |
| `setMainView("files")` or `setMainView("git")` | (set) | auto-collapse | Unless `sidebar === "commit"` or sidebar is pinned |
| Task selected (was on `home`) | terminal | task_column | — |
| Task selected (was on `terminal`/`files`/`git`) | (unchanged) | (unchanged) | All work with task context |
| Task deselected (was on `terminal`) | home | projects | Terminal needs a task |
| Task deselected (was on `files`/`git`/`home`) | (unchanged) | (unchanged) | These work without a task |
| Task deselected (sidebar was `commit`) | (unchanged) | commit | Stays open, switches to home/repo context |
| Task deselected (sidebar was `task_column`) | (per above) | projects | Falls back to projects |

### Visual highlight logic

Both highlights always reflect the actual state — no hints or overrides:

- `visualMainView` = `mainView` (always matches)
- `visualSidebar` = `sidebar` (null when collapsed, the active tab when open)

---

## Persistence

### localStorage keys

Defined in `web-ui/src/storage/local-storage-store.ts` (`LocalStorageKey` enum):

| Key | What it stores |
|-----|---------------|
| `DetailMainView` | Current main view ID |
| `DetailSidebar` | Current sidebar ID (empty string = collapsed) |
| `DetailLastSidebarTab` | Last active task-tied sidebar tab |
| `GitViewActiveTab` | Which Git view internal tab was last active |
| `DetailSidePanelRatio` | Sidebar width ratio |
| `DetailFileBrowserTreePanelRatio` | File browser tree width (FilesView internal) |
| `GitViewFileTreeRatio` | Git view's integrated file tree width ratio |

### Migration from legacy single-tab model

The old `DetailActivePanel` key stored a single `SidebarTabId`. Migration runs in `loadMainView()` and `loadSidebar()`:

- `"task_column"` / `"changes"` → `mainView: terminal`, `sidebar: task_column`
- `"files"` → `mainView: files`
- `"changes"` (as sidebar value) → `sidebar: task_column`, `mainView: git`
- All other / blank → `mainView: home`, `sidebar: projects`

---

## Main View Details

### Home (`mainView === "home"`)

- Renders `QuarterdeckBoard` (kanban columns with drag-and-drop)
- Only available when no task is selected (selecting a task auto-switches to terminal)
- Sidebar: auto-couples to `projects`

### Terminal (`mainView === "terminal"`)

- Renders `AgentTerminalPanel` for the selected task's agent session
- Requires a task — disabled in toolbar when no task is selected
- Deselecting a task auto-switches to home
- Supports a bottom terminal pane (second PTY, e.g., dev shell) via `ResizableBottomPane`

### Files (`mainView === "files"`)

- Renders the `FilesView` component — a self-contained view with ScopeBar, file tree, and content viewer
- `FilesView` has its own internal `FileBrowserTreePanel` with resize handle and visibility toggle (same pattern as `GitView`)
- Works in both task context (browsing task worktree) and home context (browsing main repo)
- Scope-aware: shows home files, task working copy, or a read-only branch view depending on `useScopeContext()`
- Does **not** suppress the sidebar — Board and Projects sidebars can coexist alongside Files view

### Git (`mainView === "git"`)

- Renders the `GitView` component — a self-contained view with its own internal tab bar
- Works in both task context and home context
- Sidebar visual highlight is suppressed (integrated file tree acts as its own sidebar)
- Has three internal sub-tabs:

#### Uncommitted (default)
- Shows HEAD vs working tree changes
- Polls on 1-second interval when visible
- Data: `useRuntimeWorkspaceChanges(taskId, projectId, baseRef, "working_copy", ...)`

#### Last Turn
- Shows changes since the agent's last turn checkpoint
- Disabled when no task is selected
- Data: `useRuntimeWorkspaceChanges(taskId, projectId, baseRef, "last_turn", ...)`

#### Compare
- Branch-to-branch diff with dual pill dropdowns (`BranchSelectorPopover`)
- Left pill (source): defaults to task branch or home current branch
- Right pill (target): defaults to task base ref; blank if no task
- "Browsing" mode: activated when left pill differs from default (purple indicator)
- "Return to context" button: appears when either pill is overridden
- Externally navigable via `pendingCompareNavigation` prop (for future "compare against" actions)
- State managed by `useGitViewCompare()` hook (`web-ui/src/hooks/use-git-view-compare.ts`)
- No polling — branch diffs are stable

---

## Sidebar Details

### Projects (`sidebar === "projects"`)

- Renders `ProjectNavigationPanel` (project list, add button)
- Always available (no task required)

### Board (`sidebar === "task_column"`)

- Renders `ColumnContextPanel` (task column with cards, drag-and-drop reorder)
- Requires a task — disabled in toolbar when no task is selected
- Persisted as `lastSidebarTab` so it re-opens correctly after sidebar collapse

### Commit (`sidebar === "commit"`)

- Renders `CommitPanel` — a JetBrains-style quick-commit panel with file list, per-file checkboxes, status badges (M/A/D/R), commit message textarea, and Commit / Discard All buttons
- Works in both task (worktree) and home (repo) contexts — unlike `task_column`, it does not require a task
- On task deselection, stays open and switches to home/repo context (does not fall back to `projects`)
- Exempt from the auto-collapse rule that collapses the sidebar when switching to `files` or `git` main views, because users may want to view diffs while staging files. The condition in `use-card-detail-layout.ts` is: `if ((view === "files" || view === "git") && sidebarRef.current !== "commit" && !sidebarPinnedRef.current)`
- Right-click context menu on files: Rollback, Open in Diff Viewer, Open in File Browser, Copy Name, Copy Path
- Component: `CommitPanel` in `web-ui/src/components/detail-panels/commit-panel.tsx`
- Hook: `useCommitPanel` in `web-ui/src/hooks/use-commit-panel.ts`

---

## How to Add a New Main View

1. **Add the ID** to `MainViewId` in `use-card-detail-layout.ts`:
   ```typescript
   type MainViewId = "home" | "terminal" | "files" | "git" | "your_view";
   ```

2. **Add localStorage migration** in `loadMainView()` if needed (for backwards compatibility).

3. **Add the toolbar button** in `detail-toolbar.tsx`:
   ```tsx
   <MainViewButton
       viewId="your_view"
       activeMainView={activeMainView}
       onMainViewChange={onMainViewChange}
       icon={<YourIcon size={18} />}
       label="Your View"
       disabled={/* condition */}
   />
   ```
   Place it above the divider, in the desired position among the main view buttons.

4. **Add the badge prop** to `DetailToolbarProps` if your view needs a notification badge.

5. **Update visual sidebar suppression** in `useCardDetailLayout()` if your view has an integrated panel that replaces the sidebar:
   ```typescript
   const visualSidebar: SidebarId | null =
       mainView === "git" || mainView === "your_view"
           ? null
           : (sidebar ?? (selectedCard ? lastSidebarTab : "projects"));
   ```

6. **Update auto-coupling rules** in the `useEffect` on `selectedTaskId` if your view has special behavior when tasks are selected/deselected (e.g., terminal switches to home when task is deselected because it needs a task; files/git stay put because they work without one).

7. **Render the view component** in both rendering paths in `App.tsx`:
   - **Task selected path** (inside `CardDetailView`): Add a branch in the right panel conditional:
     ```tsx
     mainView === "your_view" ? (
         <YourViewComponent ... />
     ) : mainView === "git" ? (
     ```
   - **No task path** (in App.tsx directly): Add a branch in the no-task main content conditional:
     ```tsx
     mainView === "your_view" ? (
         <YourViewComponent ... />
     ) : mainView === "git" ? (
     ```

8. **Handle left panel** — decide whether your view:
   - Uses the standard sidebar (projects/board) → no changes needed
   - Has an integrated left panel (like Files or Git) → render it inside `CardDetailView`'s left panel conditional and update `isTaskSidePanelOpen` accordingly

9. **Add localStorage key** in `local-storage-store.ts` if your view has internal state to persist (e.g., active sub-tab, panel ratio).

10. **Add sub-tabs** if your view needs them — follow the `GitView` pattern: local state + `loadX()`/`persistX()` functions + `TabButton` components.

---

## How to Add a New Sidebar Panel

1. **Add the ID** to `SidebarId` in `use-card-detail-layout.ts`:
   ```typescript
   type SidebarId = "projects" | "task_column" | "commit" | "your_panel";
   ```

2. **Add localStorage migration** in `loadSidebar()` and `loadLastSidebarTab()` if needed.

3. **Add the toolbar button** in `detail-toolbar.tsx`:
   ```tsx
   <SidebarButton
       sidebarId="your_panel"
       activeSidebar={activeSidebar}
       onSidebarChange={onSidebarChange}
       icon={<YourIcon size={18} />}
       label="Your Panel"
       disabled={/* condition */}
   />
   ```
   Place it below the divider, among the sidebar buttons.

4. **Render the panel content** — this depends on whether it needs task context:
   - **No task needed**: Render in `App.tsx`'s sidebar area (alongside the `ProjectNavigationPanel` path)
   - **Needs task context**: Render inside `CardDetailView`'s left panel conditional

5. **Update `lastSidebarTab` tracking** in `toggleSidebar()` if your panel is task-tied and should be remembered.

---

## File Reference

| File | Role |
|------|------|
| `web-ui/src/resize/use-card-detail-layout.ts` | Layout state hook: `MainViewId`, `SidebarId`, auto-coupling, persistence |
| `web-ui/src/components/detail-panels/detail-toolbar.tsx` | Vertical icon toolbar with main view + sidebar buttons |
| `web-ui/src/App.tsx` | Top-level orchestration: wires layout hook, renders sidebar + main content |
| `web-ui/src/components/card-detail-view.tsx` | Task-context layout: task-scoped sidebar + main content rendering |
| `web-ui/src/components/git-view.tsx` | Git main view with internal tabs (Uncommitted, Last Turn, Compare) |
| `web-ui/src/hooks/use-git-view-compare.ts` | Compare tab state: source/target refs, browsing, external navigation |
| `web-ui/src/hooks/use-file-browser-data.ts` | Files tab data: file list, content, polling |
| `web-ui/src/hooks/use-scope-context.ts` | Scope resolution: home vs task vs branch-view context |
| `web-ui/src/components/detail-panels/scope-bar.tsx` | Scope indicator bar (home/task/browsing) with branch pill |
| `web-ui/src/components/files-view.tsx` | Files main view (ScopeBar + file tree + content viewer) |
| `web-ui/src/components/detail-panels/file-browser-tree-panel.tsx` | Virtualized file tree (used inside FilesView) |
| `web-ui/src/components/detail-panels/file-content-viewer.tsx` | Syntax-highlighted file content display (used inside FilesView) |
| `web-ui/src/components/detail-panels/diff-viewer-panel.tsx` | Unified/split diff display with inline comments |
| `web-ui/src/components/detail-panels/file-tree-panel.tsx` | Simple file tree for Git view changed files |
| `web-ui/src/components/detail-panels/branch-selector-popover.tsx` | Branch picker with FZF search, used by scope bar + compare tab |
| `web-ui/src/components/detail-panels/column-context-panel.tsx` | Board sidebar: task column with cards |
| `web-ui/src/components/detail-panels/commit-panel.tsx` | Commit sidebar: file list, staging, commit message, discard |
| `web-ui/src/hooks/use-commit-panel.ts` | Commit panel state: file selection, staging, commit/discard actions |
| `web-ui/src/components/project-navigation-panel.tsx` | Projects sidebar: project list |
| `web-ui/src/storage/local-storage-store.ts` | localStorage key definitions and read/write helpers |

---

## Historical Context

This architecture is the result of several incremental reworks:

1. **Original**: Single `SidebarTabId` controlled both sidebar and main content. One selection dimension, confusing UX.
2. **Dual-selection rework** (2026-04-10): Split into independent `MainViewId` + `SidebarId`. Two highlight groups in toolbar.
3. **File browser + scope bar rework** (2026-04-09): Files became scope-aware (home/task/branch-view). Scope bar + branch selector added.
4. **Git view rework** (2026-04-11): Diff viewer promoted from sidebar ("Changes") to main view ("Git"). Internal tabs added (Uncommitted, Last Turn, Compare). `"changes"` removed from `SidebarId`.
5. **Project switcher sidebar** (2026-04-10): Projects panel added as a sidebar tab.
6. **Commit sidebar panel** (2026-04-12): JetBrains-style quick-commit panel added as a third sidebar tab. Works in both task and home contexts. Exempt from files/git auto-collapse rule.

Spec docs for these reworks live in `docs/specs/` — they document the *design intent* but may be partially outdated relative to what actually shipped. This document reflects the *as-built* state.
