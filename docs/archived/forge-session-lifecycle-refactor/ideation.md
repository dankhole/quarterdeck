---
project: session-lifecycle-refactor
date: 2026-04-12
status: research
---

# Ideation: Session Lifecycle Refactor

## Goal

Decompose `TerminalSessionManager` (~1,186 lines) into focused, single-responsibility modules without changing any external behavior. The session manager currently conflates PTY process management, state machine transitions, summary CRUD, timer management, workspace trust, and Codex-specific quirks in one file. The refactor makes the code navigable and safer for future bug fixes.

## Behavioral Change Statement

> **BEFORE**: `session-manager.ts` is a ~1,186-line class mixing 7 responsibilities. Bug fixes require understanding the entire file. Side effects are scattered.
> **AFTER**: `TerminalSessionManager` is a thin coordinator (~250-300 lines) delegating to focused modules: enriched state machine, PTY process manager, session summary manager, timer manager. Same external behavior, same `TerminalSessionService` interface.
> **SCOPE**: `src/terminal/session-manager.ts` and its internal structure. No changes to external consumers (`hooks-api.ts`, `runtime-api.ts`, `workspace-registry.ts`, `shutdown-coordinator.ts`).

## Functional Verification Steps

1. **All existing tests pass unchanged** — `test/runtime/terminal/session-manager*.test.ts` and `session-reconciliation.test.ts` pass without modification.
2. **Agent lifecycle works** — Start a Claude task, let it run, see it transition to review, approve a permission prompt, see it resume. Cards move correctly.
3. **Process exit handling** — Kill an agent process. Task card transitions to error/review. Auto-restart works when viewer is connected.
4. **Interrupt recovery** — Press Ctrl+C/Escape on a running agent. Card transitions to awaiting_review after 5s.
5. **Workspace trust auto-confirm** — Start a Claude task in a worktree. Trust prompt auto-confirmed without user intervention.
6. **Codex prompt detection** — Start a Codex task, let it complete. Prompt `>` detected, card transitions correctly.
7. **Shell session lifecycle** — Start a shell session, type commands, exit. Clean lifecycle.
8. **Reconciliation sweep** — 10s sweep detects dead processes, processless sessions, stale hook activity.
9. **Notification sounds** — Correct beep plays on review, permission, failure, completion transitions.
10. **Regression: no new imports in external files** — `hooks-api.ts`, `runtime-api.ts`, `workspace-registry.ts`, `shutdown-coordinator.ts` should not need to change their imports.

## Scope

- IN: Internal decomposition of session-manager.ts, enriching session-state-machine.ts, new focused modules
- OUT: Bug fixes (patches A/B/C), hooks-api.ts changes, frontend changes, new features

## Constraints

- `TerminalSessionService` interface is the public contract — must not change
- `entries` Map stays on the coordinator (test fixtures depend on it)
- Existing tests pass without modification throughout all phases
- Git bisectable — each phase is one or two commits
