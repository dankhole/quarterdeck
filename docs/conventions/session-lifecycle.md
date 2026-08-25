# Session and Terminal Lifecycle

Read this document before changing task-agent startup, stop/resume/restart behavior, startup recovery, hook transitions, session reconciliation, PTY identity, terminal restore, agent adapters, or host-integration launch behavior.

## Ownership model

- Managed task lifecycle gestures enter the server-owned `ProjectTaskLifecycleService`. Do not recreate a browser resource coordinator or compose board persistence, stop/start, and worktree effects in React.
- The runtime composition root's `TaskResourceOperationCoordinator` serializes low-level task-resource effects across clients and UI remounts. Keep worktree-deletion guards against active or in-flight task sessions as defense in depth.
- `src/terminal/session-transition-controller.ts` owns process-side consequences of session state-machine events and active-listener summary fanout. Input, output, restart, recovery, and reconciliation code route `hook.to_review`, `hook.to_in_progress`, `process.exit`, `interrupt.recovery`, and `autorestart.denied` through that controller rather than adding transition side effects to `TerminalSessionManager`.
- A classified hook transition and its metadata are one session-store mutation. Carry metadata on `hook.to_review` and `hook.to_in_progress`, then apply state, review reason, activity, resume session ID, and timestamps through one `applySessionEvent(...)` emission. Splitting the transition from `applyHookMetadata(...)` lets project pills, notifications, and remote readers observe contradictory intermediate summaries.

Keep task-agent terminals and shell terminals separate even when they share xterm or panel plumbing:

- Task-agent terminals are task-scoped viewers for agent sessions and use the shared/pool path.
- Home and detail shell terminals are dedicated workspace-scoped manual shells with different lifecycle, restart, and exit rules.
- If an abstraction makes shell surfaces behave like task-agent terminals, split it instead of relying on comments or task-ID prefixes.

## Reconciliation

Before adding dynamic UI state tied to session lifecycle—status indicators, transient panels, or auto-triggered actions—check `src/terminal/session-reconciliation.ts` and give stale or orphaned instances a cleanup path. The periodic sweep currently owns dead processes, processless sessions, and stale hook metadata.

Reconciliation must stop and surface a live task whose `sessionLaunchPath` disappears so it cannot remain `running` after its agent rejects an invalid cwd.

Terminal output is not evidence that an agent is working. Claude Code and other TUIs emit spinners, status redraws, and ANSI cursor movement while idle or waiting. Do not use `lastOutputAt`, output presence, or output volume as a work-state heuristic. Native hook transitions, explicit responses to a known input wait, and carriage-return submissions that start a new turn from a live review-ready terminal are authoritative. Fix missed state at the hook or ordering layer.

## Stop, restore, and targeted resume

- Restore from Trash waits for the previous task session to finish exiting through `stopTaskSession(..., { waitForExit: true })` before resuming. A rapid untrash can otherwise call `TerminalSessionManager.startTaskSession()` while the old entry is active, short-circuit on it, and then lose the session when that old process exits.
- Request normalization preserves `waitForExit`. Stop results distinguish `exited` and `not_running` from `timed_out` and `failed`.
- Worktree cleanup, replacement start, and permanent card removal proceed only after a successful stop outcome.
- If an old PTY is still exiting when a start or resume arrives for the same task, fail explicitly and log it. Never silently reuse an old `running` or `awaiting_review` summary while `suppressAutoRestartOnExit` is set.
- Best-effort resume without a stored ID (`codex resume --last` or Claude `--continue`) is checkout-scoped and silent-failure prone. Adapters and the tRPC handler warn whenever they must use it.

Resume-failure fallback does not run after an explicit stop (`suppressAutoRestartOnExit` or auto-restart reason `suppressed`). Otherwise trashing a resumed task can start a fresh process, clear the stored resume ID, and force the real restore onto a best-effort target.

- Keep fresh-prompt fallback only for explicit resume flows that are not owned by automatic startup recovery.
- Do not use it for non-zero resume exits; preserve failed resume output in the terminal.
- Outside coordinator-owned recovery, a stored targeted resume that exits non-zero clears the stored ID so the next explicit restart may use the provider's best-effort path.
- Coordinator-owned recovery preserves the ID through its one exact retry, then clears it only if the final targeted launch also exits non-zero.

Claude resume prefers the stored hook `session_id` through `claude --resume <id>`, matching Codex's targeted model. Server-start resume may use `card.workingDirectory` while that worktree still exists. Trash clears that field and deletes the worktree before restore recreates it; without a stored Claude ID, untrash/restart falls back to cwd-scoped `--continue` and must warn.

## Startup recovery

`src/server/startup-session-recovery.ts` coordinates automatic startup recovery.

