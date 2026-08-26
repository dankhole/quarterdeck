# Session and Terminal Lifecycle

Read this document before changing task-agent startup, stop/resume/restart behavior, startup recovery, hook transitions, session reconciliation, PTY identity, terminal restore, agent adapters, or host-integration launch behavior.

## Ownership model

- Managed task lifecycle gestures enter the server-owned `ProjectTaskLifecycleService`. Do not recreate a browser resource coordinator or compose board persistence, stop/start, and worktree effects in React.
- The runtime composition root's `TaskResourceOperationCoordinator` serializes low-level task-resource effects across clients and UI remounts. Keep worktree-deletion guards against active or in-flight task sessions as defense in depth.
- `src/terminal/session-transition-controller.ts` owns process-side consequences of session state-machine events and active-listener summary fanout. Input, output, restart, recovery, and reconciliation code route raw `provider.hook`, `interaction.response_submitted`, `process.exit`, `interrupt.recovery`, and recovery-failure events through that controller rather than adding transition tables or side effects to `TerminalSessionManager`.
- The controller is the sole author of live native-work confirmation and its bounded `nativeWorkEvidence` lease; callers cannot assert either. A raw provider event and its metadata are one session-store mutation through `applySessionEvent(...)`, which atomically applies state, review reason, outstanding interaction, work evidence, activity, resume identity, and timestamps. Do not restore compatibility methods with separate replay or error semantics.

Keep task-agent terminals and shell terminals separate even when they share xterm or panel plumbing:

- Task-agent terminals are task-scoped viewers for agent sessions and use the shared/pool path.
- Home and detail shell terminals are dedicated workspace-scoped manual shells with different lifecycle, restart, and exit rules.
- If an abstraction makes shell surfaces behave like task-agent terminals, split it instead of relying on comments or task-ID prefixes.

## Reconciliation

Before adding dynamic UI state tied to session lifecycle—status indicators, transient panels, or auto-triggered actions—check `src/terminal/session-reconciliation.ts` and give stale or orphaned instances a cleanup path. The periodic sweep currently owns dead processes, processless sessions, and stale hook metadata. It is a terminal safety net: routine provider input, completion, exit, and replacement sequences must converge through their normal controller events. A processless unresolved interaction becomes explicit `resolution_unknown`; reconciliation must never silently invent Running or clear a real wait.

Reconciliation must stop and surface a live task whose `sessionLaunchPath` disappears so it cannot remain `running` after its agent rejects an invalid cwd.

Terminal output and keyboard submission are not evidence that an agent is working. Claude Code and Codex emit spinners, status redraws, ANSI cursor movement, and Enter-confirmed local actions while idle or waiting. Do not use `lastOutputAt`, output presence, output volume, or submit intent as a work-state heuristic. Only a current launch-scoped native provider hook is authoritative evidence that work resumed. Fix missed state at the hook or ordering layer.

Spawning a fresh, resumed, or replacement native PTY proves only that its input surface exists. Seed it as Review/Unconfirmed (or preserve the stronger durable Review/interaction meaning being restored), never Running. A current working hook establishes Running for at most five minutes; another accepted working hook refreshes that lease. Expiry returns the task to quiet Review/Unconfirmed, and cold hydration invalidates the previous runtime's evidence before startup recovery. This intentionally prefers a conservative false Review over false Running.

Escape and Ctrl-C synchronously apply Review/Interrupted before their bounded process-exit recovery bookkeeping begins. The later timer retires the interrupt fence; it does not own a delayed visible transition. A current post-interrupt working hook may establish Running again, and a current completion hook may converge directly to ordinary Review.

A provider-specific rendered failure may conservatively remove Running only when the supported native hook surface has no equivalent event and the detector requires the complete actionable viewport state, not transcript chunks. Codex's complete "Conversation interrupted" result as the immediate nonblank result above its newest input prompt is the bounded example; the same text above newer transcript or work status is historical and inert. That exact current-launch result may also retire the current foreground Codex permission when it is still `waiting` or `response_submitted`, including after exact-session startup recovery, because the provider has visibly ended the turn and returned to its composer. It cannot rewrite ordinary Review, another provider's interaction, or a background interaction. This compatibility evidence moves the task to interrupted Review; it can never assert Running, and a current launch-scoped provider hook is still required to return the task to Running.

