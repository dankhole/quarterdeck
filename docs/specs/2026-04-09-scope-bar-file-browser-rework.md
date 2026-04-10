# Scope Bar & File Browser Context Rework

**Date**: 2026-04-09
**Scope**: Detail panel system (frontend), file browser, workspace metadata monitor (backend), settings

## Behavioral Change Statement

**BEFORE**: File browser and changes panels are disabled unless a task is selected. There is no visual indicator of which repo context (home checkout vs task worktree) the user is operating in. Branch checkout is not available from the file browser. Worktrees falling behind their base branch are invisible to the user.

**AFTER**: A persistent scope bar at the top of the detail panel area shows one of three color-coded contexts — **Home** (neutral), **Task** (blue accent), or **Branch View** (purple/gold, read-only). The file browser works in all three contexts and uses the full main content area for file viewing when expanded. Branch checkout is available from the scope bar with tiered confirmation dialogs. Worktrees behind their base branch show a notification badge on the Files tab.

**SCOPE**: Detail toolbar, detail panel area, file browser panel, scope bar (new), top bar, settings dialog, workspace metadata monitor, api-contract, config.

## Terminology

- **Home**: The on-disk project checkout directory. Replaces "main repo" in all UI text to avoid confusion with the `main` git branch. Tooltip: "The repository checkout in your project directory."
- **Task**: An isolated git worktree associated with a specific task card.
- **Branch View**: Read-only browsing of any git ref via `git show`/`git ls-tree` — no filesystem changes occur.

---

## Part 1: Scope Bar Component

### 1.1 Data Model

New file: `web-ui/src/hooks/use-scope-context.ts`

```typescript
type ScopeMode = "contextual" | "home_override" | "branch_view";

interface ScopeState {
   mode: ScopeMode;
   /** Set when mode is "branch_view" — the ref being browsed. */
   branchViewRef: string | null;
}
```

The scope bar manages a small state machine:

```
contextual (task selected → task context, no task → home context)
    ↕ user clicks "switch to home" / picks branch from dropdown
manual override (home_override or branch_view)
    ↕ user clicks "return to contextual view" / selects a different task
contextual
```

**Derived scope** (what panels actually use):

```typescript
type ResolvedScope =
   | { type: "home"; workspaceId: string; workspacePath: string }
   | { type: "task"; taskId: string; baseRef: string; workspaceId: string; branch: string | null }
   | { type: "branch_view"; ref: string; workspaceId: string };
```

Note: `workspaceId` is always present on all variants because tRPC calls require it to construct the client via `getRuntimeTrpcClient(workspaceId)`. The `workspaceId` is always `currentProjectId` from the parent context.

**Auto-reset rules:**
- Selecting a task card → resets to `contextual` mode (task context).
- Deselecting a task → resets to `contextual` mode (home context).
- Project switch (`currentProjectId` changes) → resets to `contextual` mode. All scope bar state clears: `branchViewRef` nulled, `mode` set to `contextual`.
- This joins the existing cleanup path that already clears task selection, terminal state, and metadata store via `resetWorkspaceMetadataStore()`.

### 1.2 Visual Design

The scope bar renders below the panel toolbar header (e.g., below `FileBrowserToolbar` or `DiffToolbar`) as a thin horizontal strip. **In expanded mode** (when `isDiffExpanded` or `isFileBrowserExpanded` is true and the `DetailToolbar` is hidden), the scope bar renders at the top of the main content area alongside the existing expanded toolbar (e.g., `FileBrowserToolbar` or `DiffToolbar`), ensuring the user always has scope context and access to the branch selector/escape hatch:

```
┌──────────────────────────────────────────────────────┐
│ [color accent] LABEL · branch info · status          │
│                                    [actions/buttons] │
└──────────────────────────────────────────────────────┘
```

**Three color schemes** (left border accent + text color hint):

