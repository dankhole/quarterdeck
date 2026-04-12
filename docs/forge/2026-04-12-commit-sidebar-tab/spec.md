# Commit Sidebar Tab — Implementation Specification

**Date**: 2026-04-12
**Branch**: TBD
**Ticket**: None
**Adversarial Review Passes**: 3
**Test Spec**: [test-spec.md](test-spec.md)

<!-- Raw Intent (preserved for traceability, not for implementation agents):
Todo item #6: New sidebar tab showing uncommitted changes as a file list with checkboxes for staging, a commit message input, and a commit button at the bottom — similar to the JetBrains "Commit" tool window. Commits are executed server-side via `runGit()`, no agent session needed. This is the quick-commit flow for the common case — commit without leaving your current main view. User specified: no push for v1, no auto-generated messages for v1, ignore staged/unstaged distinction, per-file rollback via right-click, open in diff viewer and open in file browser via right-click.
-->

## Goal

Add a "Commit" sidebar tab that provides a JetBrains-style quick-commit workflow — file list with checkboxes, per-file status badges, right-click context menu (rollback, open in diff viewer, open in file browser), commit message textarea, and a Commit button. All git operations are server-side via `runGit()`, no agent session required. Works in both task-worktree and home-repo contexts.

## Behavioral Change Statement

> **BEFORE**: Committing changes requires using the agent, dropping to a terminal, or external tools. There is no built-in UI for staging and committing files. The "discard all changes" function exists in code (`use-git-actions.ts:434`) but has no UI trigger. Per-file rollback does not exist.
> **AFTER**: A "Commit" sidebar tab shows all uncommitted files with checkboxes, status badges, and a right-click context menu. A commit message textarea and Commit button at the bottom allow server-side commits of selected files. Discard-all and per-file rollback are accessible from this panel. Cross-view navigation from the context menu opens files in the git diff viewer or file browser.
> **SCOPE — all code paths affected**:
> 1. Sidebar infrastructure: `use-card-detail-layout.ts:15` (SidebarId type) → `detail-toolbar.tsx` (button) → `App.tsx:1272` (home rendering) → `card-detail-view.tsx:304` (task rendering)
> 2. Backend commit: NEW `app-router.ts` mutation → `workspace-api.ts` handler → `git-sync.ts` `commitSelectedFiles()` → `runGit()` git add + commit
> 3. Backend per-file discard: NEW `app-router.ts` mutation → `workspace-api.ts` handler → `git-sync.ts` `discardSingleFile()` → `runGit()` git restore/rm
> 4. Frontend file list: `useRuntimeWorkspaceChanges` hook → `workspace.getChanges` → `getWorkspaceChanges()` → UI renders checkboxes + status badges
> 5. Frontend commit action: UI → NEW `workspace.commitSelectedFiles.mutate()` → backend → broadcast state update → UI auto-refreshes
> 6. Frontend per-file rollback: context menu → NEW `workspace.discardFile.mutate()` → backend → broadcast → file disappears
> 7. Frontend discard-all: commit panel button → existing `workspace.discardGitChanges.mutate(taskScope)` → backend → broadcast → list clears
> 8. Cross-view navigation: context menu → NEW `pendingFileNavigation` state → `setMainView("git"|"files")` → target view consumes navigation → selects file

## Hard Behavioral Constraints

### !1 — Server-side git execution only

All git operations (commit, discard, rollback) execute on the server via `runGit()`. No agent session, no PTY, no terminal interaction. The commit panel works identically whether or not an agent session is active.

### !2 — Dual context: task worktree and home repo

The commit panel operates on the task's worktree when a task is selected, and on the home repo when no task is selected. The `taskId` field in API requests is the discriminator. Context switches when the user selects/deselects a task.

### !3 — Shared-checkout safety guard

Commit and discard operations for tasks that share the main checkout (no isolated worktree) must be blocked with a clear error message, matching the existing guard at `workspace-api.ts:269-273`.

### !4 — Partial commit support

Users can check a subset of changed files and commit only those. Unchecked files remain uncommitted after the operation.

### !5 — Git errors abort and show toast

Any git operation failure (commit, discard, rollback) aborts cleanly with no partial state and shows an error toast with the git error message. The file list state is not corrupted.

### !6 — Auto-refresh after mutations

After any successful commit, discard, or rollback, the file list refreshes automatically via the existing `broadcastRuntimeWorkspaceStateUpdated` → state version bump → `useRuntimeWorkspaceChanges` refetch chain.

## Functional Verification

| # | What to do | Expected result | Code path verified |
|---|-----------|----------------|-------------------|
| 1 | Click the Commit sidebar button in the toolbar (no task selected) | Commit panel opens showing uncommitted files in the home repo with checkboxes, status badges (M/A/D/R/U), and +N/-N counts | Paths 1, 4 |
| 2 | Select a task, click the Commit sidebar button | Commit panel shows uncommitted files in the task's worktree | Paths 1, 2, 4 |
| 3 | Click the select-all checkbox | All file checkboxes toggle on. Click again → all toggle off | Path 4 |
| 4 | Check 2 of 5 files, type a commit message, click Commit | Only the 2 checked files are committed. The other 3 remain in the file list. Toast shows success | Paths 4, 5 |
| 5 | Check all files, type a message, click Commit | All files committed. File list shows empty state. Toast shows success | Path 5 |
| 6 | Try to commit with no files checked | Commit button is disabled (or shows validation message) | Path 5 |
| 7 | Try to commit with empty commit message | Commit button is disabled (or shows validation message) | Path 5 |
| 8 | Force a git error (e.g., corrupt index) then try to commit | Operation aborts, error toast with git message, file list unchanged | Path 5, !5 |
| 9 | Right-click a modified/added/deleted file → "Rollback" | File's changes are discarded. File disappears from the list. Toast shows success | Path 6 |
| 9a | Right-click a renamed/copied file → context menu | "Rollback" menu item is disabled with explanation. Other menu items work normally | Path 6 |
| 10 | Right-click a file → "Open in Diff Viewer" | Main view switches to Git view (Uncommitted tab) with that file selected in the file tree | Path 8 |
| 11 | Right-click a file → "Open in File Browser" | Main view switches to Files view, navigated to that file | Path 8 |
| 12 | Right-click a file → "Copy Path" | File path copied to clipboard | Path 4 |
| 13 | Click "Discard All" button | All uncommitted changes discarded. File list shows empty state. Toast shows success | Path 7 |
| 14 | Open commit panel for a task with a shared checkout (no worktree) → try to commit | Error message shown, commit blocked | !3 |
| 15 | Make a change in the worktree while commit panel is open | File list auto-updates within ~1s (polling) | Path 4, !6 |
| 16 | Switch between tasks while commit panel is open | File list refreshes to show the new task's worktree changes | !2 |
| 17 | Toggle between Commit, Board, and Projects sidebar tabs | Each tab renders correctly. State is preserved when switching back | Path 1 |
| 18 | No uncommitted changes exist | Commit panel shows empty state message, Commit button disabled | Path 4 |

