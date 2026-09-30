# UI Layout Conventions

As-built reference for the browser UI shell: region names, main-view/sidebar state, render ownership, and the checklist for adding a new view or panel.

Read this before changing main views, sidebar panels, toolbar tabs, or task-detail layout routing.

Last updated: 2026-09-29

## Region Names

Use these names consistently in specs, code comments, and conversation:

- **Top Bar**: horizontal bar across the top with project path, git state, shortcuts, terminal toggle, settings, and debug entry points.
- **Sidebar Toolbar**: 40px vertical icon strip rendered by `DetailToolbar`; main views are above the divider, side panels below it.
- **Side Panel**: resizable panel next to the toolbar. It can show Projects, Board/task column, or Commit.
- **Main View**: large content area to the right of the side panel.
- **Home Terminal**: optional shell terminal at the bottom of the home layout.
- **Agent Terminal**: task-scoped agent terminal in the task detail layout.
- **Detail Terminal**: optional shell terminal at the bottom of the task detail layout.
- **Task Column**: compact board-column side panel rendered by `ColumnContextPanel`.

### Shell terminal lifetime

Home and Detail Terminals are temporary manual shells. Closing or collapsing their panel stops the backing PTY and disposes its dedicated browser terminal. Changing the owning project or task, including switching between Home and task detail, closes the previous shell. Reopening starts a fresh shell; it does not restore a hidden shell session.

`useTerminalPanels` owns this contract, including waiting for a pending stop before starting the same shell again. Expanding or resizing an open panel does not close it. Task-agent terminals retain their separate session and viewer lifecycle described in [Session and Terminal Lifecycle](./session-lifecycle.md).

## Mental Model

The toolbar exposes two independent selections:

```text
Home      \
Terminal   > MainViewId: controls the large content area
Files     /
Git      /
---------
Projects \
Board     > SidebarId: controls the side panel
Commit   /
```

Main-view selection and side-panel selection are independent state values. They auto-couple only for a few UX defaults, described below.

Current IDs:

```ts
type MainViewId = "home" | "terminal" | "files" | "git";
type SidebarId = "projects" | "task_column" | "commit";
```

`GitView` also has internal tabs:

```ts
type GitViewTab = "uncommitted" | "compare";
```

## State Owners

`SurfaceNavigationProvider` owns UI surface navigation. It wraps:

- `useCardDetailLayout(...)` for `mainView`, `sidebar`, and side-panel width.
- `useGitNavigation(...)` for cross-surface file navigation and Git compare navigation.
- Git history open/closed state.

`App.tsx` consumes `useSurfaceNavigationContext()` and renders the toolbar, home side panel, home view, or task detail view. It should stay a composition surface, not the owner of new layout policy.

Important files:

| File | Role |
| --- | --- |
| `web-ui/src/providers/surface-navigation-provider.tsx` | Public context for main view, sidebar, Git history, and file/compare navigation |
| `web-ui/src/resize/use-card-detail-layout.ts` | Main-view/sidebar state, auto-coupling, persistence |
| `web-ui/src/components/terminal/detail-toolbar.tsx` | Sidebar toolbar buttons and badges |
| `web-ui/src/App.tsx` | Top-level shell wiring and home side-panel rendering |
| `web-ui/src/components/app/home-view.tsx` | No-task main area: board, files, git, and home shell terminal |
| `web-ui/src/components/task/card-detail-view.tsx` | Task-detail layout root |
| `web-ui/src/components/task/task-detail-side-panel.tsx` | Task side panel: Board or Commit |
| `web-ui/src/components/task/task-detail-main-content.tsx` | Task main-content router: repository surface vs terminal surface |
| `web-ui/src/components/task/task-detail-repository-surface.tsx` | Task Files/Git surface |

## Render Ownership

```text
App.tsx
├─ DetailToolbar
├─ home side panel, only when no task is selected
│  ├─ CommitPanel when sidebar === "commit"
│  └─ ProjectNavigationPanel for other non-null home sidebars
├─ CardDetailView when a task is selected
│  ├─ TaskDetailSidePanelSurface
│  │  ├─ CommitPanel when sidebar === "commit"
│  │  └─ ColumnContextPanel when sidebar === "task_column"
│  └─ TaskDetailMainContent
│     ├─ TaskDetailRepositorySurface when mainView is "files" or "git"
│     └─ TaskDetailTerminalSurface otherwise
└─ HomeView when no task is selected
   ├─ GitView when mainView === "git"
   ├─ FilesView when mainView === "files"
   └─ QuarterdeckBoard otherwise
```

