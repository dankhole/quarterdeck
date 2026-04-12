# Task Graph: Commit Sidebar Tab

**Generated**: 2026-04-12
**Spec**: docs/forge/2026-04-12-commit-sidebar-tab/spec.md
**Test Spec**: docs/forge/2026-04-12-commit-sidebar-tab/test-spec.md
**Total tasks**: 25

## Execution Order

```
Phase 1 (Backend):
  T1 → T2 → T3 → T4 → T5 → T6

Phase 2 (Sidebar Infrastructure):
  T7 → T8 → T9 → T10 → T11

Phase 3 (Commit Panel UI):
  T12 → T13 → T14 → T15 → T16 → T17

Phase 4 (Context Menu & Cross-View Navigation):
  T18 → T19 → T20 → T21 → T22 → T23

Final:
  T24 → T25
```

Dependency chains:
- T2 depends on T1
- T3 depends on T1, T2
- T4 depends on T1, T2, T3
- T5 depends on T4
- T6 depends on T5
- T8 depends on T7
- T9 depends on T7
- T10 depends on T8, T9
- T11 depends on T10
- T12 depends on T6
- T13 depends on T11, T12
- T14 depends on T13
- T15 depends on T14
- T16 depends on T15
- T17 depends on T16
- T18 depends on T17
- T19 depends on T18
- T20 depends on T18
- T21 depends on T19, T20
- T22 depends on T21
- T23 depends on T22
- T24 depends on T23
- T25 depends on T24

## Tasks

---

### T1: Add Zod schemas for commit and discard-file endpoints
- **Grade**: 2
- **Status**: pending
- **Depends on**: none
- **SDD Phase**: Phase 1 — Backend (Step 1: Zod Schemas)
- **Files to modify**: `src/core/api-contract.ts`
- **Description**: Add four new Zod schemas and their inferred TypeScript types to `api-contract.ts`:
  1. `runtimeGitCommitRequestSchema` — `{ taskScope: runtimeTaskWorkspaceInfoRequestSchema.nullable(), paths: z.array(z.string()).min(1), message: z.string().min(1) }`
  2. `runtimeGitCommitResponseSchema` — `{ ok: z.boolean(), commitHash: z.string().optional(), summary: runtimeGitSyncSummarySchema, output: z.string(), error: z.string().optional() }`
  3. `runtimeGitDiscardFileRequestSchema` — `{ taskScope: runtimeTaskWorkspaceInfoRequestSchema.nullable(), path: z.string().min(1), fileStatus: runtimeWorkspaceFileStatusSchema }`
  4. No new discard response schema needed — reuse existing `runtimeGitDiscardResponseSchema`.
  Export all new types. Place after existing `runtimeGitDiscardResponseSchema` block (around line 219).
- **Acceptance criteria**:
  - **Automated**: `npm run typecheck` passes. `npm run lint` passes.
  - **Manual**: None.
- **Outcome notes**:
- **Attempts**:

---

### T2: Implement `commitSelectedFiles` in git-sync.ts
- **Grade**: 2
- **Status**: pending
- **Depends on**: T1
- **SDD Phase**: Phase 1 — Backend (Step 2: Git Operations — commitSelectedFiles)
- **Files to modify**: `src/workspace/git-sync.ts`
- **Description**: Add exported function `commitSelectedFiles(options: { cwd: string; paths: string[]; message: string }): Promise<RuntimeGitCommitResponse>`. Implementation:
  1. Resolve repo root via `resolveRepoRoot(cwd)`.
  2. Validate all paths via `validateGitPath()` from `git-utils.ts`. If any fails, return `{ ok: false, error: "Invalid file path: <path>", summary: <empty>, output: "", commitHash: undefined }`.
  3. Run `git add -- <paths>` via `runGit()`.
  4. If add fails, return error response.
  5. Run `git commit -m <message>` via `runGit()`.
  6. If commit fails, run `git reset HEAD -- <paths>` to unstage, return error response.
  7. On success, extract commit hash from stdout (parse `[branch hash]` pattern), call `getGitSyncSummary()`, return success response.
  Import `validateGitPath` from `git-utils.ts`. Do NOT use `--no-optional-locks` (this is a write operation). Use `--` separator before paths in all git commands.