## Current State

- `web-ui/src/resize/use-card-detail-layout.ts:15` — `SidebarId = "projects" | "task_column"`. No "commit" variant.
- `web-ui/src/components/detail-panels/detail-toolbar.tsx:189-205` — 2 sidebar buttons (Projects, Board). No Commit button.
- `src/trpc/app-router.ts:400-411` — Workspace router has `discardGitChanges`, `runGitSyncAction`, `checkoutGitBranch`. No commit or per-file discard mutations.
- `src/workspace/git-sync.ts:377-417` — `discardGitChanges()` does full discard only. No `commitSelectedFiles` or `discardSingleFile`.
- `web-ui/src/hooks/use-git-actions.ts:434-473` — `discardHomeWorkingChanges()` exists but is unreferenced from any component.
- `web-ui/src/runtime/use-runtime-workspace-changes.ts` — Hook exists for fetching uncommitted file list with polling. Used by git view.
- `web-ui/src/App.tsx:962-969` — `pendingCompareNavigation` pattern exists for cross-view navigation to the compare tab. No file-level navigation.

## Desired End State

A third sidebar tab ("Commit") appears in the toolbar below the divider, alongside Projects and Board. When opened, it displays a scrollable list of uncommitted files with checkboxes, status badges, and diff stat counts. A select-all checkbox at the top controls all files. Right-clicking a file opens a context menu with Rollback, Open in Diff Viewer, Open in File Browser, Copy Name, and Copy Path options. At the bottom, a commit message textarea and Commit button allow committing checked files. A Discard All button allows discarding all uncommitted changes. The panel works in both task and home contexts, auto-refreshes via polling, and gracefully handles git errors via toasts.

## Out of Scope

