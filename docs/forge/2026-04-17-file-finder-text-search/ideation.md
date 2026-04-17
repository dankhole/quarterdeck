---
project: file-finder-text-search
date: 2026-04-17
status: ideation
---

# Ideation: File Finder (Cmd+P) and Text Search (Cmd+Shift+F)

## Goal

Add two VS Code-style search modals to Quarterdeck's web UI: a file finder (Cmd+P) for fuzzy filename search and a text search (Cmd+Shift+F) for grep-across-worktree. Both open as centered overlays, are keyboard-navigable, and open results in the existing file content viewer.

### Behavioral Change Statement

> **BEFORE**: Users can only browse files via the file browser tree sidebar. There is no way to search file contents across a worktree from the UI.
> **AFTER**: Cmd+P opens a quick-open file finder (fuzzy filename search, debounced 150ms). Cmd+Shift+F opens a text search modal (git grep, fires on Enter, results grouped by file with line numbers and match highlighting). Clicking/selecting a result in either modal opens it in the file content viewer.
> **SCOPE**: Both modals available whenever a workspace is selected (task selected or project has a root worktree). Active in the main board view.

### Functional Verification Steps

1. **File finder — basic search**: Press Cmd+P -> modal opens with input focused. Type partial filename -> results appear after 150ms debounce. Arrow down/up navigates results. Enter opens file in viewer. Esc dismisses.
2. **File finder — empty state**: Open Cmd+P -> empty list with "Type to search files..." placeholder. No results until user types.
3. **File finder — outside click**: Click outside the modal -> modal dismisses.
4. **File finder — no workspace**: With no workspace selected, Cmd+P does nothing (no modal).
5. **Text search — basic search**: Press Cmd+Shift+F -> modal opens. Type query, press Enter -> results appear grouped by file with line numbers and highlighted matches. Click a result -> opens file in viewer.
6. **Text search — toggles**: Case sensitivity and regex toggles work. Toggling re-executes search if a query exists.
7. **Text search — result count**: Total match count displayed.
8. **Text search — limit**: Results capped at 100 matches default. Truncation indicated to user.
9. **Text search — empty/short query**: No search executed for empty query. Minimum 2 characters before executing.
10. **Text search — outside click/Esc**: Both dismiss the modal.
11. **Regression — existing hotkeys**: Existing hotkeys (Cmd+K, etc.) still work. Cmd+P doesn't trigger browser print dialog.
12. **Regression — file browser**: File browser tree still works as before.

## Scope

- **IN**: Backend text search endpoint (git grep), file finder modal + Cmd+P, text search modal + Cmd+Shift+F, hotkey wiring
- **OUT**: File view history / recent files, scroll-to-line on text search result click (follow-up), text search context lines (contextBefore/contextAfter — include in schema but optional in v1)

## Key Requirements

- File finder uses existing `workspace.searchFiles` endpoint
- Text search uses new `workspace.searchText` endpoint backed by `git grep` with `grep -rn` fallback
- Both modals keyboard-navigable (up/down/enter/esc)
- Both modals dismiss on outside click
- Both only active when workspace is selected
- Results open in existing FileContentViewer

## Constraints

- Must follow existing tRPC patterns (workspace procedures, workspaceProcedure middleware)
- Must follow web-ui conventions (Tailwind v4, dark theme, Radix primitives where appropriate)
- Text search default limit: 100 matches
- Text search fires on Enter, not on every keystroke
- File finder debounced at 150ms

## Defaults Confirmed

- Outside click dismisses both modals
- Empty file finder shows placeholder, no results
- Text search requires Enter to execute (not keystroke-based)
- Text search limit: 100 matches default

## Open Questions for Research

- How does the existing `searchWorkspaceFiles` hook get called from the UI? Need to understand the tRPC client pattern for workspace-scoped queries.
- What's the existing pattern for opening a file in the file content viewer programmatically (not via tree click)?
- How do existing modals/overlays work in the app — is there an overlay pattern beyond the dialog provider?
- What workspace selection state is available in React context for the "only when workspace selected" guard?