Key split:

- No task selected: `App.tsx` owns the side panel and `HomeView` owns main content.
- Task selected: `CardDetailView` owns task-scoped side panel and main content.

Do not route task-scoped panels through the home side-panel path; task panels usually need task identity, repository scope, session summary, or branch actions that are already assembled inside the task-detail path.

## Main Views

### Home

- No-task layout: renders `QuarterdeckBoard`.
- Selecting Home also deselects the current task and opens Projects.
- If a task is selected, task selection auto-switches away from Home to Terminal.

The home board stacks In Progress and Review sections with responsive card grids. Trash is a visible, collapsed row that mounts its compact cards only when expanded. Create task stays above the project list in the Projects side panel and above the scrollable sections in the task sidebar. The home board has no separate header row. Unstarted tasks remain grouped within Review.

Rich cards show a bounded plain-text response preview from the existing session projection. They never mount or prewarm terminals or fetch transcripts. Inline replies use the existing task-input API with an exact session-instance fence; only a live, review-ready native agent can receive them. Approvals and busy agents keep drafts without sending. `BoardReplyDrafts` owns window-local drafts keyed by project, task, and creation time, surviving navigation and column changes without writing board state.

The home grid uses dnd-kit with dedicated pointer/keyboard handles; the compact task sidebar retains its list drag implementation. Grid drops resolve task IDs back to the existing board/lifecycle intent path.

### Terminal

- Task-detail layout: renders the task's agent terminal plus optional Detail Terminal.
- Disabled in the toolbar when no task is selected.
- Deselecting a task while on Terminal returns to Home.

### Files

- Renders `FilesView` in home or task context.
- Includes its own scope bar, branch pill, file tree, and content viewer.
- Can browse home workspace, task worktree, or a read-only branch view depending on `useScopeContext()`.

### Git

- Renders `GitView` in home or task context.
- Includes its own changed-file tree and internal tabs: Uncommitted, Compare.
- Git history is a nested panel controlled by `SurfaceNavigationProvider`, not a separate main view.

## Side Panels

### Projects

- Home/no-task layout: renders `ProjectNavigationPanel`.
- Task-detail layout: does not render a task side panel.

Named project groups are one level deep. Each project belongs to at most one group; Ungrouped appears last only when needed (and as a drop target during dragging). With no groups, the original flat list remains. The Projects plus menu offers Add project and New group; group menus offer add, rename, reorder, and removal. Removing a group moves its projects to Ungrouped without touching tasks or repositories.

`useProjectGroupNavigation` owns interaction state, reveal behavior, and drag coordination. `useProjectGroups` submits typed intent to `projects.organize`, with one pending mutation and a reversible optimistic projection. `project-groups.ts` owns pure grouping/drop projections. Group membership/order is runtime-owned global project-index metadata, independent of board state. Revision-checked writes use the index lock, and every project registration/removal preserves metadata and advances its revision. A coherent project list plus organization snapshot travels through the existing state stream; stale organization messages cannot roll back membership or resurrect removed project rows.

Collapse state is a browser preference scoped to the stable organization ID. Each open tab keeps its own view; storage seeds later visits. Collapsing never changes selection or stops tasks. Collapsed headers show aggregate activity and indicate when they contain the current project. An explicit project switch reveals its row; background activity does not expand groups. Project and group menus provide keyboard alternatives to drag handles. Dropping on a collapsed header appends without expanding it.

### Board (`task_column`)

- Task-detail layout: renders `ColumnContextPanel`.
- Disabled in the toolbar when no task is selected.
- Stored as the last task-tied sidebar so task selection can reopen it.

### Commit

- Home/no-task layout: renders `CommitPanel` for the repository.
- Task-detail layout: renders `CommitPanel` for the task worktree.
- Exempt from Files/Git auto-collapse so users can stage or commit while inspecting repository views.

## Auto-Coupling Rules

These are defaults, not locks. The user can override them unless the target surface cannot function.