- Commit and Push (future todo #24)
- Auto-generated commit messages (future todo #25)
- Staged vs unstaged distinction / git index modeling
- Amend checkbox
- Inline diff preview within the sidebar
- Push operations of any kind

## Dependencies

No external dependencies. All required packages (`@radix-ui/react-context-menu`, `@radix-ui/react-checkbox`, `lucide-react`, `sonner`) are already installed.

## New Dependencies & Configuration

None. All dependencies are already in `web-ui/package.json`.

## Architecture & Approach

Follow established patterns exactly:
- **Backend**: New git functions in `git-sync.ts`, new handlers in `workspace-api.ts`, new procedures in `app-router.ts`, Zod schemas in `api-contract.ts`. Same layered pattern as existing `discardGitChanges`.
- **Sidebar**: Register new `SidebarId` variant, add toolbar button, add rendering branches in `App.tsx` and `card-detail-view.tsx`. Same pattern as `ColumnContextPanel`.
- **Data**: Reuse `useRuntimeWorkspaceChanges` hook for the file list with 1s polling.
- **Context menu**: Use Radix `ContextMenu` with `CONTEXT_MENU_ITEM_CLASS` from `context-menu-utils.ts`. Same pattern as `file-browser-tree-panel.tsx:292-355`.
- **Cross-view navigation**: Extend the `pendingCompareNavigation` pattern with a new `pendingFileNavigation` state for file-level navigation.

### Design Decisions

| Decision | Choice | Rationale | Alternative Considered | Implementation Constraint |
|----------|--------|-----------|----------------------|--------------------------|
| Sidebar vs Main View | Sidebar panel | User wants quick-commit without leaving current main view. Sidebar is the right surface. | Main view tab | Must be `SidebarId`, not `MainViewId` |
| File list data source | Reuse `useRuntimeWorkspaceChanges` | Same data as git view uncommitted tab. Avoids duplicate endpoints. | New lightweight endpoint (path+status only) | Pays cost of `oldText`/`newText` fetching — acceptable for v1 |
| Checkbox state | Client-side only | Git index modeling is out of scope. Checkboxes are UI state. Server receives explicit file paths at commit time. | Model git staging area | Must NOT call `git add` until the user clicks Commit |
| Sidebar auto-collapse behavior | Commit sidebar does NOT auto-collapse on "files"/"git" main views | User may want to view diffs (git view) while staging files for commit. Collapsing would break this workflow. | Follow existing auto-collapse rule | Must update the auto-collapse condition at `use-card-detail-layout.ts:153-155` to exclude `"commit"` |
| Commit panel availability | Available with and without a task selected | Committing in the home repo is a valid use case (e.g., after manual edits) | Task-only (like Board sidebar) | Must handle both contexts in rendering and API calls |

## Interface Contracts

### tRPC Mutations

#### `workspace.commitSelectedFiles`

**Input** (`runtimeGitCommitRequestSchema`):
```typescript
z.object({
  taskScope: runtimeTaskWorkspaceInfoRequestSchema.nullable(),
  paths: z.array(z.string()).min(1),
  message: z.string().min(1),
})
```

Note: The `taskScope` field follows the same `{ taskId: string, baseRef: string } | null` shape used by `optionalTaskWorkspaceInfoRequestSchema`. When `taskScope` is `null`, the commit operates on the home repo. The workspace-api handler uses `normalizeOptionalTaskWorkspaceScopeInput(input.taskScope)` to parse the task scope, then accesses `input.paths` and `input.message` directly for the extra fields.

**Output** (`runtimeGitCommitResponseSchema`):
```typescript
z.object({
  ok: z.boolean(),
  commitHash: z.string().optional(),
  summary: runtimeGitSyncSummarySchema,
  output: z.string(),
  error: z.string().optional(),
})
```

**Behavior**:
1. Resolve cwd: home repo (`taskScope` null) or task worktree (`taskScope` present → pass to `resolveTaskWorkingDirectory`)
2. Block if shared checkout (same guard as discard)
3. Run `git add -- <paths>` (handles both tracked and untracked files)
4. Run `git commit -m <message>`
5. On success: extract commit hash from output, get updated git summary, broadcast state update
6. On failure at any step: return `{ ok: false, error: <message> }`. If `git add` succeeded but `git commit` failed, run `git reset HEAD -- <paths>` to unstage.

#### `workspace.discardFile`

**Input** (`runtimeGitDiscardFileRequestSchema`):
```typescript
z.object({
  taskScope: runtimeTaskWorkspaceInfoRequestSchema.nullable(),
  path: z.string().min(1),
  fileStatus: runtimeWorkspaceFileStatusSchema,
})
```

Note: Same `taskScope` pattern as `runtimeGitCommitRequestSchema`. The workspace-api handler uses `normalizeOptionalTaskWorkspaceScopeInput(input.taskScope)` for scope resolution and accesses `input.path` and `input.fileStatus` directly.

**Output** (`runtimeGitDiscardResponseSchema`): (reuses existing schema)
```typescript
z.object({
  ok: z.boolean(),
  summary: runtimeGitSyncSummarySchema,
  output: z.string(),
  error: z.string().optional(),
})
```

**Behavior**:
1. Resolve cwd: home or task worktree
2. Block if shared checkout
3. Based on `fileStatus`:
   - `"untracked"`: `git clean -f -- <path>`
   - `"renamed"` or `"copied"`: Return `{ ok: false, error: "Cannot rollback renamed/copied files individually. Use Discard All instead." }`. For renamed files (`foo.ts` → `bar.ts`), `git restore --source=HEAD --staged --worktree -- bar.ts` fails because `bar.ts` didn't exist at HEAD. Proper rollback requires restoring the original path AND removing the new path, which is complex and deferred to a future version.
   - All other statuses (`"modified"`, `"added"`, `"deleted"`, `"unknown"`): `git restore --source=HEAD --staged --worktree -- <path>`
4. Get updated summary, broadcast state update

### Cross-View Navigation Type

```typescript
interface PendingFileNavigation {
  targetView: "git" | "files";
  filePath: string;
}
```

Held as `useState<PendingFileNavigation | null>` in `App.tsx`, passed down to `GitView` and `FilesView` as props, consumed via `useEffect` and cleared after navigation.

## Implementation Phases

### Phase 1: Backend — New Git Operations & tRPC Endpoints

#### Overview

Add the server-side git operations and tRPC endpoints for committing selected files and discarding a single file. This phase has no frontend changes — it establishes the API that the UI will call.

#### Changes Required

##### 1. Zod Schemas

**File**: `src/core/api-contract.ts`
**Action**: Add
**Location**: After existing git schemas (near `runtimeGitDiscardResponseSchema`)
**Changes**:
- Add `runtimeGitCommitRequestSchema`: `{ taskScope: { taskId: string, baseRef: string } | null, paths: string[], message: string }` — reuses `runtimeTaskWorkspaceInfoRequestSchema` for the `taskScope` field to match the existing `optionalTaskWorkspaceInfoRequestSchema` shape
- Add `runtimeGitCommitResponseSchema`: `{ ok: boolean, commitHash?: string, summary: RuntimeGitSyncSummary, output: string, error?: string }`
- Add `runtimeGitDiscardFileRequestSchema`: `{ taskScope: { taskId: string, baseRef: string } | null, path: string, fileStatus: RuntimeWorkspaceFileStatus }` — same `taskScope` pattern
- Export types for all new schemas

**Code Pattern to Follow**: See existing `runtimeGitCheckoutRequestSchema` / `runtimeGitCheckoutResponseSchema` at `api-contract.ts` for the established pattern of request/response schema pairs.

##### 2. Git Operations

**File**: `src/workspace/git-sync.ts`
**Action**: Add two new exported functions
**Location**: After `discardGitChanges()` (line 417)
**Changes**:

`commitSelectedFiles(options: { cwd: string; paths: string[]; message: string })`:
- Resolve repo root via `resolveRepoRoot(cwd)`
- Validate all paths via `validateGitPath()` from `git-utils.ts` (reject `..` traversal). If any path fails validation, return `{ ok: false, error: "Invalid file path: <path>", summary: <empty summary>, output: "", commitHash: undefined }` immediately — do not proceed to git commands.
- Run `git add -- <paths>` via `runGit()`
- If add fails → return error response
- Run `git commit -m <message>` via `runGit()`
- If commit fails → run `git reset HEAD -- <paths>` to unstage, return error response
- On success → extract commit hash from stdout (parse `[branch hash]` pattern), get `getGitSyncSummary()`, return response

`discardSingleFile(options: { cwd: string; path: string; fileStatus: string })`:
- Resolve repo root
- Validate path via `validateGitPath()`. If validation fails, return `{ ok: false, error: "Invalid file path", summary: <empty summary>, output: "" }` immediately.
- If `fileStatus === "renamed"` or `"copied"` → return `{ ok: false, error: "Cannot rollback renamed/copied files individually. Use Discard All instead." }` with empty summary
- If `fileStatus === "untracked"` → run `git clean -f -- <path>`
- Otherwise → run `git restore --source=HEAD --staged --worktree -- <path>`
- Get updated `getGitSyncSummary()`, return response

**Code Pattern to Follow**: See `discardGitChanges()` at `git-sync.ts:377-417` — same structure of resolve root → check preconditions → run git commands → get summary → return structured response.

##### 3. Workspace API Handlers

**File**: `src/trpc/workspace-api.ts`
**Action**: Add two new methods to `createWorkspaceApi`
**Location**: After `discardGitChanges` handler (line 288)
**Changes**:

`commitSelectedFiles(workspaceScope, input)`:
- Parse task scope with `normalizeOptionalTaskWorkspaceScopeInput(input.taskScope)`
- Resolve cwd: if `taskScope` is null → `workspaceScope.workspacePath` (home repo); otherwise → `resolveTaskWorkingDirectory()`
- Block shared-checkout tasks (same guard as `discardGitChanges` at line 269-273)
- Call `commitSelectedFiles({ cwd, paths: input.paths, message: input.message })`
- On success → broadcast `broadcastRuntimeWorkspaceStateUpdated`
- Wrap in try/catch → return error response via `createEmptyGitCommitErrorResponse(error)` on failure

`discardFile(workspaceScope, input)`:
- Parse task scope with `normalizeOptionalTaskWorkspaceScopeInput(input.taskScope)` — same pattern
- Same cwd resolution and shared-checkout guard
- Call `discardSingleFile({ cwd, path: input.path, fileStatus: input.fileStatus })`
- On success → broadcast
- Wrap in try/catch → return error response via `createEmptyGitDiscardErrorResponse(error)` on failure

**Error response helper**: Add `createEmptyGitCommitErrorResponse(error: unknown): RuntimeGitCommitResponse` in `workspace-api.ts` alongside the existing `createEmptyGitDiscardErrorResponse`. It returns `{ ok: false, summary: <empty summary>, output: "", error: message }` — same pattern but with the `commitHash` field omitted (it's optional in the response schema).

**Code Pattern to Follow**: See `discardGitChanges` handler at `workspace-api.ts:259-288` — identical structure. See `createEmptyGitDiscardErrorResponse` at `workspace-api.ts:157-173` for the error response helper pattern.

##### 4. tRPC Router Procedures

**File**: `src/trpc/app-router.ts`
**Action**: Add two new mutations to the workspace router
**Location**: After existing `discardGitChanges` procedure (around line 405)
**Changes**:

```typescript
commitSelectedFiles: workspaceProcedure
  .input(runtimeGitCommitRequestSchema)
  .output(runtimeGitCommitResponseSchema)
  .mutation(async ({ ctx, input }) => {
    return await ctx.workspaceApi.commitSelectedFiles(ctx.workspaceScope, input);
  }),

discardFile: workspaceProcedure
  .input(runtimeGitDiscardFileRequestSchema)
  .output(runtimeGitDiscardResponseSchema)
  .mutation(async ({ ctx, input }) => {
    return await ctx.workspaceApi.discardFile(ctx.workspaceScope, input);
  }),
```

Note: The router procedures pass the full `input` to the workspace-api handler. The handler destructures `input.taskScope` for scope resolution and `input.paths`/`input.message` (or `input.path`/`input.fileStatus`) for the operation. No `input ?? null` coercion needed because `taskScope` is already typed as nullable within the schema.

**Code Pattern to Follow**: See `discardGitChanges` procedure at `app-router.ts:400-405`.

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] Type check passes: `npm run typecheck`
- [ ] Lint passes: `npm run lint`
- [ ] Runtime tests pass: `npm test`

##### Behavioral

- [ ] New schemas export correctly (verified via type check)
- [ ] New functions are importable from `git-sync.ts`

**Checkpoint**: Pause here for verification before proceeding to Phase 2.

---

### Phase 2: Frontend — Sidebar Infrastructure

#### Overview

Register the "commit" sidebar tab in the layout system, add the toolbar button, and create the commit panel component shell. After this phase, clicking the Commit toolbar button opens an empty panel in the sidebar slot.

#### Changes Required

##### 1. SidebarId Type

**File**: `web-ui/src/resize/use-card-detail-layout.ts`
**Action**: Modify
**Location**: Line 15
**Changes**:
- Add `"commit"` to `SidebarId`: `export type SidebarId = "projects" | "task_column" | "commit";`
- Update `toggleSidebar` (around line 164): the commit sidebar is NOT task-tied — it works in both task and home contexts. Do NOT add `"commit"` to `lastSidebarTab` tracking (that mechanism is only for `"task_column"` which requires a task). The commit sidebar simply opens and closes via `toggleSidebar` with no special task-coupling logic.
- Update auto-coupling rules: When `mainView` switches to `"files"` or `"git"`, do NOT auto-collapse if `sidebar === "commit"` (user may want to view diffs while staging). Modify the condition at line 153-155 to: `if ((mainView === "files" || mainView === "git") && sidebar !== "commit" && !sidebarPinned) { collapse }`
- Task deselection behavior: The existing code at line 209-211 falls back `"task_column"` to `"projects"` on task deselection. The commit sidebar must NOT be affected — it stays open and switches to showing home repo changes. No code change needed here (the existing condition only checks `=== "task_column"`), but verify this during testing.
- Update `loadSidebar()` at line 52-64: add `if (stored === "commit") return "commit";` to the stored-value checks (after `"task_column"`, before the `"changes"` migration). This prevents a persisted `"commit"` value from falling through to the legacy migration path. `loadLastSidebarTab()` does NOT need this change (it only tracks `"task_column"`). `persistSidebar()` needs no changes (it already persists any `SidebarId | null`).

##### 2. Toolbar Button

**File**: `web-ui/src/components/detail-panels/detail-toolbar.tsx`
**Action**: Modify
**Location**: After the Board `SidebarButton` (around line 205)
**Changes**:
- Import `GitCommitHorizontal` from `lucide-react`
- Add a new `SidebarButton`:
  ```tsx
  <SidebarButton
    sidebarId="commit"
    activeSidebar={activeSidebar}
    onSidebarChange={onSidebarChange}
    icon={<GitCommitHorizontal size={18} />}
    label="Commit"
  />
  ```
- Note: NOT disabled when no task selected — commit panel works in home context too

##### 3. Commit Panel Component Shell

**File**: `web-ui/src/components/detail-panels/commit-panel.tsx` (NEW)
**Action**: Create
**Changes**:
- Create a basic panel component that renders "Commit panel" placeholder text
- Accept props matching the sidebar rendering pattern: `taskId`, `workspaceId`, `baseRef` for context resolution
- Export `CommitPanel` component
- This is a shell — full UI comes in Phase 3

##### 4. App.tsx Sidebar Rendering

**File**: `web-ui/src/App.tsx`
**Action**: Modify
**Location**: Sidebar rendering block (around line 1272-1313)
**Changes**:
- Import `CommitPanel`
- Restructure the sidebar rendering conditional at line 1272. The existing condition is:
  ```
  sidebar === "projects" || (sidebar !== null && !selectedCard)
  ```
  This currently renders `ProjectNavigationPanel` for any non-null sidebar when no task is selected — which would incorrectly render `ProjectNavigationPanel` when `sidebar === "commit"`. Change to:
  ```
  sidebar === "projects" ? <ProjectNavigationPanel ... />
  : sidebar === "commit" && !selectedCard ? <CommitPanel ... /> (home context, no task)
  : null
  ```
  The key insight: when `sidebar === "commit"` and a task IS selected, the `CommitPanel` is rendered by `CardDetailView` (Phase 2, step 5), not by `App.tsx`. When `sidebar === "commit"` and no task is selected, `App.tsx` renders it in the home sidebar slot.
- **Home context props**: `<CommitPanel workspaceId={currentProjectId} taskId={null} baseRef={null} />`
  (Phase 4 adds `navigateToFile={navigateToFile}` — see step 5)
- The commit panel renders in the same sidebar layout slot as `ProjectNavigationPanel`, using the same `homeSidePanelPercent` flex sizing and resize handle

##### 5. CardDetailView Sidebar Rendering

**File**: `web-ui/src/components/card-detail-view.tsx`
**Action**: Modify
**Location**: Task side panel conditional (around line 304-338)
**Changes**:
- Import `CommitPanel`
- Extend `isTaskSidePanelOpen` to include `sidebar === "commit"`: `const isTaskSidePanelOpen = sidebar === "task_column" || sidebar === "commit"`
- Add rendering branch: when `sidebar === "commit"`, render `CommitPanel` with task context props instead of `ColumnContextPanel`:
  `<CommitPanel workspaceId={currentProjectId} taskId={selection.card.id} baseRef={selection.card.baseRef} />`
  (Phase 4 adds `navigateToFile={navigateToFile}` — see step 5)

##### 6. Update UI Layout Architecture Doc

**File**: `docs/ui-layout-architecture.md`
**Action**: Modify
**Changes**:
- Add `"commit"` to `SidebarId` type definition
- Add Commit entry to Sidebar Details section
- Update auto-coupling rules table (commit sidebar exempt from files/git auto-collapse)
- Update component hierarchy diagram

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] Type check passes: `npm run typecheck && npm run web:typecheck`
- [ ] Lint passes: `npm run lint`

##### Behavioral

- [ ] Commit button appears in toolbar below divider
- [ ] Clicking it toggles a sidebar panel (placeholder content visible)
- [ ] Clicking it again collapses the sidebar
- [ ] Switching to git or files main view does NOT auto-collapse the commit sidebar
- [ ] The commit sidebar renders in both task and home contexts

**Checkpoint**: Pause here for verification before proceeding to Phase 3.

---

### Phase 3: Frontend — Commit Panel UI

#### Overview

Build the full commit panel UI: file list with checkboxes, status badges, select-all, commit message textarea, Commit button, and Discard All button. Wire up the commit and discard-all actions to the backend endpoints.

#### Changes Required

##### 1. Commit Panel Hook

**File**: `web-ui/src/hooks/use-commit-panel.ts` (NEW)
**Action**: Create
**Changes**:

Create a hook `useCommitPanel(taskId, workspaceId, baseRef)` that encapsulates all commit panel state and actions:
- **State version**: Both hooks must be called unconditionally (React rules of hooks). Derive the effective version from context:
  ```typescript
  const taskStateVersion = useTaskWorkspaceStateVersionValue(taskId);
  const homeStateVersion = useHomeGitStateVersionValue();
  const stateVersion = taskId ? taskStateVersion : homeStateVersion;
  ```
  Import both from `@/stores/workspace-metadata-store`. When `taskId` is null (home context), `useTaskWorkspaceStateVersionValue` returns 0 with a no-op subscription — harmless. When `taskId` is present, `useHomeGitStateVersionValue` still subscribes but its value is ignored.
- **File list**: Use `useRuntimeWorkspaceChanges(taskId, workspaceId, baseRef, "working_copy", stateVersion, pollIntervalMs)` for data with 1s polling (see polling suppression below)
- **Selection state**: `Map<string, boolean>` tracking which files are checked. Initialize all files as checked when data loads. When file list changes (files added/removed), sync selection state (add new files as checked, remove departed files).
- **Select-all**: Computed from selection state. Tri-state: all checked, none checked, some checked (indeterminate).
- **Commit message**: `useState<string>("")`
- **Task scope helper**: Derives `taskScope` from `taskId` and `baseRef`: `const taskScope = taskId && baseRef ? { taskId, baseRef } : null`. This is `null` for home context and `{ taskId, baseRef }` for task context. Both `taskId` and `baseRef` are required together — `baseRef` on `CardData` is `string` (required, non-nullable), so if a task is selected, `baseRef` is always present.
- **Commit action**: Calls `workspace.commitSelectedFiles.mutate({ taskScope, paths: selectedPaths, message })`. Shows success/error toast. Clears message on success.
- **Discard all action**: Calls `workspace.discardGitChanges.mutate(taskScope)`. Shows success/error toast. Uses existing endpoint. Note: `discardGitChanges` uses `optionalTaskWorkspaceInfoRequestSchema` which accepts `{ taskId, baseRef } | null` — same shape as `taskScope`.
- **Per-file rollback action**: Calls `workspace.discardFile.mutate({ taskScope, path, fileStatus })`. Shows success/error toast.
- **Polling suppression during mutations**: Track an `isMutating` flag (true when any of commit/discard/rollback is in flight). Derive `pollIntervalMs` as `isMutating ? null : 1000` and pass it to `useRuntimeWorkspaceChanges`. This prevents a poll from firing during the `git add` → `git commit` window and seeing partially staged state, which would cause brief UI flicker. The state version bump after the mutation completes triggers a refetch regardless.
- **Loading states**: Track `isCommitting`, `isDiscarding`, `isRollingBack` to disable UI during operations. Derive `isMutating = isCommitting || isDiscarding || isRollingBack`.
- **Validation**: `canCommit = selectedPaths.length > 0 && message.trim().length > 0 && !isCommitting`
- **Shared-checkout detection**: If commit/discard returns error about shared checkout, show that in the toast

**Code Pattern to Follow**: See `use-git-actions.ts:344-381` for the tRPC mutation + toast + loading state pattern. See `use-runtime-workspace-changes.ts` for the data fetching pattern.

##### 2. Commit Panel Component

**File**: `web-ui/src/components/detail-panels/commit-panel.tsx`
**Action**: Modify (replace shell from Phase 2)
**Changes**:

**Layout** (flex column, full height):
```
┌─────────────────────────┐
│ Header: "Changes" + count│  ← sticky top
│ [✓] Select all (N files) │
├─────────────────────────┤
│ ☐ path/to/file.ts  M +3-1│  ← scrollable file list
│ ☑ path/to/other.ts A +10 │
│ ☑ new-file.ts      U +5  │
│                          │
│                          │
├─────────────────────────┤
│ [Commit message textarea]│  ← fixed bottom section
│                          │
│ [Commit]  [Discard All]  │
└─────────────────────────┘
```

- **Header**: "Changes" label + file count badge. Use `text-[13px] font-medium text-text-secondary`.
- **Select-all row**: Radix Checkbox with indeterminate state. Label: "Select all (N files)". Follows `checkout-confirmation-dialog.tsx` pattern.
- **File list**: Scrollable `overflow-y-auto flex-1`. Each row is a `CommitFileRow` sub-component:
  - Radix Checkbox (left)
  - File icon (`FileText` from lucide, 14px)
  - File path (truncated, `text-[13px]`)
  - Status badge: single letter colored by status — M (`text-status-blue`, modified), A (`text-status-green`, added), D (`text-status-red`, deleted), R (`text-status-orange`, renamed), C (`text-status-blue`, copied), U (`text-text-secondary`, untracked), ? (`text-text-tertiary`, unknown)
  - Diff stats: `+N` green, `-N` red (same pattern as `file-tree-panel.tsx:46-49`)
  - Entire row wrapped in Radix `ContextMenu.Root > Trigger` for right-click menu (Phase 4 adds the content)
- **Commit message**: `<textarea>` with `bg-surface-2 border border-border rounded-md p-2 text-[13px] text-text-primary placeholder:text-text-tertiary resize-none`. Placeholder: "Commit message". 3-4 rows height.
- **Buttons**: Row with `Commit` (primary variant, disabled when `!canCommit`) and `Discard All` (danger variant). Use `Button` from `@/components/ui/button`.
- **Empty state**: When no files, show centered message "No uncommitted changes" with `text-text-tertiary`.
- **Loading state**: While `isCommitting`, show spinner on Commit button. While `isDiscarding`, show spinner on Discard All.

**Styling**: Follow `bg-surface-0` for panel background. File rows use `hover:bg-surface-3` for hover. Selected (checked) rows can have a subtle `bg-surface-2/50` tint. Use Tailwind classes throughout (no inline styles for theme colors).

##### 3. Wire Discard All for Task Context

**File**: `web-ui/src/hooks/use-commit-panel.ts`
**Action**: Part of hook creation (above)
**Changes**:
- The discard-all action passes `taskScope` (`{ taskId, baseRef }` when a task is selected, or `null` for home context) to `workspace.discardGitChanges.mutate()`
- This wires up the task-scoped discard path that exists on the backend but has never been called from the frontend

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] Type check passes: `npm run typecheck && npm run web:typecheck`
- [ ] Lint passes: `npm run lint`

