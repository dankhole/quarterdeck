# Runtime State and Board Ownership

Read this document before changing board persistence, lifecycle board transitions, runtime-owned board metadata, authoritative project hydration, project-scoped browser projections, notifications, task indicators, or automatic task titles.

The browser is an optimistic client. The runtime owns durable board state, session truth, and the projections that connect them.

## Durable board authority

- `ProjectBoardCommandService` is the only production authority that writes durable board state. Browser clients are optimistic views: `setBoard` derives and submits ordinary typed command batches, while lifecycle gestures use the explicitly presentation-only `presentLifecycleBoard` plus `ProjectTaskLifecycleService.execute(...)`.
- `setBoard` must reject lifecycle-managed commands instead of displaying an optimistic transition it will not submit. Non-browser callers use the command or lifecycle service with typed intent; they never accept `BoardData`, reuse `setBoard`, reuse the presentation adapter, expose a whole-board save route, or let a client payload replace `board.json`.
- Runtime session truth comes from the server-owned terminal/session store, never browser payloads or cached board restore data. Low-level `saveProjectState` remains for migrations, isolated tests, and controlled maintenance only. Tests that seed state directly must target the isolated runtime state root through `QUARTERDECK_STATE_HOME`, not a browser API.

## Command receipts and lifecycle effects

- Board-command receipt metadata is server-owned and bounded. Check a repeated command ID and payload fingerprint before expected-revision rejection so a retry after a lost response works across runtime restarts. Reject reuse of the same ID with different content.
- A first-seen accepted command, including a semantic no-op, consumes one revision so its receipt and ordering are durable.
- Receipts retain whether the originally accepted command changed the board. Lifecycle orchestration must use that recorded result, source-column preconditions, and authoritative session state before running a post-commit process effect; `replayed` alone is insufficient.
- Coalesce same-process duplicate create/start calls, never blindly relaunch after a persisted move, and recover an interrupted pre-launch move to Backlog without deleting worktree or branch state.
- Board-changing lifecycle effects wait for the optimistic command queue to flush before starting or stopping a task session, creating or restoring a worktree, or deleting a worktree. Otherwise the effect can observe the old durable card or outlive a rejected optimistic move.

### Create and start

