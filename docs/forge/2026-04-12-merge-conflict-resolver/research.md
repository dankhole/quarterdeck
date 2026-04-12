---
project: merge-conflict-resolver
date: 2026-04-12
ticket: null
status: research
---

# Research: Merge/Rebase Conflict Resolver

## Behavioral Change

> **BEFORE**: Merge or rebase hits a conflict → `git merge --abort` fires automatically → user sees error toast.
> **AFTER**: Merge or rebase hits a conflict → operation pauses → conflict resolution panel appears → user resolves per-file → continue or abort.
> **SCOPE**: git-sync merge/rebase flow, workspace metadata monitor, file-changes panel in web-ui, tRPC API surface.

---

## Codebase Research Summary

### Relevant Code

#### Runtime — Git Operations

- **`src/workspace/git-sync.ts:380-427`** — `runGitMergeAction()`: The core change target. Runs `git merge <branch> --no-edit` (L405). On failure, immediately runs `git merge --abort` (L409) and returns `{ok: false, error: "Merge failed and was aborted..."}`. Must be changed to detect conflicts, pause instead of aborting, and return conflict file data.

- **`src/workspace/git-sync.ts:117-205`** — `probeGitWorkspaceState()`: Parses `git status --porcelain=v2`. Line 166: handles `u ` prefix (unmerged entries) but only counts them as `changedFiles` — no dedicated field for active conflict state. Does NOT check for `.git/MERGE_HEAD` or `.git/rebase-merge/`.

- **`src/workspace/get-workspace-changes.ts:55-63`** — `mapNameStatus()`: Maps git status codes to `RuntimeWorkspaceFileStatus`. Has NO handling for `U` (unmerged) — falls through to `"unknown"`.

- **`src/workspace/get-workspace-changes.ts:371-427`** — `getWorkspaceChanges()`: Uses `git diff --name-status HEAD` for file changes. During active merge conflict, HEAD still points to pre-merge commit. Unmerged files would show with `U` status and map to "unknown".

- **`src/workspace/git-utils.ts`** — `runGit()` utility: All git commands go through this. Returns `{ok, exitCode, stdout, stderr, output}`.

- **NO REBASE SUPPORT EXISTS.** The only rebase reference is `src/prompts/prompt-templates.ts:11` ("Do not cherry-pick, rebase, or push to other branches"). There is no `runGitRebaseAction`, no rebase tRPC endpoint. Rebase is entirely new code.

#### Runtime — Metadata & Broadcasting

- **`src/server/workspace-metadata-monitor.ts:282-305`** — Computes `hasUnmergedChanges` using `git diff --quiet baseRef...HEAD` (three-dot merge-base diff). **MISLEADINGLY NAMED**: this means "task branch diverges from base ref", NOT "there are active merge conflicts." A separate mechanism is needed for conflict state.

- **`src/server/runtime-state-hub.ts:265-279`** — `broadcastTaskReadyForReview()` pattern: Adds new message type to discriminated union in api-contract, creates broadcast method, UI receives via WebSocket dispatch. Follow this for conflict state notifications.

- **`src/core/api-contract.ts:484-496`** — `runtimeStateStreamMessageSchema`: Discriminated union of all WebSocket message types. New conflict-related message type goes here.

- **`src/core/api-contract.ts:358-373`** — `RuntimeTaskWorkspaceMetadata`: Has `hasUnmergedChanges` (branch divergence), `changedFiles`, `branch`, `baseRef`. Needs new fields for active conflict state (`mergeInProgress`, `rebaseInProgress`, `conflictedFileCount`).

#### Runtime — tRPC API

- **`src/trpc/app-router.ts:430-435`** — `mergeBranch` route: dispatches to `workspaceApi.mergeBranch`. Response schema needs conflict-aware variant. New routes needed for conflict resolution operations.

- **`src/trpc/workspace-api.ts:307-356`** — `mergeBranch` handler: Resolves cwd (task worktree or home repo), blocks if shared checkout, delegates to `runGitMergeAction`. Must handle new conflict response and broadcast conflict state.

- **`src/core/api-contract.ts:221-235`** — `RuntimeGitMergeRequest`/`Response`: Response is `{ok, branch, summary, output, error?}`. No conflict-specific fields. Needs extending or a new response type.

#### Frontend — UI Components