##### Behavioral

- [ ] Opening commit panel shows file list with checkboxes and status badges
- [ ] Select-all toggles all checkboxes
- [ ] Typing a message and clicking Commit with files checked → files are committed, list refreshes
- [ ] Partial commit: checking 2 of 5 files → only 2 committed, 3 remain
- [ ] Discard All removes all uncommitted changes
- [ ] Empty state shown when no changes exist
- [ ] Error toast shown on git failure
- [ ] Panel works in both task and home contexts

**Checkpoint**: Pause here for verification before proceeding to Phase 4.

---

### Phase 4: Frontend — Context Menu & Cross-View Navigation

#### Overview

Add the right-click context menu to each file row (rollback, open in diff viewer, open in file browser, copy name, copy path) and implement the cross-view navigation mechanism.

#### Changes Required

##### 1. Cross-View Navigation State

**File**: `web-ui/src/App.tsx`
**Action**: Modify
**Location**: Near `pendingCompareNavigation` state (around line 963)
**Changes**:
- Add new state: `const [pendingFileNavigation, setPendingFileNavigation] = useState<PendingFileNavigation | null>(null);`
- Define type (in a types file or inline): `interface PendingFileNavigation { targetView: "git" | "files"; filePath: string; }`
- Add `navigateToFile` callback:
  ```typescript
  const navigateToFile = useCallback((nav: PendingFileNavigation) => {
    setPendingFileNavigation(nav);
    setMainView(nav.targetView, { setSelectedTaskId });
  }, [setMainView, setSelectedTaskId]);
  ```