### Bootstrap and discovery

- Validate and hydrate every available indexed project before accepting clients, then queue eligible recovery in the background through the shared global coordinator.
- Startup discovery is read-only. Skip a temporarily unavailable path without deleting its index entry or saved board/session state; destructive pruning stays at the explicit project-stream reconciliation boundary.
- WebSocket connection, active-project selection, and GUI mount never trigger or gate recovery. Inactive project pills and notification snapshots need the same hydrated truth as the selected project.
- Wait for orphan-agent cleanup and prepare each task once through the shared task-start service.
- Serialize and space only actual launch operations globally. Let unrelated tasks wait for readiness concurrently so one hookless TUI cannot block the queue.

### Retry and identity

- Freeze the resolved agent, command, cwd, settings, and resume target. Reuse that exact preparation for one bounded retry after positive failures only.
- A launch-scoped native hook from the current `sessionInstanceId`, plus the expected stored session ID when one exists, confirms identity.
- A live process at the hook deadline is unconfirmed, not failed. Leave it available to the user rather than stopping or replaying it.
- Retry spawn failures, early exits, and identity mismatches. Stop and wait for the exact failed PTY before replacement, never start a third copy, and do not retry deterministic preparation failures.
- Explicit start, stop, or input cancels recovery ownership. Exhausted failures route through the terminal transition owner. Keep hook-receipt accounting separate from launch-hook admission.
- Failures in `resumeInterruptedSessions(...)` are warnings, not debug-only breadcrumbs. Logs distinguish failure to select an interrupted task from failure to start the selected task.

### Persisted meaning

Process recovery eligibility is separate from user-visible task meaning:

- A durable modern interrupted handoff represents previously Running work and returns to Running after process replacement.
- Valid Review, Needs Input, and Error semantics survive hydration and shutdown while stale PID ownership is cleared.
- Ineligible recovery policy results carry no launch semantic state. Only ambiguous legacy interrupted persistence remains neutral.
- Restoring a completed `hook` review never fabricates `attention`; only a structured question or permission signal creates Needs Input.
- A legacy `attention` record without that proof remains ineligible even with `startupRecoveryRequired: true`, and hydration clears the stale handoff so it is not persisted again.

## PTY and terminal restore identity

Task PTY exit callbacks bind to the exact spawned `PtySession`, not only the task ID. A delayed exit from an old wrapper or PTY must not finalize and clear a replacement session for the same task.

Terminal restore has several distinct races:

- If a new task session instance (`startedAt` / `pid`) appears before the first control-socket restore finishes, `web-ui/src/terminal/slot-socket-manager.ts` queues the follow-up `request_restore` and replays it from `markRestoreCompleted()`.
- The React-side `sessionStartedAt` reset in `usePersistentTerminalSession` can happen after the control socket already restored the replacement PTY. A pooled task reset immediately requests authoritative restore so the late xterm reset cannot leave a blank pane.
- Once the IO socket is open, a stalled control restore must not keep the loading overlay forever. `terminal-session-handle.ts` uses a readiness fallback for new and reused slots and for delayed IO-open events.
- Do not pair that fallback with speculative restore. A stale or empty snapshot can erase live output already written to xterm.
- When a live session instance changes (`startedAt` with non-null `pid`), drop and reopen pooled terminal sockets rather than queueing restore on an existing control socket; reused active slots can otherwise remain stuck at `restoreCompleted=false`. Do not reconnect for processless stop summaries (`pid: null`).
- Before treating a restore snapshot as empty, `TerminalViewport` drains queued writes; live output can be queued but not yet visible.

Terminal restore readiness is not browser presentation readiness. Do not clear loading or notify connection-ready subscribers until `TerminalViewport` drains queued writes, resizes, scrolls to bottom across layout frames, and reveals the host. The IO-open fallback uses the same settled reveal path. Claude sessions are especially sensitive to redraw and status output around restore.

## Hook and input semantics

### Shared rules

- Agent session-identity hooks are metadata-only. Persist `resumeSessionId` from Codex `session_meta` and Claude `SessionStart` without clobbering `latestHookActivity` or changing state twice.
- If resume identity and hook activity land together, use one store mutation such as `applyHookMetadata(...)`, not separate `update(...)` and `applyHookActivity(...)` calls. An already-known session ID remains a no-op for activity and broadcast purposes.
- Provider-neutral high-level input carries explicit submit intent into `TerminalSessionManager.writeInput(...)`. The input pipeline applies `user.responded` or `user.submitted`; browser-only updates and PTY-output inference are forbidden.
- Generic task-session input is a local PTY capability and is not part of the future Remote Companion gateway contract.

### Claude hooks