- **Acceptance criteria**:
  - **Automated**: `npm run typecheck` passes. `npm run build` passes.
  - **Manual**: None (tested via T5).
- **Outcome notes**:
- **Attempts**:

---

### T3: Implement `discardSingleFile` in git-sync.ts
- **Grade**: 2
- **Status**: pending
- **Depends on**: T1, T2
- **SDD Phase**: Phase 1 — Backend (Step 2: Git Operations — discardSingleFile)
- **Files to modify**: `src/workspace/git-sync.ts`
- **Description**: Add exported function `discardSingleFile(options: { cwd: string; path: string; fileStatus: string }): Promise<RuntimeGitDiscardResponse>`. Implementation:
  1. Resolve repo root via `resolveRepoRoot(cwd)`.
  2. Validate path via `validateGitPath()`. If fails, return `{ ok: false, error: "Invalid file path", summary: <empty>, output: "" }`.
  3. If `fileStatus === "renamed"` or `"copied"`, return `{ ok: false, error: "Cannot rollback renamed/copied files individually. Use Discard All instead." }` with empty summary.
  4. If `fileStatus === "untracked"`, run `git clean -f -- <path>`.
  5. Otherwise, run `git restore --source=HEAD --staged --worktree -- <path>`.
  6. Get updated `getGitSyncSummary()`, return response.
  Follow `discardGitChanges()` at `git-sync.ts:377-417` for structure. Do NOT use `--no-optional-locks`.
- **Acceptance criteria**:
  - **Automated**: `npm run typecheck` passes. `npm run build` passes.
  - **Manual**: None (tested via T5).
- **Outcome notes**:
- **Attempts**:

---

### T4: Add workspace-api handlers and tRPC router procedures
- **Grade**: 2
- **Status**: pending
- **Depends on**: T1, T2, T3
- **SDD Phase**: Phase 1 — Backend (Steps 3 + 4: Workspace API Handlers + tRPC Router)
- **Files to modify**: `src/trpc/workspace-api.ts`, `src/trpc/app-router.ts`
- **Description**:
  **workspace-api.ts**: Add two new methods to the object returned by `createWorkspaceApi`:
  1. `commitSelectedFiles(workspaceScope, input)` — Parse task scope via `normalizeOptionalTaskWorkspaceScopeInput(input.taskScope)`, resolve cwd (home vs task worktree), shared-checkout guard (same as `discardGitChanges` at line 269-273), call `commitSelectedFiles()` from git-sync, broadcast on success. Add `createEmptyGitCommitErrorResponse(error)` helper following `createEmptyGitDiscardErrorResponse` pattern.
  2. `discardFile(workspaceScope, input)` — Same scope resolution and guard, call `discardSingleFile()`, broadcast on success.

  **app-router.ts**: Add two new mutations to the workspace router after `discardGitChanges`:
  1. `commitSelectedFiles` — `workspaceProcedure.input(runtimeGitCommitRequestSchema).output(runtimeGitCommitResponseSchema).mutation(...)`.
  2. `discardFile` — `workspaceProcedure.input(runtimeGitDiscardFileRequestSchema).output(runtimeGitDiscardResponseSchema).mutation(...)`.
  Import new schemas from `api-contract.ts`.
- **Acceptance criteria**:
  - **Automated**: `npm run typecheck` passes. `npm run build` passes. `npm run lint` passes. `npm test` passes (existing tests unbroken).
  - **Manual**: None.
- **Outcome notes**:
- **Attempts**:

---

### T5: Write backend integration tests for git operations
- **Grade**: 2
- **Status**: pending
- **Depends on**: T4
- **SDD Phase**: Phase 1 — Tests
- **Files to modify**: `test/runtime/git-commit.test.ts` (NEW)
- **Description**: Create integration test file following `test/runtime/git-history.test.ts` pattern. Use `createTempDir()` and `createGitTestEnv()` to create real temp git repos. Implement all 14 test cases from the test spec:
  1. `commitSelectedFiles commits only specified paths` — partial commit with 3 files, assert only 2 committed
  2. `commitSelectedFiles handles untracked files` — new file committed via `git add`
  3. `commitSelectedFiles returns commit hash` — verify hash matches `git rev-parse HEAD`
  4. `commitSelectedFiles fails with empty paths array` — schema validation rejects
  5. `commitSelectedFiles fails with empty message` — schema validation rejects
  6. `commitSelectedFiles rolls back staging on commit failure` — verify unstaged after failed commit
  7. `commitSelectedFiles rejects path traversal` — `..` paths rejected
  8. `discardSingleFile restores tracked modified file` — file restored to HEAD
  9. `discardSingleFile removes untracked file` — file deleted
  10. `discardSingleFile restores tracked deleted file` — file recreated from HEAD
  11. `discardSingleFile handles staged file` — staged + worktree restored
  12. `discardSingleFile rejects path traversal` — `..` paths rejected
  13. `discardSingleFile rejects renamed files` — returns error, no git command run
  14. `discardSingleFile rejects copied files` — returns error, no git command run