| Context | Left Border | Label | Color Token |
|---------|-------------|-------|-------------|
| Home | `border-text-secondary` (muted) | `Home` | Neutral — `text-text-secondary` |
| Task | `border-accent` (blue) | `Task: {card title or branch}` | Blue — `text-accent` for label |
| Branch View | `border-status-purple` | `Browsing: {ref}` | Purple — `text-status-purple` |

**Content per context:**

**Home:**
> `Home` · `main` · `clean` (or `2 uncommitted changes`)
> If detached HEAD: `Home` · `HEAD (detached at a3f2c1b)` · ⚠ warning icon

**Task:**
> `Task: fix-login-bug` · `on feat/fix-login` · `based on main`
> If behind base: `based on main (4 commits behind)` with info icon
> If `branch` is null (worktree not created yet or detached): `Task: fix-login-bug · (initializing)` with muted style

**Branch View:**
> `Browsing: release/v2.1` · `read-only` · [Return to contextual view ↩]

If the browsed branch happens to match a task's branch, show a subtle link: `(Task: fix-login-bug)` that jumps to that task.

**Actions in the scope bar:**
- Branch dropdown (chevron icon) — opens branch selector popover
- "Return to contextual view" button — only in manual override modes (`home_override` or `branch_view`)
- The "switch to home" escape hatch — a small home icon button visible only when in task context

**Distinction from the Home toolbar tab**: The toolbar Home tab (in `detail-toolbar.tsx`) deselects the task and navigates to the project list — it is a **navigation** action. The scope bar's home icon is a **context override** — it switches the file browser/panels to show home repo content while keeping the task selected (terminal still visible, card still highlighted). These are intentionally different actions:
- Toolbar Home tab = "I'm done looking at this task, show me the project view"
- Scope bar home icon = "I want to peek at the home repo without losing my task context"

### 1.3 Component Structure

New file: `web-ui/src/components/detail-panels/scope-bar.tsx`

Props:
```typescript
interface ScopeBarProps {
   resolvedScope: ResolvedScope;
   scopeMode: ScopeMode;
   homeGitSummary: RuntimeGitSyncSummary | null;
   taskWorkspaceInfo: RuntimeTaskWorkspaceInfoResponse | null;
   behindBaseCount: number | null;
   branches: RuntimeGitRef[] | null;
   onSwitchToHome: () => void;
   onReturnToContextual: () => void;
   onSelectBranchView: (ref: string) => void;
   onCheckoutBranch: (branch: string) => void;
   worktreeBranches: Set<string>; // branches locked by worktrees — gray out in dropdown
}
```

### 1.4 Branch Selector Popover

Uses `@radix-ui/react-popover`. Lists branches from the existing `workspace.getGitRefs` tRPC endpoint (already returns local + remote branches).

- Branches checked out by a task worktree are grayed out with a tooltip: "Checked out by Task: {title}"
- Selecting a branch from the dropdown defaults to **Branch View** (read-only) — not checkout
- A "Checkout" button/icon next to each branch triggers the checkout flow with confirmation dialog
- Search/filter input at the top for long branch lists
- Grouped: Local branches, then Remote branches (matching `getGitRefs` ref types)

