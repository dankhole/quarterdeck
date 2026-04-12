---
project: commit-sidebar-tab
date: 2026-04-12
ticket: null
status: research
---

# Research: Commit Sidebar Tab

## Codebase Research Summary

### Relevant Code

**Backend — Git Operations Layer**

- `src/workspace/git-utils.ts` — `runGit(cwd, args, options)` executes git commands, returns `{ ok, stdout, stderr, output, error, exitCode }`. All new git operations (stage, commit, restore single file) go through this.
- `src/workspace/git-sync.ts:377-417` — `discardGitChanges({ cwd })` runs `git restore --source=HEAD --staged --worktree -- .` + `git clean -fd -- .`. Full discard only — no per-file path. New `discardSingleFile` and `commitSelectedFiles` functions will live alongside this.
- `src/workspace/get-workspace-changes.ts:371-427` — `getWorkspaceChanges(cwd)` returns `{ repoRoot, generatedAt, files[] }` where each file has `path, status, additions, deletions, oldText, newText`. Uses fingerprint-based caching (max 128 entries). This is the data source for the commit panel's file list.
- `src/workspace/task-worktree.ts:734` — `resolveTaskWorkingDirectory()` resolves a taskId to the task's worktree path. Used by all task-scoped operations.

**Backend — tRPC API Layer**

- `src/core/api-contract.ts:1-42` — Zod schemas for workspace file changes, request/response types. `RuntimeWorkspaceFileChange` has `path, status, additions, deletions, oldText, newText`. New commit and discard-file schemas will be added here.
- `src/trpc/app-router.ts:400-411` — Workspace router with existing mutations: `discardGitChanges`, `runGitSyncAction`, `checkoutGitBranch`. New `commitSelectedFiles` and `discardFile` mutations follow the same `workspaceProcedure` pattern.
- `src/trpc/workspace-api.ts:259-288` — `discardGitChanges` handler: resolves cwd (home or task worktree), blocks discard for shared-checkout tasks (line 269-273), calls git-sync, broadcasts state update on success. New handlers follow this exact pattern.
- `src/core/api-validation.ts:61-89` — Request parsing helpers for `workspaceProcedure` inputs.

**Frontend — Layout/Sidebar Infrastructure**

- `web-ui/src/resize/use-card-detail-layout.ts:14-15` — `SidebarId = "projects" | "task_column"`. New `"commit"` variant added here. Auto-coupling rules at lines 146-157: "home" forces sidebar to "projects"; "files"/"git" collapse sidebar unless pinned.
- `web-ui/src/components/detail-panels/detail-toolbar.tsx:129-226` — Vertical toolbar: 4 main view buttons above divider, 2 sidebar buttons below. New `SidebarButton` for commit tab added here.
- `web-ui/src/App.tsx:1272-1313` — Sidebar rendering: `sidebar === "projects"` renders `ProjectNavigationPanel`. New `sidebar === "commit"` branch needed for both home and task contexts.
- `web-ui/src/components/card-detail-view.tsx:304-338` — Task sidebar rendering: `sidebar === "task_column"` renders `ColumnContextPanel`. New `sidebar === "commit"` branch needed here.

**Frontend — Data & Actions**

- `web-ui/src/runtime/use-runtime-workspace-changes.ts` — Hook that fetches file list from `workspace.getChanges`. Supports polling via `pollIntervalMs` (1s in git view). The commit panel reuses this hook for its file list.
- `web-ui/src/hooks/use-git-actions.ts:434-473` — `discardHomeWorkingChanges` (defined but **currently unreferenced from any UI**). Calls `workspace.discardGitChanges.mutate(null)`. New commit and per-file discard actions follow the same pattern.
- `web-ui/src/hooks/use-scope-context.ts:42` — Scope resolution: if task selected → `{type:"task", taskId, baseRef}`, else → `{type:"home"}`. Determines which workspace operations target.

**Frontend — UI Patterns**