- **Acceptance criteria**:
  - **Automated**: `npx vitest run test/runtime/git-commit.test.ts` — all 14 tests pass.
  - **Manual**: None.
- **Outcome notes**:
- **Attempts**:

---

### T6: Extend workspace-api tests for new handlers
- **Grade**: 2
- **Status**: pending
- **Depends on**: T5
- **SDD Phase**: Phase 1 — Tests
- **Files to modify**: `test/runtime/trpc/workspace-api.test.ts` (EXTEND)
- **Description**: Add 8 test cases to the existing workspace-api test file following its mock pattern:
  1. `commitSelectedFiles resolves home cwd when no taskId` — taskScope null routes to workspacePath
  2. `commitSelectedFiles resolves task worktree cwd` — taskScope present routes to resolveTaskWorkingDirectory
  3. `commitSelectedFiles blocks shared-checkout tasks` — shared checkout returns error
  4. `commitSelectedFiles broadcasts state update on success` — broadcastRuntimeWorkspaceStateUpdated called
  5. `commitSelectedFiles returns error on git failure` — error propagation
  6. `discardFile resolves cwd and calls discardSingleFile` — basic routing
  7. `discardFile blocks shared-checkout tasks` — safety guard
  8. `discardFile broadcasts state update on success` — broadcast called
- **Acceptance criteria**:
  - **Automated**: `npx vitest run test/runtime/trpc/workspace-api.test.ts` — all tests pass (existing + 8 new).
  - **Manual**: None.
- **Outcome notes**:
- **Attempts**:

---

### T7: Add "commit" to SidebarId type and update loadSidebar
- **Grade**: 2
- **Status**: pending
- **Depends on**: none
- **SDD Phase**: Phase 2 — Frontend Sidebar Infrastructure (Step 1: SidebarId Type)
- **Files to modify**: `web-ui/src/resize/use-card-detail-layout.ts`
- **Description**: 
  1. Extend `SidebarId` type at line 15: `export type SidebarId = "projects" | "task_column" | "commit";`
  2. Update `loadSidebar()` at line 52-64: add `if (stored === "commit") return "commit";` after the `"task_column"` check to prevent fallthrough to legacy migration.
  3. Update auto-coupling in `setMainView` at line 152: change `if ((view === "files" || view === "git") && !sidebarPinnedRef.current)` to `if ((view === "files" || view === "git") && sidebarRef.current !== "commit" && !sidebarPinnedRef.current)` so the commit sidebar is not auto-collapsed.
  4. Verify that `toggleSidebar` does NOT need changes — it already handles any `SidebarId`. Do NOT add `"commit"` to `lastSidebarTab` tracking (that is `task_column`-only).
  5. Verify task deselection (line 209-211) only checks `=== "task_column"` — commit sidebar unaffected, no change needed.
- **Acceptance criteria**:
  - **Automated**: `npm run web:typecheck` passes.
  - **Manual**: None (UI tested after T11).
- **Outcome notes**:
- **Attempts**:

---

### T8: Add Commit toolbar button
- **Grade**: 1
- **Status**: pending
- **Depends on**: T7
- **SDD Phase**: Phase 2 — Frontend Sidebar Infrastructure (Step 2: Toolbar Button)
- **Files to modify**: `web-ui/src/components/detail-panels/detail-toolbar.tsx`
- **Description**: Import `GitCommitHorizontal` from `lucide-react`. Add a `SidebarButton` after the Board button (line 205):
  ```tsx
  <SidebarButton
    sidebarId="commit"
    activeSidebar={activeSidebar}
    onSidebarChange={onSidebarChange}
    icon={<GitCommitHorizontal size={18} />}
    label="Commit"
  />
  ```
  NOT disabled when no task selected — commit panel works in home context.