## Stop, restore, and targeted resume

- Restore from Trash waits for the previous task session to finish exiting through `stopTaskSession(..., { waitForExit: true })` before resuming. A rapid untrash can otherwise call `TerminalSessionManager.startTaskSession()` while the old entry is active, short-circuit on it, and then lose the session when that old process exits.
- Request normalization preserves `waitForExit`. Stop results distinguish `exited` and `not_running` from `timed_out` and `failed`.
- Worktree cleanup, replacement start, and permanent card removal proceed only after a successful stop outcome.
- If an old PTY is still exiting when a start or resume arrives for the same task, fail explicitly and log it. Never silently reuse an old `running` or `awaiting_review` summary while `suppressAutoRestartOnExit` is set.
- Best-effort resume without a stored ID (`codex resume --last` or Claude `--continue`) is checkout-scoped and silent-failure prone. Adapters and the tRPC handler warn whenever they must use it.

Automatic crash and startup recovery require the exact stored provider session ID. A failed targeted resume becomes explicit Review/Error and never replays the original prompt in a fresh conversation. Explicit stops suppress restart before signalling the PTY. Outside coordinator-owned recovery, a final non-zero targeted resume may clear the unusable stored ID so a later explicit user Restart can choose the documented best-effort provider path; the automatic path itself never does.

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

- A durable modern interrupted handoff represents previously Running work, but process replacement alone leaves it Interrupted. Only a current launch-scoped native working hook may return it to Running; a current completion hook may take it directly to ordinary Review.
- Valid Review, Needs Input, and Error semantics survive hydration and shutdown while stale PID ownership is cleared.
- Persisted native work evidence never survives runtime ownership replacement. Previously Running work hydrates as Review/Interrupted with a durable recovery handoff until the replacement emits current provider evidence.
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
- Raw native hooks enter through `hooks.ingest`, provider-specific delivery ordering, `TerminalSessionManager.applyProviderHook(...)`, the transition controller, and the pure reducer. Deduplicate delivery IDs; fence session instances; retain Codex turn/tool ordering and Claude prompt/tool ordering separately; and fail closed on missing or ambiguous correlation. Reliable ingest acknowledges only after the semantic mutation plus its bounded content-free ordering receipt are durable. Hydration rebuilds the provider-specific ordering guard from those receipts before replaying the outbox; it must not replace an unreadable session store with empty state.
- Provider-neutral high-level input carries explicit submit intent into `TerminalSessionManager.writeInput(...)` for byte handling and ordering. When a durable interaction is genuinely `waiting`, a successfully written submit, Ctrl-C, or bare Escape changes only the nested status to `response_submitted`; the top-level task remains Review and stops advertising Needs Input. `UserPromptSubmit`, an exactly matched `PostToolUse`/`PostToolUseFailure`/`ElicitationResult`, or a later identity-bearing `PreToolUse` establishes resumed work. A current root `Stop` establishes Review even when the retired wait lacks exact interaction identity. A demonstrably newer foreground turn/prompt may supersede an obsolete wait, but same-turn parallel activity, a different tool's delayed completion, generic activity, notifications, and background-agent hooks are not proof of resumed work.
- Generic task-session input is a local PTY capability and is not part of the future Remote Companion gateway contract.
- Interrupt recovery and an explicit PTY stop can both surface as `awaiting_review/interrupted`, but they are not the same process state. A pending bare Ctrl-C/Escape recovery signal owns an immediate PTY exit even when the process reports code 0; persist Interrupted and suppress auto-restart instead of inferring completion from the exit code. Only an accepted current provider hook carrying that exact PTY's `sessionInstanceId` and a delivery time after the latest interrupt, while `PtySession.wasInterrupted()` is false, may advance or complete the review. Either proof cancels the interrupt timer and clears its one-shot auto-restart suppression. Once an explicit stop marks the PTY interrupted, reject further input and provider evidence until a replacement session starts.

### Claude hooks

