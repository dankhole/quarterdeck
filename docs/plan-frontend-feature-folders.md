# Frontend Feature Folders & Component Decomposition Plan

Reorganize `web-ui/src/` from type-grouped directories (components/, hooks/, stores/) into feature-grouped directories so that all code for a feature lives together — components, hooks, domain modules, and tests. Then decompose oversized components and add barrel exports for clean imports.

This continues the readability roadmap that already completed: provider extraction, hook subdirectories, domain module extraction, CSS decomposition, and backend class/interface refactoring. The remaining gaps are component organization, component sizes, and import ergonomics.

## Current state

### What's already done

- **Hooks** are in domain subdirectories: `hooks/board/`, `hooks/git/`, `hooks/terminal/`, `hooks/project/`, `hooks/notifications/`
- **Domain modules** extracted alongside hooks (16 modules, 211 tests)
- **Providers** extracted into `providers/` (Project, Board, Terminal, Git, Interactions, Dialog)
- **CSS** split from 920-line globals.css into 9 focused stylesheets
- **Backend** uses classes, service interfaces, handler files, typed dispatch maps

### What's left

1. **52 component files in `components/` root** — flat directory mixing board, git, task, settings, debug, and shell components. Six subdirectories exist (`detail-panels/`, `settings/`, `git-history/`, `shared/`, `ui/`, `dependencies/`) but 48 files sit at the root.
2. **7 components over 500 lines** — `board-card.tsx` (784), `git-view.tsx` (757), `task-create-dialog.tsx` (725), `project-navigation-panel.tsx` (679), `top-bar.tsx` (624), `card-detail-view.tsx` (587), `branch-selector-popover.tsx` (698).
3. **15 orphan hooks** at `hooks/` root that belong in subdirectories.
4. **Zero barrel exports** — every import is a direct file path.

---

## Phase 1: Sort orphan hooks into domain subdirectories

**Goal:** Every hook and domain module lives in a feature subdirectory. The `hooks/` root contains only `index.ts` barrel files (added in Phase 4).

**Approach:** Pure file moves + import path updates. No logic changes.

| Hook file | Target subdirectory | Rationale |
|-----------|-------------------|-----------|
| `use-app-dialogs.ts` | `hooks/app/` (new) | App-shell dialog state |
| `use-app-hotkeys.ts` + test | `hooks/app/` | App-level keyboard shortcuts |
| `use-escape-handler.ts` | `hooks/app/` | App-level escape key handling |
| `use-navbar-state.ts` | `hooks/app/` | Top bar / navigation state |
| `use-debug-logging.ts` | `hooks/debug/` (new) | Debug panel state |
| `debug-logging.ts` + test | `hooks/debug/` | Debug domain module |
| `use-debug-tools.ts` | `hooks/debug/` | Debug tools state |
| `use-display-summary.ts` + test | `hooks/board/` | Board card display |
| `use-file-browser-data.ts` | `hooks/git/` | File browser (git workspace) |
| `use-prompt-shortcuts.ts` + test | `hooks/board/` | Prompt shortcuts for agent tasks |
| `use-settings-form.ts` | `hooks/settings/` (new) | Settings dialog state |
| `settings-form.ts` + test | `hooks/settings/` | Settings domain module |
| `use-shortcut-actions.ts` + test | `hooks/settings/` | Shortcut CRUD |
| `shortcut-actions.ts` + test | `hooks/settings/` | Shortcut domain module |
| `use-task-editor.ts` + test | `hooks/board/` | Task editing state |
| `task-editor.ts` + test | `hooks/board/` | Task editor domain module |
| `use-task-base-ref-sync.ts` | `hooks/board/` | Board state sync |
| `use-task-branch-options.ts` | `hooks/git/` | Branch option computation |
| `use-task-start-actions.ts` + test | `hooks/board/` | Task start logic |
| `use-task-title-sync.ts` | `hooks/board/` | Board state sync |
| `use-task-working-directory-sync.ts` | `hooks/board/` | Board state sync |
| `use-title-actions.ts` | `hooks/board/` | Task title mutations |

New subdirectories: `hooks/app/`, `hooks/debug/`, `hooks/settings/`.

**Verification:** `npm run web:typecheck && npm run web:test` — no logic changes, only import paths.

---

## Phase 2: Group components into feature directories

**Goal:** Components live next to the hooks and domain modules they use, organized by feature. The `components/` root contains only cross-cutting app-shell files and re-exports.

### Target structure

