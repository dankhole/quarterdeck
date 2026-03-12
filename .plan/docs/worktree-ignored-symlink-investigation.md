# Worktree Ignored Symlink Investigation

Date: March 12, 2026

Purpose: capture the investigation into why Kanban task worktrees sometimes show ignored paths such as `.next`, `.husky/_`, or `node_modules` in the diff view, often as empty `+0 -0` entries.

## Executive summary

The root problem is not just the diff UI.
The deeper issue is that Kanban symlinks ignored directories from the main repo into each task worktree, but Git does not always apply the original `.gitignore` rule to the symlinked path the same way it applied it to the real directory.

That means a path that is ignored in the main repo can become untracked in the task worktree.

Examples that triggered this investigation:

- `~/Repositories/cline-web` ignores `.next` with `/.next/`
- a user report showed `node_modules/` in `.gitignore`
- a prior Kanban bug involved `.husky/_`, which is ignored by a nested `.gitignore` inside `.husky/_/`

All of these are the same family of problem:

- the original ignore rule was written for a real directory
- Kanban replaced that directory in the worktree with a symlink
- Git no longer matched the ignore rule the same way

The empty `+0 -0` diff entries are a second bug layered on top:

- once the ignored path leaks in as untracked
- Kanban's diff code tries to render it like a file
- reading contents from a directory or directory symlink fails
- the UI falls back to an empty diff shape instead of treating it as a non-file entry

## Concrete examples

### Example 1: `cline-web` and `/.next/`

`~/Repositories/cline-web/.gitignore` contains:

```gitignore
/.next/
```

This correctly ignores the real `.next` directory in the main repo.

But when Kanban creates a task worktree and symlinks `.next` into it:

```text
worktree/.next -> ~/Repositories/cline-web/.next
```

Git can stop treating the worktree path as a normal directory for ignore matching.
In a direct repro, `git status --short --ignored` in the worktree showed:

```text
?? .next
```

That is why `.next` started appearing in Kanban's diff view.

### Example 2: `node_modules/`

A user report showed a repo with:

```gitignore
node_modules/
```

This is the same type of rule as `/.next/` for Git's purposes here.
It is a directory-oriented ignore rule.
If Kanban symlinks `node_modules` into the worktree, Git may treat the worktree path as a symlink entry rather than a normal directory, so the original rule may stop matching reliably.

This explains why different users saw `node_modules` leak into the diff view even though it was already in `.gitignore`.

One subtlety:

- `node_modules` without a trailing slash can sometimes still ignore the symlink path
- `node_modules/` or `/.next/` are more likely to expose the problem

That is why the bug can look inconsistent across repos.

### Example 3: `.husky/_`

The earlier `.husky/_` bug was a more specific version of the same issue.
There, the ignored directory was not ignored by the repo root `.gitignore`.
Instead, it was ignored by a nested `.gitignore` inside the directory itself:

```text
.husky/_/.gitignore
*
```

When `.husky/_` became a symlink in the worktree, Git no longer traversed into the nested ignore file through the symlink boundary, so the path showed up as:

```text
?? .husky/_
```

That fix addressed one variant, but not the broader class of "ignored directory becomes symlink, ignore rule stops matching."

## Root cause

Kanban's current worktree setup has this product goal:

- create a fast, ready-to-run task worktree
- avoid copying large ignored directories like `node_modules`
- avoid forcing a fresh install or build in every task worktree

To achieve that, Kanban symlinks ignored paths from the main repo into the task worktree.

The problem is that Git ignore rules are not purely path-string based.
They depend on path type and traversal behavior too.

In practice:

- an ignore rule written for a directory is not always equivalent when the worktree path is a symlink
- a nested ignore file inside an ignored directory does not apply through a symlink boundary the same way

So the symlink strategy is fundamentally interacting with Git semantics, not just with Kanban UI code.

## Why the diff view shows empty `+0 -0`

The `+0 -0` entries are not the actual root cause.
They are the visible symptom after the ignored path has already leaked into Git status.

Current behavior:

1. Git reports the leaked symlinked ignored directory as untracked, for example `?? .next`
2. Kanban collects untracked paths and builds per-file diff entries
3. the diff code tries to read the path like a text file
4. for a directory or directory symlink, that read fails
5. the fallback stats end up as zero additions and zero deletions

So the UI is misrepresenting a leaked directory as if it were an empty file diff.

This means there are two fixes worth tracking separately:

- prevent ignored symlink paths from leaking into Git status
- make the diff UI refuse to render directory-like entries as fake file diffs

## Is changing `.git/info/exclude` a band-aid?

Not exactly.

It would be a band-aid if we were editing the tracked repo `.gitignore` to paper over unrelated bugs.
That is not what this does.

Using `.git/info/exclude` is a local-only Git mechanism.
It is untracked, per-repo, and specifically intended for local ignore behavior.

If Kanban chooses to keep symlinking ignored paths, then adding exact local ignore entries for those symlink targets is a direct fix for the semantic mismatch Kanban introduced.

In other words:

- the symlink created the mismatch
- the local exclude restores the intended ignore behavior for that symlinked path

So it is not arbitrary, but it is still a tradeoff.

## Product and architecture options

### Option 1: stop symlinking ignored paths entirely

Pros:

- simplest Git model
- no special local exclude handling
- fewer surprising diff leaks
- easier mental model for worktrees

Cons:

- worktrees are no longer immediately runnable
- users may need to run install/build steps inside each task worktree
- loses one of Kanban's key convenience features

### Option 2: keep symlinking ignored paths and add local exact excludes

Pros:

- preserves fast, ready-to-run worktrees
- fixes both root-level and nested ignore-rule failures
- keeps ignore behavior local to `.git/info/exclude`, not tracked files

Cons:

- adds more machinery to worktree setup
- requires careful syncing when ignored paths change
- still depends on symlink semantics, which are inherently a bit subtle

### Option 3: only symlink an allowlist

Example allowlist candidates:

- `node_modules`
- package-manager caches
- selected build caches

Pros:

- smaller surface area for Git weirdness
- preserves the highest-value fast-start paths
- easier to reason about than "symlink every ignored path"

Cons:

- requires product decisions on what belongs in the allowlist
- can still hit the same Git issue for those allowed paths unless local excludes are also added
- some repos may want different paths than others

## Current conclusion

The investigation supports these conclusions:

1. The root issue is real Git behavior around symlinked ignored directories, not just a Kanban rendering bug.
2. The old `.husky/_` fix solved only one narrow form of the problem.
3. `/.next/` and `node_modules/` are both valid examples of the broader issue.
4. The `+0 -0` rows are a separate UI bug and should be fixed independently.
5. If Kanban wants to preserve the "ready state via symlinked ignored paths" vision, local exact excludes are a reasonable fix.
6. If Kanban wants the simplest mental model, the only fully simple approach is to stop symlinking ignored directories.

## Recommendation

Short term:

- keep the worktree setup stable by ensuring symlinked ignored roots remain ignored locally
- separately harden the diff UI so untracked directories or directory symlinks never render as fake `+0 -0` file diffs

Long term:

- revisit whether "symlink all ignored paths" is the right product rule
- consider narrowing it to an allowlist if the broad behavior keeps producing edge cases

## Key mental model going forward

This issue becomes much easier to reason about with one rule:

"Ignored directory" and "symlink to an ignored directory" are not equivalent in Git.

Once Kanban replaces a real ignored directory with a symlink inside the worktree, it owns the consequences of that semantic change.
