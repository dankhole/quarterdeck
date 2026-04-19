// Default prompt templates for prompt shortcuts and auto-review actions.
// Kept in a dedicated file so multi-line templates don't clutter config-defaults.

export const DEFAULT_COMMIT_PROMPT_TEMPLATE = `When you are finished with the task, commit your working changes.

First, check your current git state: run \`git status\` and \`git branch --show-current\`.

- If you are on a branch, stage and commit your changes directly on that branch. Write a clear, descriptive commit message that summarizes the changes and their purpose.
- If you are on a detached HEAD, create a new branch from the current commit first (e.g. \`git checkout -b <descriptive-branch-name>\`), then stage and commit. Report that a new branch was created.
- Do not run destructive commands: git reset --hard, git clean -fdx, git worktree remove, rm/mv on repository paths.
- Do not cherry-pick, rebase, or push to other branches. Just commit to your current branch.

Report:
- Branch name
- Final commit hash
- Final commit message
- Whether a new branch was created (detached HEAD case)`;

export const DEFAULT_OPEN_PR_PROMPT_TEMPLATE = `When you are finished with the task, open a pull request against {{base_ref}}.

- Do not run destructive commands: git reset --hard, git clean -fdx, git worktree remove, rm/mv on repository paths.
- Do not modify the base worktree.
- Keep all PR preparation in the current worktree.

Steps:
1. Ensure all intended changes are committed.
2. If currently on detached HEAD, create a branch at the current commit.
3. Push the branch to origin and set upstream.
4. Create a pull request with base {{base_ref}} and head as the pushed branch (use gh CLI if available).
5. If a pull request already exists for the same head and base, return that existing PR URL instead of creating a duplicate.
6. If PR creation is blocked, explain exactly why and provide the exact commands to complete it manually.
7. Report:
   - PR title: PR URL
   - Base branch
   - Head branch
   - Any follow-up needed`;

