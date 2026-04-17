# UI Component Cheatsheet

Quick reference for what everything is called, what it looks like, and where to find it.

For the full layout architecture (auto-coupling rules, persistence, how to add new views), see [ui-layout-architecture.md](ui-layout-architecture.md).

---

## Canonical Names

These are the agreed-upon names for UI regions. Use these consistently in specs, code comments, and conversation.

- **Top Bar** — horizontal bar across the top (project path, git buttons, settings)
- **Sidebar** — thin vertical icon strip (40px) with two button groups: main views (top) and sidebar panels (bottom)
- **Side Panel** — resizable panel next to the sidebar (projects, task column, commit)
- **Main View** — the large content area right of the side panel
- **Agent Terminal** — the task's chat/terminal that fills the main view when a task is selected
- **Home Terminal** — resizable bottom terminal on the home view
- **Detail Terminal** — resizable bottom terminal on the task detail view
- **Task Column** — compact stacked board columns in the side panel (component: `ColumnContextPanel`)

---

## Top-Level Layout

The UI has two independent selection dimensions rendered in the sidebar toolbar. Main view (top group) controls the large content area. Sidebar (bottom group) controls the left panel. They are independent — changing one does not clear the other (with a few auto-coupling exceptions documented in `ui-layout-architecture.md`).

```
┌─────────────┐
│  Home        │  <- main view (left-border accent when active)
│  Terminal    │
│  Files       │
│  Git         │
│──────────────│  <- divider
│  Projects    │  <- sidebar panel (filled bg when active)
│  Board       │
│  Commit      │
└──────────────┘
```

Home main view + Projects sidebar (default, no task selected):

```
+--+----------------+------------------------------+
|  |                | Top Bar                      |
|Ho|  Side Panel     +------------------------------+
|Te|                |                              |
|Fi| Project nav +   |  Main View                   |
|Gi| agent section  |  (Board / Git History)        |
|--|                |                              |
|Pr|                +------------------------------+
|Bo|                | Home Terminal (opt, bottom)   |
|Co|                |                              |
+--+----------------+------------------------------+
```

Terminal main view + Board sidebar (task selected):

```
+--+----------------+------------------------------+
|  |                | Top Bar                      |
|Ho|  Side Panel     +------------------------------+
|Te|                |                              |
|Fi| Task Column     |  Main View                   |
|Gi| (stacked cards) |  (Agent Terminal)             |
|--|                |                              |
|Pr|                +------------------------------+
|Bo|                | Detail Terminal (opt, bottom) |
|Co|                |                              |
+--+----------------+------------------------------+
```

---

## Sidebar Toolbar

### Main Views (top group)

| View | ID | Icon | Main view content |
|---|---|---|---|
| Home | `home` | Home | Board (kanban columns) |
| Terminal | `terminal` | Terminal | Agent terminal (task) or empty (no task) |
| Files | `files` | Folder | File browser (task worktree) |
| Git | `git` | GitBranch | Git view with sub-tabs: Uncommitted, Last Turn, Compare |

### Sidebar Panels (bottom group)

| Panel | ID | Icon | Side panel content |
|---|---|---|---|
| Projects | `projects` | LayoutList | Project list with task count badges |
| Board | `task_column` | Columns3 | Stacked board columns, selected task highlighted |
| Commit | `commit` | GitCommitVertical | Staged/unstaged changes, commit message, push |

---

## The Pieces

### Always Visible

| What you see | Name | Component | File |
|---|---|---|---|
| Horizontal bar across the top with project path, git buttons, terminal toggle, settings gear | **Top Bar** | `TopBar` | `components/top-bar.tsx` |
| Thin vertical icon strip with tab buttons (Home, Task Column, Changes, Files) | **Sidebar** | `DetailToolbar` | `components/detail-panels/detail-toolbar.tsx` |

### Home Tab (Side Panel)

