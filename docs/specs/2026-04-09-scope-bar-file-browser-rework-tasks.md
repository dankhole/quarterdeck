# Task Graph: Scope Bar & File Browser Context Rework

**SDD**: `docs/specs/2026-04-09-scope-bar-file-browser-rework.md`
**Total tasks**: 20 (8 grade-1, 10 grade-2, 2 grade-1 integration)

## Execution Order

### Phase A: Backend Foundation (no frontend changes)

**T1** — Add `getCommitsBehindBase` git utility (Grade 1)
- **Description**: New function in `src/workspace/git-utils.ts` that runs `git merge-base HEAD {baseRef}` then `git rev-list --count {mergeBase}..{baseRef}`. Try `origin/{baseRef}` first (reflects latest remote state), fall back to local `refs/heads/{baseRef}`.
- **Files**: `src/workspace/git-utils.ts`
- **Dependencies**: None
- **Acceptance**: Function returns `{ behindCount, mergeBase }` or `null`. Unit test with a git repo fixture that has diverged branches.

**T2** — Add `behindBaseCount` to API contract and metadata schemas (Grade 1)
- **Description**: Add `behindBaseCount: z.number().nullable()` to `runtimeTaskWorkspaceMetadataSchema` in `api-contract.ts`. Add `behindBaseCount: number | null` to `ReviewTaskWorkspaceSnapshot` in `web-ui/src/types/board.ts`.
- **Files**: `src/core/api-contract.ts`, `web-ui/src/types/board.ts`
- **Dependencies**: None
- **Acceptance**: `npm run typecheck` passes. Schema includes the new field.

**T3** — Integrate behind-base into metadata monitor (Grade 2)
- **Description**: In `workspace-metadata-monitor.ts`, add `getCommitsBehindBase` to the `Promise.all` in `loadTaskWorkspaceMetadata`. Set `behindBaseCount` on the returned metadata. Update `areTaskMetadataEqual` to include the new field.
- **Files**: `src/server/workspace-metadata-monitor.ts`
- **Dependencies**: T1, T2
- **Acceptance**: Metadata monitor returns `behindBaseCount` for tasks with diverged base branches. Field is `null` for non-existent worktrees.

**T4** — Add `listFilesAtRef` and `getFileContentAtRef` git utilities (Grade 2)
- **Description**: New functions in `src/workspace/git-utils.ts`. `listFilesAtRef(cwd, ref)` uses `git ls-tree -r --name-only -- {ref}`. `getFileContentAtRef(cwd, ref, path)` uses `git show {ref}:{path}`. Handle errors (bad ref, missing file) gracefully. **Input sanitization**: Validate `ref` does not start with `-` and does not contain `..`. Validate `path` does not contain `..` traversal. Binary detection via NUL byte check in first 8KB.
- **Files**: `src/workspace/git-utils.ts`
- **Dependencies**: None
- **Acceptance**: Functions return file list / content from a ref without touching the working tree. Malformed refs (starting with `-`) are rejected. Paths with `..` are rejected.

**T5** — Make `listFiles` and `getFileContent` support null taskId and ref browsing (Grade 2)
- **Description**: Modify `runtimeListFilesRequestSchema` and `runtimeFileContentRequestSchema`: `taskId` becomes `z.string().nullable()`, `baseRef` becomes `z.string().optional()` (meaningless when taskId is null), add `ref: z.string().optional()`. In `workspace-api.ts` handlers, branch **before** `normalizeRequiredTaskWorkspaceScopeInput`: when `taskId` is null, use `workspaceScope.workspacePath` directly (skip task resolution). When `ref` is provided, use `listFilesAtRef`/`getFileContentAtRef` instead of reading from disk.
- **Files**: `src/core/api-contract.ts`, `src/trpc/workspace-api.ts`
- **Dependencies**: T4
- **Acceptance**: `listFiles({ taskId: null })` returns files from home repo. `listFiles({ taskId: null, ref: "some-branch" })` returns files at that ref. Existing task-scoped calls with `taskId` + `baseRef` continue to work unchanged.

**T5b** — Extend `checkoutGitBranch` to support task-scoped checkout (Grade 2)
- **Description**: The current `workspace.checkoutGitBranch` endpoint only operates on the home repo. Extend `runtimeGitCheckoutRequestSchema` to `{ branch: string, taskId?: string, baseRef?: string }`. In `workspace-api.ts`, when `taskId` is provided, resolve the task working directory via `resolveTaskWorkingDirectory` and run `runGitCheckoutAction` against that path. The existing safety check that blocks checkout when shared-checkout tasks are active only applies to home repo checkout (no `taskId`).
- **Files**: `src/core/api-contract.ts`, `src/trpc/workspace-api.ts`
- **Dependencies**: None
- **Acceptance**: `checkoutGitBranch({ branch: "feat/x", taskId: "abc", baseRef: "main" })` checks out the branch in the task's worktree. Home checkout (no taskId) still works as before with the safety check. `npm run typecheck` passes.