- **Acceptance criteria**:
  - **Automated**: `npm run web:typecheck` passes.
  - **Manual**: Commit button visible in toolbar below divider.
- **Outcome notes**:
- **Attempts**:

---

### T9: Create CommitPanel component shell
- **Grade**: 1
- **Status**: pending
- **Depends on**: T7
- **SDD Phase**: Phase 2 — Frontend Sidebar Infrastructure (Step 3: Component Shell)
- **Files to modify**: `web-ui/src/components/detail-panels/commit-panel.tsx` (NEW)
- **Description**: Create a basic shell component:
  ```tsx
  interface CommitPanelProps {
    workspaceId: string;
    taskId: string | null;
    baseRef: string | null;
  }
  export function CommitPanel({ workspaceId, taskId, baseRef }: CommitPanelProps) {
    return (
      <div className="flex flex-col h-full p-3 text-text-secondary text-[13px]">
        Commit panel
      </div>
    );
  }
  ```
  This is a placeholder — Phase 3 replaces it with the full UI.
- **Acceptance criteria**:
  - **Automated**: `npm run web:typecheck` passes.
  - **Manual**: None (rendered in parent via T10).
- **Outcome notes**:
- **Attempts**:

---

### T10: Wire CommitPanel rendering in App.tsx and CardDetailView
- **Grade**: 2
- **Status**: pending
- **Depends on**: T8, T9
- **SDD Phase**: Phase 2 — Frontend Sidebar Infrastructure (Steps 4 + 5: App.tsx + CardDetailView)
- **Files to modify**: `web-ui/src/App.tsx`, `web-ui/src/components/card-detail-view.tsx`
- **Description**:
  **App.tsx** (line 1272): Restructure the sidebar rendering conditional. Current: `sidebar === "projects" || (sidebar !== null && !selectedCard)` renders `ProjectNavigationPanel` for any non-null sidebar without a task. Change to:
  - `sidebar === "projects" || (sidebar !== null && sidebar !== "commit" && !selectedCard)` renders `ProjectNavigationPanel`
  - Add new branch: `sidebar === "commit" && !selectedCard` renders `<CommitPanel workspaceId={currentProjectId} taskId={null} baseRef={null} />` in the same layout slot (same `homeSidePanelPercent` flex + resize handle).

  **card-detail-view.tsx** (line 261): Change `isTaskSidePanelOpen = sidebar === "task_column"` to `isTaskSidePanelOpen = sidebar === "task_column" || sidebar === "commit"`. Add rendering branch inside the task side panel area: when `sidebar === "commit"`, render `<CommitPanel workspaceId={currentProjectId} taskId={selection.card.id} baseRef={selection.card.baseRef} />` instead of `ColumnContextPanel`.

  Import `CommitPanel` in both files.
- **Acceptance criteria**:
  - **Automated**: `npm run build` passes. `npm run web:typecheck` passes.
  - **Manual**: Clicking Commit toolbar button opens sidebar with placeholder text. Works in both task and home contexts. Toggling back closes it. Switching to git/files view does NOT collapse it.
- **Outcome notes**:
- **Attempts**:

---

### T11: Update UI layout architecture doc
- **Grade**: 1
- **Status**: pending
- **Depends on**: T10
- **SDD Phase**: Phase 2 — Frontend Sidebar Infrastructure (Step 6: Docs)
- **Files to modify**: `docs/ui-layout-architecture.md`
- **Description**: Update the doc to reflect the new commit sidebar:
  1. Add `"commit"` to the `SidebarId` type definition.
  2. Add Commit entry to the Sidebar Details section.
  3. Update auto-coupling rules table (commit sidebar exempt from files/git auto-collapse).
  4. Update component hierarchy diagram to show CommitPanel.
- **Acceptance criteria**:
  - **Automated**: None.
  - **Manual**: Doc accurately describes the new sidebar variant.
- **Outcome notes**:
- **Attempts**:

---

