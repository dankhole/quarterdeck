# Dev Journal

Personal notes and discoveries while working on Kanban.

---

## 2026-04-05 — Kanban Agent tab & bypass permissions

### What is the Kanban Agent tab?

The "Kanban Agent" tab in the left sidebar is a built-in agent that manages the Kanban board through natural language. It's not a separate system — it spins up the same CLI agent you have selected (Cline, Claude Code, Codex, etc.) but with a special system prompt appended that teaches it the `kanban` CLI commands (`task create`, `task link`, `task start`, `task trash`, etc.).

When you say "break this into 3 tasks", the agent literally runs shell commands like:
```
kanban task create --prompt "Implement feature X"
kanban task link --task-id abc --linked-task-id def
```

The system prompt lives in `src/prompts/append-system-prompt.ts` (lines 120-291). It also tells the agent to never edit code files — its only job is board management.

### Bypass permissions bug

The "Enable bypass permissions flag" checkbox in Settings controls whether agents run with auto-approve flags (e.g. `--dangerously-skip-permissions` for Claude Code, `--auto-approve-all` for Cline CLI). This worked fine for terminal-based agents but **had no effect on the Kanban Agent tab**.

**Root cause:** The Kanban Agent tab uses the Cline SDK chat path, not the terminal adapter path. In `src/cline-sdk/cline-runtime-setup.ts`, the `requestToolApproval` callback was hardcoded to `{ approved: true }` — it never checked the config setting.

**The fix (3 files):**
- `src/config/runtime-config.ts` — Changed `DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED` from `true` to `false`
- `src/cline-sdk/cline-task-session-service.ts` — Added `autonomousModeEnabled` to `StartClineTaskSessionRequest`; only passes the auto-approve callback when `true`
- `src/trpc/runtime-api.ts` — Both Cline SDK `startTaskSession` call sites now pass `agentAutonomousModeEnabled` from the runtime config

### Architecture note

Two separate code paths for agent sessions:
1. **Terminal path** — spawns CLI processes (Claude Code, Codex, Gemini, Droid, Cline CLI). Adapter in `src/terminal/agent-session-adapters.ts` adds flags like `--dangerously-skip-permissions`. Correctly reads `autonomousModeEnabled`.
2. **Cline SDK path** — used when `selectedAgentId === "cline"`. Runs the Cline SDK in-process. Tool approval is handled by a `requestToolApproval` callback, not CLI flags. The `ClineRuntimeSetup` is cached per workspace in a watcher registry — don't bake session-scoped config into it.
