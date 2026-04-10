# Scope Bar & File Browser — Handoff Notes (Session 3)

**Branch**: `feat/scope-bar-wiring`
**Base**: merged `feat/scope-bar-file-browser-rework` into detached HEAD from main, then created this branch
**Date**: 2026-04-09
**Commits on branch** (oldest first):
1. `ebcc2208` feat: add scope bar, context-aware file browser, and behind-base detection (prior session)
2. `ad79895c` fix: wire scope bar actions in CardDetailView, use scope-derived file browser context (prior session)
3. `5a972f1a` Merge branch 'feat/scope-bar-file-browser-rework' into HEAD
4. `6c064fc5` feat: wire scope bar file browser layout, branch selector, and checkout dialog (session 2)
5. `f1835b8d` chore: remove unused variables flagged by biome
6. `20dea508` fix: remove nested Radix asChild bug and stale performCheckout closure
7. `80302d3f` fix: rename reserved `ref` prop to `gitRef` and delete orphaned FileBrowserPanel (session 3)
8. `a2b6bd33` feat: wire "don't show again" persistence for checkout confirmation (session 3)
9. `527da22b` feat: replace branch text with pill-styled popover trigger and add checkout button (session 3)
10. `f30b4a83` fix: headless worktree display, behind-base gating, and home-switch UX (session 3)
11. `75bae703` refactor: clean up scope bar architecture after audit (session 3)

## What is done and working

### Backend (unchanged from prior sessions, fully functional)
- `src/workspace/git-utils.ts` — `getCommitsBehindBase()`, `listFilesAtRef()`, `getFileContentAtRef()`
- `src/trpc/workspace-api.ts` — `listFiles`/`getFileContent` accept null taskId + optional ref; `checkoutGitBranch` added
- `src/server/workspace-metadata-monitor.ts` — `behindBaseCount` in poll cycle
- `src/config/` — `skipTaskCheckoutConfirmation` and `skipHomeCheckoutConfirmation` full pipeline

### Frontend — fully wired

#### File browser layout rework (task context — CardDetailView)
- Files tab sidebar: renders `ScopeBar` + `FileBrowserTreePanel` (tree only)
- Files tab main area: renders `FileContentViewer` (displaces terminal)
- Other tabs (task_column, changes) still show terminal in main area
- Diff expanded mode still works — isDiffExpanded branch is intact
- Removed `isFileBrowserExpanded` mode entirely (no longer needed)

#### File browser layout rework (home context — App.tsx)
- Files tab sidebar: renders `ScopeBar` + `FileBrowserTreePanel`
- Files tab main area: renders `FileContentViewer` instead of `QuarterdeckBoard`
- Board still renders for home/other tabs

#### useFileBrowserData hook (`web-ui/src/hooks/use-file-browser-data.ts`)
- Extracts tRPC file list + content queries
- Polls file list every 5s, but NOT in branch_view mode (browseRef truthy)
- Clears stale content immediately on selectedPath change
- Used by both CardDetailView (task scope) and App.tsx (home scope)

#### Scope bar (`scope-bar.tsx`)
- **Branch pill slot** (`branchPillSlot`): Replaces old `branchSelectorSlot`/`onBranchSelectorOpen`. The branch name is now a clickable pill button (GitBranch icon + name + chevron) styled like the top bar's `GitBranchStatusControl`. Rendered inline in the scope content area where the static "on branch" text was.
- **Headless support**: `taskIsDetached` prop. "(initializing)" only shows when neither `taskBranch` nor `branchPillSlot` is available. Headless worktrees show their short commit hash in the pill.
- **Behind-base gating**: "Based on {baseRef} (N behind)" only renders when `taskIsDetached` is true. Named-branch worktrees are self-describing.
- **Checkout button**: In `branch_view` mode, a "Checkout" button (LogIn icon + text) appears in the action area via `onCheckoutBrowsingBranch`.
- **Home button behavior**: Clicking Home now deselects the task (calls `onDeselectTask`) instead of entering `home_override` mode. Clearer UX — leaves the task context entirely.
- Return button still shows for `branch_view` mode (scopeMode !== "contextual").

#### Branch selector popover (wired via `useBranchActions` hook)
- Hook: `web-ui/src/hooks/use-branch-actions.ts`
- Manages: popover open/close state, branch fetching, checkout flow
- Branches fetched lazily via `workspace.getGitRefs` tRPC — only when popover opens
- `worktreeBranches` map derived from `board.columns` → cards' `branch` field
- Popover trigger is the pill button (branch name), not a separate ChevronDown
- Wired in both CardDetailView and App.tsx

