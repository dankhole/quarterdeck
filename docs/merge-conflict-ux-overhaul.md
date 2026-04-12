# Merge Conflict Resolution UX Overhaul

## Context

The merge conflict resolution feature was recently added but has several issues:
- **Bug**: Clicking a file in the resolver shows a grey box — no diff renders (likely `getConflictFileContent` fails silently, returning empty strings, which renders the empty-state SVG)
- Files that git auto-merges (non-conflicting changes in the same file) are committed silently with no review opportunity
- The resolver doesn't auto-open — just shows a toast saying "resolve in the Git view"
- No persistent indicator that a merge is in progress when navigating away from git view
- "Resolve Manually" button just shows a toast, which is unhelpful
- Conflict files show a unified diff instead of side-by-side ours vs theirs

## Changes

### 1. Schema: Add auto-merged files to conflict state

**`src/core/api-contract.ts`**
- Add `autoMergedFiles: z.array(z.string()).default([])` to `runtimeConflictStateSchema`
- Add `runtimeAutoMergedFileSchema`: `{ path, oldContent, newContent }`
- Add `runtimeAutoMergedFilesRequestSchema` and `runtimeAutoMergedFilesResponseSchema`

### 2. Backend: `--no-commit` merge + auto-merged detection

**`src/workspace/git-sync.ts`**

- Change `runGitMergeAction` line 413: `["merge", branchToMerge, "--no-edit"]` → `["merge", branchToMerge, "--no-commit", "--no-edit"]`
- **Success path** (no conflicts): auto-commit via `runGit(repoRoot, ["commit", "--no-edit"])`, then return success as before
- **Conflict path**: detect auto-merged files = `git diff --cached --name-only` minus conflicted files from `git ls-files -u`. Pass into conflict state.
- New helper `computeAutoMergedFiles(cwd, conflictedFiles)`: runs `git diff --cached --name-only`, filters out conflicted paths
- New function `getAutoMergedFileContent(cwd, path)`: runs `git show HEAD:<path>` (old) and `git show :0:<path>` (merged stage 0) to get before/after content
- Update `getConflictState` overrides to accept and pass through `autoMergedFiles`

### 3. Backend: New tRPC endpoint

**`src/trpc/workspace-api.ts`** + **`src/trpc/app-router.ts`**
- Add `getAutoMergedFiles` endpoint following same pattern as `getConflictFiles`
- Resolves task cwd if `taskId` provided, calls `getAutoMergedFileContent` for each path

### 4. Frontend: Fix grey box bug + use diff primitives

**`web-ui/src/components/detail-panels/conflict-resolution-panel.tsx`**

The grey box is the `DiffViewerPanel` empty state SVG — it renders when `oursContent` and `theirsContent` are both empty. Root cause: `getConflictFileContent` may be failing silently (the `.catch(() => {})` in `use-conflict-resolution.ts` swallows errors).

**Fix approach**: Replace `DiffViewerPanel` wrapper with direct use of diff primitives:
- Import `buildUnifiedDiffRows` and `ReadOnlyUnifiedDiff` from `diff-renderer`
- For conflict files: build rows from `oursContent`/`theirsContent`, render with `ReadOnlyUnifiedDiff` (this avoids DiffViewerPanel's complex file-tree/scrolling/section infrastructure that's overkill for a single file)
- Add column headers: "Ours (current branch)" / "Theirs (incoming)"
- Add error state when content is empty (show message instead of blank)

Note: Using `ReadOnlyUnifiedDiff` for now rather than the split view. The split view (`SplitDiff`) in `DiffViewerPanel` requires the comment system callbacks. We can switch to split later if needed, but the immediate fix is getting *any* diff to render reliably. The unified diff with clear "Ours" / "Theirs" labeling plus the existing added/removed line coloring makes the comparison clear.

**Replace "Resolve Manually"**: Remove button + toast. Add persistent info bar:
```
[Info icon] To resolve manually, edit in your editor then run `git add <path>` [Copy path button]
```

### 5. Frontend: Auto-merged files in resolver

**`web-ui/src/hooks/use-conflict-resolution.ts`**
- Add state: `autoMergedFiles: RuntimeAutoMergedFile[]`, `reviewedAutoMergedFiles: Set<string>`
- New effect: when `conflictState.autoMergedFiles` changes, fetch content via `trpc.workspace.getAutoMergedFiles`
- New callback: `acceptAutoMergedFile(path)` adds to reviewed set
- Computed: `allReviewed = allConflictsResolved && allAutoMergedReviewed`
- Reset reviewed set when conflict becomes inactive or rebase step changes