### T12: Create useCommitPanel hook — selection state and validation logic
- **Grade**: 2
- **Status**: pending
- **Depends on**: T6
- **SDD Phase**: Phase 3 — Frontend Commit Panel UI (Step 1: Hook — state management)
- **Files to modify**: `web-ui/src/hooks/use-commit-panel.ts` (NEW)
- **Description**: Create the `useCommitPanel(taskId, workspaceId, baseRef)` hook. This task covers the non-mutation parts:
  1. **State version**: Call both `useTaskWorkspaceStateVersionValue(taskId)` and `useHomeGitStateVersionValue()` unconditionally. Derive effective version: `taskId ? taskStateVersion : homeStateVersion`.
  2. **File list**: Call `useRuntimeWorkspaceChanges(taskId, workspaceId, baseRef, "working_copy", stateVersion, pollIntervalMs)` with 1s default polling.
  3. **Selection state**: `Map<string, boolean>` — initialize all files as checked. Sync when file list changes (add new files checked, remove departed).
  4. **Select-all**: Tri-state computed (all/none/indeterminate).
  5. **Commit message**: `useState<string>("")`.
  6. **Task scope helper**: `const taskScope = taskId && baseRef ? { taskId, baseRef } : null`.
  7. **Validation**: `canCommit = selectedPaths.length > 0 && message.trim().length > 0 && !isCommitting`.
  8. **Polling suppression**: `isMutating` flag derives `pollIntervalMs = isMutating ? null : 1000`.
  9. Stub mutation functions (`commitFiles`, `discardAll`, `rollbackFile`) as no-ops for now — T14 wires them.
  Return: `{ files, selectedPaths, isAllSelected, isIndeterminate, toggleFile, toggleAll, message, setMessage, canCommit, isLoading, isCommitting, isDiscarding, isRollingBack, commitFiles, discardAll, rollbackFile, taskScope }`.
- **Acceptance criteria**:
  - **Automated**: `npm run web:typecheck` passes.
  - **Manual**: None (tested via T13).
- **Outcome notes**:
- **Attempts**:

---

### T13: Write useCommitPanel hook unit tests
- **Grade**: 2
- **Status**: pending
- **Depends on**: T11, T12
- **SDD Phase**: Phase 3 — Tests
- **Files to modify**: `web-ui/src/hooks/use-commit-panel.test.ts` (NEW)
- **Description**: Write 8 test cases from the test spec using `renderHook` from `@testing-library/react`:
  1. `initializes all files as selected`
  2. `toggleFile toggles individual file selection`
  3. `toggleAll selects all when some unchecked`
  4. `toggleAll deselects all when all checked`
  5. `canCommit is false when no files selected`
  6. `canCommit is false when message is empty`
  7. `canCommit is true when files selected and message present`
  8. `syncs selection state when file list changes`
  Mock `useRuntimeWorkspaceChanges` and state version hooks to return controlled data.
- **Acceptance criteria**:
  - **Automated**: `cd web-ui && npx vitest run src/hooks/use-commit-panel.test.ts` — all 8 tests pass.
  - **Manual**: None.
- **Outcome notes**:
- **Attempts**:

---

### T14: Wire tRPC mutations into useCommitPanel hook
- **Grade**: 2
- **Status**: pending
- **Depends on**: T13
- **SDD Phase**: Phase 3 — Frontend Commit Panel UI (Step 1: Hook — mutations)
- **Files to modify**: `web-ui/src/hooks/use-commit-panel.ts`
- **Description**: Replace the stub mutation functions with real tRPC calls:
  1. **commitFiles**: Call `workspace.commitSelectedFiles.mutate({ taskScope, paths: selectedPaths, message })`. Set `isCommitting = true` during flight. Show success toast with commit hash on success. Show error toast on failure. Clear message on success.
  2. **discardAll**: Call `workspace.discardGitChanges.mutate(taskScope)`. Set `isDiscarding = true`. Toast on success/error.
  3. **rollbackFile(path, fileStatus)**: Call `workspace.discardFile.mutate({ taskScope, path, fileStatus })`. Set `isRollingBack = true`. Toast on success/error.
  4. Derive `isMutating = isCommitting || isDiscarding || isRollingBack` for polling suppression.
  Follow `use-git-actions.ts:344-381` for the tRPC mutation + toast + loading state pattern.
- **Acceptance criteria**:
  - **Automated**: `npm run web:typecheck` passes. `npm run build` passes.
  - **Manual**: None (UI tested after T16).
- **Outcome notes**:
- **Attempts**:

---