#### Checkout confirmation dialog
- `resolveCheckoutDialogState()` determines dialog type: confirm, blocked, dirty_warning, or skip
- "skip" result calls `performCheckout` directly (no dialog)
- **"Don't show again" persisted**: `onSkipTaskConfirmationChange` wired to `saveRuntimeConfig` + `refreshRuntimeProjectConfig` in App.tsx, threaded to both dialogs
- `CheckoutConfirmationDialog` rendered in both CardDetailView and App.tsx

#### Settings dialog
- `runtime-settings-dialog.tsx` — Git section with both checkout confirmation toggles

### Tests
- All 706 tests pass (374 runtime + 332 web-ui): `npm run check` clean
- `card-detail-view.test.tsx` updated with `onDeselectTask` required prop
- Build succeeds

## Bugs caught and fixed

### 1. Nested Radix `asChild` (FIXED in `20dea508`)
**Problem**: BranchSelectorPopover trigger wrapped in Tooltip. Nesting two `asChild` components breaks Radix prop merging.
**Fix**: Removed Tooltip wrapper. Trigger uses `aria-label` instead.

### 2. Stale `performCheckout` closure (FIXED in `20dea508`)
**Problem**: `handleCheckoutBranch` didn't list `performCheckout` in deps. Forward reference.
**Fix**: Moved `performCheckout` above, added to dep array.

### 3. React reserved `ref` prop (FIXED in `80302d3f`)
**Problem**: `BranchItem` used `ref` as prop name. React silently strips it → `undefined` at runtime.
**Fix**: Renamed to `gitRef` everywhere.

### 4. Headless worktrees stuck on "(initializing)" (FIXED in `f30b4a83`)
**Problem**: Scope bar showed "(initializing)" when `taskBranch` was null — which is always the case for detached HEAD worktrees.
**Fix**: Gate changed to `!taskBranch && !branchPillSlot`. Parent passes pill with `headCommit.substring(0,7)` for headless.

## Architectural decisions (session 3)

### Home button deselects task (not home_override)
Clicking the Home icon in a task's scope bar now calls `onDeselectTask` (`setSelectedTaskId(null)`) which unmounts CardDetailView and returns to the board/home view. Previously it entered `home_override` mode, which showed home files while keeping the task selected — confusing UX. The `home_override` mode still exists in `useScopeContext` but is only reachable from the home scope (App.tsx), not from task scope (CardDetailView no longer calls `switchToHome`).

### Branch pill replaces branch text
The static "on {branch}" text in the scope bar is now a `branchPillSlot` ReactNode. The parent creates a `BranchSelectorPopover` with a pill-styled trigger button (`GitBranch icon + label + ChevronDown`). This replaces the old `branchSelectorSlot` that was in the action buttons area. The pill is inline with the scope content; the popover anchors to it via Radix.

### Headless worktree pill label
`pillBranchLabel` is computed in a `useMemo` in `card-detail-view.tsx`. The fallback chain is: `branch → card.branch → headCommit.substring(0,7) → null`. When null (workspace info not loaded), no pill is provided and ScopeBar shows "(initializing)".

### Behind-base only for headless
`taskIsDetached` prop on ScopeBar. "Based on {baseRef}" only renders when the task worktree is on a detached HEAD. Named-branch worktrees are self-describing.

## Known issues / deferred work

### Quality notes
1. **Inconsistent key strategy for home file browser tree reset** — CardDetailView uses compound key `${taskId}-${scopeMode}`, App.tsx uses `key={currentProjectId}` + manual useEffect reset. Both work.
2. **`taskBranch` prop still passed to ScopeBar** — only consumed as fallback when `branchPillSlot` is absent (never in current code). Kept for defensive compatibility.
3. **Home scope pill always rendered** — unlike task scope which gates on `pillBranchLabel !== null`, home scope always renders the pill (falls back to "unknown" during loading). The `HomeContent` detached-HEAD early return skips the slot anyway.

### Functional gaps (still open)
1. **`searchFiles` not task-scoped** — `workspace-api.ts` `searchFiles` always uses home repo path. Low priority since file browser uses client-side filtering.

## End-to-end test plan (needs manual testing)

The full flow has NOT been manually verified end-to-end yet.