**Branch listing always queries the home repo** regardless of scope mode. Task worktrees share the same git object store (they're worktrees of the same repo), so the branch list is identical. The `workspace.getGitRefs` endpoint is called without a task scope — it resolves to `workspacePath`.

**Data source for worktree-locked branches:**
Derive from existing board state — iterate all cards, collect those with `useWorktree !== false` and a non-null `branch` field via a `useMemo` in the component that owns the scope bar (App.tsx or CardDetailView). The board data is available from `useBoardState()`. This is entirely frontend — no new backend call needed.

### 1.5 File Placement

| File | Purpose |
|------|---------|
| `web-ui/src/hooks/use-scope-context.ts` | State machine hook: `ScopeMode`, `ResolvedScope`, auto-reset logic |
| `web-ui/src/components/detail-panels/scope-bar.tsx` | Visual scope bar component |
| `web-ui/src/components/detail-panels/branch-selector-popover.tsx` | Branch dropdown popover |
| `web-ui/src/components/detail-panels/checkout-confirmation-dialog.tsx` | Tiered checkout confirmation dialog |

---

## Part 2: Checkout Confirmation Dialogs

### 2.1 Tiered Confirmation

Two tiers of confirmation when checking out a branch:

**Task worktree checkout:**
- `AlertDialog` with: "Switch this task's worktree to `{branch}`?"
- Body: "This changes the working directory for this task only."
- "Don't show again" checkbox (persisted as `skipTaskCheckoutConfirmation` setting)
- On confirm: calls `workspace.checkoutGitBranch` with task scope (see 2.4 for backend changes)

**Home repo checkout:**
- `AlertDialog` with slightly more prominent styling: "Switch the home repository to `{branch}`?"
- Body: "This changes the shared checkout that all new tasks branch from."
- **No "Don't show again" checkbox** in the dialog itself
- A setting exists: `skipHomeCheckoutConfirmation` (default `false`) — configurable in Settings → Git section
- On confirm: calls `workspace.checkoutGitBranch` with no task scope (existing behavior)

**On checkout failure**: Show a toast with the error message from the `{ ok: false, error }` response. The scope bar reflects the actual current branch from the metadata monitor's next poll cycle, not the attempted branch.

### 2.2 Pre-Checkout Validation

Before showing the dialog, check:

1. **Branch already checked out by a worktree**: Query board state for cards with `branch === targetBranch && useWorktree !== false`. If found, show an info dialog: "This branch is checked out by Task: {title}" with a "Go to task" button. Do not proceed.
2. **Dirty working tree**: Check `homeGitSummary.changedFiles > 0` (home) or `taskWorkspaceSnapshot.changedFiles > 0` (task). If dirty, show warning: "You have uncommitted changes that may conflict. Proceed anyway?" with proceed/cancel.
3. **Already on this branch**: If `currentBranch === targetBranch`, show toast: "Already on {branch}" and skip.

### 2.3 New Settings

Two new boolean settings following the existing pattern:

| Setting | Default | Dialog presence |
|---------|---------|-----------------|
| `skipTaskCheckoutConfirmation` | `false` | "Don't show again" checkbox on task dialog |
| `skipHomeCheckoutConfirmation` | `false` | No checkbox — only in Settings → Git |

Files to modify:
- `src/config/config-defaults.ts` — add defaults
- `src/config/runtime-config.ts` — add to config shapes, normalization, persistence
- `src/core/api-contract.ts` — add to config response/save schemas
- `web-ui/src/components/runtime-settings-dialog.tsx` — add toggles in a "Git" section

### 2.4 Backend: Task-Scoped Checkout

The current `workspace.checkoutGitBranch` endpoint (`workspace-api.ts:241`) only operates on the home repo (`workspaceScope.workspacePath`). It has no task scope parameter. The `runtimeGitCheckoutRequestSchema` is `{ branch: string }` with no `taskId`.

**Changes needed:**
- Extend `runtimeGitCheckoutRequestSchema` to: `{ branch: string, taskId?: string, baseRef?: string }`
- In `workspace-api.ts` `checkoutGitBranch`: when `taskId` is provided, resolve the task working directory via `resolveTaskWorkingDirectory(workspaceScope.workspacePath, { taskId, baseRef })` and run `runGitCheckoutAction` against that path instead of `workspaceScope.workspacePath`
- The existing safety check that blocks checkout when shared-checkout tasks are active (`workspace-api.ts:248-262`) only applies to home repo checkout (no `taskId`). Task worktree checkout doesn't need this check since worktrees are isolated.

---

## Part 3: File Browser in All Contexts

### 3.1 Enable Files Tab Without Task Selected

Currently the Files tab is disabled when `!hasSelectedTask` (`detail-toolbar.tsx:127`). Change:

- Files tab is **always enabled** (remove `disabled={!hasSelectedTask}`)
- Changes tab remains task-only for now (diff viewer rework is out of scope)
- Board tab remains task-only

### 3.2 Home-Scoped File Listing

The existing `workspace.listFiles` endpoint requires `taskId`. Add an alternative path:

**Backend**: In `workspace-api.ts`, modify `listFiles` and `getFileContent` to accept `taskId: null`:
- Schema change in `api-contract.ts`: `runtimeListFilesRequestSchema.taskId` becomes `z.string().nullable()`. `baseRef` becomes `z.string().optional()` (it has no semantic meaning when `taskId` is null).
- Same for `runtimeFileContentRequestSchema`.
- **Control flow change**: In the `listFiles` handler (`workspace-api.ts`), branch **before** calling `normalizeRequiredTaskWorkspaceScopeInput` (which throws on null taskId). When `input.taskId` is null, use `workspaceScope.workspacePath` directly and skip task resolution entirely. Same for `getFileContent`.

```typescript
// In listFiles handler:
if (!input.taskId) {
   const files = await listAllWorkspaceFiles(workspaceScope.workspacePath);
   return { files };
}
// Existing task-scoped path follows...
const normalizedInput = normalizeRequiredTaskWorkspaceScopeInput(input);
```

This avoids a new endpoint — the existing `listFiles` and `getFileContent` just gain a null-taskId path that uses the home directory.

**`searchFiles` scoping**: The existing `workspace.searchFiles` endpoint (`workspace-api.ts:375`) searches against `workspaceScope.workspacePath` unconditionally. Apply the same nullable-taskId treatment: when `taskId` is provided, resolve the task worktree and search there. When null, search the home repo. Branch-view search is out of scope for this feature (searching a git ref's tree would require `git grep` — defer to a future iteration). The file browser's search/filter in the tree panel is a client-side filter on the already-fetched file list, not a backend search, so it works in all modes automatically.

### 3.3 Branch-View File Listing (Read-Only)

For Branch View, files are listed from a git ref without touching the working directory.

**New backend utility**: `listFilesAtRef(cwd: string, ref: string): Promise<string[]>`
- Uses `git ls-tree -r --name-only -- {ref}` to list all files at a ref
- No filesystem access to the working tree
- **Input sanitization**: Validate `ref` does not start with `-` (prevents flag injection). Reject refs containing `..`.

**New backend utility**: `getFileContentAtRef(cwd: string, ref: string, path: string): Promise<{ content: string; binary: boolean }>`
- Uses `git show {ref}:{path}` to read file content (the `ref:path` syntax is inherently repo-scoped)
- **Input sanitization**: Same ref validation. Validate `path` does not contain `..` traversal.
- **Binary detection**: Check for NUL bytes in the first 8KB of output, consistent with the existing `isBinaryContent` approach. If binary, return `{ content: "", binary: true }`.
- Returns raw content for text files

**Backend endpoint changes**:
- Add optional `ref` field to `runtimeListFilesRequestSchema` and `runtimeFileContentRequestSchema`
- When `ref` is provided and `taskId` is null, use the ref-based utilities instead of reading from disk
- When `ref` is provided and `taskId` is set, use the ref-based utilities against the task worktree's repo

**Frontend: disable polling in branch view**: When `ref` is provided (branch view mode), the file list is immutable (a commit's tree never changes). Disable the 5-second polling interval in `FileBrowserPanel` to avoid unnecessary `git ls-tree` spawning.

### 3.4 File Browser Full-Panel Mode

Currently the file browser is a split panel (tree + content viewer) in the sidebar. When a file is selected in the expanded file browser, the content should fill the **main content area** (where the terminal normally lives), not the sidebar split.

**Approach**: When `isFileBrowserExpanded` is true and `fileBrowserSelectedPath` is non-null, the main content area renders `FileContentViewer` instead of the terminal. The sidebar shows only the file tree.

This is already partially how the expanded diff works — the main area shows the diff content. Apply the same pattern:

In `card-detail-view.tsx` (and the equivalent App.tsx no-task branch):
- When file browser is expanded: main area = `FileContentViewer`, sidebar = `FileBrowserTreePanel`
- When file browser is collapsed (sidebar mode): sidebar = tree + content split (current behavior)

### 3.5 File Browser Without Task: App.tsx Changes

Currently, `App.tsx` only renders `CardDetailView` when a task is selected. When no task is selected and `activeTab === "files"`, the sidebar area needs to render the file browser in home context.

**Approach**: Extract a `HomeScopeFileBrowser` wrapper that:
- Uses `null` for taskId in the `listFiles`/`getFileContent` calls
- Shares the same `FileBrowserPanel` component (now accepting `taskId: string | null`)
- Renders in the sidebar slot when `activeTab === "files"` and no task is selected

The `useCardDetailLayout` hook's auto-switch logic (lines 151-168) needs adjustment:
- When task is deselected and `activeTab === "files"`, stay on files (don't switch to home)
- Only auto-switch to home when deselecting from `task_column` or `changes` tabs

---

## Part 4: Behind-Base Detection

### 4.1 New Git Utility

New function in `src/workspace/git-utils.ts`:

```typescript
export async function getCommitsBehindBase(
   cwd: string,
   baseRef: string,
): Promise<{ behindCount: number; mergeBase: string | null } | null> {
   // 1. Find merge base
   const mergeBaseResult = await runGit(cwd, ["merge-base", "HEAD", baseRef]);
   if (!mergeBaseResult.ok) {
      // Try origin/{baseRef} as fallback
      const originRef = `origin/${baseRef}`;
      const fallbackResult = await runGit(cwd, ["merge-base", "HEAD", originRef]);
      if (!fallbackResult.ok) return null;
      const countResult = await runGit(cwd, ["rev-list", "--count", `${fallbackResult.stdout}..${originRef}`]);
      return {
         behindCount: countResult.ok ? parseInt(countResult.stdout, 10) || 0 : 0,
         mergeBase: fallbackResult.stdout,
      };
   }
   // 2. Count commits between merge-base and current tip of baseRef
   const countResult = await runGit(cwd, ["rev-list", "--count", `${mergeBaseResult.stdout}..${baseRef}`]);
   return {
      behindCount: countResult.ok ? parseInt(countResult.stdout, 10) || 0 : 0,
      mergeBase: mergeBaseResult.stdout,
   };
}
```

**Ref resolution order**: Try `origin/{baseRef}` first (remote tracking refs are updated by the periodic `git fetch --all --prune` that runs via the home repo's git sync). Fall back to local `refs/heads/{baseRef}` if the remote ref doesn't exist. This ensures behind-base counts reflect the latest known remote state, not a potentially stale local branch that hasn't been pulled.

**Staleness note**: The count depends on the last `git fetch`. The home repo metadata monitor already runs periodic `git fetch` via `runGitSyncAction` when enabled by the user. If the user hasn't fetched recently, the count may be stale — this is acceptable and consistent with how `git status` upstream tracking works.

### 4.2 Schema Changes

Add `behindBaseCount` to `runtimeTaskWorkspaceMetadataSchema` in `api-contract.ts`:

```typescript
behindBaseCount: z.number().nullable(), // null = not computed yet or error
```

Add to `ReviewTaskWorkspaceSnapshot` in `web-ui/src/types/board.ts`:
```typescript
behindBaseCount: number | null;
```

### 4.3 Metadata Monitor Integration

In `workspace-metadata-monitor.ts`, `loadTaskWorkspaceMetadata`:

After the existing `Promise.all` that loads `summary` and `unmergedResult`, add `getCommitsBehindBase`:

```typescript
const [summary, unmergedResult, behindBase] = await Promise.all([
   getGitSyncSummary(pathInfo.path, { probe }),
   runGit(pathInfo.path, ["--no-optional-locks", "diff", "--quiet", pathInfo.baseRef, "HEAD"]),
   getCommitsBehindBase(pathInfo.path, pathInfo.baseRef),
]);
```

Set `behindBaseCount: behindBase?.behindCount ?? null` on the metadata object.

**Performance**: `merge-base` + `rev-list --count` are fast O(commit-graph) operations — typically <10ms. Adding them to the existing poll cycle is negligible.

### 4.4 Frontend: Badge on Files Tab

In `detail-toolbar.tsx`, add a badge to the Files tab:

- Blue badge (`bg-status-blue`) when the currently selected task has `behindBaseCount > 0`
- The badge data flows through the same path as the Changes badge: `App.tsx` reads from `useTaskWorkspaceSnapshotValue`, derives `isBehindBase`, passes it to `DetailToolbar`
- Reuse the existing `"blue"` badge color — no new color type needed. The blue badge on Files means "behind base" (analogous to blue on Changes meaning "unmerged changes")

In the scope bar (Part 1), show: `based on main (4 commits behind)` with a subtle info/warning treatment.

### 4.5 Workspace Metadata Store Changes

In `workspace-metadata-store.ts`:

- Add `behindBaseCount` to the `toTaskWorkspaceSnapshot` mapping
- Add to `areTaskWorkspaceSnapshotsEqual` comparison
- The field flows through `replaceWorkspaceMetadata` → `toTaskWorkspaceSnapshot` → `useTaskWorkspaceSnapshotValue` automatically

---

## Part 5: Project Switch Cleanup

### 5.1 State That Must Reset

When `currentProjectId` changes, the following scope bar state must reset:

| State | Reset to | Where |
|-------|----------|-------|
| `scopeMode` | `"contextual"` | `use-scope-context.ts` |
| `branchViewRef` | `null` | `use-scope-context.ts` |
| File browser: expandedDirs, selectedPath, scroll | Clear | `card-detail-view.tsx` / App.tsx |
| Branch list cache | Discard | `use-scope-context.ts` or consumer |
| Behind-base cached data | Discarded by `resetWorkspaceMetadataStore()` | Already handled |

### 5.2 Implementation

The `use-scope-context.ts` hook accepts `currentProjectId` as a dependency. A `useEffect` resets to contextual mode when it changes:

```typescript
useEffect(() => {
   setScopeState({ mode: "contextual", branchViewRef: null });
}, [currentProjectId]);
```

File browser expanded dirs and selected path are ephemeral (React state only, not persisted to localStorage). "Keyed by" means the state resets when switching contexts via a React `key` prop:
- Task scope: `key={selection.card.id}` — already implemented
- Home scope: `key={currentProjectId}` — resets on project switch

---

## Verification Steps

1. **Home context**: No task selected → Files tab enabled → file browser shows home repo files → scope bar shows `Home · {branch} · {status}` with neutral color
2. **Task context**: Select a task card → panels switch to task worktree → scope bar shows `Task: {title} · on {branch} · based on {baseRef}` with blue accent
3. **Branch view**: Click scope bar dropdown, pick a branch → panels show read-only file listing from that ref → scope bar shows `Browsing: {ref} · read-only` with purple accent → sticky until "return to contextual view" clicked
4. **Escape hatch**: Task selected → click home icon in scope bar → scope switches to home context, task stays selected → click "return to contextual view" → snaps back to task
5. **Branch checkout (task)**: From scope bar, choose checkout → confirmation dialog with "Don't show again" → checkout succeeds → scope bar updates
6. **Branch checkout (home)**: From scope bar, choose checkout → confirmation dialog (no "Don't show again") → checkout succeeds
7. **Checkout blocked by worktree**: Attempt to checkout a branch used by a task → info dialog "This branch is checked out by Task: X" with link
8. **Dirty tree warning**: Attempt checkout with uncommitted changes → warning dialog
9. **Behind-base detection**: Task based on `main`, `main` has new commits → blue badge on Files tab → scope bar shows `(N commits behind)`
10. **Project switch**: Switch projects while in branch view → scope resets to home context, file browser clears
11. **Detached HEAD**: Home repo detached → scope bar shows warning icon with detached info
12. **File viewer full panel**: Expand file browser → select file → main content area shows file content, sidebar shows tree only