| Trigger | Main view result | Sidebar result |
| --- | --- | --- |
| `setMainView("home")` | Home | Projects; also deselects task through callback |
| `setMainView("files")` or `"git"` | Files/Git | Collapses sidebar unless it is Commit |
| `setMainView("terminal")` | Terminal | Restores sidebar that Files/Git auto-collapsed, when still applicable |
| Task selected while on Home | Terminal | Board |
| Task selected while on Terminal/Files/Git | Unchanged | Unchanged |
| Task deselected while on Terminal | Home | Projects |
| Task deselected while sidebar is Board | Unchanged, except Terminal still returns Home | Projects |
| Project switch starts | Home | Projects; Git history closes |

Toolbar highlights are literal:

- `visualMainView = mainView`
- `visualSidebar = sidebar`

There is no hidden override layer. If the sidebar auto-collapses, the sidebar highlight becomes empty.

## Persistence

Layout state starts fresh at Home + Projects on mount. Some values are still written to localStorage for within-session behavior, resize persistence, and legacy migration.

Relevant `LocalStorageKey` values:

| Key | Meaning |
| --- | --- |
| `DetailMainView` | Last written main view |
| `DetailSidebar` | Last written sidebar; empty string means collapsed |
| `DetailLastSidebarTab` | Last task-tied sidebar |
| `DetailSidePanelRatio` | Home/task side-panel width |
| `GitViewActiveTab` | Current Git tab |
| `GitViewFileTreeRatio` | Git changed-file tree width |
| `DetailFileBrowserTreePanelRatio` | FilesView tree width |

Legacy `DetailActivePanel` and `DetailLastTaskTab` are still read by migration helpers in `use-card-detail-layout.ts`.

## Adding A Main View

1. Add the ID to `MainViewId` in `use-card-detail-layout.ts`.
2. Add migration handling in `loadMainView()` if old persisted values need mapping.
3. Add a `MainViewButton` in `DetailToolbar`.
4. Extend `useCardDetailLayout()` auto-coupling only if the new view has special task-selection behavior.
5. Render the view in `HomeView` for no-task context, in `TaskDetailMainContent` or a task-detail sub-surface for task context, or intentionally support only one context.
6. Add a localStorage key only for user-visible layout/view state that should persist.
7. If the view needs repository scope, reuse the existing Git/Files scope and navigation seams before adding another surface-level state owner.

## Adding A Side Panel

1. Add the ID to `SidebarId` in `use-card-detail-layout.ts`.
2. Add migration handling in `loadSidebar()` / `loadLastSidebarTab()` if needed.
3. Add a `SidebarButton` in `DetailToolbar`.
4. Decide whether it is home-scoped, task-scoped, or valid in both contexts.
5. Render home-scoped panels from the `App.tsx` side-panel area.
6. Render task-scoped panels from `TaskDetailSidePanelSurface`.
7. Update `isTaskSidePanelOpen` in `use-card-detail-view.ts` for task-scoped panels.
8. Update `lastSidebarTab` only for panels that should reopen automatically when a task is selected.

## Component Name Reference

| UI name | Primary component |
| --- | --- |
| Top Bar | `TopBar` / `ConnectedTopBar` |
| Sidebar Toolbar | `DetailToolbar` |
| Projects side panel | `ProjectNavigationPanel` |
| Board side panel / Task Column | `ColumnContextPanel` |
| Commit side panel | `CommitPanel` |
| Home board | `QuarterdeckBoard` |
| Task card | `BoardCard` |
| Files main view | `FilesView` |
| Git main view | `GitView` |
| Git history panel | `GitHistoryView` |
| Agent terminal | `AgentTerminalPanel` |
| Shell terminal | `ShellTerminalPanel` |
| Create task dialog | `TaskCreateDialog` |
| Settings dialog | `RuntimeSettingsDialog` |

## Historical Context

The current shell came from a few incremental reworks:

1. A legacy single-tab model used one persisted `DetailActivePanel` value for both side panel and main content.
2. The dual-selection model split that into `MainViewId` and `SidebarId`.
3. Files became a scope-aware main view with its own tree/content layout.
4. Git became a main view with internal Uncommitted and Compare tabs.
5. Projects and Commit became side panels, with Commit valid in both home and task contexts.

## Validation

Follow [`../testing.md`](../testing.md). Start with the affected layout hook and component tests. Use Playwright or deterministic Agent Lab when navigation, persisted selection, cross-surface coupling, responsive layout, or a real runtime projection is part of the claim. Capture pixel evidence only for spacing, clipping, stacking, paint, or responsive behavior.
