# Implementation Log

> Prior entries in `docs/implementation-archive/`: `implementation-log-through-0.11.0.md`, `implementation-log-through-0.10.0.md`, `implementation-log-through-0.9.4.md`, `implementation-log-through-2026-04-15.md`, `implementation-log-through-2026-04-12.md`.

## Fix: clarify worktree system prompt is Claude Code only (2026-04-22)

The settings UI described the worktree system prompt template as appended "to the agent's system prompt", but only the Claude adapter in `src/terminal/agent-session-adapters.ts` injects it via `--append-system-prompt`. The Codex adapter has no equivalent. Updated the description in `web-ui/src/components/settings/agent-section.tsx` to say "Claude Code's system prompt" so users know the scope.

Files touched: `web-ui/src/components/settings/agent-section.tsx`

## Docs cleanup and version bump to 0.11.0 (2026-04-22)

Archived 7 completed refactor docs to `docs/archive/`, rotated changelog and implementation log into their archive files, bumped version from 0.10.0 to 0.11.0, and updated `docs/README.md` cross-references.