- Add `clearPendingFileNavigation` callback
- Pass `pendingFileNavigation` and `clearPendingFileNavigation` as props to `GitView` and `FilesView` in all rendering paths (task and home)
- Pass `navigateToFile` to `CommitPanel`

**Code Pattern to Follow**: See `openGitCompare` / `pendingCompareNavigation` at `App.tsx:962-969` — identical pattern.

##### 2. Git View — Accept External File Navigation

**File**: `web-ui/src/components/git-view.tsx`
**Action**: Modify
**Changes**:
- Add `pendingFileNavigation` and `onFileNavigationConsumed` props
- Add `useEffect`: when `pendingFileNavigation?.targetView === "git"`, switch to the "uncommitted" tab via `setActiveTab("uncommitted")` and set `selectedPath` to `pendingFileNavigation.filePath` via `setSelectedPath()`, then call `onFileNavigationConsumed()`
- Note: The variable is `selectedPath` (not `selectedFilePath`) — see `git-view.tsx:231`. Same pattern as the existing `pendingCompareNavigation` consumption at line 310-314.
- This makes the git view select a specific file when navigated to from the commit panel

##### 3. Files View — Accept External File Navigation

**File**: `web-ui/src/components/files-view.tsx`
**Action**: Modify
**Changes**:
- Add `pendingFileNavigation` and `onFileNavigationConsumed` props
- Add `useEffect`: when `pendingFileNavigation?.targetView === "files"`, call `fileBrowserData.onSelectPath(pendingFileNavigation.filePath)` to set the selected path, then call `onFileNavigationConsumed()`

