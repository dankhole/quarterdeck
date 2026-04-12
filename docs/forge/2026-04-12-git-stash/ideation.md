---
project: git-stash
date: 2026-04-12
status: ideation
---

# Ideation: Git Stash in Commit Panel

**Goal**: Add git stash support to Quarterdeck, integrated into the existing commit sidebar panel (JetBrains-style). Users can stash changes alongside committing/discarding, browse and manage existing stashes, and get contextual "Stash & Retry" actions when operations are blocked by a dirty working tree.

## Behavioral Change Statement

> **BEFORE**: The commit panel offers Commit and Discard. When checkout or pull fails due to uncommitted changes, the user must manually commit, discard, or open a terminal to run `git stash`. There is no stash visibility or management anywhere in the UI.
> **AFTER**: The commit panel gains a Stash button that stashes selected files (or all, with untracked always included). A collapsible "Stashes" section below the file list shows the stash stack with pop/apply/drop actions and diff preview. When checkout or pull fails due to dirty tree, an error toast includes a "Stash & Retry" action that auto-stashes and retries the operation.
> **SCOPE**: Commit panel (home + task-scoped), checkout flow, pull flow, git status metadata polling.

## Functional Verification Steps

1. **Stash all from commit panel**: With uncommitted changes, click Stash with no files selected -> all changes (tracked + untracked) stashed, file list clears, stash appears in stash list section.
2. **Stash selected files**: Check 2 of 5 changed files, click Stash -> only those 2 files stashed, other 3 remain in file list.
3. **Stash with message**: Enter a message before stashing -> stash list shows the custom message instead of the default git description.
4. **Stash list display**: Create 3 stashes -> collapsible section shows all 3 with index, message, originating branch, badge count on header.
5. **Pop stash**: Click Pop on a stash entry -> changes restored to working tree, entry removed from stash list.
6. **Apply stash**: Click Apply -> changes restored, entry remains in stash list.
7. **Drop stash**: Click Drop on a stash entry -> entry removed without applying, confirmation dialog.
8. **Stash diff preview**: Click a stash entry -> see diff of stashed changes (via "Open in diff viewer" or inline summary).
9. **Stash & Retry on blocked checkout**: Attempt checkout with dirty tree -> error toast with "Stash & Switch" action -> auto-stashes, retries checkout, succeeds.
10. **Stash & Retry on blocked pull**: Attempt pull with dirty tree -> error toast with "Stash & Pull" action -> auto-stashes, pulls, auto-pops stash.
11. **Stash pop/apply conflict**: Pop a stash that conflicts with current changes -> conflict state detected, conflict resolution panel activates.
12. **Task-scoped stash**: Stash operations in a task worktree affect only that worktree's stash stack, not the home repo.
13. **Regression -- commit still works**: Existing commit flow (select files, enter message, commit) unchanged.
14. **Regression -- discard still works**: Existing discard all/per-file flow unchanged.

## Scope

- **IN**: Stash push (partial + full), stash list, pop, apply, drop, diff preview, stash & retry for checkout/pull, message input, collapsible stash list section in commit panel
- **OUT**: Stash branch (create branch from stash), stash rename, stash across worktrees, auto-stash on any operation other than checkout/pull

## Key Requirements

- Partial stash via file selection checkboxes (reuse existing selection state)
- Always include untracked files (`--include-untracked`)
- Optional stash message
- Stash pop/apply must integrate with existing conflict resolution
- Badge count on collapsible stash list header
- Drop requires confirmation

## Constraints

- Worktrees share the git object database but may have independent stash stacks -- needs verification
- Must follow board state single-writer rule (stash operations are server-side git commands, not board state mutations)
- Stash list polling must not add noticeable overhead to the existing metadata poll cycle

## Open Questions for Research

- Is `git stash` per-worktree or shared across worktrees?
- How does the commit panel's file polling interact with stash operations?
- What's the exact error shape when checkout/pull fails due to dirty tree?
- How does the conflict resolution panel get activated?