### Task context (named branch worktree)
1. Select task with a named branch → Files tab → scope bar shows: `Task · title · [pill: branch ▾]`
2. Verify NO "based on main" text (named branch, not headless)
3. Click branch pill → popover opens with branch list + fuzzy search
4. Pick a different branch → enters branch_view: `Browsing · [pill: other-branch ▾] · read-only`
5. Verify "Checkout" button and "Return" button appear in scope bar
6. Click "Checkout" → confirmation dialog → confirm → branch switches, toast
7. Click "Return" → back to task scope
8. Click Home icon → task deselects, board/home view shown

### Task context (headless/detached HEAD worktree)
9. Select a task with a detached HEAD worktree → Files tab
10. Scope bar shows: `Task · title · [pill: a1b2c3d ▾] · based on main (N behind)`
11. Verify the behind count is correct (compare with `git rev-list --count`)
12. Branch pill click → popover opens (same as above)

### Home context
13. No task selected → Files tab sidebar → scope bar shows: `Home · [pill: main ▾] · clean`
14. Click branch pill → popover opens with branches
15. Pick a branch → branch_view: `Browsing · [pill: branch ▾] · read-only`
16. Click "Checkout" → checkout dialog → confirm → home branch switches
17. Click "Return" → back to home contextual

### Checkout confirmation
18. Check "Don't show again" in task checkout dialog → confirm → next checkout skips dialog
19. Verify setting persists (check runtime config file or settings dialog toggle)
20. Test blocked dialog when branch is in use by another worktree
21. Test dirty working tree warning when uncommitted changes exist

## File inventory (current state)

| File | Status | Notes |
|------|--------|-------|
| `src/workspace/git-utils.ts` | Done | Unchanged from prior sessions |
| `src/trpc/workspace-api.ts` | Done | Unchanged from prior sessions |
| `src/server/workspace-metadata-monitor.ts` | Done | Unchanged |
| `src/config/config-defaults.ts` | Done | Unchanged |
| `src/config/runtime-config.ts` | Done | Unchanged |
| `src/core/api-contract.ts` | Done | Unchanged |
| `web-ui/src/hooks/use-scope-context.ts` | Done | Unchanged (home_override still available but unused from task) |
| `web-ui/src/hooks/use-file-browser-data.ts` | Done | File list + content query hook |
| `web-ui/src/hooks/use-branch-actions.ts` | Done | Branch popover + checkout flow hook |
| `web-ui/src/components/detail-panels/scope-bar.tsx` | Done | branchPillSlot, taskIsDetached, onCheckoutBrowsingBranch |
| `web-ui/src/components/detail-panels/branch-selector-popover.tsx` | Done | ref→gitRef fix committed |
| `web-ui/src/components/detail-panels/checkout-confirmation-dialog.tsx` | Done | "Don't show again" wired |
| `web-ui/src/components/detail-panels/file-browser-panel.tsx` | **Deleted** | Orphaned after layout rework |
| `web-ui/src/components/card-detail-view.tsx` | Done | pillBranchLabel useMemo, onDeselectTask (required) |
| `web-ui/src/components/card-detail-view.test.tsx` | Done | Updated with onDeselectTask |
| `web-ui/src/App.tsx` | Done | handleDeselectTask, handleSkipTaskCheckoutConfirmationChange |
| `web-ui/src/runtime/runtime-config-query.ts` | Done | skipCheckout fields added to saveRuntimeConfig |
| `web-ui/src/components/runtime-settings-dialog.tsx` | Done | Unchanged |

## Recommended next steps

1. **Manual E2E testing** of the full flow above (21 test cases)
2. **Merge to main** once tested

## Patterns to know

- **Radix `asChild` + Tooltip**: Never nest a Tooltip around a Radix trigger that uses `asChild`. Use `aria-label` instead.
- **React reserved prop names**: `ref`, `key` cannot be used as regular props. `ref` is especially insidious — silently stripped, no error.
- **`branchPillSlot` pattern**: The popover must anchor to a trigger element. The parent creates `<BranchSelectorPopover trigger={<pill-button />} />` and passes the whole thing as `branchPillSlot`. The scope bar renders it inline where the branch name would be.
- **`pillBranchLabel` fallback chain**: `branch → card.branch → headCommit[0:7] → null`. Null means genuinely initializing (no workspace info yet). Computed in `useMemo` in card-detail-view.tsx.
- **`useBranchActions` hook**: Encapsulates the full branch popover + checkout flow. Both CardDetailView and App.tsx use it independently.
- **`useFileBrowserData` hook**: Shared file list/content queries. Parent renders tree and viewer in separate layout areas, connected by the hook's shared state.
- **Task scope never enters `home_override`**: The Home icon deselects the task. `useScopeContext.switchToHome()` is unused in task context. Only the home scope (App.tsx) can enter `home_override`.
