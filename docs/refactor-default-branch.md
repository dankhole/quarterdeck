# Refactor: Unify default branch resolution

## Problem

"Default branch" is determined in three independent places with no shared logic, creating confusion about what "default" means and making it hard to trace:

### 1. Git auto-detection (server)

`src/state/workspace-state-utils.ts:123` — `detectGitDefaultBranch()`:
- Runs `git symbolic-ref refs/remotes/origin/HEAD` to get the remote default
- Falls back to `"main"` → `"master"` → first branch alphabetically
- Result stored as `workspaceGit.defaultBranch` in the `RuntimeGitRepositoryInfo` schema

### 2. "(default)" label in dropdown (frontend)

`web-ui/src/hooks/use-task-branch-options.ts:44-50`:
- Picks `"main"` if it exists, otherwise uses `workspaceGit.defaultBranch`
- Appends the string `"(default)"` to the label — purely cosmetic
- This label is **not updated** when the user pins a different branch via config

### 3. User-pinned default (config)

`src/config/global-config-fields.ts:119` — `defaultBaseRef` in project config:
- Set via the pin button in `BranchSelectDropdown`
- Stored in `.quarterdeck/config.json` per project
- When set, `useTaskBranchOptions` returns it as `defaultTaskBranchRef` and sets `isConfigDefaultBaseRef: true`

### Where they diverge

| Scenario | Git detection | "(default)" label | Config pin | Dropdown selection |
|----------|--------------|-------------------|------------|-------------------|
| Fresh repo, no pin | `main` | `main (default)` | empty | `main` |
| User pins `develop` | `main` | `main (default)` | `develop` | `develop` |
| User pins `main` | `main` | `main (default)` | `main` | `main` |

When the user pins `develop`, the dropdown correctly selects `develop` on open, but the "(default)" label still shows on `main`. This is confusing — there are now two visual indicators of "default" pointing at different branches.

### CLI also ignores the config pin

`src/commands/task-board-helpers.ts:25` — `resolveTaskBaseRef()`:
```ts
return state.git.defaultBranch ?? state.git.currentBranch ?? state.git.branches[0] ?? "";
```
Used by `quarterdeck task create` (CLI). It only reads `state.git.defaultBranch` — it does **not** check the config `defaultBaseRef`. So CLI task creation and UI task creation can silently use different base refs.

### Home terminal also ignores the config pin

`web-ui/src/hooks/use-terminal-panels.ts:280`:
```ts
baseRef: workspaceGit?.currentBranch ?? workspaceGit?.defaultBranch ?? "HEAD",
```
Uses git detection only, not the config default.

## Proposed fix

Unify into a single resolution function used everywhere:

1. **Single resolver**: Create a shared `resolveDefaultBaseRef(gitInfo, configDefaultBaseRef?)` that implements the priority chain: config pin → git detection → fallback. Use it in:
   - `useTaskBranchOptions` (frontend dropdown default + label)
   - `resolveTaskBaseRef` (CLI task creation)
   - `use-terminal-panels.ts` (home terminal base ref)

2. **"(default)" label follows the pin**: When a config default is set, move the "(default)" label to the pinned branch instead of the git-detected one. When no pin is set, keep current behavior (label on git-detected default).

3. **Remove the pin icon when "(default)" label is sufficient**: Consider whether the pin icon and the "(default)" label are redundant. If the label moves to the pinned branch, the pin icon on hover could be replaced with a simpler "Set as default" in the dropdown — or removed entirely and managed only through settings.

4. **Include config default in workspace state response**: So the CLI's `resolveTaskBaseRef` can read it without a separate config fetch.

## Scope

- `src/state/workspace-state-utils.ts` — no change (git detection stays as-is)
- `src/commands/task-board-helpers.ts` — update `resolveTaskBaseRef` to check config
- `web-ui/src/hooks/use-task-branch-options.ts` — update label logic + use shared resolver
- `web-ui/src/hooks/use-terminal-panels.ts` — use shared resolver
- `web-ui/src/components/branch-select-dropdown.tsx` — possibly simplify pin UI
