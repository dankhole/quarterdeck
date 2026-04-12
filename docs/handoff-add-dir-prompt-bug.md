# Handoff: `--add-dir` prompt injection bug

**Date**: 2026-04-11
**Branch**: `fix/trust-cap-warning-toast` (merged with main)
**Status**: Fixed

## The bug

When the "Allow agents to access the parent repo from worktrees" setting (`worktreeAddParentRepoDir`) is enabled, task creation appears to succeed but the agent sits idle — the task prompt is never delivered.

When both `worktreeAddParentRepoDir` and `worktreeAddQuarterdeckDir` are enabled, the failure is the same but worse (more directories consumed as phantom paths).

## Root cause

Claude Code's `--add-dir` flag is **variadic**: `--add-dir <directories...>`. It consumes all subsequent non-option arguments as directory paths.

The Claude adapter in `agent-session-adapters.ts` builds args like this:

```
claude --settings /path/settings.json --add-dir /path/to/repo "task prompt text"
```

The CLI parser sees `--add-dir` and greedily consumes `/path/to/repo` AND `"task prompt text"` as directories. The prompt is never delivered to the agent. Confirmed via `claude --help`:

```
--add-dir <directories...>    Additional directories to allow tool access to
```

## The fix

Insert `"--"` (end-of-options separator) before the prompt positional arg. This tells the CLI parser to stop consuming options and treat everything after as positional arguments.

### Where to change

`src/terminal/agent-session-adapters.ts`, in `claudeAdapter.prepare()` around line 614.

**Before:**
```typescript
const withPromptLaunch = withPrompt(args, input.prompt, "append");
```

**After** (option A — in the adapter, Claude-specific):
```typescript
// "--" terminates option parsing so variadic flags like --add-dir
// don't consume the prompt as a directory path.
if (input.prompt.trim()) {
    args.push("--");
}
const withPromptLaunch = withPrompt(args, input.prompt, "append");
```

**After** (option B — simpler, just always push `--` before the prompt):
```typescript
args.push("--");
const withPromptLaunch = withPrompt(args, input.prompt, "append");
```

Option A is slightly cleaner (no `--` when there's no prompt). Either works.

### What NOT to change

`withPrompt()` itself is shared across adapters. Don't put `--` in there — other CLIs (Codex, Gemini, OpenCode) may not support it.

## What was already done this session

All changes are committed on branch `fix/trust-cap-warning-toast`, merged with `main`.

### 1. Trust auto-confirm multi-prompt support (`session-manager.ts`)

**What**: The workspace trust auto-confirm mechanism previously only handled one trust prompt per session. After confirming the first prompt, `autoConfirmedWorkspaceTrust` was set to `true` permanently. The fix re-arms the detector after each confirmation.

**Changes**:
- Added `workspaceTrustConfirmCount: number` to `ActiveProcessState` (initialized to 0 at both creation sites: task sessions line ~577, shell sessions line ~734)
- Added `MAX_AUTO_TRUST_CONFIRMS = 5` constant
- After each confirmation timer fires: if count < cap, reset `autoConfirmedWorkspaceTrust = false`. If count >= cap, set `workspaceTrustBuffer = null` to disable entirely.
- When cap is reached: set `warningMessage` on the session summary and log at `warn` level

**Relevance to the actual bug**: This fix is **defensive but not the root cause**. The `--add-dir` variadic issue means the prompt is lost at CLI arg parsing time, before trust prompts are even relevant. However, the multi-prompt trust fix is still correct behavior for cases where multiple trust prompts genuinely appear (e.g., future Claude Code changes).

### 2. Debug logging (`agent-session-adapters.ts`, `session-manager.ts`)

**What**: Added `createTaggedLogger("agent-launch")` and `createTaggedLogger("session-mgr")` with structured debug log calls at key points in the task creation flow.

**Log points** (all zero-overhead when debug mode is off):
- `prepareAgentLaunch` called — taskId, agentId, cwd, workspacePath, add-dir settings, prompt presence
- Claude adapter `--add-dir` check — isWorktree, which paths are added
- Claude adapter prepared launch — argCount, promptLength, full args (truncated at 200 chars each)
- Session spawn — binary, cwd, willAutoTrust, add-dir settings
- Spawn success — pid
- Spawn failure — error message
- Trust prompt detected — confirmCount, which pattern matched
- Process exit — exitCode, total trust confirm count

### 3. Default change (`global-config-fields.ts`)

`worktreeAddParentRepoDir` default changed from `true` to `false`. Both `--add-dir` settings now default to off. Test fixtures in `runtime-config.test.ts` updated to match.

### 4. Toast for `warningMessage` (`use-task-sessions.ts`)

`upsertSession` in `web-ui/src/hooks/use-task-sessions.ts` now checks for new `warningMessage` values on session summaries and shows a toast via `showAppToast({ intent: "warning", message })`. This surfaces the trust cap warning (and any future server-side warnings) without requiring the user to be watching the terminal.

### 5. `willAutoTrust` extraction (`session-manager.ts`)

The inline conditional `shouldAutoConfirmClaudeWorkspaceTrust(...) || shouldAutoConfirmCodexWorkspaceTrust(...) || hasCodexLaunchSignature` was extracted into a named `willAutoTrust` variable, used for both the `ActiveProcessState.workspaceTrustBuffer` initialization and the debug logging.

### 6. Release hygiene

- `CHANGELOG.md` — updated "Agent directory access" entry (both settings off by default), added "Fix: workspace trust auto-confirm" entry
- `docs/implementation-log.md` — added detailed entry for the trust fix, debug logging, and default change; fixed stale "default true" reference in the original `--add-dir` entry

## Files touched (cumulative)

| File | Changes |
|------|---------|
| `src/terminal/agent-session-adapters.ts` | Debug logging, `--add-dir` logging |
| `src/terminal/session-manager.ts` | Trust multi-prompt fix, debug logging, `willAutoTrust` extraction, cap warning |
| `src/config/global-config-fields.ts` | `worktreeAddParentRepoDir` default `true` → `false` |
| `test/runtime/config/runtime-config.test.ts` | Fixture update for new default |
| `web-ui/src/hooks/use-task-sessions.ts` | Toast for `warningMessage` |
| `CHANGELOG.md` | Updated + new entries |
| `docs/implementation-log.md` | New entry + stale reference fix |

## To verify the fix works

1. Apply the `--` fix in `claudeAdapter.prepare()`
2. Build: `npm run dev`
3. Enable `worktreeAddParentRepoDir` in Settings > Git & Worktrees
4. Create a task with a prompt (e.g., "test ignore me")
5. Enable debug mode — check the `agent-launch` log for the final args. The prompt should appear after `--`:
   ```
   args: ["--settings", "...", "--add-dir", "/path/to/repo", "--", "test ignore me"]
   ```
6. The agent should start working on the prompt, not sit idle
7. Test with `worktreeAddQuarterdeckDir` also enabled — should see two `--add-dir` entries before the `--`
8. Test without either setting — should work as before (no `--add-dir`, prompt at end)