- `web-ui/src/components/detail-panels/context-menu-utils.ts` — Shared `CONTEXT_MENU_ITEM_CLASS` and `copyToClipboard` helper for Radix context menus.
- `web-ui/src/components/detail-panels/file-browser-tree-panel.tsx:292-355` — Canonical Radix `ContextMenu.Root > Trigger asChild > Portal > Content` pattern with shared styling.
- `web-ui/src/components/detail-panels/file-tree-panel.tsx:11-68` — `FileTreeRow` renders files with `+N/-N` diff stats using `text-status-green`/`text-status-red`. Uses `buildFileTree()` utility.
- `web-ui/src/components/detail-panels/checkout-confirmation-dialog.tsx` — Existing Radix Checkbox pattern (`@radix-ui/react-checkbox`).

**Cross-View Navigation**

- `web-ui/src/App.tsx:962-969` — `openGitCompare(navigation)` sets `pendingCompareNavigation` state + calls `setMainView("git")`. The consume side is in `git-view.tsx:311` via useEffect.
- `web-ui/src/hooks/use-git-view-compare.ts:9-12` — `GitViewCompareNavigation = { sourceRef?, targetRef? }`. New `pendingFileNavigation` for "open in diff viewer" / "open in file browser" follows this same pattern.

### Existing Patterns

| Pattern | Example | Reference |
|---------|---------|-----------|
| Sidebar panel | `ColumnContextPanel` | `column-context-panel.tsx` |
| Sidebar button | `SidebarButton` | `detail-toolbar.tsx:107` |
| Radix context menu | File browser tree | `file-browser-tree-panel.tsx:292-355` |
| Context menu styling | Shared class | `context-menu-utils.ts:3-4` |
| Radix checkbox | Checkout dialog | `checkout-confirmation-dialog.tsx` |
| File tree with diff stats | `FileTreePanel` | `file-tree-panel.tsx:11-68` |
| tRPC mutation + toast | `runGitAction` | `use-git-actions.ts:344-381` |
| Polling | Uncommitted tab 1s | `use-runtime-workspace-changes.ts:83-92` |
| Cross-view navigation | Compare tab nav | `App.tsx:962-969` |
| Backend git operations | `discardGitChanges` | `git-sync.ts:377-417` |

### Integration Points

1. **Sidebar registration**: `SidebarId` type → `detail-toolbar.tsx` button → `App.tsx` rendering → `card-detail-view.tsx` rendering → `use-card-detail-layout.ts` auto-coupling rules.
2. **Backend endpoints**: New schemas in `api-contract.ts` → new functions in `git-sync.ts` → new handlers in `workspace-api.ts` → new procedures in `app-router.ts`.
3. **File list data**: Reuse existing `useRuntimeWorkspaceChanges` hook with `mode: "working_copy"` and 1s polling.
4. **Cross-view navigation**: New `pendingFileNavigation` state in `App.tsx` → consumed by `git-view.tsx` (for "open in diff viewer") and `files-view.tsx` (for "open in file browser"). Follow the `pendingCompareNavigation` pattern.
5. **Post-mutation refresh**: After commit/discard, broadcast `workspace_state_updated` → triggers metadata store version bump → `useRuntimeWorkspaceChanges` auto-refetches. Also call `refreshGitHistory()` per existing pattern.

### Test Infrastructure

- **Runtime tests**: Vitest in `test/` directory. Key files: `test/runtime/trpc/workspace-api.test.ts` (extend for new endpoints), `test/runtime/git-utils.test.ts`, `test/runtime/git-history.test.ts` (integration tests with real temp repos).
- **Web UI tests**: Vitest + jsdom, co-located in `web-ui/src/`. Existing: `column-context-panel.test.tsx`, `card-detail-view.test.tsx`, `diff-viewer-panel.test.tsx`.
- **Mocking**: `vi.hoisted()` + `vi.mock()` pattern. Module paths use `.js` extensions. `createTempDir()` + `createGitTestEnv()` for integration tests.
- **Commands**: `npm test` (runtime), `npm run web:test` (web UI), `npx vitest run <file>` (single file).

