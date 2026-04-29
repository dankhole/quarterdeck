# Codex Untrash Resume Handoff

This is a branch-context handoff for reviewing `fix/untrash-resume-logs-and-race`. It records what each fix is for, what to inspect, and which debugging paths were tried.

## Problem

Codex tasks could get into bad terminal/session states after trash/restore or server restart:

- Trash then untrash could show only a spinner or a blank terminal.
- Some restores briefly showed the Codex chat, then blanked.
- A late old Codex process exit could clear a newly spawned resume session.
- Startup resume could skip tasks that were visibly resumable by trash/untrash.
- Diagnostics were initially too sparse or at inconsistent log levels.

Claude did not reproduce the same way because its `--continue` path is cwd-scoped and often produced visible output, while Codex needs the stored root `resumeSessionId` to target the exact conversation.

## Current Fixes To Review

### Stale PTY Exit Guard

Files:

- `src/terminal/session-lifecycle.ts`
- `test/runtime/terminal/session-manager-ordering.test.ts`

The task `onExit` path now receives the concrete `PtySession` instance and verifies that the exiting PTY is still `entry.active.session` before mutating state or finalizing cleanup. This prevents a delayed old Codex wrapper exit from clearing the new resumed process.

Review focus:

- Confirm every task `onExit` caller passes the session instance.
- Confirm ignored stale exits do not leak terminal mirrors or listeners.
- Confirm shell-session exit handling is unaffected.

### Explicit-Stop Guard For Resume-Failure Fallback

Files:

- `src/terminal/session-lifecycle.ts`
- `test/runtime/terminal/session-manager-auto-restart.test.ts`

The resume-failure fallback still exists for startup resume, but it no longer runs after explicit stop/trash paths where auto-restart is suppressed. Without this guard, a stopped resumed Codex process could schedule a fresh non-resume Codex start and overwrite `resumeSessionId` with `null` before the real untrash resume arrived.

Review focus:

- The guard should be based on explicit stop suppression, not exit code.
- Clean `codex resume` / Claude `--continue` exits during startup may still need the fallback.
- The stored `resumeSessionId` must survive a trash stop.

### Startup Resume Selection And Diagnostics

Files:

- `src/server/project-registry.ts`
- `test/runtime/server/project-registry-startup-resume.test.ts`
- `test/integration/server-restart.integration.test.ts`

Startup resume now logs a scan summary and warns for real blockers: no terminal manager, failed state load, unresolved agent command, interrupted task missing `workingDirectory`, no resumable work-column sessions despite session records, and launch rejection.

The startup selector resumes:

- `interrupted` / `interrupted`
- `awaiting_review` / `attention` with a non-null persisted `pid`

The second case covers unclean server stops where disk still says "awaiting review for attention" even though the agent process was live when the server died. On the next boot that pid is stale, and trash/untrash proves the task is resumable if it has `workingDirectory` and `resumeSessionId`.

The selector still preserves completed review sessions such as `hook` and `exit`, and processless `attention` sessions.

Review focus:

- Make sure the stale-pid rule is narrow enough not to resume completed review tasks.
- Check whether `awaiting_review` / `stalled` should remain preserved.
- Confirm warnings are not too noisy at default `warn` level.

### Shutdown Persistence

Files:

- `src/server/shutdown-coordinator.ts`
- `test/integration/shutdown-coordinator.integration.test.ts`

Shutdown persistence now preserves summaries that `markInterruptedAndStopAll()` already mutated to `interrupted` / `interrupted`. Earlier logic could skip those already-interrupted in-memory summaries and leave disk stuck at the previous `awaiting_review` state.

Review focus:

- Managed running tasks should persist as interrupted.
- Idle tasks and tasks without session records should stay unchanged.
- Indexed unmanaged projects should still be handled conservatively.

### Terminal Restore Queueing And Reconnect

Files:

- `web-ui/src/terminal/slot-socket-manager.ts`
- `web-ui/src/terminal/terminal-attachment-controller.ts`
- `web-ui/src/terminal/terminal-session-handle.ts`
- `web-ui/src/terminal/terminal-reuse-manager.ts`
- related tests under `web-ui/src/terminal/`

