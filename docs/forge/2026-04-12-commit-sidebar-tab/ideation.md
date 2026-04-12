---
project: commit-sidebar-tab
date: 2026-04-12
ticket: null
status: spec
---

# Ideation: Commit Sidebar Tab

**Goal**: Add a new "Commit" sidebar tab that provides a JetBrains-style quick-commit workflow — file list with checkboxes, commit message input, and a commit button — all executed server-side via `runGit()` with no agent session required.

## Behavioral Change Statement

> **BEFORE**: Committing changes requires either using the agent ("commit these files"), dropping to a terminal, or using external tools. There's no built-in UI for staging and committing. The "discard all changes" action was removed from the git history panel and has no current home.
> **AFTER**: A "Commit" sidebar tab shows all uncommitted files with checkboxes, file status badges, a right-click context menu (rollback, open in diff viewer, open in file browser), a commit message textarea, and a Commit button. Discard-all lives here too. Works in both task-worktree and home-repo contexts.
> **SCOPE**: New sidebar panel, new backend endpoints (commit selected files, discard single file), cross-view navigation to git view and files view.

## Functional Verification Steps

1. **File list rendering**: Open the commit sidebar with uncommitted changes present -> see all changed files with checkboxes, status badges (M/A/D/R/U), and +N/-N counts.
2. **Select all**: Click the parent checkbox -> all file checkboxes toggle. Click again -> all deselect.
3. **Commit flow**: Check some files, type a message, click Commit -> selected files are committed, file list refreshes to show remaining uncommitted files (or empty state), toast confirms success.
4. **Partial commit**: Check 2 of 5 files, commit -> only those 2 are in the commit. The other 3 remain in the file list.
5. **Git error handling**: Attempt a commit that fails (e.g. empty message, merge conflict) -> operation aborts, toast shows the error, no partial state.
6. **Per-file rollback**: Right-click a file -> "Rollback" -> file's changes are discarded, file disappears from list.
7. **Open in diff viewer**: Right-click a file -> "Open in Diff Viewer" -> main view switches to Git view (uncommitted tab) with that file selected.
8. **Open in file browser**: Right-click a file -> "Open in File Browser" -> main view switches to Files view navigated to that file.
9. **Task context**: Select a task, open commit sidebar -> shows uncommitted files in that task's worktree.
10. **Home context**: No task selected, open commit sidebar -> shows uncommitted files in the main repo.
11. **Empty state**: No uncommitted changes -> sidebar shows an appropriate empty message.
12. **Regression -- existing sidebar behavior**: Projects and Board sidebar tabs still work as before. Switching between all three sidebar tabs preserves state correctly.

## Scope

**IN**:
- Sidebar panel with file list, checkboxes, select-all, status badges
- Right-click context menu: rollback, open in diff viewer, open in file browser
- Commit message textarea and commit button
- Discard-all changes action (relocated from removed git history panel header)
- Server-side commit and per-file rollback endpoints
- Cross-view navigation to git view and files view
- Both task-worktree and home-repo contexts
- Polling for file list freshness

**OUT**:
- Commit and Push (future todo)
- Auto-generated commit messages (future todo)
- Staged/unstaged index modeling
- Amend checkbox
- Inline diff preview within the sidebar

## Key Requirements

- Server-side commit via `runGit()` -- no agent session dependency
- Works in both task-worktree and home-repo contexts
- Per-file rollback (new endpoint) and discard-all (existing endpoint)
- Cross-view navigation to git view and files view from context menu
- Poll for file list changes (match existing 1s interval from git view uncommitted tab)

## Constraints

- Must follow existing sidebar panel patterns (SidebarId, toggleSidebar, lastSidebarTab)
- Must follow the board state single-writer rule
- Existing tRPC workspace router pattern for new endpoints
- Zod schemas in api-contract.ts for new request/response types

## Open Questions for Research

- Exact cross-view navigation mechanism for "open in diff viewer" and "open in file browser"
- Whether the existing workspace changes endpoint data is sufficient or needs augmentation
- Right-click context menu pattern -- does a reusable one exist already?