**`web-ui/src/components/detail-panels/conflict-resolution-panel.tsx`**
- File list: add "Auto-merged" section header, list auto-merged files with different icon (FileCheck vs AlertTriangle)
- When auto-merged file selected: show unified diff (oldContent -> newContent) using `ReadOnlyUnifiedDiff` with "Accept" button
- "Complete Merge" button: disabled until `allReviewed` (both conflicts resolved AND auto-merged reviewed)
- Progress text: show both conflict and auto-merge counts

### 6. Frontend: Auto-open resolver on conflicts

**`web-ui/src/hooks/use-branch-actions.ts`**
- Update toast from "resolve in the Git view" -> "Merge has conflicts -- opening resolver"

**`web-ui/src/components/card-detail-view.tsx`**
- Add `onConflictDetected?: () => void` prop
- Pass to `useBranchActions` call

**`web-ui/src/App.tsx`**
- Pass `onConflictDetected={() => setMainView("git", { setSelectedTaskId })}` to `CardDetailView`

### 7. Frontend: Persistent merge conflict banner

**New file: `web-ui/src/components/conflict-banner.tsx`**
- Subscribes to `useConflictState(taskId)` and `useHomeConflictState()`
- Returns null if no active conflict
- Renders narrow orange-tinted bar: `[GitMerge icon] Merge in progress -- N conflicts remaining [-> Resolve]`
- Entire banner clickable -> navigates to git view

**`web-ui/src/App.tsx`**
- Render `<ConflictBanner>` after `{topBar}` in the layout, passing selected task ID and navigate callback

**`web-ui/src/components/card-detail-view.tsx`**
- Accept and render the banner between top bar and content area

### 8. Frontend: Metadata store update

**`web-ui/src/stores/workspace-metadata-store.ts`**
- Update `areConflictStatesEqual` to compare `autoMergedFiles` arrays

## Key files
- `src/core/api-contract.ts` -- schemas
- `src/workspace/git-sync.ts` -- merge execution, conflict detection, file content
- `src/trpc/workspace-api.ts` + `src/trpc/app-router.ts` -- tRPC endpoints
- `web-ui/src/hooks/use-conflict-resolution.ts` -- conflict UI state management
- `web-ui/src/hooks/use-branch-actions.ts` -- merge trigger + toast
- `web-ui/src/components/detail-panels/conflict-resolution-panel.tsx` -- resolver UI
- `web-ui/src/components/shared/diff-renderer.tsx` -- diff rendering primitives
- `web-ui/src/components/detail-panels/diff-viewer-panel.tsx` -- existing diff panel (reference)
- `web-ui/src/components/git-view.tsx` -- conditional conflict panel render
- `web-ui/src/components/card-detail-view.tsx` -- task detail layout
- `web-ui/src/App.tsx` -- layout wiring, navigation
- `web-ui/src/stores/workspace-metadata-store.ts` -- conflict state subscriptions

## Implementation order
1. Schema changes (api-contract.ts)
2. Backend: --no-commit + auto-merged detection (git-sync.ts)
3. Backend: new tRPC endpoint (workspace-api.ts, app-router.ts)
4. Frontend: metadata store (workspace-metadata-store.ts)
5. Frontend: fix grey box + new conflict detail pane (conflict-resolution-panel.tsx)
6. Frontend: auto-merged files in hook + panel (use-conflict-resolution.ts, conflict-resolution-panel.tsx)
7. Frontend: auto-open + task wiring (use-branch-actions.ts, card-detail-view.tsx, App.tsx)
8. Frontend: conflict banner (new conflict-banner.tsx, App.tsx, card-detail-view.tsx)

## Verification
1. Build: `npm run build` -- ensure no type errors from schema/API changes
2. Tests: `npm run test` -- existing conflict tests should mostly pass (may need updates for --no-commit behavior)
3. Manual test: create committed conflicting changes on two branches, merge via UI:
   - Verify banner appears, resolver auto-opens
   - Verify conflicted files show diff with ours/theirs
   - Verify auto-merged files show unified diff with "Accept"
   - Verify "Complete Merge" requires all files reviewed
   - Verify manual resolution info bar and "Copy path" work
   - Navigate away from git view -> verify banner persists and navigates back