Terminal slots can receive a new runtime session instance while the control socket is still waiting for an initial restore. The branch now:

- queues `request_restore` until initial restore completion,
- reconnects IO/control sockets when the live session instance changes,
- only reconnects for non-null `pid` summaries, avoiding extra flashes for processless stop summaries,
- reveals the terminal after a short readiness fallback if IO is open but restore completion stalls.

Review focus:

- Stale control sockets should not be reused after `startedAt` / `pid` changes.
- Processless stop summaries should not trigger reconnects.
- The readiness fallback should reveal input, not request speculative restore.

### Empty Restore Guard

Files:

- `web-ui/src/terminal/terminal-viewport.ts`
- `web-ui/src/terminal/terminal-restore-policy.ts`
- `web-ui/src/terminal/terminal-restore-policy.test.ts`

Live output can hit the write queue before a delayed empty restore snapshot arrives. `TerminalViewport.applyRestoreSnapshot(...)` now drains queued writes and skips an empty restore over a non-empty visible buffer.

Review focus:

- The guard should only skip empty snapshots over visible content.
- Non-empty snapshots should still restore normally.
- Draining queued writes before checking the buffer is important.

### Logging Policy

Files:

- `src/server/project-registry.ts`
- `src/terminal/session-lifecycle.ts`
- `src/commands/codex-wrapper.ts`
- `src/commands/codex-session-parser.ts`
- `src/commands/codex-rollout-parser.ts`
- browser-side client log call sites for untrash/task-session traces

Default log level remains `warn`. Routine breadcrumbs are `debug`, scan/launch breadcrumbs are `info`, and user-visible degradation paths are `warn`. Temporary raw `process.stderr.write(...)` traces in Codex wrapper/parser code were removed so debugging output does not pollute the visible agent terminal stream.

Useful debug filters:

- `project-registry`
- `task-session-start`
- `task-session-stop`
- `session-mgr`
- `agent-launch`
- `hooks`
- `session-store`
- `untrash`
- `task-session`
- `terminal-session-handle`
- `slot-socket`
- `terminal-viewport`
- `terminal-pool`
- `terminal-panels`

## Review Checklist

- Trash/untrash a Codex task with a stored `resumeSessionId`; it should use `codex resume <id>`, not `--last`.
- Trash/untrash should not clear `resumeSessionId` during the stop phase.
- If the terminal restore stalls, IO-open fallback should reveal an interactive terminal.
- A delayed empty restore must not blank already-visible Codex output.
- Server startup should resume stale live Codex review sessions if persisted as `awaiting_review` / `attention` with a pid.
- Completed review sessions (`hook` / `exit`) should not be restarted on server startup.
- Claude behavior should remain best-effort; untrash after deleting the original worktree is not equivalent to startup resume.

## Debug History And Failed Paths

- Initial assumption was missing info logging. Logging was real but not enough; the important logs were at debug/warn boundaries and several startup paths returned silently.
- Adding stored Codex `resumeSessionId` made Codex resume target the right conversation, but untrash still failed when later code cleared that id.
- The first untrash race was an old PTY exit arriving after the new resume started. Fixed by checking the concrete `PtySession` on exit.
- The next race was the stopped resume process scheduling the resume-failure fallback. That started a fresh non-resume Codex process and cleared `resumeSessionId`. Fixed by suppressing that fallback after explicit stops.
- A too-broad fallback guard briefly broke startup resume because clean `codex resume` exits can still need a fresh review prompt. The guard was narrowed to explicit stops only.
- A terminal readiness fallback first helped with spinners, but speculative restore requests could blank live output. The fallback now reveals the terminal without requesting restore.
- A reused pooled slot then showed `queued restore request until initial restore completes`; the old control socket was stuck with `restoreCompleted=false`. Live session-instance changes now reconnect sockets instead of queueing behind stale state.
- Reconnecting on processless stop summaries caused extra flashing before the real replacement process. Reconnects are now limited to live summaries with a non-null pid.
- The latest startup log showed work-column sessions with `awaiting_review` / `attention`, `workingDirectory`, and `resumeSessionId`, but not `interrupted`. That likely represents unclean server exit or stale disk state; startup now treats that stale-pid shape as resumable while preserving completed review reasons.