| What you see | Name | Component | File |
|---|---|---|---|
| Project list with task count badges, add button, keyboard shortcuts | **Project nav** | `ProjectNavigationPanel` | `components/project-navigation-panel.tsx` |
| Individual project row with name, path, B/IP/R/T badges | **Project row** | `ProjectRow` | `components/project-navigation-panel.tsx` (private) |

### Home Tab (Main View)

| What you see | Name | Component | File |
|---|---|---|---|
| The kanban board with columns (Backlog, In Progress, Review, Trash) | **Board** | `QuarterdeckBoard` | `components/quarterdeck-board.tsx` |
| Single column on the board | **Board column** | `BoardColumn` | `components/board-column.tsx` |
| A task card on the board | **Card** / **task card** | `BoardCard` | `components/board-card.tsx` |
| SVG lines connecting dependent tasks | **Dependency lines** | `DependencyOverlay` | `components/dependencies/dependency-overlay.tsx` |
| Git branch/commit history view (toggled via Cmd+G) | **Git history** | `GitHistoryView` | `components/git-history-view.tsx` |

### Task Column Tab (Side Panel)

| What you see | Name | Component | File |
|---|---|---|---|
| All board columns stacked vertically with selected task highlighted | **Task Column** | `ColumnContextPanel` | `components/detail-panels/column-context-panel.tsx` |

### Git Main View (Side Panel: Commit)

| What you see | Name | Component | File |
|---|---|---|---|
| Diff viewer showing file changes for the task | **Changes panel** | `DiffViewerPanel` | `components/detail-panels/diff-viewer-panel.tsx` |
| Split (side-by-side) diff rendering | **Diff split** | `DiffSplit` | `components/detail-panels/diff-split.tsx` |
| Unified diff rendering | **Diff unified** | `DiffUnified` | `components/detail-panels/diff-unified.tsx` |
| File tree listing changed files (left side of changes) | **File tree** (diff) | `FileTreePanel` | `components/detail-panels/file-tree-panel.tsx` |

### Files Tab (Side Panel)

| What you see | Name | Component | File |
|---|---|---|---|
| File browser for exploring the task's worktree | **Files panel** | `FileBrowserPanel` | `components/detail-panels/file-browser-panel.tsx` |
| Tree navigation inside file browser | **File browser tree** | `FileBrowserTreePanel` | `components/detail-panels/file-browser-tree-panel.tsx` |
| Syntax-highlighted file content viewer | **File viewer** | `FileContentViewer` | `components/detail-panels/file-content-viewer.tsx` |

### Main View (Task Selected)

| What you see | Name | Component | File |
|---|---|---|---|
| The task's agent chat/terminal filling the main view | **Agent Terminal** | `AgentTerminalPanel` | `components/detail-panels/agent-terminal-panel.tsx` |
| Resizable terminal at the bottom (dev shell for the task) | **Detail Terminal** | `AgentTerminalPanel` inside `ResizableBottomPane` | `components/detail-panels/agent-terminal-panel.tsx` |

### Main View (No Task)

| What you see | Name | Component | File |
|---|---|---|---|
| Resizable terminal at the bottom of the home view | **Home Terminal** | `AgentTerminalPanel` inside `ResizableBottomPane` | `components/detail-panels/agent-terminal-panel.tsx` |

### Dialogs / Modals

| What you see | Name | Component | File |
|---|---|---|---|
| Create task popup with prompt box, branch picker, images | **Create task dialog** | `TaskCreateDialog` | `components/task-create-dialog.tsx` |
| Inline card editor that appears in-place in the backlog column | **Inline task editor** | `TaskInlineCreateCard` | `components/task-inline-create-card.tsx` |
| Settings modal with agent config, shortcuts, notifications | **Settings** | `RuntimeSettingsDialog` | `components/runtime-settings-dialog.tsx` |
| First-run agent selection carousel | **Onboarding** | `StartupOnboardingDialog` | `components/startup-onboarding-dialog.tsx` |
| "Are you sure?" when trashing a task | **Trash warning** | `TaskTrashWarningDialog` | `components/task-trash-warning-dialog.tsx` |
| "Clear all trash?" confirmation | **Clear trash dialog** | `ClearTrashDialog` | `components/clear-trash-dialog.tsx` |
| "Isolate/de-isolate workspace?" confirmation | **Migrate dialog** | `MigrateWorkingDirectoryDialog` | `components/migrate-working-directory-dialog.tsx` |
| Prompt shortcut editor | **Prompt shortcuts editor** | `PromptShortcutEditorDialog` | `components/prompt-shortcut-editor-dialog.tsx` |
| Debug tools (dev only) | **Debug dialog** | `DebugDialog` | `components/debug-dialog.tsx` |