**T6** — Add checkout confirmation settings (Grade 1)
- **Description**: Add `skipTaskCheckoutConfirmation` and `skipHomeCheckoutConfirmation` boolean settings (both default `false`). Follow the existing pattern through: `config-defaults.ts`, `runtime-config.ts`, `api-contract.ts` config schemas.
- **Files**: `src/config/config-defaults.ts`, `src/config/runtime-config.ts`, `src/core/api-contract.ts`
- **Dependencies**: None
- **Acceptance**: `npm run typecheck` passes. Settings load/save correctly. Defaults are `false`.

### Phase B: Frontend Metadata Plumbing (no visual changes yet)

**T7** — Wire `behindBaseCount` through workspace metadata store (Grade 1)
- **Description**: Add `behindBaseCount` to `toTaskWorkspaceSnapshot` mapping in `workspace-metadata-store.ts`. **Critically**: update `areTaskWorkspaceSnapshotsEqual` to compare `behindBaseCount` — if this comparison is missing, the store will never re-render when the count changes because the equality check will still return `true`.
- **Files**: `web-ui/src/stores/workspace-metadata-store.ts`
- **Dependencies**: T2
- **Acceptance**: `useTaskWorkspaceSnapshotValue` returns `behindBaseCount` when available. Changing `behindBaseCount` on the server triggers a UI re-render (verify equality check works).

**T8** — Add `behindBaseCount` badge to Files tab in detail toolbar (Grade 1)
- **Description**: In `detail-toolbar.tsx`, accept new `filesBadgeColor` prop. Show a blue badge on the Files tab when the selected task has `behindBaseCount > 0`. In `App.tsx`, derive `filesBadgeColor` from `selectedTaskWorkspaceSnapshot?.behindBaseCount`.
- **Files**: `web-ui/src/components/detail-panels/detail-toolbar.tsx`, `web-ui/src/App.tsx`
- **Dependencies**: T7
- **Acceptance**: Blue dot appears on Files tab when a task's worktree is behind its base branch. No dot when caught up or no task selected.

### Phase C: Scope Bar & Context Switching

**T9** — Create `use-scope-context` hook (Grade 2)
- **Description**: New hook managing the scope state machine: `ScopeMode` (`contextual` | `home_override` | `branch_view`), `ResolvedScope` derivation, auto-reset on task selection change and project switch. Accepts `selectedTaskId`, `currentProjectId`, `selectedCard` as inputs.
- **Files**: `web-ui/src/hooks/use-scope-context.ts`
- **Dependencies**: None
- **Acceptance**: Hook returns correct `ResolvedScope` for all mode transitions. Resets on project switch. Resets on task selection.

**T10** — Create scope bar component (Grade 2)
- **Description**: New `ScopeBar` component showing context label, branch info, behind-base count, color accent (left border), and action buttons (home icon, return-to-contextual). Three visual treatments per context type (Home/Task/Branch View).
- **Files**: `web-ui/src/components/detail-panels/scope-bar.tsx`
- **Dependencies**: T9
- **Acceptance**: Component renders correctly for all three context types. Shows behind-base count with info styling. Shows detached HEAD warning. Action buttons trigger callbacks.

**T11** — Create branch selector popover (Grade 2)
- **Description**: Radix popover listing branches from `workspace.getGitRefs`. Search/filter, local/remote grouping, worktree-locked branches grayed out with tooltip. Selecting a branch triggers branch-view mode (read-only). Checkout icon button per-branch triggers checkout flow.
- **Files**: `web-ui/src/components/detail-panels/branch-selector-popover.tsx`
- **Dependencies**: T9, T10
- **Acceptance**: Popover shows branches. Worktree-locked branches are visually disabled. Selecting opens branch view. Checkout icon available for non-locked branches.

**T12** — Create checkout confirmation dialog (Grade 2)
- **Description**: `AlertDialog`-based component with tiered behavior. Task tier: "Don't show again" checkbox, stores `skipTaskCheckoutConfirmation`. Home tier: no checkbox, always shows unless setting is on. Pre-checkout validation: worktree lock check, dirty tree warning. On checkout failure: show toast with error message.
- **Files**: `web-ui/src/components/detail-panels/checkout-confirmation-dialog.tsx`
- **Dependencies**: T5b, T6, T11
- **Acceptance**: Task checkout shows "Don't show again". Home checkout does not. Worktree-locked branch shows info dialog. Dirty tree shows warning. Failed checkout shows error toast.

**T13** — Add checkout settings to settings dialog (Grade 1)
- **Description**: Add two toggles to `RuntimeSettingsDialog` in a "Git" section: "Skip task worktree checkout confirmation" and "Skip home checkout confirmation". Follow existing `RadixSwitch.Root` pattern.
- **Files**: `web-ui/src/components/runtime-settings-dialog.tsx`
- **Dependencies**: T6
- **Acceptance**: Settings save and load correctly. Toggles work.

