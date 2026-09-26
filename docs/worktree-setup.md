# Worktree setup

Quarterdeck prepares new isolated task worktrees before launching the coding agent. It initializes submodules, copies selected ignored files, and runs the project's optional setup script. Shared-checkout tasks do not run this preparation.

## Include ignored files

Create `.worktreeinclude` in the project repository root. It uses the same `.gitignore`-style patterns as [Codex's format](https://learn.chatgpt.com/docs/environments/git-worktrees#copy-ignored-local-files-into-managed-worktrees):

```gitignore
# Local configuration needed by new tasks
.env
.env.local
config/local/**
!config/local/cache/**
```

Only files that Git ignores and the include patterns select are copied. Tracked files already come from the checkout; other untracked files are not included. With no `.worktreeinclude`, no ignored files are copied. Patterns support comments, negation, root anchors, and directory matches, including the usual Git rule that a negated child cannot reinclude a file under an excluded parent.

Files become independent copies. Quarterdeck skips source symlinks, symlinked ancestors, and existing destination files, directories, or links. Includes cannot override the exclusions for `node_modules`, `bin`, `obj`, `TestResults`, test reports, and internal Git paths. Install dependencies inside the task worktree instead. Existing dependency symlinks from older Quarterdeck versions are removed without following them or modifying their targets; other existing task files remain untouched.

Copying happens during creation or an explicit retry of incomplete setup. It does not synchronize later edits from the project into existing worktrees. Quarterdeck retains Git exclude entries for copied files so local setup files stay out of task changes even when their original ignore rules were not tracked.

## Configure the script

Select the project, open Settings, and save **Worktree setup script**. For a typical npm project:

```sh
npm ci
```

For Quarterdeck itself, `npm run bootstrap` installs its root and web dependencies. The setting is local to that project in Quarterdeck's project configuration (`worktreeSetupScript`), not global and not read as executable instructions from `.worktreeinclude`.

The script runs with the new worktree as its working directory and inherits the runtime's environment and PATH. On macOS/Linux it uses `/bin/sh -e`; on Windows it uses noninteractive Windows PowerShell without a profile. Use syntax for your host shell. In Windows PowerShell, explicitly check native-command failures when chaining commands, for example `npm ci; if ($LASTEXITCODE) { exit $LASTEXITCODE }`. Scripts have a ten-minute timeout and closed stdin; use noninteractive commands and keep necessary work in the foreground. Quarterdeck terminates the script's process tree on timeout or runtime exit.

## Progress and retry

The task shows setup progress before the agent launches. Successful setup runs once for that worktree, even if the script setting later changes or the task is resumed/restarted. Existing worktrees created before this feature do not retroactively run a script. Restoring a deleted worktree creates a new one and prepares it again.

A failed or interrupted setup blocks agent launch and preserves the worktree. Correct the project script or local files, then explicitly **Start** or **Restart** the task to retry. Automatic startup recovery never retries incomplete setup. Scripts should tolerate partial prior runs; copied files are never overwritten on retry.

The failure message points to `quarterdeck-setup.log` in that worktree's Git administrative directory. It retains the last 64 KiB of script output locally (mode `0600` on macOS/Linux); script output is not copied into ordinary runtime diagnostics. The neighboring `quarterdeck-setup.json` records completion independently of the task's tracked files. Worktree deletion waits for the setup lock or reports contention rather than deleting files under a running script.