### Shared / Reusable

| What you see | Name | Component | File |
|---|---|---|---|
| Colored dot/icon indicating column status | **Column indicator** | `ColumnIndicator` | `components/ui/column-indicator.tsx` |
| Syntax-highlighted diff blocks | **Diff renderer** | `DiffRenderer` | `components/shared/diff-renderer.tsx` |
| Diff parsing and hunk extraction | **Diff parser** | `parseDiff` | `components/shared/diff-parser.ts` |
| Syntax highlighting (Prism language resolution, line highlighting) | **Syntax highlighting** | `resolvePrismLanguage`, `getHighlightedLineHtml` | `components/shared/syntax-highlighting.ts` |
| Reusable confirmation dialog (Radix AlertDialog) | **Confirmation dialog** | `ConfirmationDialog` | `components/ui/confirmation-dialog.tsx` |
| Settings form controls (switch, checkbox, select) | **Settings controls** | various | `components/ui/settings-controls.tsx` |
| Searchable dropdown (branches, open targets, etc.) | **Search dropdown** | `SearchSelectDropdown` | `components/search-select-dropdown.tsx` |
| Autocomplete popup in the prompt composer | **Completion picker** | `InlineCompletionPicker` | `components/inline-completion-picker.tsx` |
| Textarea with file mentions and image paste | **Prompt composer** | `TaskPromptComposer` | `components/task-prompt-composer.tsx` |
| Editable task title (click to edit) | **Title editor** | `InlineTitleEditor` | `components/inline-title-editor.tsx` |
| IDE open button with target dropdown | **Open workspace button** | `OpenWorkspaceButton` | `components/open-workspace-button.tsx` |

### Key Hooks

60 hook files in `web-ui/src/hooks/`. The most important ones for understanding data flow:

| What it does | Hook | File |
|---|---|---|
| Manages which project is active, URL sync, add/remove | `useProjectNavigation` | `hooks/use-project-navigation.ts` |
| Derives display-ready project list with local task counts | `useProjectUiState` | `hooks/use-project-ui-state.ts` |
| Sidebar tab selection + side panel ratio (localStorage) | `useCardDetailLayout` | `resize/use-card-detail-layout.ts` |
| Home + detail terminal open/close/expand state | `useTerminalPanels` | `hooks/use-terminal-panels.ts` |
| Board mutations (drag, trash, start, restore, etc.) | `useBoardInteractions` | `hooks/use-board-interactions.ts` |
| DnD handler extracted from board interactions | `useBoardDragHandler` | `hooks/use-board-drag-handler.ts` |
| Task start orchestration (worktree, agent, dialog) | `useTaskStart` | `hooks/use-task-start.ts` |
| Task lifecycle (stop, restart, resume) | `useTaskLifecycle` | `hooks/use-task-lifecycle.ts` |
| Trash/untrash/hard-delete workflow | `useTrashWorkflow` | `hooks/use-trash-workflow.ts` |
| Session-to-column sync (hook-driven card moves) | `useSessionColumnSync` | `hooks/use-session-column-sync.ts` |
| WebSocket state stream (projects, workspace, sessions) | `useRuntimeStateStream` | `runtime/use-runtime-state-stream.ts` |
| On-demand diff content loading | `useFileDiffContent` | `runtime/use-file-diff-content.ts` |