```
web-ui/src/components/
├── app/                          # App shell (layout, routing, dialogs)
│   ├── app-dialogs.tsx
│   ├── app-error-boundary.tsx
│   ├── connected-top-bar.tsx
│   ├── home-view.tsx
│   ├── top-bar.tsx               (+ extracted sub-components after Phase 3)
│   ├── project-navigation-panel.tsx
│   ├── project-dialogs.tsx
│   ├── runtime-disconnected-fallback.tsx
│   ├── quarterdeck-access-blocked-fallback.tsx
│   ├── startup-onboarding-dialog.tsx
│   └── inline-completion-picker.tsx
│
├── board/                        # Kanban board
│   ├── board-card.tsx            (+ extracted sub-components after Phase 3)
│   ├── board-card.test.tsx
│   ├── board-column.tsx
│   ├── quarterdeck-board.tsx
│   ├── quarterdeck-board.test.tsx
│   └── dependencies/             (already exists, move into board/)
│
├── task/                         # Task creation, editing, detail view
│   ├── card-detail-view.tsx
│   ├── card-detail-view.test.tsx
│   ├── task-create-dialog.tsx
│   ├── task-inline-create-card.tsx
│   ├── task-prompt-composer.tsx
│   ├── task-image-strip.tsx
│   ├── task-start-agent-onboarding-carousel.tsx
│   ├── task-trash-warning-dialog.tsx
│   ├── hard-delete-task-dialog.tsx
│   ├── clear-trash-dialog.tsx
│   ├── migrate-working-directory-dialog.tsx
│   └── inline-title-editor.tsx + test
│
├── git/                          # Git operations, branches, conflicts
│   ├── git-view.tsx
│   ├── git-history-view.tsx + test
│   ├── git-init-dialog.tsx
│   ├── git-action-error-dialog.tsx
│   ├── conflict-banner.tsx
│   ├── branch-select-dropdown.tsx
│   ├── files-view.tsx
│   ├── history/                  (rename from git-history/)
│   │   └── (existing files)
│   └── panels/                   (rename from detail-panels/)
│       ├── branch-selector-popover.tsx
│       ├── commit-panel.tsx
│       ├── conflict-resolution-panel.tsx + test
│       ├── diff-viewer-panel.tsx + test
│       ├── diff-split.tsx
│       ├── diff-unified.tsx
│       ├── diff-viewer-utils.tsx
│       ├── file-browser-tree-panel.tsx
│       ├── file-content-viewer.tsx
│       ├── file-tree-panel.tsx
│       ├── scope-bar.tsx
│       ├── stash-list-section.tsx
│       ├── context-menu-utils.tsx
│       └── (all branch dialog files)
│
├── terminal/                     # Terminal in card detail
│   ├── agent-terminal-panel.tsx  (from detail-panels/)
│   ├── detail-toolbar.tsx        (from detail-panels/)
│   └── column-context-panel.tsx + test (from detail-panels/)
│
├── settings/                     # (already exists — keep as-is)
│   ├── runtime-settings-dialog.tsx  (move from root)
│   ├── runtime-settings-dialog.test.tsx
│   ├── prompt-shortcut-editor-dialog.tsx + test
│   └── (existing section files)
│
├── debug/                        # Debug tools
│   ├── debug-shelf.tsx
│   ├── debug-dialog.tsx
│   └── debug-log-panel.tsx
│
├── shared/                       # (already exists — cross-cutting rendering)
│   └── (existing files)
│
└── ui/                           # (already exists — design primitives)
    └── (existing files)
```

**Approach:** Pure file moves + import path updates. Batch by feature directory — move one group, update imports, verify typecheck, move next.

**Verification after each batch:** `npm run web:typecheck` — catch broken imports immediately. Full `npm run web:test` after all moves complete.

---

## Phase 3: Decompose oversized components

**Goal:** No component file exceeds ~400 lines. Extract sub-components and domain logic.

Do these in priority order (biggest files first, highest reader traffic first).

### 3a. `board-card.tsx` (784 lines)

The board card renders session status, agent metadata, prompt preview, dependency badges, drag handles, context menus, and branch labels — all in one file. Extract:

- **`BoardCardStatusBadge`** — session status indicator + tooltip (the status icon/color/animation logic)
- **`BoardCardContextMenu`** — right-click menu with trash/archive/start/stop actions
- **`BoardCardMetadata`** — branch pill, agent label, timestamp, dependency badges
- Keep the top-level `BoardCard` as a composition wrapper (~200 lines)