- Preserve the tested Claude Code 2.1.198 minimum-version compatibility gate for the installed native hook schema. Do not use global Agent View notifications as evidence for a Quarterdeck task session.
- `Stop.last_assistant_message` supplies `finalMessage` and `conversationSummaryText`. Do not parse the lag-prone `transcript_path` file for this summary.
- A main-agent `Stop` is incomplete while `background_tasks` or `session_crons` is non-empty. Keep it activity-only, preserve stronger input or permission waits, suppress completion metadata, and wait for a later completed `Stop`.
- `SubagentStop` remains activity-only even when it includes `last_assistant_message`.
- A Claude hook carrying `agent_id` belongs to a subagent. It may participate in provider diagnostics, but it cannot change foreground task state, cancel foreground interrupt recovery, replace `latestHookActivity`, or supply the task's completion/display summary. The current single `outstandingInteraction` record intentionally does not pretend to model concurrent background-agent waits.
- Reliable `PreToolUse` supplies tool identity for `PermissionRequest`, `AskUserQuestion`, and `ExitPlanMode`; a delayed predecessor may enrich the same wait but cannot claim resumed work. `AskUserQuestion`, `ExitPlanMode`, and MCP `Elicitation` create typed Needs Input waits. Claude `Notification` hooks—including `permission_prompt`, elicitation UI notifications, and legacy background-agent notification types—are presentation-only: they carry human-facing notification text, may duplicate native lifecycle events, and do not provide the exact actionable interaction identity needed to author foreground state. Matching native resolution, later post-response work, a demonstrably newer foreground prompt, or a current completed root `Stop` clears a durable wait; same-prompt parallel events do not.
- Claude `PermissionDenied` is an automatic permission-mode event with `tool_use_id`; correlate it by that exact ID and mark the response pending. Manual denial emits no equivalent hook, so local submit remains pending until later work or Stop evidence. Never simulate a provider hook the real provider does not emit.
- Bound native message/activity text before storage or broadcast. `PostCompact.compact_summary` describes compaction and never populates completed-turn summaries.

Claude fullscreen scrolling is application-owned rather than xterm scrollback. Fullscreen launches default `CLAUDE_CODE_SCROLL_SPEED` to `3` while preserving an explicit user override. Do not apply that default to classic Claude, Codex, Pi, or shell terminals.

### Codex hooks and launch arguments

- Quarterdeck-managed Codex hooks stay launch-scoped. Never write them to repo-local or user-global hook files.
- Pass hook config inline on the `codex` command line (`-c hooks...` plus `--enable hooks`). Generate matching `hooks.state` trust entries from the same config using `/<session-flags>/config.toml:<event_snake>:<groupIndex>:<handlerIndex>` source keys (`C:\<session-flags>\config.toml` on Windows). Never use `--dangerously-bypass-hook-trust`.
- Preserve the current minimum-version and feature gate. Only genuine user-input or approval waits surface as Needs Input.
- Codex permission approval can resume through `PostToolUse` without a separate resolved hook. Because native `PermissionRequest` may omit `tool_use_id`, bind it to exactly one preceding open `PreToolUse` from the same launch and turn, persist that exact identity on the interaction, and accept only its matching completion. This resolves user- or provider-approved waits without inventing local input; same-turn parallel or ambiguous tools fail closed. If exact approval resolution is absent, a strictly later current-launch `UserPromptSubmit` or identity-bearing hook from a different foreground turn may retire the obsolete wait.
- Codex approval cancellation can render the complete current "Conversation interrupted" result and return to the composer without emitting `PostToolUse` or `Stop`. That bounded current-screen evidence retires the exact foreground permission into interrupted Review whether the local response was recorded or the wait was restored across a runtime restart. It is terminal negative evidence only; output never establishes Running.
- Codex emits `PermissionRequest` before routing the decision and does not expose the effective reviewer in the native hook payload. For an exact Quarterdeck launch configured with `auto_review`, retain that hook only as ordering/correlation evidence; it is not proof that a person must answer. If auto-review delegates an exceptional request to the user, the narrow rendered approval detector creates the actionable wait. `inherit` and `user` launches continue to treat native `PermissionRequest` as actionable because Quarterdeck cannot safely infer the user's external Codex configuration.
- A carriage return while the shared indicator is `needsInput` records submit ordering so an older delayed `PermissionRequest` cannot restore the wait. Codex's exact single-byte `y` and numbered approval-row shortcuts are also submissions only while the current foreground interaction is a waiting Codex permission; the TUI consumes those hotkeys without Enter. These paths change only the typed interaction status, never Running: Enter can accept `/model`, compaction, an approval choice, or another TUI-local action. Input from ordinary Review, questions, editing, cursor movement, protocol responses, other providers, and PTY output remain semantically neutral.
- Codex dispatches root `Stop` and `SubagentStop` separately; install the review transition only for root `Stop` rather than inferring identity from missing summary fields.
- `SessionStart` stays metadata-only. Manual `/compact` uses its `PreCompact` / `PostCompact` pair matched only on `manual`, and both hooks are activity-only; automatic compaction does not change task state either. Do not infer `/resume`, plugin reload, or other TUI-local command state from typed text, prompt redraws, or terminal output.
- Prompt positionals require an explicit `--` after every option and config override. Keep launch-scoped global flags before `resume` or `fork`, and keep the prompt after the resume target and `--`; otherwise a prompt beginning with `-` can be parsed as a resume option during auto-restart.

