---
project: file-finder-text-search
date: 2026-04-17
phase: plan
status: ready
---

# Task Graph: File Finder and Text Search

## Summary
- Total tasks: 5
- Grade distribution: G1: 0, G2: 4, G3: 1
- Estimated total LOC: ~550
- Critical path: T1 -> T2 -> T4 -> T5

## Tasks

### T1: Backend text search endpoint (schemas + implementation + tRPC wiring)
- **Grade**: 3 (>100 LOC across 6 files)
- **Dependencies**: none
- **Files**:
  - `src/core/api/workspace-files.ts` (modify -- add 4 Zod schemas + types)
  - `src/workspace/search-workspace-text.ts` (create -- `searchWorkspaceText` function)
  - `src/workspace/index.ts` (modify -- add barrel export)
  - `src/trpc/app-router-context.ts` (modify -- add `searchText` to `workspaceApi` interface + import types)
  - `src/trpc/workspace-api-changes.ts` (modify -- add `"searchText"` to `ChangesOps` pick, implement in `createChangesOps`, add import)
  - `src/trpc/workspace-procedures.ts` (modify -- add `searchText` procedure to `workspaceRouter`, add schema imports)
- **Description**: Implement the entire backend for text search per spec section 3.1. Add the 4 Zod schemas (`runtimeWorkspaceTextSearchRequestSchema`, `runtimeWorkspaceTextSearchMatchSchema`, `runtimeWorkspaceTextSearchFileSchema`, `runtimeWorkspaceTextSearchResponseSchema`) and their inferred types to `workspace-files.ts`. Create `search-workspace-text.ts` with the `searchWorkspaceText` function that runs `git grep -rn --null --no-color [-i] [-F|-E] -- <pattern>` via `runGit`, parses NUL-delimited output, groups by file, enforces a match limit (default 100), and handles exit code 1 (no matches) vs exit code 2 (bad regex -> TRPCError BAD_REQUEST). Wire through the tRPC layer: add `searchText` to the `workspaceApi` interface in `app-router-context.ts`, implement it in `workspace-api-changes.ts` under `ChangesOps`, and add the `searchText` query procedure in `workspace-procedures.ts`.
- **Acceptance criteria**:
  1. `runtimeWorkspaceTextSearchRequestSchema` validates `{ query, caseSensitive?, isRegex?, limit? }` per spec.
  2. `searchWorkspaceText` returns grouped results with `{ query, files, totalMatches, truncated }`.
  3. Exit code 1 returns empty results (not an error). Exit code 2 throws `TRPCError({ code: "BAD_REQUEST" })`.
  4. Results are truncated at `limit` (default 100) with `truncated: true`.
  5. The `workspace.searchText` tRPC query is callable and validates input/output with the Zod schemas.
  6. `npm run typecheck` passes.
  7. `npm run test:fast` passes (no regressions).

### T2: Shared overlay shell component
- **Grade**: 2 (~40 LOC)
- **Dependencies**: none
- **Files**:
  - `web-ui/src/components/search/search-overlay-shell.tsx` (create)
- **Description**: Implement the shared overlay shell per spec section 3.2. A full-viewport backdrop (`fixed inset-0 z-50 bg-black/50`) that calls `onDismiss` on click. Centers a floating panel (`max-w-2xl w-full max-h-[70vh]`, dark themed card, rounded, shadow) with `e.stopPropagation()` on the panel div. Listens for `Escape` via a `useEffect` keydown handler on `document` with `capture: true` (fires before `useEscapeHandler` in App.tsx). Does not manage focus -- consuming components auto-focus their own input. No Radix Dialog.
- **Acceptance criteria**:
  1. Component renders a backdrop and centered panel.
  2. Clicking backdrop calls `onDismiss`.
  3. Pressing Escape calls `onDismiss` (handler uses `capture: true`).
  4. Clicking inside the panel does not dismiss (stopPropagation).
  5. `npm run web:typecheck` passes.
  6. Component is rendered by parent in T3 and T4.

### T3: File finder overlay (hook + component)
- **Grade**: 2 (~100 LOC across 2 files)
- **Dependencies**: T2
- **Files**:
  - `web-ui/src/hooks/search/use-file-finder.ts` (create)
  - `web-ui/src/components/search/file-finder-overlay.tsx` (create)
- **Description**: Implement the file finder per spec section 3.3. The `useFileFinder` hook manages: controlled `query` input, debounced search via `useDebouncedEffect` (150ms) calling `workspace.searchFiles`, `requestIdRef` race-condition protection, `selectedIndex` for keyboard navigation (ArrowUp/Down/Enter/Escape), and `confirmSelection` that calls `onSelect(results[selectedIndex].path)`. The `FileFinderOverlay` component wraps `SearchOverlayShell`, renders an auto-focused input, maps results to `FileFinderResultItem` sub-components (name bold, path dimmed, changed dot, selected highlight, `scrollIntoView` on keyboard select), and shows an empty state when query exists but no results.
- **Acceptance criteria**:
  1. Typing in the input triggers debounced search after 150ms.
  2. Stale responses are discarded via `requestIdRef`.
  3. ArrowDown/ArrowUp cycles through results, Enter calls `onSelect` with the selected file path.
  4. Escape calls `onDismiss`.
  5. Selected result row is visually highlighted and scrolls into view.
  6. Empty query shows no results and no API call.
  7. `npm run web:typecheck` passes.
  8. Component is rendered by parent in T5 (App.tsx integration).

