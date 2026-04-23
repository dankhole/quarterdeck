# Implementation Log

> Prior entries in `docs/implementation-archive/`: `implementation-log-through-0.11.0.md`, `implementation-log-through-0.10.0.md`, `implementation-log-through-0.9.4.md`, `implementation-log-through-2026-04-15.md`, `implementation-log-through-2026-04-12.md`.

## Remove agent autonomous mode / bypass permissions feature (2026-04-22)

The "bypass permissions" toggle understated the security impact for Codex users — the UI copy said it "allows agents to use tools without stopping for permission" but the Codex adapter actually appended `--dangerously-bypass-approvals-and-sandbox`, which disables both approvals *and* the execution sandbox. Current Codex CLI docs recommend `--full-auto` for sandboxed unattended work and reserve the dangerous flag for externally isolated runners. Rather than fix the copy, removed the entire feature since it encouraged unsafe defaults.

Removed end-to-end across 18 files:
- **Config layer**: `agentAutonomousModeEnabled` field from `global-config-fields.ts`, both Zod schemas in `core/api/config.ts`
- **Agent catalog**: `autonomousArgs` from `RuntimeAgentCatalogEntry` interface and both agent entries in `agent-catalog.ts`
- **Adapter layer**: `autonomousModeEnabled` from `AgentAdapterLaunchInput`, Claude's `--dangerously-skip-permissions` injection, Codex's `--dangerously-bypass-approvals-and-sandbox` injection, debug log field in `agent-session-adapters.ts`
- **Session plumbing**: removed from `StartTaskSessionRequest`, `session-lifecycle.ts`, `start-task-session.ts`, `migrate-task-working-directory.ts`, `project-registry.ts`
- **Settings UI**: checkbox + helper text from `agent-section.tsx`, `buildDisplayedAgentCommand` and autonomous command display from `runtime-settings-dialog.tsx`, form field from `settings-form.ts`
- **Tests**: autonomous mode adapter tests, agent-registry autonomous tests, config-persistence autonomous tests, agent-selection assertions, web-ui test factory defaults

Plan mode logic in the Claude adapter (`--allow-dangerously-skip-permissions` + `--permission-mode plan`) was preserved — that's a separate feature for within-session permission escalation, not the bypass toggle.

## Fix: clarify worktree system prompt is Claude Code only (2026-04-22)

The settings UI described the worktree system prompt template as appended "to the agent's system prompt", but only the Claude adapter in `src/terminal/agent-session-adapters.ts` injects it via `--append-system-prompt`. The Codex adapter has no equivalent. Updated the description in `web-ui/src/components/settings/agent-section.tsx` to say "Claude Code's system prompt" so users know the scope.

Files touched: `web-ui/src/components/settings/agent-section.tsx`

## Docs cleanup and version bump to 0.11.0 (2026-04-22)

Archived 7 completed refactor docs to `docs/archive/`, rotated changelog and implementation log into their archive files, bumped version from 0.10.0 to 0.11.0, and updated `docs/README.md` cross-references.