### All Code Paths for Behavioral Change

1. **File list rendering**: `useRuntimeWorkspaceChanges` → `workspace.getChanges` → `getWorkspaceChanges(cwd)` → returns `RuntimeWorkspaceFileChange[]`. Same data flow as git view uncommitted tab. Commit sidebar adds checkbox state (client-only).
2. **Commit flow** (NEW): UI checkbox selection + message → `workspace.commitSelectedFiles.mutate({taskId, paths, message})` → `workspace-api.commitSelectedFiles` → resolve cwd (home or task worktree) → `git add <paths>` + `git commit -m <message>` → broadcast state update → UI auto-refreshes.
3. **Per-file rollback** (NEW): Right-click → Rollback → `workspace.discardFile.mutate({taskId, path})` → resolve cwd → `git restore --source=HEAD -- <path>` (tracked) or `rm <path>` (untracked) → broadcast state update → file disappears from list.
4. **Discard all**: Commit sidebar button → existing `workspace.discardGitChanges.mutate({taskId, baseRef})` → existing backend. Task-scoped already supported on backend, just needs frontend wiring.
5. **Open in diff viewer**: Right-click → context menu → set `pendingFileNavigation({view:"git", path})` → `setMainView("git")` → git view useEffect detects pending nav → switches to uncommitted tab → selects file.
6. **Open in file browser**: Right-click → context menu → set `pendingFileNavigation({view:"files", path})` → `setMainView("files")` → files view useEffect detects pending nav → navigates to file.
7. **Sidebar toggle**: Click commit toolbar button → `toggleSidebar("commit")` → renders commit panel in sidebar slot.
8. **Context switching**: Task selected → commit panel shows task worktree changes. No task → shows home repo changes. Switching tasks → data refreshes via `taskId` change in hook params.

### Constraints Discovered

1. **Shared-checkout safety guard** (`workspace-api.ts:269-273`): Discard and commit for tasks that share the main checkout (no worktree) must be blocked or warned. The existing discard endpoint already returns an error for this. New commit endpoint needs the same guard.
2. **Sidebar auto-collapse** (`use-card-detail-layout.ts:153-155`): "files" and "git" main views collapse the sidebar unless pinned. The commit sidebar should NOT auto-collapse on files/git since the user may want to commit while viewing diffs. Need to exempt "commit" from this rule or make it follow the same pattern — design decision for the spec.
3. **No `git add --intent-to-add` handling**: `getWorkspaceChanges` uses `git diff --name-status HEAD` for tracked files + `git ls-files --others` for untracked. The commit endpoint will need to `git add` untracked files before committing — straightforward but must be handled.
4. **Cache invalidation is automatic**: After commit, HEAD moves → fingerprint changes → cache miss on next `getWorkspaceChanges` call → fresh data. No manual cache invalidation needed.
5. **File content in response**: `getWorkspaceChanges` returns `oldText`/`newText` for every file. The commit sidebar only needs `path`, `status`, `additions`, `deletions` — it pays the cost of full content anyway since reusing the same endpoint/hook. Acceptable for v1.
6. **`discardHomeWorkingChanges` has no UI trigger**: The function exists in `use-git-actions.ts:434` but is not called from any component. The commit sidebar becomes its home.

### Gaps

- **No cross-view file navigation pattern exists yet**: The `pendingCompareNavigation` pattern handles navigating to a compare view with refs, but there's no equivalent for "navigate to a specific file in the uncommitted tab" or "navigate to a specific file in the files view." This needs to be invented following the same `setPending → setMainView → useEffect consume` pattern.
- **Git view uncommitted tab doesn't accept external file selection**: The uncommitted tab renders its own `FileTreePanel` with internal `selectedFilePath` state. To support "open in diff viewer," it needs to accept and react to an externally-provided file path. This is a small addition to `git-view.tsx`.
- **Files view doesn't accept external navigation target**: Similar gap — `FilesView` manages its own selected path internally. Needs to accept a `pendingNavigation` prop.