Note: `FilesView` does NOT own the file selection state — it receives `fileBrowserData: UseFileBrowserDataResult` as a prop from the parent. The `useFileBrowserData` hook owns `selectedPath` and exposes `onSelectPath` to set it. The navigation effect in `FilesView` must use `fileBrowserData.onSelectPath()` to drive the selection, NOT create local state.

##### 4. Context Menu on File Rows

**File**: `web-ui/src/components/detail-panels/commit-panel.tsx`
**Action**: Modify
**Location**: Each `CommitFileRow`
**Changes**:
- Wrap each file row in `ContextMenu.Root > ContextMenu.Trigger asChild`
- Add `ContextMenu.Portal > ContextMenu.Content` with items:
  1. **Rollback** — icon: `Undo2`, calls `onRollbackFile(path, status)`, shows confirmation for safety since this is destructive. **Disabled** for `"renamed"` and `"copied"` statuses with tooltip "Cannot rollback renamed/copied files individually" — the backend rejects these, and disabling in the UI prevents a confusing error flow.
  2. **Open in Diff Viewer** — icon: `GitCompare` (or `Diff`), calls `onNavigateToFile({ targetView: "git", filePath: path })`
  3. **Open in File Browser** — icon: `FileSearch`, calls `onNavigateToFile({ targetView: "files", filePath: path })`
  4. **Separator**
  5. **Copy Name** — icon: `ClipboardCopy`, calls `copyToClipboard(fileName, "Name")`
  6. **Copy Path** — icon: `ClipboardCopy`, calls `copyToClipboard(path, "Path")`