### 3b. `git-view.tsx` (757 lines)

Extract:
- **`GitViewToolbar`** — the tab bar / toolbar with compare mode toggle, scope selector
- **`GitViewDiffSection`** — the diff panel wrapper with file tree integration
- **`GitViewConflictBanner`** — conflict state UI (may already be partially in `conflict-banner.tsx`)
- Keep `GitView` as the layout shell

### 3c. `task-create-dialog.tsx` (725 lines)

Extract:
- **`TaskCreateForm`** — the form body (title, description, branch selection, agent selection)
- **`TaskCreateAdvancedOptions`** — advanced settings section (worktree isolation toggle, base ref)
- Keep the dialog chrome (open/close, validation, submit) in the parent

### 3d. `branch-selector-popover.tsx` (698 lines)

Extract:
- **`BranchListItem`** — single branch row with status indicators and context menu
- **`BranchContextMenu`** — the extensive right-click menu (checkout, compare, merge, delete, rename, rebase, reset, pull, push)
- Keep the popover wrapper + search/filter logic

### 3e. `project-navigation-panel.tsx` (679 lines)

Extract:
- **`ProjectListItem`** — single project row with task counts and status
- **`ProjectListHeader`** — section headers with collapse/expand
- Keep the panel wrapper + project switching logic

### 3f. `top-bar.tsx` (624 lines)

Extract:
- **`TopBarProjectSection`** — project name, switch button
- **`TopBarTaskSection`** — selected task info, status, agent
- **`TopBarShortcutButtons`** — project shortcut button row
- Keep `TopBar` as layout + composition

### 3g. `card-detail-view.tsx` (587 lines)

Extract:
- **`DetailViewTabBar`** — the tab strip for terminal/git/files/history views
- **`DetailViewHeader`** — task title, branch pill, action buttons
- Keep `CardDetailView` as layout shell + tab routing

**Approach per component:** Read the component, identify natural extraction boundaries (look for `{/* section */}` comments, distinct state groups, or JSX blocks that take no props from siblings), extract into same directory, wire up props/callbacks. Each extraction is one commit.

**Verification:** `npm run web:typecheck && npm run web:test` after each extraction. If the component has visual tests or test files, run those specifically.

---

## Phase 4: Add barrel exports

**Goal:** Consumers import from feature modules, not individual files.

Add `index.ts` to each feature directory that re-exports the public API:

```ts
// web-ui/src/components/board/index.ts
export { BoardCard } from "./board-card";
export { BoardColumn } from "./board-column";
export { QuarterdeckBoard } from "./quarterdeck-board";
```

```ts
// web-ui/src/hooks/board/index.ts
export { useBoardInteractions } from "./use-board-interactions";
export { useLinkedBacklogTaskActions } from "./use-linked-backlog-task-actions";
export { useReviewAutoActions } from "./use-review-auto-actions";
// ... etc
```

Apply to all feature directories in both `components/` and `hooks/`.

Update existing import sites to use barrel imports. This can be done incrementally — new code uses barrels, existing code migrates over time.

**Verification:** `npm run web:typecheck` — barrel re-exports must not create circular dependencies. If they do, the barrel for that directory should only export leaf components, not things that import from peers.

---

## Execution order and dependencies

```
Phase 1 (hooks cleanup)
  │  No dependencies, small scope, low risk
  ▼
Phase 2 (component grouping)
  │  Depends on Phase 1 so import paths are stable
  ▼
Phase 3 (component decomposition)
  │  Depends on Phase 2 so new sub-components go in the right directories
  ▼
Phase 4 (barrel exports)
     Depends on Phases 1-3 so barrel files export the final public API
```

Each phase is independently shippable. If you stop after Phase 2, the codebase is still better than before.

## Risk mitigation

- **Merge conflicts:** These phases touch import paths in many files. Do each phase on its own branch and merge promptly. Avoid running concurrent feature branches that also move files.
- **Circular dependencies:** Barrel exports can surface or create circular imports. If `npm run web:typecheck` passes but the dev server hangs, check for barrel → barrel cycles. Fix by removing the cyclic re-export and requiring direct imports for that edge.
- **No logic changes in Phases 1-2:** These are pure file moves. If a test breaks, it's an import path typo, not a behavior regression.
- **Phase 3 extraction boundaries:** When extracting sub-components, prefer passing 2-4 focused props over prop-drilling the entire parent state. If a sub-component needs more than 6 props from the parent, the extraction boundary is probably wrong.