### T4: Text search overlay (hook + component)
- **Grade**: 2 (~130 LOC across 2 files)
- **Dependencies**: T1, T2
- **Files**:
  - `web-ui/src/hooks/search/use-text-search.ts` (create)
  - `web-ui/src/components/search/text-search-overlay.tsx` (create)
- **Description**: Implement the text search per spec section 3.4. The `useTextSearch` hook manages: controlled `query`, `caseSensitive` and `isRegex` toggles, `executeSearch` (fires on Enter, min 2 chars, calls `workspace.searchText`), `flatMatches` useMemo for flat-index keyboard navigation, `selectedIndex` into the flat list, `hasSearched` boolean to distinguish Enter-to-search vs Enter-to-confirm, and `confirmSelection` calling `onSelect(flatMatches[selectedIndex].path)`. Toggling caseSensitive/isRegex re-executes search if a query exists and search has run at least once. The `TextSearchOverlay` component wraps `SearchOverlayShell`, renders an auto-focused input with toggle buttons (Aa for case, .* for regex), a match count summary line, results grouped by file with `TextSearchResultLine` sub-components (line number + highlighted content, `scrollIntoView` on select), and an empty state.
- **Acceptance criteria**:
  1. Enter in the input fires `executeSearch` (no search for queries < 2 chars).
  2. Results grouped by file with line numbers and match content.
  3. Match highlighting works for fixed-string mode; regex mode uses try/catch for invalid patterns.
  4. ArrowDown/ArrowUp navigates the flat match list, Enter on a selected result calls `onSelect`.
  5. Case/regex toggles re-execute the search when toggled with an existing executed query.
  6. Truncation indicator shown when results are capped.
  7. `npm run web:typecheck` passes.
  8. Component is rendered by parent in T5 (App.tsx integration).

### T5: Hotkey registration + App.tsx integration
- **Grade**: 2 (~80 LOC modifications across 2 files)
- **Dependencies**: T3, T4
- **Files**:
  - `web-ui/src/hooks/app/use-app-hotkeys.ts` (modify -- add `currentProjectId`, `handleToggleFileFinder`, `handleToggleTextSearch` to interface; add 2 `useHotkeys` calls)
  - `web-ui/src/App.tsx` (modify -- add `isFileFinderOpen`/`isTextSearchOpen` state, toggle handlers, `handleSearchFileSelect`, render overlays, pass new props to `useAppHotkeys`, add cleanup to `handleProjectSwitchStart`)
- **Description**: Wire everything together per spec sections 3.5 and 3.6. In `use-app-hotkeys.ts`, add `currentProjectId`, `handleToggleFileFinder`, and `handleToggleTextSearch` to `UseAppHotkeysInput`. Add two `useHotkeys` calls: `mod+p` (file finder, `preventDefault: true` to suppress browser print dialog) and `mod+shift+f` (text search), both guarded by `if (!currentProjectId) return`. In `App.tsx` `AppContent`: add `isFileFinderOpen`/`isTextSearchOpen` boolean state atoms, toggle handlers (each closes the other before toggling self), `handleSearchFileSelect` (closes both, calls `git.navigateToFile({ targetView: "files", filePath })`), render both overlays conditionally after `<AppDialogs>`, pass new props to `useAppHotkeys`, and add both `setIs*Open(false)` calls to `handleProjectSwitchStart` in the `App` function.
- **Acceptance criteria**:
  1. Cmd+P opens/closes the file finder overlay. Cmd+P does not trigger browser print dialog.
  2. Cmd+Shift+F opens/closes the text search overlay.
  3. Opening one overlay closes the other (mutual exclusion).
  4. Selecting a file from either overlay navigates to the file viewer (`navigateToFile` called, main view switches to "files").
  5. Both overlays close on project switch (`handleProjectSwitchStart`).
  6. Hotkeys are no-ops when `currentProjectId` is null.
  7. `npm run web:typecheck` passes.
  8. `npm run check` passes (lint + typecheck + tests).

## Execution Order
1. T1 (no dependencies -- backend endpoint)
2. T2 (no dependencies -- shared shell component; can run in parallel with T1 but sequential in --lite mode)
3. T3 (depends on T2 -- file finder)
4. T4 (depends on T1, T2 -- text search)
5. T5 (depends on T3, T4 -- integration wiring)

## Notes

- **Natural merges applied**: Spec section 3.1 (schemas + implementation + tRPC wiring) merged into a single task instead of 3 separate tasks. Sections 3.5 + 3.6 (hotkeys + state + App.tsx) merged into one task.
- **Grade-1 elimination**: The barrel export in `src/workspace/index.ts` (~1 LOC) and the type additions in `app-router-context.ts` (~5 LOC) are absorbed into T1 rather than being standalone tasks.
- **Integration verification**: T3 and T4 both have "rendered by parent in T5" in acceptance criteria. T5 does the actual rendering in App.tsx.
- **Test strategy**: T1 (backend) validates with `test:fast`. T5 (final integration) validates with full `npm run check`. Frontend tasks T2-T4 validate with `web:typecheck` since there are no existing unit test patterns for overlay components.
- **Critical path**: T1 -> T4 -> T5 (3 tasks). T2 -> T3 is a parallel chain that merges at T5. In sequential execution: T1, T2, T3, T4, T5.