Fresh explicit Start has a bounded initial Running phase after process ownership handoff. Shared indicators recognize the exact launch-scoped `initialWorkConfirmation` marker; it is separate from native work evidence and invalidated on cold hydration. The session transition controller owns confirmation and expiry (see the [session lifecycle rules](session-lifecycle.md#reconciliation)).

Lifecycle `create_and_start` tolerates bounded bursts of unrelated revision advances from runtime-owned title, session, branch, or worktree projections:

1. Rebase the additive `create_task` step only after proving the stable task ID is still absent.
2. Rebase the following move only while that exact task identity remains in Backlog.
3. Re-evaluate both guards before every bounded retry.
4. If the identity appeared concurrently, its source-column precondition changed, or the retry budget was exhausted, retain the latest revision conflict and run no process or worktree effect.

This makes sequential bulk starts resilient without weakening identity protection or adding browser retries.

### Trash and linked tasks

A Trash transition that unblocks linked Backlog tasks journals the linked-task plan and deterministic child operation IDs before moving the parent. The move consumes the exact revision from which the plan was derived; canonical dependency cleanup after the move intentionally removes the evidence needed to rediscover those children.

Clear Trash captures the originating project, initial revision, and exact task IDs/creation times before awaiting the board-command flush. It sends one typed request to `ProjectTaskLifecycleService.clearTrash`, which runs four bounded workers through the existing per-task lifecycle service and returns compact outcomes plus one final authoritative state. Each child has a deterministic operation ID; a lost response can retry the same request once. Navigation must not retarget the revision, stop the remaining work, or apply the response to another project. Progress and completion use one aggregate toast. Failed identities remain protected by normal Trash/source-column guards; if a deleted task's old receipt has already been pruned, report deletion as unconfirmed rather than repeating destructive effects or claiming confirmed success.

## Runtime-owned projections

- Runtime-owned session, generated-title, branch/base-ref, and worktree metadata projections go through the same command service and internal mutation lock before the newer board is published.
- `RuntimeSessionPersistence` independently subscribes to terminal-store changes, projects sessions through `ProjectBoardCommandService`, retains dirty generations across an in-flight write, retries failures with bounded backoff, and flushes during orderly shutdown. Hook ingestion and startup replay await its explicit generation barriers before acknowledging durability. The composition root owns its tracking, project disposal, and shutdown separately from `RuntimeStateHub`; changing or closing the WebSocket transport must not own persistence correctness. Do not move that projection into browser effects or treat a logged persistence failure as success.
- Incremental browser session updates require the originating project ID at `useTaskSessions.upsertSession(projectId, summary)`. Reject other-project responses before merging or warning, including queued updates; terminal subscriptions must retain their own project ID when forwarding through the latest callback. Task IDs alone are not project identity (home shells share an ID).
- The browser Git/worktree metadata read model is project-scoped even though task metadata is indexed by task ID. Change its scope before paint during navigation, and pass the originating project ID into async writes so late results cannot attach to the next project.

The behind-base labels show independent local and remote counts of commits reachable from each comparison ref but absent from task `HEAD` (`HEAD..ref`). A local base branch compares with `refs/heads/<base>` and `refs/remotes/origin/<base>`; an explicit remote base compares with that remote branch and its matching local branch. Always display both counts, including zero. Missing refs and failed comparisons remain unavailable, never fabricated zero. Do not combine the counts or count from a single merge base: divergent refs and multiple merge bases can report different missing commits. The metadata cache and browser equality checks observe both refs and counts so local-only commits, tracking-ref creation, and remote advances refresh independently without HEAD moving.

### Authoritative browser hydration

`applyAuthoritativeProjectState(...)` in `web-ui/src/hooks/project/project-sync.ts` is the single browser-side entry point for authoritative project state. Do not split this pipeline across `use-project-sync.ts` or nearby code:

- reconcile authoritative sessions against the latest local session state;
- treat the runtime board as authoritative, with pending local command batches overlaid only for optimistic presentation;
- allow a command response or conflict refresh to force exact authoritative hydration even at a revision the browser already displayed; and
- keep hydration flags, cache updates, queue revision re-entry, and optimistic overlay in this one apply path.

## Automatic task titles

Initial title generation is triggered by the board command service's post-commit `untitled_task_created` effect. This is the only automatic model-call trigger. Codex tasks use a local placeholder instead of a model call, then follow native Codex thread names. Completing a turn never requests another generated title; follow-up generation requires the user's explicit Auto-generate title action.

- Keep initial scheduling in `src/server/automatic-task-title-scheduler.ts` with the per-project/task coordinator. Do not subscribe title generation to lifecycle or review-ready events.
- `src/server/task-title-service.ts` owns explicit regeneration with bounded provider-history reads and persistence. Recent user/assistant turns inform the overall thread purpose; the opening prompt is brief background. Use the existing conversation reader (24 messages maximum), then bound title context to 6,000 characters. Do not add another transcript store or summarization call. Missing history can use completed-turn summaries or the initial request.
- Initial and follow-up prompts request 2–4 words, preferably 2–3, using recognizable subject/purpose labels such as “UI Work” or “Kafka Investigation” while retaining useful distinguishing subjects. Avoid first-step titles, subtask lists, and incidental completion details. Explicit regeneration uses the conversation's current direction and shortens existing titles that exceed the requested length.
- `src/server/codex-task-title-monitor.ts` follows native Codex name changes through the launch profile’s `session_index.jsonl`; a separate app-server connection is not subscribed to TUI notifications. Poll only exact live Codex session identities, with bounded read-only metadata reads, no provider launch or transcript reads, and shutdown fencing. Missing metadata keeps the placeholder. Never overwrite manually named or named legacy cards.
- `titleAutoGenerated` is server-owned provenance; for native Codex tasks it also permits continued synchronization with provider names. Initial/generated titles set it to true; explicit title edits set it to false, including a same-wording rename. Clients cannot supply provenance through board commands. Other providers’ titles stay unchanged unless explicitly edited or regenerated. Explicit regeneration remains available; later Codex name changes may replace a generated title.
- Persist through `ProjectBoardCommandService.setGeneratedTaskTitle(...)`. Lock-held task creation time, expected title/provenance, and current-session guards reject replaced tasks, concurrent manual renames, and results from replaced sessions. Identical generated titles do not advance board state.
- Keep the local fallback for initial titles. A failed follow-up keeps the existing title. Luna remains at `none` reasoning; changing the context and instructions showed more benefit than increasing reasoning in the bounded comparison.


## Stream and notification identity

Browser runtime-stream identity has three separate fences:

1. Connection generation rejects events queued by a superseded WebSocket.
2. Project identity rejects active-project state and metadata at one reducer boundary.
3. Per-project notification revision orders cross-project notification snapshots and deltas.

Preserve `projectId` through wire decoding instead of duplicating scope checks in message handlers. Counts from an exact project-state revision may outrank a same-revision project-list summary, but unproven list counts remain replaceable so transient fallbacks can self-heal.

Any browser notification map spanning projects keys task identity by `projectId` plus `taskId`; task IDs are board-local and can collide across projects. Preserve the original task ID separately for sounds and user-facing actions.

Notification ownership is intentionally split:

- `web-ui/src/runtime/runtime-state-stream-store.ts` keeps cross-project notification state bucketed by project rather than as one flat task map plus a task-to-project lookup.
- UI consumers read the provider-owned projection (`needsInputByProject` and current/other-project Needs Input flags) rather than re-deriving ownership from raw buckets.
- `use-audible-notifications` may flatten project buckets into task entries because sound transitions are cross-project and event-oriented.
- Audible detection follows semantic notification edges, not only active/stopped column changes. A stopped Review card can become approval-required without crossing columns; that higher-priority transition emits one sound, while retained initial state and unchanged metadata remain silent.
- Board columns and project navigation pills answer different questions. A blocked task remains physically in Review, but navigation attention categories are exclusive: Needs Input overrides Review. Three Review-column cards with one blocked task display `R 2 · NI 1`; one blocked Review card displays only `NI 1`.

## Task indicator semantics

Use `deriveTaskIndicatorState(summary)` from `src/core/api/task-indicators.ts` / `@runtime-contract` for every user-visible task classification. `isPermissionActivity(...)` exists only for bounded legacy metadata cleanup; activity text is not task-state authority.

Do not reinterpret `reviewReason`, `latestHookActivity.notificationType`, `hookEventName`, or `"Waiting for approval"` directly in components or hooks. Project badges, status badges, audible notifications, and approval-blocking behavior flow from the shared semantic layer.

The canonical persisted/runtime lifecycle has only three top-level values: `idle`, `running`, and `awaiting_review`. The shared classifier exposes the five public outcomes clients need: `none`, `running`, `review`, `needs_input`, and `error`. `failed` and `interrupted` remain input-only persistence migrations and normalize to Review with `error` or `interrupted` detail before entering the runtime domain. A component, transport, startup path, or notification hook must never add another state table.

Native Codex/Claude/Pi Running requires matching `nativeWorkEvidence` issued only by `SessionTransitionController` for the exact current launch. The first authoritative foreground-start or work hook admits Running immediately, and Running persists until a typed completion, interaction, interruption, process exit, replacement, or recovery event ends or suspends that execution. Hook silence has no lifecycle meaning; a PTY PID, output, browser input, submit intent, process replacement, and persisted evidence from a previous runtime are never sufficient. Shell terminals are manual process surfaces and do not use this task-agent evidence contract.

`RuntimeTaskSessionSummary.outstandingInteraction` is the durable provider-interaction authority. `waiting` means the provider currently requires action; `response_submitted` means input reached the exact local PTY but provider resumption is not yet proven; `resolution_unknown` means the process or recovery path ended before the outcome could be established. These statuses remain nested under Review rather than overloading Running or `reviewReason`. The runtime state hub derives notifications, project refreshes, and ready-for-review events from the shared semantic result; transports must not reclassify raw hook names. A coalesced ready event is emitted only if the delivered summary is still review-ready.

## Task path terminology

Task identity has three distinct path concepts:

- project root: `projectPath` in project-level state and providers;
- assigned task identity: `taskWorktreeInfo.path` or the task metadata snapshot path; and
- session launch path: `RuntimeTaskSessionSummary.sessionLaunchPath`.

`sessionLaunchPath` is not a live cwd stream. It records where the current agent session launched. Persisted-state loading alone owns the one-time rewrite from legacy `projectPath` fields in old `sessions.json` files. Use `sessionLaunchPath` for divergence and restart hints, not as the authoritative task branch, folder, or shared-versus-isolated display source.

## Related documents

- [Testing strategy](../testing.md)
- [Architecture overview](../architecture.md)
- [Session and terminal lifecycle](./session-lifecycle.md)
- [Architecture guardrails](./architecture-guardrails.md)

## Validation

Start with focused command, reducer, classifier, stream, or projection tests for the owner being changed. Add the relevant integration boundary for persistence, revision receipts, startup, or shutdown. Use deterministic Agent Lab only when browser-visible convergence across cards, project pills, notifications, sounds, or a cold runtime restart is part of the invariant. Follow [the testing strategy](../testing.md) instead of running every projection and lifecycle scenario by default.