### Phase D: File Browser Rework

**T14** — Enable Files tab without task selected (Grade 1)
- **Description**: Remove `disabled={!hasSelectedTask}` from the Files tab in `detail-toolbar.tsx`. Modify `useCardDetailLayout` auto-switch logic: when task is deselected and `activeTab === "files"`, stay on files instead of switching to home.
- **Files**: `web-ui/src/components/detail-panels/detail-toolbar.tsx`, `web-ui/src/resize/use-card-detail-layout.ts`
- **Dependencies**: None
- **Acceptance**: Files tab is clickable when no task is selected. Deselecting a task while on files tab keeps files active.

**T15** — Make `FileBrowserPanel` accept nullable taskId and ref (Grade 2)
- **Description**: Change `FileBrowserPanel` props: `taskId: string | null`, add optional `ref: string | null`. When `taskId` is null, call `listFiles({ taskId: null })` for home repo. When `ref` is provided, pass it to use `git show` path for branch view. **Disable the 5-second polling interval when `ref` is set** — a commit's tree is immutable, so polling is wasted work.
- **Files**: `web-ui/src/components/detail-panels/file-browser-panel.tsx`
- **Dependencies**: T5
- **Acceptance**: File browser works with no task (shows home files). Works in branch view (shows ref files read-only). No polling in branch view mode.

**T16a** — Render basic file browser in App.tsx when no task selected (Grade 2)
- **Description**: In App.tsx's no-task-selected branch, when `activeTab === "files"`, render `FileBrowserPanel` in the sidebar slot with `taskId: null`. No scope bar yet — just the basic file browser showing home repo files. Import `useHomeGitSummaryValue` for future scope bar wiring.
- **Files**: `web-ui/src/App.tsx`
- **Dependencies**: T14, T15
- **Acceptance**: No task selected + Files tab active → file browser shows home repo files in sidebar. Clicking files opens content viewer.

**T16b** — Wire scope bar and branch features into App.tsx no-task path (Grade 2)
- **Description**: Add scope bar, branch selector popover, and checkout confirmation dialog to the App.tsx no-task file browser from T16a. Wire `useScopeContext`, `useHomeGitSummaryValue`, branch list fetching, and `worktreeBranches` derivation (via `useMemo` over board state).
- **Files**: `web-ui/src/App.tsx`
- **Dependencies**: T9, T10, T11, T12, T16a
- **Acceptance**: No task selected + Files tab active → scope bar shows Home context with branch info. Branch selector popover works. Branch view mode works. Checkout with confirmation works.

### Phase E: Integration

**T17** — Wire scope bar into CardDetailView for task context (Grade 1)
- **Description**: In `CardDetailView`, render the `ScopeBar` above the file browser and changes panels. Wire the scope context hook. When in `home_override` mode, the file browser shows home files even though a task is selected. When in `branch_view` mode, shows ref files. Scope bar must remain visible in expanded mode (rendered alongside FileBrowserToolbar/DiffToolbar in the main content area).
- **Files**: `web-ui/src/components/card-detail-view.tsx`
- **Dependencies**: T9, T10, T15, T16b
- **Acceptance**: Scope bar visible in task context (both collapsed and expanded mode). Escape hatch to home works. Branch view works. Returning to contextual view snaps back to task. Project switch resets scope.

**T18** — File browser full-panel mode in expanded view (Grade 1)
- **Description**: When `isFileBrowserExpanded` is true and a file is selected, render `FileContentViewer` in the main content area (where terminal normally lives) and `FileBrowserTreePanel` in the sidebar. Match existing expanded-diff pattern.
- **Files**: `web-ui/src/components/card-detail-view.tsx`, `web-ui/src/App.tsx`
- **Dependencies**: T17
- **Acceptance**: Expand file browser → select file → file content fills main area, tree stays in sidebar. Collapsing returns to normal split.

---

## Dependency Graph

```
T1 ──→ T3 ──→ T7 ──→ T8
T2 ──→ T3
T2 ──→ T7
T4 ──→ T5 ──→ T15 ──→ T16a ──→ T16b ──→ T17 ──→ T18
T5b ──→ T12
T6 ──→ T12
T6 ──→ T13
T9 ──→ T10 ──→ T11 ──→ T12
T9 ──→ T16b
T10 ──→ T16b
T11 ──→ T16b
T12 ──→ T16b
T14 ──→ T16a
T15 ──→ T16a
T15 ──→ T17
T16b ──→ T17
T17 ──→ T18
```

**Parallelizable roots**: T1, T2, T4, T5b, T6, T9, T14 can all start simultaneously.

**Critical path**: T4 → T5 → T15 → T16a → T16b → T17 → T18 (7 tasks). T16a can start as soon as T14 + T15 are done, unblocking basic file browser testing before the scope bar is ready.

---

## Plan Corrections Log

(Empty — no corrections yet.)