- Claude hook parity requires Claude Code 2.1.198 or newer because `agent_needs_input` is a documented notification type at that boundary.
- `Stop.last_assistant_message` supplies `finalMessage` and `conversationSummaryText`. Do not parse the lag-prone `transcript_path` file for this summary.
- A main-agent `Stop` is incomplete while `background_tasks` or `session_crons` is non-empty. Keep it activity-only, preserve stronger input or permission waits, suppress completion metadata, and wait for a later completed `Stop`.
- `SubagentStop` remains activity-only even when it includes `last_assistant_message`.
- `AskUserQuestion`, `ExitPlanMode`, and MCP `Elicitation` create attention/Needs Input waits. Only a matching `PostToolUse`, `ElicitationResult`, or real `UserPromptSubmit` returns them to Running; unrelated parallel events do not clear the wait.
- Bound native message/activity text before storage or broadcast. `PostCompact.compact_summary` describes compaction and never populates completed-turn summaries.

Claude fullscreen scrolling is application-owned rather than xterm scrollback. Fullscreen launches default `CLAUDE_CODE_SCROLL_SPEED` to `3` while preserving an explicit user override. Do not apply that default to classic Claude, Codex, Pi, or shell terminals.

### Codex hooks and launch arguments

- Quarterdeck-managed Codex hooks stay launch-scoped. Never write them to repo-local or user-global hook files.
- Pass hook config inline on the `codex` command line (`-c hooks...` plus `--enable hooks`). Generate matching `hooks.state` trust entries from the same config using `/<session-flags>/config.toml:<event_snake>:<groupIndex>:<handlerIndex>` source keys (`C:\<session-flags>\config.toml` on Windows). Never use `--dangerously-bypass-hook-trust`.
- Preserve the current minimum-version and feature gate. Only genuine user-input or approval waits surface as Needs Input.
- Codex permission approval can resume through `PostToolUse` without a separate resolved hook, so the permission guard permits the matching Codex transition back to Running.
- A carriage return while the shared indicator is `needsInput`, or from a live review-ready session, is authoritative submit intent. Route it through `SessionTransitionController`, atomically clear stale wait/review activity, and record submission ordering so an older delayed `PermissionRequest` cannot restore the wait. Editing, cursor movement, protocol responses, and PTY output are state-neutral.
- Codex dispatches root `Stop` and `SubagentStop` separately; install the review transition only for root `Stop` rather than inferring identity from missing summary fields.
- `SessionStart` stays metadata-only. Manual `/compact` uses its `PreCompact` / `PostCompact` pair matched only on `manual`; automatic compaction does not change task state. Do not infer `/resume`, plugin reload, or other TUI-local command state from typed text, prompt redraws, or terminal output.
- Prompt positionals require an explicit `--` after every option and config override. Keep launch-scoped global flags before `resume` or `fork`, and keep the prompt after the resume target and `--`; otherwise a prompt beginning with `-` can be parsed as a resume option during auto-restart.

A visible canonical Codex approval overlay never coexists with a Running task card. Native `PermissionRequest` is primary, but nested Code Mode tools may render approval without that hook. Preserve the Codex-only rendered-screen fallback: require an official approval title, selected choice, and bottom-anchored confirm/cancel footer after the terminal mirror applies output; accept supported narrow or clipped layouts without scanning accumulated transcript text. Route detection through `SessionTransitionController`, latch against redraws, reset after every authoritative transition to Running, and resolve the wait immediately on Enter confirmation or bare Escape cancellation.

## Agent and host process launch

Quarterdeck inherits the user's shell environment. Agent discovery and task-agent startup use direct PATH checks and direct process launches. Do not spawn `zsh -i`, use shell fallback discovery, or launch a shell and type the command on these hot paths; heavy `conda` or `nvm` initialization can freeze concurrent starts. Interactive shells remain appropriate for explicit shell terminals.

`IRuntimeHostIntegrations`, composed by `createRuntimeHostIntegrations`, is the sole production boundary for server-side file, application, URL, and folder-picker effects. Keep its launch-scoped `RuntimeCapabilities` check ahead of launcher discovery and return discriminated typed outcomes. Open Project sends only an allowlisted target ID; the runtime derives the scoped project path and owns executable and argument construction. Do not restore an arbitrary runtime-command route or browser command builder, and do not bypass the service from a handler.

On headless remote Linux, native pickers such as `zenity` or `kdialog` may be unavailable. Treat that as a supported runtime limitation and use manual path entry rather than requiring desktop packages.

## Related documents

- [Runtime state and board ownership](./runtime-state.md)
- [Task lifecycle reliability plan](../task-lifecycle-reliability-plan.md)
- [Agent functional testing](../agent-functional-testing.md)
- [Unified diagnostics contract](../diagnostics.md)