### T15: Build CommitPanel file list UI with checkboxes and status badges
- **Grade**: 2
- **Status**: pending
- **Depends on**: T14
- **SDD Phase**: Phase 3 — Frontend Commit Panel UI (Step 2: Component — file list)
- **Files to modify**: `web-ui/src/components/detail-panels/commit-panel.tsx`
- **Description**: Replace the Phase 2 shell with the full file list UI. Wire to `useCommitPanel` hook.
  1. **Header**: "Changes" label + file count badge. `text-[13px] font-medium text-text-secondary`.
  2. **Select-all row**: Radix `Checkbox` with indeterminate state. Label: "Select all (N files)".
  3. **File list** (scrollable `overflow-y-auto flex-1`): Each row is a `CommitFileRow`:
     - Radix Checkbox (left)
     - File icon (`FileText` from lucide, 14px)
     - File path (truncated, `text-[13px]`)
     - Status badge: M (blue), A (green), D (red), R (orange), C (blue), U (secondary), ? (tertiary)
     - Diff stats: `+N` green, `-N` red (same pattern as `file-tree-panel.tsx:46-49`)
  4. **Empty state**: "No uncommitted changes" centered, `text-text-tertiary`.
  Do NOT add the bottom commit section yet — that is T16. Do NOT add context menu yet — that is T22.
- **Acceptance criteria**:
  - **Automated**: `npm run web:typecheck` passes. `npm run build` passes.
  - **Manual**: Opening commit sidebar shows file list with checkboxes and status badges. Select-all toggles all. Empty state renders when no changes.
- **Outcome notes**:
- **Attempts**:

---

### T16: Build CommitPanel bottom section — message input, Commit and Discard All buttons
- **Grade**: 2
- **Status**: pending
- **Depends on**: T15
- **SDD Phase**: Phase 3 — Frontend Commit Panel UI (Step 2: Component — action section)
- **Files to modify**: `web-ui/src/components/detail-panels/commit-panel.tsx`
- **Description**: Add the fixed bottom section to the commit panel:
  1. **Commit message textarea**: `bg-surface-2 border border-border rounded-md p-2 text-[13px] text-text-primary placeholder:text-text-tertiary resize-none`. Placeholder: "Commit message". 3-4 rows.
  2. **Button row**: `Commit` (primary variant, disabled when `!canCommit`, spinner when `isCommitting`) and `Discard All` (danger variant, spinner when `isDiscarding`). Use `Button` from `@/components/ui/button`.
  3. Wire `Commit` onClick to `commitFiles()`. Wire `Discard All` onClick to `discardAll()`.
  4. Commit button disabled when `!canCommit`. Discard All button disabled when `isDiscarding` or no files.
- **Acceptance criteria**:
  - **Automated**: `npm run build` passes. `npm run web:typecheck` passes.
  - **Manual**: Typing a message and clicking Commit with files checked commits them (list refreshes, toast). Partial commit works (2 of 5 files). Discard All removes all changes. Error toast on git failure. Panel works in both task and home contexts.
- **Outcome notes**:
- **Attempts**:

---

### T17: Phase 3 verification checkpoint
- **Grade**: 1
- **Status**: pending
- **Depends on**: T16
- **SDD Phase**: Phase 3 — Verification
- **Files to modify**: none
- **Description**: Run the full verification suite for Phase 3. Fix any issues found.
  1. `npm run build`
  2. `npm run typecheck && npm run web:typecheck`
  3. `npm run lint`
  4. `npm test`
  5. `npm run web:test`
  Verify SDD functional verification items #1-8, #13, #15-18.
- **Acceptance criteria**:
  - **Automated**: All commands pass.
  - **Manual**: All Phase 3 behavioral criteria from the SDD verified.
- **Outcome notes**:
- **Attempts**:

---