// Squash-merge prompt extracted from the squash-merge Claude skill, with
// project-specific release hygiene removed so it works as a generic
// worktree landing flow.
export const DEFAULT_SQUASH_MERGE_PROMPT_TEMPLATE = `Land commits onto a target branch from a worktree using squash merge.

## Step 0: Ask the User

Before doing anything, ask the user to confirm the target branch and explain what will happen. Present this message:

---

**Squash merge — what's about to happen:**

This will take all the commits on your current branch, squash them into a single commit, and land that commit on a target branch. It uses \`git commit-tree\` + \`git update-ref\` instead of a normal merge, which means it works even when the target branch is checked out in another worktree.

**Which branch should I land on?** (default: \`main\`)

---

Wait for the user's response. If they name a branch, use it as the target. If they confirm without naming one, default to \`main\`. If they want to bail out, stop here.

Verify the target exists locally:
\`\`\`bash
git rev-parse --verify refs/heads/<target>
\`\`\`

If the target doesn't exist, tell the user and stop.

## Step 1: Check State

\`\`\`bash
git branch --show-current
git status --porcelain
git log --oneline <target>..HEAD
\`\`\`

- If \`git branch --show-current\` returns the **target** branch name, **stop** — you're already on the target. Nothing to land.
- If \`git log <target>..HEAD\` shows no commits and there are no uncommitted changes, **stop** — nothing to land.

## Step 2: Commit Uncommitted Changes

If \`git status --porcelain\` shows uncommitted work, stage and commit it with a clear message summarizing the changes.

If the working tree is clean, skip to Step 3.

## Step 3: Sync with Target Branch

**CRITICAL:** \`commit-tree\` replaces the target's entire tree with HEAD's tree. If the target has advanced since this worktree branched (other worktrees landed work), those changes will be silently dropped unless merged first.

Check if the target has diverged:

\`\`\`bash
git merge-base --is-ancestor <target> HEAD
\`\`\`

Exit code 0 means the target is an ancestor of HEAD (up to date) — skip to Step 4. Exit code 1 means the target has diverged.

If the target has diverged, first identify what each side changed independently:

\`\`\`bash
# Files this worktree changed since the branch point
git diff --name-only <target>...HEAD
# Files the target changed since we branched
git diff --name-only HEAD...<target>
\`\`\`

Save both file lists. Files that appear in **both** lists were modified by both sides — these are the risky ones that need careful review even if git merges them cleanly.

Now merge without committing so you can review:

\`\`\`bash
git merge <target> --no-commit --no-ff
\`\`\`

- If there are merge conflicts, **abort and stop**:
  \`\`\`bash
  git merge --abort
  \`\`\`
  Tell the user which files conflict and let them resolve manually.

- If the merge applies cleanly, review it by comparing each side's intent:
  \`\`\`bash
  git diff --cached --stat
  \`\`\`

  For every file that **both branches modified** (from the lists above), inspect the merged result carefully:
  \`\`\`bash
  git diff --cached -- <file>
  \`\`\`
  Verify that changes from both sides are preserved and logically compatible. Watch for:
  - One side adding code that depends on something the other side removed
  - Both sides modifying the same function/config in ways that contradict each other
  - Import/dependency changes that conflict semantically but merged textually

  **If any file was modified by both branches and you aren't confident the merged result is correct, abort and stop:**
  \`\`\`bash
  git merge --abort
  \`\`\`
  Tell the user which files were modified by both branches, show the relevant diffs from each side, and let them decide how to proceed.

- **When in doubt, bail out.** If the merge diff is large, touches many files, or is hard to reason about with confidence, abort and present the situation to the user rather than proceeding. A false stop is cheap — a bad merge is not.

- If the merge is clean and all dual-modified files look correct, commit:
  \`\`\`bash
  git commit --no-edit
  \`\`\`

## Step 4: Verify No Unintended Changes

Build the list of files this worktree actually touched (excluding merge commits from the sync step):

\`\`\`bash
git log <target>..HEAD --no-merges --name-only --format=""
\`\`\`

Deduplicate this into a set of **expected files**.

Now check what the final diff against the target looks like:

\`\`\`bash
git diff <target> HEAD --stat
\`\`\`

Compare the two lists. Every file in the diff should appear in the expected-files set. If any file shows up in the diff but was **not** touched by this worktree's own commits, **stop** — that file is being changed as a side effect (likely a stale version from the worktree overwriting a newer version on the target). Tell the user exactly which files are unexpected and let them investigate.

## Step 5: Generate Commit Message

Review the commits being landed:

\`\`\`bash
git log --oneline --reverse <target>..HEAD
\`\`\`

Ignore any merge commits from the sync step — focus on the actual work commits.

Write a single squash commit message:
- First line: concise summary under 72 chars
- Blank line
- Body: bullet points summarizing the key changes, focusing on *why* not *what*
- Follow the repo's commit message style (check \`git log --oneline -5 <target>\`)
- Keep the whole message under 20 lines

## Step 6: Land on Target

### Pre-flight: detect target worktree

Check if the target branch is checked out in another worktree **before** landing. The porcelain format groups \`worktree\`, \`HEAD\`, and \`branch\` lines into blocks separated by blank lines — the worktree path and branch are only associated if they're in the **same block**.

Parse correctly by extracting the worktree path from the block that contains the matching branch:

\`\`\`bash
git worktree list --porcelain | awk -v target="branch refs/heads/<target>" '/^worktree /{wt=$0; sub(/^worktree /,"",wt)} $0==target{print wt}'
\`\`\`

If this prints a path (and it's not the current worktree), check for uncommitted work **now** — before \`update-ref\` changes anything:

\`\`\`bash
git -C <target-worktree-path> status --porcelain
\`\`\`

Note whether the worktree was dirty or clean. This must happen before \`update-ref\` because \`update-ref\` itself makes the worktree dirty (it advances HEAD without touching the index or working tree).

### Land

Run these as three separate commands, capturing output from each to use in the next:

\`\`\`bash
git rev-parse <target>
\`\`\`
Save the output as OLD_TARGET.

\`\`\`bash
git commit-tree HEAD^{tree} -p <target> -m "<message>"
\`\`\`
Save the output as COMMIT.

\`\`\`bash
git update-ref refs/heads/<target> <COMMIT> <OLD_TARGET>
\`\`\`
Substitute the literal values captured above (not shell variables). If \`update-ref\` fails (compare-and-swap rejected), the target was advanced by another process. Tell the user and stop.

**Do NOT run \`git checkout <target>\`.** Stay where you are — the worktree may be cleaned up after this, and switching branches would cause problems.

### Sync target worktree

If the target branch is checked out in another worktree (detected in pre-flight):

- If it was **dirty before the land**: warn the user that the ref was updated but the worktree has uncommitted work they should save first. Tell them to run \`git -C '<target-worktree-path>' reset --hard HEAD\` when ready.
- If it was **clean before the land**: run \`git -C <target-worktree-path> reset --hard HEAD\` to sync. \`update-ref\` moved the ref without touching the index — resetting is safe because there's no real uncommitted work to lose.

## Step 7: Verify

\`\`\`bash
git log --oneline <target> -5
\`\`\`

Confirm the new commit appears at the top with the expected message.

Report:
- Target branch name
- Commit hash
- Commit message
- Whether the target worktree was synced (if checked out elsewhere)

**Do NOT push without asking.**`;

// Default system prompt template appended to worktree agent sessions via
// --append-system-prompt. Uses mustache-style placeholders that are resolved
// at launch time:
//   {{cwd}}                – the worktree working directory
//   {{project_path}}     – the main repository directory
//   {{detached_head_note}} – conditional note when HEAD is detached (or empty)
export const DEFAULT_WORKTREE_SYSTEM_PROMPT_TEMPLATE = `You are working in a git worktree.
- Your working directory is {{cwd}}. Shell commands reset to this path between invocations.
- The main repository is at {{project_path}}. Other agents may be running in parallel worktrees on the same repo.
- Do not check out branches, commit, push, or run destructive git operations (reset --hard, clean -fdx, force push) unless explicitly asked.
- Do not modify files outside your worktree unless explicitly asked.{{detached_head_note}}
- This worktree shares the git object database with the main repo. To read any file from another branch without leaving the worktree, use \`git show <ref>:<path>\` (e.g. \`git show main:AGENTS.md\`, \`git show main:docs/guide.md\`). Prefer this over trying to navigate to the parent repo directory.
- When spawning subagents, include the above worktree context in their prompts.`;