- Use `CONTEXT_MENU_ITEM_CLASS` from `context-menu-utils.ts`
- Destructive items (Rollback) use `text-status-red` color

**Code Pattern to Follow**: See `file-browser-tree-panel.tsx:292-355` — exact same Radix ContextMenu structure and styling.

##### 5. Pass Navigation Callbacks Through

**File**: `web-ui/src/components/card-detail-view.tsx` and `web-ui/src/App.tsx`
**Action**: Modify
**Changes**:
- Modify the `CommitPanel` rendering in BOTH locations added in Phase 2:
  - **App.tsx home context** (Phase 2, step 4): Add `navigateToFile={navigateToFile}` prop to the `<CommitPanel>` rendered when `sidebar === "commit" && !selectedCard`
  - **CardDetailView task context** (Phase 2, step 5): Add `navigateToFile={navigateToFile}` prop to the `<CommitPanel>` rendered when `sidebar === "commit"`. This requires threading `navigateToFile` into `CardDetailView` as a new prop from `App.tsx`.
- `CommitPanel` passes `navigateToFile` to its file rows for the context menu actions

#### Success Criteria

##### Automated

- [ ] Build succeeds: `npm run build`
- [ ] Type check passes: `npm run typecheck && npm run web:typecheck`
- [ ] Lint passes: `npm run lint`