### T18: Add pendingFileNavigation state and navigateToFile callback in App.tsx
- **Grade**: 2
- **Status**: pending
- **Depends on**: T17
- **SDD Phase**: Phase 4 — Context Menu & Cross-View Navigation (Step 1: Navigation State)
- **Files to modify**: `web-ui/src/App.tsx`
- **Description**: Following the `pendingCompareNavigation` pattern at line 962-969:
  1. Define `PendingFileNavigation` type (inline or in types file): `{ targetView: "git" | "files"; filePath: string }`.
  2. Add state: `const [pendingFileNavigation, setPendingFileNavigation] = useState<PendingFileNavigation | null>(null)`.
  3. Add callback: `const navigateToFile = useCallback((nav: PendingFileNavigation) => { setPendingFileNavigation(nav); setMainView(nav.targetView, { setSelectedTaskId }); }, [...])`.
  4. Add: `const clearPendingFileNavigation = useCallback(() => setPendingFileNavigation(null), [])`.
  5. Pass `pendingFileNavigation` and `clearPendingFileNavigation` to `GitView` and `FilesView` in all rendering paths (task and home).
  6. Add `navigateToFile` prop to `CommitPanel` in both rendering locations (App.tsx home context and CardDetailView task context). Thread `navigateToFile` into `CardDetailView` as a new prop.
  7. Update `CommitPanel` props interface to accept `navigateToFile`.
- **Acceptance criteria**:
  - **Automated**: `npm run web:typecheck` passes. `npm run build` passes.
  - **Manual**: None (tested after T22).
- **Outcome notes**:
- **Attempts**:

---

### T19: GitView — consume pendingFileNavigation
- **Grade**: 2
- **Status**: pending
- **Depends on**: T18
- **SDD Phase**: Phase 4 — Context Menu & Cross-View Navigation (Step 2: Git View)
- **Files to modify**: `web-ui/src/components/git-view.tsx`
- **Description**: Add props `pendingFileNavigation` and `onFileNavigationConsumed` to GitView. Add `useEffect`: when `pendingFileNavigation?.targetView === "git"`, call `setActiveTab("uncommitted")` and `setSelectedPath(pendingFileNavigation.filePath)`, then call `onFileNavigationConsumed()`. Follow the existing `pendingCompareNavigation` consumption pattern at line 310-314. Note: the variable is `selectedPath`, not `selectedFilePath`.
- **Acceptance criteria**:
  - **Automated**: `npm run web:typecheck` passes.
  - **Manual**: None (tested after T22).
- **Outcome notes**:
- **Attempts**:

---

### T20: FilesView — consume pendingFileNavigation
- **Grade**: 2
- **Status**: pending
- **Depends on**: T18
- **SDD Phase**: Phase 4 — Context Menu & Cross-View Navigation (Step 3: Files View)
- **Files to modify**: `web-ui/src/components/files-view.tsx`
- **Description**: Add props `pendingFileNavigation` and `onFileNavigationConsumed` to FilesView. Add `useEffect`: when `pendingFileNavigation?.targetView === "files"`, call `fileBrowserData.onSelectPath(pendingFileNavigation.filePath)`, then call `onFileNavigationConsumed()`. Note: `FilesView` does NOT own file selection state — it receives `fileBrowserData` as a prop. Use `fileBrowserData.onSelectPath()` to set the selection.
- **Acceptance criteria**:
  - **Automated**: `npm run web:typecheck` passes.
  - **Manual**: None (tested after T22).
- **Outcome notes**:
- **Attempts**:

---

### T21: Update GitView and FilesView prop threading in all parent rendering paths
- **Grade**: 2
- **Status**: pending
- **Depends on**: T19, T20
- **SDD Phase**: Phase 4 — Context Menu & Cross-View Navigation (Step 5: Prop Threading)
- **Files to modify**: `web-ui/src/App.tsx`, `web-ui/src/components/card-detail-view.tsx`
- **Description**: Ensure `pendingFileNavigation` and `onFileNavigationConsumed={clearPendingFileNavigation}` are passed to every `GitView` and `FilesView` render site in both App.tsx (home context) and CardDetailView (task context). There may be multiple render paths for each — check all. Also pass `navigateToFile` to `CommitPanel` in both locations if not done in T18.
- **Acceptance criteria**:
  - **Automated**: `npm run web:typecheck` passes. `npm run build` passes.
  - **Manual**: None (tested after T22).
- **Outcome notes**:
- **Attempts**:

---

