---
project: merge-conflict-resolver
date: 2026-04-12
ticket: null
status: plan
---

# Ideation: Merge/Rebase Conflict Resolver

## Goal

Add merge and rebase conflict resolution to Quarterdeck. Today, conflicts trigger an auto-abort and the user gets nothing. The MVP should pause on conflict, show which files are affected, let the user resolve per-file (accept ours / accept theirs / resolve manually in terminal), and continue or abort the operation.

## Behavioral Change Statement

> **BEFORE**: Merge or rebase hits a conflict → `git merge --abort` fires automatically → user sees an error message and is back to pre-merge state with no option to resolve.
> **AFTER**: Merge or rebase hits a conflict → operation pauses → file-changes panel is replaced by a conflict resolution panel showing conflicted files, per-file ours-vs-theirs preview, and resolution actions → user resolves all files → "Continue" completes the operation; "Abort" rolls back cleanly.
> **SCOPE**: git-sync merge/rebase flow, workspace metadata monitor, file-changes panel in web-ui, tRPC API surface.

## Functional Verification Steps

1. **Merge with conflict**: Trigger a merge that produces a conflict → conflict panel appears (not file-changes) showing conflicted file list. Currently: auto-aborts.
2. **Accept ours**: Click "Accept ours" on a conflicted file → file resolves with our version, progress updates. Currently: N/A.
3. **Accept theirs**: Click "Accept theirs" on a conflicted file → file resolves with their version, progress updates. Currently: N/A.
4. **Resolve manually**: Click "Resolve manually" → user handles it in terminal, file marked resolved when `git add`ed. Currently: N/A.
5. **Continue merge**: All files resolved → click "Continue merge" → merge commit created, panel returns to normal file-changes view. Currently: N/A.
6. **Abort merge**: Click "Abort merge" at any point → returns to pre-merge state, conflict panel dismissed. Currently: auto-aborts without user choice.
7. **Rebase with conflict**: Trigger a rebase that produces conflicts → same conflict panel appears with "Rebase in progress" banner. Currently: auto-aborts.
8. **Rebase multi-round**: Resolve all files in round 1, continue → second round of conflicts appears → panel refreshes with new conflicted files. Currently: N/A.
9. **Abort mid-rebase**: Partially through rebase resolution → abort → all rounds discarded, back to pre-rebase state. Abort messaging explicitly states all resolutions are lost.
10. **Reopen mid-conflict**: Close Quarterdeck while a merge/rebase is in progress → reopen → conflict panel surfaces immediately (detects `.git/rebase-merge/` or `.git/MERGE_HEAD`).
11. **Ours-vs-theirs preview**: Click a conflicted file → see a diff of ours vs theirs using existing diff renderer. Currently: N/A.
12. **Regression — clean merge**: Trigger a merge with no conflicts → normal merge completes as today, no conflict panel appears.

## Scope

- **IN**: Merge conflicts, rebase conflicts, per-file resolution (ours/theirs/manual), conflict detection on app open, abort at any point, progress tracking, ours-vs-theirs diff preview
- **OUT**: Inline editing of conflict markers in UI, three-way (base/ours/theirs) diff view, per-hunk resolution, cherry-pick conflicts

## Key Requirements

- Conflict panel hijacks the file-changes view — must be visually clear what state the workspace is in
- Abort is always visible and its consequences are explicit ("discards all resolutions, returns to pre-merge/rebase state")
- Rebase progress shows "Resolving commit N of M"
- "Resolve manually" escape hatch for anything beyond accept-ours/theirs

## Constraints

- Must work with existing worktree isolation model (conflicts happen per-worktree)
- Must not violate board state single-writer rule
- Must integrate with existing workspace metadata monitor for conflict detection

## Open Questions for Research

- How does `runGitMergeAction()` currently abort? What needs to change to pause instead?
- What metadata does `workspace-metadata-monitor` already track for unmerged state?
- What's the existing diff panel architecture — can we reuse it for ours-vs-theirs preview?
- How does the file-changes panel detect what to show? How do we swap it for a conflict panel?
- What tRPC endpoints exist for git operations? What new ones are needed?