##### Behavioral

- [ ] Right-click a file → context menu appears with all 5 items
- [ ] "Rollback" discards that file's changes, file disappears from list
- [ ] "Open in Diff Viewer" switches to git view, uncommitted tab, with that file selected
- [ ] "Open in File Browser" switches to files view with that file selected
- [ ] "Copy Name" and "Copy Path" copy to clipboard with toast confirmation
- [ ] Context menu works in both task and home contexts

**Checkpoint**: Feature complete. Run full verification suite.

---

## Error Handling

| Scenario | Expected Behavior | How to Verify |
|----------|------------------|---------------|
| `git commit` fails (empty message, conflict) | Error toast with git message. No partial state. Files remain in list. | Force conflict, attempt commit |
| `git add` fails (path doesn't exist) | Error toast. Files remain unstaged. | Delete file between selection and commit |
| `git restore` fails (per-file rollback) | Error toast. File remains in list unchanged. | Attempt rollback on binary conflict |
| `git clean` fails (per-file rollback of untracked) | Error toast. File remains in list. | Protected directory scenario |
| Shared-checkout task commit/discard | Error toast: "Cannot commit/discard in shared checkout. Isolate task to worktree first." | Select non-worktree task, try commit |
| Network error (tRPC call fails) | Error toast with generic message. Loading state clears. | Kill server during operation |
| Commit succeeds but `git add` staged extra files | Rollback: `git reset HEAD -- <paths>` unstages on commit failure. On success, only requested paths are staged. | Partial staging test |

## Rollback Strategy

- **Phase 1 rollback**: Delete new schemas from `api-contract.ts`, new functions from `git-sync.ts`, new handlers from `workspace-api.ts`, new procedures from `app-router.ts`. No data migration needed.
- **Phase 2 rollback**: Remove `"commit"` from `SidebarId`, delete `commit-panel.tsx`, revert rendering branches in `App.tsx` and `card-detail-view.tsx`, revert toolbar button.
- **Phase 3 rollback**: Delete `use-commit-panel.ts`, revert `commit-panel.tsx` to shell.
- **Phase 4 rollback**: Remove `pendingFileNavigation` state, revert git-view and files-view props, remove context menu from commit panel.
- **Full rollback**: `git revert` the feature branch. No database, no persistent state changes.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| File list polling (1s) adds load with commit sidebar open | Low | Low | Same polling already runs in git view uncommitted tab. Not additive if both are open (shared query). |
| `oldText`/`newText` in workspace changes response is expensive for many files | Low | Medium | Acceptable for v1. Future optimization: add a `lightweight` mode that skips content. |
| Cross-view navigation races with view mounting | Low | Medium | Follow established `pendingCompareNavigation` pattern which handles this via useEffect + clear callback. |

## Implementation Notes / Gotchas

- **`validateGitPath()` + `--` separator**: New endpoints MUST validate user-provided file paths via `validateGitPath()` from `git-utils.ts` to reject `..` traversal. However, `validateGitPath` alone is not a complete security boundary (e.g., it does not reject `-` prefix paths that git could interpret as flags). All git commands MUST also use the `--` separator before file path arguments (e.g., `git add -- <paths>`, `git restore -- <path>`, `git clean -f -- <path>`) to ensure paths are never interpreted as options. Both layers are required.
- **`--no-optional-locks`**: In `git-sync.ts`, this flag is used only for read-only/query commands (`status`, `rev-parse`, `diff --numstat`) that run during polling and should not contend for the index lock. Write operations like `git restore`, `git clean`, and `git add` do NOT use it — they need the lock. The new `commitSelectedFiles` and `discardSingleFile` functions are write operations, so do NOT use `--no-optional-locks`. This matches the `discardGitChanges()` precedent at `git-sync.ts:377-417`.
- **Commit message safety with `execFile` array args**: The message is passed as `[..., "-m", message]` to `runGit()`, which uses `execFileAsync` (Node.js `execFile`). This means the message is always the argument to `-m`, even if it starts with `-` or contains `--amend`. For example, `["commit", "-m", "--amend"]` tells git: `-m`'s value is `"--amend"`. No flag injection possible. No special escaping needed.
- **Commit message newlines**: The commit message textarea may contain newlines. Pass the message via `git commit -m` — git handles this. Do NOT use shell escaping or temp files.
- **Untracked files in `git add`**: `git add -- <path>` works for both tracked modified files and untracked files. No special handling needed.
- **Cache invalidation after commit**: The `getWorkspaceChanges` cache keys on HEAD commit + file fingerprints. After a commit, HEAD changes → cache misses → fresh data on next poll. No manual invalidation needed.
- **Auto-coupling update**: The condition at `use-card-detail-layout.ts:153-155` auto-collapses sidebar on files/git views. The commit sidebar must be exempt from this. Update the condition to check `sidebar !== "commit"`.
- **`broadcastRuntimeWorkspaceStateUpdated`**: Call this after successful commit/discard operations. It triggers the WebSocket → metadata store → state version → useRuntimeWorkspaceChanges refetch chain that auto-refreshes the UI.
- **Button loading states**: While a mutation is in flight, the Commit and Discard All buttons should show a spinner and be disabled. The per-file rollback should disable the context menu item for that specific file.

## References

- **Related files**: `src/workspace/git-sync.ts:377-417`, `src/trpc/workspace-api.ts:259-288`, `src/trpc/app-router.ts:400-411`, `src/core/api-contract.ts:1-42`
- **Prior art**: `ColumnContextPanel` (sidebar panel), `file-browser-tree-panel.tsx:292-355` (context menu), `file-tree-panel.tsx:11-68` (file list with stats), `App.tsx:962-969` (cross-view navigation)
- **Test Spec**: [test-spec.md](test-spec.md)