### T22: Add context menu to CommitFileRow
- **Grade**: 2
- **Status**: pending
- **Depends on**: T21
- **SDD Phase**: Phase 4 — Context Menu & Cross-View Navigation (Step 4: Context Menu)
- **Files to modify**: `web-ui/src/components/detail-panels/commit-panel.tsx`
- **Description**: Wrap each `CommitFileRow` in `ContextMenu.Root > ContextMenu.Trigger asChild`. Add `ContextMenu.Portal > ContextMenu.Content` with items:
  1. **Rollback** — icon: `Undo2`, calls `onRollbackFile(path, status)`. **Disabled** for "renamed" and "copied" statuses with "Cannot rollback renamed/copied files individually" label. Destructive: `text-status-red`.
  2. **Open in Diff Viewer** — icon: `GitCompare`, calls `navigateToFile({ targetView: "git", filePath: path })`.
  3. **Open in File Browser** — icon: `FileSearch`, calls `navigateToFile({ targetView: "files", filePath: path })`.
  4. **Separator**.
  5. **Copy Name** — icon: `ClipboardCopy`, calls `copyToClipboard(fileName, "Name")`.
  6. **Copy Path** — icon: `ClipboardCopy`, calls `copyToClipboard(path, "Path")`.
  Use `CONTEXT_MENU_ITEM_CLASS` from `context-menu-utils.ts` and `copyToClipboard` from same file. Follow `file-browser-tree-panel.tsx:292-355` pattern exactly.
- **Acceptance criteria**:
  - **Automated**: `npm run build` passes. `npm run web:typecheck` passes. `npm run lint` passes.
  - **Manual**: Right-click a file shows context menu with all 6 items. Rollback discards file (disappears from list). Open in Diff Viewer switches to git view uncommitted tab with file selected. Open in File Browser switches to files view with file selected. Copy Name/Path copies to clipboard with toast. Rollback disabled for renamed/copied files. Works in both task and home contexts.
- **Outcome notes**:
- **Attempts**:

---

### T23: Phase 4 verification checkpoint
- **Grade**: 1
- **Status**: pending
- **Depends on**: T22
- **SDD Phase**: Phase 4 — Verification
- **Files to modify**: none
- **Description**: Run the full verification suite for Phase 4.
  1. `npm run build`
  2. `npm run typecheck && npm run web:typecheck`
  3. `npm run lint`
  4. `npm test && npm run web:test`
  Verify SDD functional verification items #9-12 (context menu actions), #9a (renamed/copied disabled).
- **Acceptance criteria**:
  - **Automated**: All commands pass.
  - **Manual**: All Phase 4 behavioral criteria verified.
- **Outcome notes**:
- **Attempts**:

---

### T24: Full regression and integration verification
- **Grade**: 1
- **Status**: pending
- **Depends on**: T23
- **SDD Phase**: Post-implementation verification
- **Files to modify**: none
- **Description**: Run full test suite and verify all SDD functional verification items (#1-18) and regression tests:
  1. `npm run check` (lint + typecheck + tests)
  2. `npm run build`
  3. Regression: existing sidebar toggle between projects/board still works (#3)
  4. Regression: git view uncommitted tab still renders (#4)
  5. Regression: existing discard-all endpoint still works (#1)
  6. Regression: workspace.getChanges still returns correct data (#2)
  7. Full walkthrough of SDD functional verification table items #1-18
- **Acceptance criteria**:
  - **Automated**: `npm run check && npm run build` passes.
  - **Manual**: All 18 functional verification items pass. All 4 regression tests pass.
- **Outcome notes**:
- **Attempts**:

---

### T25: Update changelog, todo, and implementation log
- **Grade**: 1
- **Status**: pending
- **Depends on**: T24
- **SDD Phase**: Release hygiene
- **Files to modify**: `CHANGELOG.md`, `docs/todo.md`, `docs/implementation-log.md`
- **Description**: Per AGENTS.md release hygiene rules:
  1. `docs/todo.md` — Remove the completed todo item (#6: commit sidebar tab). Renumber remaining items. Update cross-references.
  2. `CHANGELOG.md` — Add bullet under current version section: commit sidebar tab feature with description.
  3. `docs/implementation-log.md` — Add detailed entry at top: what changed, why, which files were touched, commit hash.
- **Acceptance criteria**:
  - **Automated**: None.
  - **Manual**: All three files updated consistently.
- **Outcome notes**:
- **Attempts**:

---

## Plan Corrections Log

| Correction # | Task | Issue | Resolution | Date |
|--------------|------|-------|------------|------|
| | | | | |

## Summary

_To be filled after build completion._