A visible canonical Codex approval overlay never coexists with a Running task card. Native `PermissionRequest` is primary, but nested Code Mode tools may render approval without that hook. Preserve the Codex-only rendered-screen fallback: require an official approval title, selected choice, and bottom-anchored confirm/cancel footer after the terminal mirror applies output; accept supported narrow or clipped layouts without scanning accumulated transcript text. Route detection through `SessionTransitionController`, latch against redraws, and reset after every authoritative provider transition to Running. Enter confirmation, the overlay's exact `y` or numbered approval-row hotkey, or bare Escape cancellation moves the typed wait to response-pending; it cannot claim Running before native completion or later causal foreground-work evidence, and process loss becomes `resolution_unknown` instead of leaving Needs Input forever.

### Pi lifecycle extension and approvals

- Quarterdeck-managed Pi sessions always load the launch-scoped lifecycle extension. It owns project trust, exact session/run/tool identity, lifecycle delivery, and managed-session replacement guards; disabling tool approvals must never disable or omit the extension.
- `piToolApprovalsEnabled` defaults on and applies only to new or restarted sessions. When enabled, bypass approval only for genuine Pi built-in read, grep, find, and ls tools. Effectful, overridden, or unknown tools require an exact keyed interaction.
- When the setting is off, allow ordinary Pi tool calls without a Quarterdeck confirmation while preserving project trust and all lifecycle/recovery hooks. Pass this policy through the server-owned launch environment; do not accept a browser-supplied environment override.
- Project trust remains a once-per-launch confirmation in both modes because project resources and extensions may execute code before ordinary tool calls begin.

## Agent and host process launch

Quarterdeck inherits the user's shell environment. Agent discovery and task-agent startup use direct PATH checks and direct process launches. Do not spawn `zsh -i`, use shell fallback discovery, or launch a shell and type the command on these hot paths; heavy `conda` or `nvm` initialization can freeze concurrent starts. Interactive shells remain appropriate for explicit shell terminals.

`IRuntimeHostIntegrations`, composed by `createRuntimeHostIntegrations`, is the sole production boundary for server-side file, application, URL, and folder-picker effects. Keep its launch-scoped `RuntimeCapabilities` check ahead of launcher discovery and return discriminated typed outcomes. Open Project sends only an allowlisted target ID; the runtime derives the scoped project path and owns executable and argument construction. Do not restore an arbitrary runtime-command route or browser command builder, and do not bypass the service from a handler.

On headless remote Linux, native pickers such as `zenity` or `kdialog` may be unavailable. Treat that as a supported runtime limitation and use manual path entry rather than requiring desktop packages.

## Related documents

- [Testing strategy](../testing.md)
- [Runtime state and board ownership](./runtime-state.md)
- [Task lifecycle reliability plan](../task-lifecycle-reliability-plan.md)
- [Agent functional testing](../agent-functional-testing.md)
- [Unified diagnostics contract](../diagnostics.md)

## Validation

Start with focused state-machine, transition-controller, manager, adapter, or hook-ingest tests. Add a process/filesystem integration test for startup, shutdown, exact resume, or recovery behavior. Use deterministic Agent Lab only for browser/PTY convergence or cold runtime hydration; use an explicitly authorized real provider only when its actual TUI, native hook sequence, version compatibility, or launcher interpretation is the unresolved risk. Follow [the testing strategy](../testing.md) and do not substitute terminal output or screenshots for authoritative lifecycle assertions.
