# Runtime State and Board Ownership

Read this document before changing board persistence, lifecycle board transitions, runtime-owned board metadata, authoritative project hydration, project-scoped browser projections, notifications, task indicators, or automatic task titles.

The browser is an optimistic client. The runtime owns durable board state, session truth, and the projections that connect them.

## Durable board authority

- `ProjectBoardCommandService` is the only production authority that writes durable board state. Browser clients are optimistic views: `setBoard` derives and submits ordinary typed command batches, while lifecycle gestures use the explicitly presentation-only `presentLifecycleBoard` plus `ProjectTaskLifecycleService.execute(...)`.
- `setBoard` must reject lifecycle-managed commands instead of displaying an optimistic transition it will not submit. Future remote or mobile services call the command or lifecycle service with typed intent; they never accept `BoardData`, reuse `setBoard`, reuse the presentation adapter, expose a whole-board save route, or let a browser payload replace `board.json`.
- Runtime session truth comes from the server-owned terminal/session store, never browser payloads or cached board restore data. Low-level `saveProjectState` remains for migrations, isolated tests, and controlled maintenance only. Tests that seed state directly must target the isolated runtime state root through `QUARTERDECK_STATE_HOME`, not a browser API.

## Command receipts and lifecycle effects

- Board-command receipt metadata is server-owned and bounded. Check a repeated command ID and payload fingerprint before expected-revision rejection so a retry after a lost response works across runtime restarts. Reject reuse of the same ID with different content.
- A first-seen accepted command, including a semantic no-op, consumes one revision so its receipt and ordering are durable.
- Receipts retain whether the originally accepted command changed the board. Lifecycle orchestration must use that recorded result, source-column preconditions, and authoritative session state before running a post-commit process effect; `replayed` alone is insufficient.
- Coalesce same-process duplicate create/start calls, never blindly relaunch after a persisted move, and recover an interrupted pre-launch move to Backlog without deleting worktree or branch state.
- Board-changing lifecycle effects wait for the optimistic command queue to flush before starting or stopping a task session, creating or restoring a worktree, or deleting a worktree. Otherwise the effect can observe the old durable card or outlive a rejected optimistic move.

### Create and start

Lifecycle `create_and_start` tolerates bounded bursts of unrelated revision advances from runtime-owned title, session, branch, or worktree projections:

1. Rebase the additive `create_task` step only after proving the stable task ID is still absent.
2. Rebase the following move only while that exact task identity remains in Backlog.
3. Re-evaluate both guards before every bounded retry.
4. If the identity appeared concurrently, its source-column precondition changed, or the retry budget was exhausted, retain the latest revision conflict and run no process or worktree effect.

This makes sequential bulk starts resilient without weakening identity protection or adding browser retries.

### Trash and linked tasks

A Trash transition that unblocks linked Backlog tasks journals the linked-task plan and deterministic child operation IDs before moving the parent. The move consumes the exact revision from which the plan was derived; canonical dependency cleanup after the move intentionally removes the evidence needed to rediscover those children.

## Runtime-owned projections

- Runtime-owned session, generated-title, branch/base-ref, and worktree metadata projections go through the same command service and internal mutation lock before the newer board is published.
- The runtime state hub schedules session persistence from terminal-store changes. Do not move that projection into browser effects.
- The browser Git/worktree metadata read model is project-scoped even though task metadata is indexed by task ID. Change its scope before paint during navigation, and pass the originating project ID into async writes so late results cannot attach to the next project.

### Authoritative browser hydration

`applyAuthoritativeProjectState(...)` in `web-ui/src/hooks/project/project-sync.ts` is the single browser-side entry point for authoritative project state. Do not split this pipeline across `use-project-sync.ts` or nearby code:

- reconcile authoritative sessions against the latest local session state;
- treat the runtime board as authoritative, with pending local command batches overlaid only for optimistic presentation;
- allow a command response or conflict refresh to force exact authoritative hydration even at a revision the browser already displayed; and
- keep hydration flags, cache updates, queue revision re-entry, and optimistic overlay in this one apply path.

## Automatic task titles

Automatic title generation has one authoritative trigger: the board command service's post-commit `untitled_task_created` effect. Every accepted `create_task`, whether submitted by a browser batch or by `ProjectTaskLifecycleService`, passes through that effect stream.

- Keep scheduling routed through `src/server/automatic-task-title-scheduler.ts` and its shared per-project/task coordinator.
- Transport handlers and lifecycle orchestration must not scan boards or schedule titles independently.
- Persist through `ProjectBoardCommandService.setGeneratedTaskTitle(...)`. Its task ID, `createdAt`, and lock-held `expectedTitle: null` checks prevent a delayed result from renaming a replacement task or overwriting a manual rename.
- Replayed post-commit delivery may retry an untitled task. The coordinator deduplicates overlapping automatic requests, while explicit manual regeneration remains independent because it may use richer session context.

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

## Task indicator semantics

Use `deriveTaskIndicatorState(summary)` and `isPermissionActivity(...)` from `src/core/api/task-indicators.ts` / `@runtime-contract` for approval, review-ready, Needs Input, and failure meaning.

Do not reinterpret `reviewReason`, `latestHookActivity.notificationType`, `hookEventName`, or `"Waiting for approval"` directly in components or hooks. Project badges, status badges, audible notifications, and approval-blocking behavior flow from the shared semantic layer.

## Task path terminology

Task identity has three distinct path concepts:

- project root: `projectPath` in project-level state and providers;
- assigned task identity: `taskWorktreeInfo.path` or the task metadata snapshot path; and
- session launch path: `RuntimeTaskSessionSummary.sessionLaunchPath`.

`sessionLaunchPath` is not a live cwd stream. It records where the current agent session launched. Persisted-state loading alone owns the one-time rewrite from legacy `projectPath` fields in old `sessions.json` files. Use `sessionLaunchPath` for divergence and restart hints, not as the authoritative task branch, folder, or shared-versus-isolated display source.

## Related documents

- [Architecture overview](../architecture.md)
- [Task lifecycle reliability plan](../task-lifecycle-reliability-plan.md)
- [Session and terminal lifecycle](./session-lifecycle.md)
- [Architecture guardrails](./architecture-guardrails.md)