- **`web-ui/src/components/git-view.tsx`** — `GitView`: Main file-changes panel with internal tabs (Uncommitted, Last Turn, Compare). The Uncommitted tab is the natural place to show conflict resolution UI when conflicts are active.

- **`web-ui/src/components/detail-panels/diff-viewer-panel.tsx`** — `DiffViewerPanel`: Stateless, accepts `RuntimeWorkspaceFileChange[]` with `{path, oldText, newText, status}`. Can be reused for ours-vs-theirs preview by providing conflict-side file contents.

- **`web-ui/src/components/detail-panels/file-tree-panel.tsx`** — `FileTreePanel`: File list with status badges. Needs conflict status indicator (icon, color).

- **`web-ui/src/hooks/use-branch-actions.ts:146-167`** — `handleMergeBranch()`: Calls `trpc.workspace.mergeBranch.mutate()`, shows toast on success/error. Must handle "conflict paused" response by transitioning to conflict resolution state.

- **`web-ui/src/runtime/use-runtime-workspace-changes.ts`** — Polling hook for workspace file changes. Conflict resolution panel may use its own data source (git show :2:/:3: for ours/theirs) or a modified version of this.

- **`web-ui/src/stores/workspace-metadata-store.ts`** — `useSyncExternalStore` pattern for workspace metadata. Conflict-active state from the metadata monitor would flow through here.

- **`web-ui/src/types/board.ts:53-64`** — `ReviewTaskWorkspaceSnapshot`: Has `hasUnmergedChanges` field. May need richer conflict metadata.

### Existing Patterns

- **tRPC endpoint pattern**: `workspaceProcedure.input(schema).output(schema).mutation(...)` → delegate to `workspaceApi` method → call domain function in `git-sync.ts` → broadcast via `RuntimeStateHub`. (`app-router.ts:430-435`)

- **WebSocket broadcast**: New message type added to discriminated union in `api-contract.ts`, broadcast method in `RuntimeStateHub`, dispatched in `use-runtime-state-stream.ts`. Follow `task_ready_for_review` pattern. (`runtime-state-hub.ts:265-279`)

- **Workspace metadata polling**: `workspace-metadata-monitor.ts` polls at 2-10s intervals, broadcasts updates. Conflict state detection fits naturally here. (`workspace-metadata-monitor.ts:487-514`)

- **Hook + component split**: Commit panel is the closest precedent for this feature — `use-commit-panel.ts` encapsulates data fetching and mutations, `commit-panel.tsx` is thin presentation. (`use-commit-panel.ts:28-257`)

- **DiffViewerPanel reuse**: Accepts `workspaceFiles`, `selectedPath`, `viewMode`. Completely stateless about data source — conflict preview can reuse this with ours/theirs content. (`diff-viewer-panel.tsx:505-523`)

- **Git view internal tabs**: `GitViewTab` type union + `TabButton` component + localStorage persistence. The conflict panel could follow a similar conditional rendering pattern within GitView. (`git-view.tsx:43-53`)

- **Error response pattern**: Git operations return `{ok: false, error: string}` rather than throwing. (`git-sync.ts:406-418`)

- **Git ref validation**: `validateGitRef()` from `git-utils.ts` used before all git operations.

### Integration Points

- **Merge response → UI state transition**: `runGitMergeAction` return value flows through `workspace-api.ts` → tRPC → `use-branch-actions.ts`. Currently: ok/error binary. Needs: ok/error/conflict ternary.

- **Metadata monitor → conflict detection**: `workspace-metadata-monitor.ts` polls git state. Add `.git/MERGE_HEAD` and `.git/rebase-merge/` existence checks to detect active conflict state on each poll cycle. This also handles the "reopen mid-conflict" scenario.

- **WebSocket → UI reactivity**: Conflict state broadcast triggers UI to show/hide conflict panel. Use existing `workspace_metadata_updated` or add a dedicated `conflict_state_changed` message.

- **DiffViewerPanel data contract**: Needs `oldText` (ours) and `newText` (theirs) per file. Source: `git show :2:<path>` (ours) and `git show :3:<path>` (theirs).

- **FileTreePanel status rendering**: `RuntimeWorkspaceFileStatus` needs `"conflicted"` value. All consumers (file-tree-panel, diff-viewer-panel, commit-panel) need to handle this.

### Test Infrastructure

- **Framework**: Vitest 4.1.x (runtime + web-ui), Playwright (E2E)
- **Commands**: `npm test` (all runtime), `npm run test:fast` (runtime+utility), `npm run web:test` (web UI)
- **Organization**: Separate `test/runtime/` for runtime, co-located `*.test.tsx` for web-ui
- **Git mocking**: `vi.mock()` with `vi.hoisted()` for mock objects. `createGitTestEnv()` in `test/utilities/git-env.ts` for integration tests with real git repos
- **tRPC mocking**: Full module mocks of `git-sync.ts` functions. See `test/runtime/trpc/workspace-api.test.ts:29-56`
- **Existing gaps**: No tests for merge conflict scenarios, no tests for workspace-metadata-monitor, no tests for the auto-abort behavior being replaced

### All Code Paths for Behavioral Change

1. **Home repo merge via branch popover** → `branch-selector-popover.tsx` → `use-branch-actions.ts:handleMergeBranch` → `workspace-api.ts:mergeBranch` → `git-sync.ts:runGitMergeAction` → auto-abort
2. **Task worktree merge via card-detail-view** → `card-detail-view.tsx` → same `handleMergeBranch` path but with `taskId`/`baseRef` → same auto-abort
3. **Metadata polling** → `workspace-metadata-monitor.ts` polls every 2-10s → `hasUnmergedChanges` computed but means branch divergence, not active conflict
4. **GitView Uncommitted tab** → `useRuntimeWorkspaceChanges` → `workspace-api:loadChanges` → `getWorkspaceChanges` → `git diff --name-status HEAD` — would show conflicted files as "unknown" status during active conflict
5. **`probeGitWorkspaceState`** → parses porcelain v2 → counts `u ` entries as `changedFiles` but no conflict flag
6. **Pull (ff-only)** → `git-sync.ts:300-305` — uses `--ff-only`, so conflicts are impossible. No change needed.
7. **Agent merge in PTY** → `prompt-templates.ts:108-116` — agent-side instructions, not runtime API. No change needed.

Only one path NOT identified: if rebase is triggered from outside Quarterdeck (user manually runs `git rebase` in terminal), the metadata monitor would detect it on next poll via `.git/rebase-merge/` existence — this is the "reopen mid-conflict" scenario.

### Constraints Discovered

- **Board state single-writer rule**: Server must NOT call `mutateWorkspaceState` when UI is connected. Use WebSocket broadcast for conflict state; let UI manage its own state.
- **No `"conflicted"` file status**: `runtimeWorkspaceFileStatusSchema` has no conflict value. Adding it is a cross-cutting schema change affecting runtime and web-ui type consumers.
- **`hasUnmergedChanges` is taken**: Means branch divergence, not active conflicts. New field needed — don't reuse this.
- **`getWorkspaceChanges` uses `git diff HEAD`**: During active conflict, this shows conflict markers as literal text. Ours/theirs preview needs different approach: `git show :2:<path>` (ours) and `git show :3:<path>` (theirs).
- **Rebase is entirely new**: No existing rebase infrastructure to modify. All rebase code is net-new.

### Gaps

- **No test coverage for merge conflict paths**: The entire auto-abort path in `runGitMergeAction` is untested. New tests must cover both merge and rebase conflict scenarios.
- **`workspace-metadata-monitor.ts` has no unit tests**: Adding conflict detection to the monitor will need its own test coverage.

---

## Design Approach

Research points clearly to one approach — no competing alternatives with real tradeoffs:

**Conflict state lives in workspace metadata, conflict UI lives in GitView.**

- The metadata monitor already polls git state every 2-10s. Adding `.git/MERGE_HEAD` / `.git/rebase-merge/` detection to each poll cycle is natural and handles the "reopen mid-conflict" scenario for free.
- GitView's Uncommitted tab already shows file changes with the diff viewer. When conflicts are active, it conditionally renders a conflict resolution panel instead of (or overlaid on) the normal file list.
- New tRPC endpoints for conflict operations (list conflicted files with ours/theirs content, resolve file, continue merge/rebase, abort merge/rebase) follow the existing `workspaceProcedure` pattern.
- The merge response extends with an optional `conflicts` field so the UI can react immediately without waiting for a metadata poll cycle.
