# Task Lifecycle Reliability and Project Read-Model Plan

Status: implemented and fully validated on `feature/remote-access` as of 2026-08-21. Local `main` through `ede5614ac` is integrated; manual dogfood in the user's existing Quarterdeck runtime is the remaining release-confidence step.

This plan is a required reliability follow-up to the runtime board-command cutover in [`remote-companion-plan.md`](./remote-companion-plan.md). It addresses the dogfood failures where a trashed task returned, a restored task was trashed again, and project-count pills changed merely because a project became active.

The work is still prerequisite work for remote access. It adds no remote listener, authentication flow, mobile UI, file exposure, or replacement conversation renderer.

## Implementation Status

The reliability cutover is implemented as one server-owned lifecycle path:

- `ProjectTaskLifecycleOperationStore` records bounded, write-ahead operation receipts with stable identity, semantic fingerprints, explicit phases, typed outcomes, and startup recovery.
- `ProjectTaskLifecycleService` coordinates create-and-start, start, trash, restore, stop, restart, and permanent delete. Board steps use stable command IDs; process launches use `launchOperationId`; stops can target an exact `sessionInstanceId`.
- Trash archival and permanent purge are separate idempotent worktree mechanisms, so replaying Trash cannot delete the saved restore patch.
- Desktop gestures retain their optimistic presentation but call one high-level lifecycle command. Browser code no longer composes board persistence, task-agent stop/start, and worktree mutation.
- The generic browser board-command route rejects managed lifecycle transitions. Low-level session/worktree procedures remain internal compatibility or shell-terminal mechanisms, not the desktop task-lifecycle path.
- Project summaries carry `boardRevision`, derive counts from the same authoritative board snapshot, and merge monotonically in the browser. Project activation no longer selects a different count algorithm.
- Runtime startup recovers non-terminal operations before the HTTP listener is exposed and does not require a browser connection.

No remote listener or remote projection was added. The next Remote Companion prerequisites remain provider-neutral conversation reads, structured non-PTY interaction, strict leak-tested projections, and their browserless acceptance harness.

## Decision Summary

Do not fix these failures as independent React patches.

Quarterdeck needs four explicit layers:

1. `ProjectBoardCommandService` remains the only durable board writer.
2. `TerminalSessionManager` and native hooks remain the authority for live process and agent-turn state.
3. `ProjectTaskLifecycleService` becomes the durable coordinator for high-level task intent such as start, trash, restore, stop, restart, and delete.
4. Project-list counts become a revisioned read projection of authoritative board state, never a second source of task state.

The browser may animate an optimistic result, but it must not coordinate board persistence, session stop/start, and worktree mutation itself. Desktop and future mobile clients must call the same high-level lifecycle operations.

The central invariant is:

> A process or worktree side effect may run only for a durable lifecycle operation tied to the exact task instance and an authoritatively accepted state precondition. A stale failure or compensation may never overwrite a newer accepted operation.

This is not one monolithic state machine. It is a durable operation coordinator between two existing state machines and one read model.

## Why This Plan Exists

### Dogfood symptoms

- Trashing a conversation appeared to work, then the card returned.
- Restoring a trashed task could later move it back to Trash.
- Project-count pills changed when navigating between projects.
- The failures did not leave useful default-level runtime logs.

### Confirmed split state

During investigation, durable board state contained a task in Trash while its task-agent process was still live and its session summary remained `awaiting_review`. That state should be transient only while an acknowledged trash operation is stopping the process. At the time, browser orchestration could silently continue, stop early, or compensate after a board-command failure without one server-owned operation describing what happened.

### Former failure seams now closed

Before this cutover, several individually reasonable safeguards did not compose into one authoritative operation:

- Optimistic board persistence and browser-owned session/worktree effects could observe different revisions.
- Stop returned no typed distinction between clean exit, no running process, stale session identity, timeout, and failure.
- Restore, Trash, hard delete, clear Trash, and linked-task starts were spread across React hooks and fire-and-forget continuations.
- A process launch had no durable operation identity with which to reconcile a lost response.
- Trash archive and permanent purge shared one ambiguous deletion mechanism.
- Project counts could be derived differently depending on whether a project was active or had a terminal manager.

The implemented coordinator, journal, exact session identity, split worktree mechanisms, desktop adapter, and revisioned read model close those ownership splits. Focused regression and fault-injection tests cover the original return-from-Trash, re-trash-after-restore, stale compensation, stop-timeout, replay, and project-pill failures.

Before the cutover, count pills had a separate ownership split:

- [`src/server/project-registry.ts`](../src/server/project-registry.ts) cached counts conditionally based on whether a terminal manager existed and overlaid live `awaiting_review` session state onto board counts.
- [`web-ui/src/hooks/project/use-project-ui-state.ts`](../web-ui/src/hooks/project/use-project-ui-state.ts) replaced the active project's streamed counts with counts from the displayed board.
- Switching projects changed which calculation owned a pill, so activation itself could change the number.

### Why destructive retries required separate mechanisms

The former `deleteTaskWorktree(...)` path served two different intents:

- archive a task worktree while preserving a patch for later restore;
- permanently purge a deleted task's worktree and patch files.

Those intents are now separate: `archiveTaskWorktreeForTrash(...)` preserves an existing restore patch on replay, while `purgeTaskWorkspaceForDelete(...)` permanently removes both workspace and patches and is safely repeatable.

## Goals

- Make start, trash, restore, stop, restart, hard delete, clear trash, and create-and-start safe under conflicts, retries, disconnects, and runtime restart.
- Preserve current desktop gestures, animations, native Claude/Codex TUIs, and hook-driven running/review semantics.
- Give every high-level mutation a stable operation identity and queryable outcome.
- Prevent an old failed operation from reverting a newer successful one.
- Make stop timeout distinguishable from stop success.
- Make process launch replayable without starting a duplicate session.
- Make trash worktree archival and permanent deletion independently idempotent.
- Make project counts deterministic for a particular board revision.
- Produce visible, content-safe diagnostics for every rejected transition, failed side effect, compensation, and recovery decision.
- Provide the same internal lifecycle API to the desktop and future Remote Companion.
- Keep correctness intact with caches, batching, optimistic animation, and streaming disabled.

## Non-Goals

- No remote network listener or exposure of the desktop tRPC router.
- No mobile UI, pairing, device authentication, or relay.
- No new conversation renderer and no replacement of xterm/native agent TUIs.
- No lifecycle inference from terminal output, conversation history, timestamps, or renderer state.
- No broad redesign of task columns or native hook semantics.
- No expansion of legacy Pi support. Claude Code and Codex are the supported targets.
- No attempt to make several filesystem files participate in a database-style atomic transaction. Recovery is achieved with a write-ahead operation record, stable subcommand IDs, state inspection, and idempotent effects.

## Target Ownership Model

```text
desktop action ───────┐
future mobile action ─┼─> ProjectTaskLifecycleService
headless recovery ────┘          |
                                  | durable operation journal
                                  | exact task/column/session preconditions
                    +-------------+--------------+
                    |                            |
                    v                            v
        ProjectBoardCommandService      Terminal/worktree mechanisms
          sole board file writer         no board policy of their own
                    |                            |
                    +-------------+--------------+
                                  |
                                  v
                    authoritative commit event
                                  |
                  +---------------+----------------+
                  |                                |
                  v                                v
       project-state projection          revisioned project summary
       active board + sessions             counts for project list
```

### Layer 1: durable board state

Owns cards, columns, dependencies, task metadata, board revisions, and durable board-command receipts.

- `ProjectBoardCommandService` remains the only production writer.
- Pure reducers remain in `src/core` and are shared with optimistic presentation.
- A lifecycle transition uses a derived stable board-command ID and an exact source-column/task-instance precondition.
- Native session projection may move only between In Progress and Review. It must continue to leave Backlog and Trash user-controlled.

### Layer 2: live session state

Owns process identity, PID, active PTY, provider session identity, hook activity, and running/review/failure state.

- `TerminalSessionManager` owns the process registry.
- Native hooks remain the semantic authority for running, needs-input, and review-ready transitions.
- The lifecycle coordinator may request start, stop, or resume, but it cannot synthesize a hook result.
- Task-agent sessions and task-bound shell terminals remain separate process domains even when one lifecycle operation must stop both before deleting a worktree.

### Layer 3: durable lifecycle operation

Owns the user's high-level intent and progress across board, process, and worktree boundaries.

- One active lifecycle operation is allowed per task instance.
- An operation has a stable ID, semantic fingerprint, explicit phase, exact task identity, and typed result.
- The operation is recorded before its first board or process effect.
- Every board substep has a stable ID derived from the operation ID.
- Every process launch carries the operation ID so an ambiguous response can be reconciled without launching again.
- Non-terminal operations are resumed at runtime startup without waiting for a browser connection.

### Layer 4: revisioned read model

Owns project-list counts and other lightweight project summaries.

- Counts are derived from one authoritative board snapshot and carry that board revision.
- Live session summaries do not independently change counts. Session-to-column projection commits the board first; that board commit then changes the count projection.
- A cache may memoize a known revision but cannot determine truth or change behavior based on project activation.

## Required Invariants

### Operation identity and concurrency

1. `operationId + fingerprint` is immutable. Reusing an ID with different semantic content is a conflict.
2. Retrying the same ID returns or resumes the same operation.
3. A different operation targeting the same `taskId + taskCreatedAt` while one is active returns `busy`; the first correct implementation does not silently queue it.
4. Optional viewport geometry is a launch hint, not part of semantic identity. A retry from another client cannot become a different task operation merely because its screen size differs.
5. Task IDs are not sufficient identity on their own. Every operation also records the task's immutable `createdAt` value.

### Board transitions

1. Managed lifecycle edges cannot be submitted through the generic client board-command route after cutover.
2. The managed edges are:
   - Backlog to In Progress when starting a task.
   - Any non-Trash column to Trash.
   - Trash to Review when restoring a task.
   - Permanent task deletion.
3. Reordering within a column and non-lifecycle edits remain ordinary board commands.
4. A lifecycle board step must validate the exact source column and task identity under the project lock.
5. An unrelated project revision change may be semantically rebased by the server only after revalidating those task-local preconditions. Clients do not retry semantic conflicts blindly.
6. A first-seen accepted no-op remains a durable receipt but does not grant permission to run a side effect.

### Side effects

1. No session/worktree effect runs before the durable operation record exists.
2. Start, trash, and restore do not run their effects until their exact board transition has an accepted durable receipt.
3. Permanent deletion is different: the durable operation first claims and revalidates a card already in Trash, stops and purges its resources, and only then removes the card. Deleting the card first would prune the session record while a process could still be live.
4. A stop timeout is failure, not success. Worktree deletion and replacement start are forbidden after a timed-out stop.
5. A successful or ambiguous process launch is reconciled by `launchOperationId` and session instance. It is never treated as failure merely because the response was lost.
6. Compensation is a compare-and-set transition. It runs only while the operation still owns the expected post-transition state and no successful launch for that operation exists.
7. Cleanup failure after a clean stop does not restart a task. The card remains safely in Trash with a warning.
8. No background cleanup may delete a worktree after a newer restore operation supersedes it.

### Publication and read models

1. Every accepted board change produces an authoritative commit event containing the resulting state and revision.
2. Active project state and project summary projections derive from that same result where available.
3. Project summaries carry `boardRevision`.
4. A client never replaces a revision `N+1` summary with revision `N`.
5. Project activation cannot change the count algorithm.
6. Optimistic counts exist only as a tagged overlay for known pending command/operation IDs and a known base revision.

### User experience

1. Revisions, journals, and compensation phases are internal details.
2. The UI can immediately show `Starting…`, `Trashing…`, `Restoring…`, or `Deleting…` and animate the intended card movement.
3. A completed operation reconciles to authoritative state.
4. A failed operation removes its optimistic overlay, shows one plain-language toast, and leaves a structured runtime warning.
5. Losing the browser connection does not cancel the server operation. Reconnect queries the same operation ID.

## Durable Operation Journal

Add a versioned project-local lifecycle journal, owned by a focused store such as `ProjectTaskLifecycleOperationStore`. The journal is not board state and cannot write `board.json`.

Use the existing per-project directory lock for journal mutations. Keep all non-terminal operations plus a bounded set of recent terminal receipts. Never evict an active operation.

### Why board-command receipts are not enough

The existing receipts remain the proof that one board step was accepted, but they intentionally store only command identity, fingerprint, revision, timestamp, and whether the command changed the board. They do not retain the high-level operation kind, task target, linked child tasks, current process/worktree phase, or terminal outcome. After a card is permanently deleted, the bounded receipt also does not contain enough target data to finish interrupted resource cleanup or answer a reconnecting client's operation-status query.

The lifecycle journal complements rather than replaces board receipts: the journal says what high-level operation is in progress, and each board receipt proves the durable result of one of its board steps.

An illustrative internal record is:

```ts
interface PersistedTaskLifecycleOperation {
  version: 1;
  operationId: string;
  fingerprint: string;
  projectId: string;
  taskId: string;
  taskCreatedAt: number;
  kind:
    | "create_and_start"
    | "start"
    | "trash"
    | "restore"
    | "stop"
    | "restart"
    | "delete";
  status:
    | "pending"
    | "completed"
    | "completed_with_warning"
    | "failed"
    | "superseded";
  phase: TaskLifecycleOperationPhase;
  sourceColumnId: RuntimeBoardColumnId | null;
  targetColumnId: RuntimeBoardColumnId | null;
  acceptedBoardRevision: number | null;
  launchOperationId: string | null;
  childOperationIds: readonly string[];
  outcomeCode: string | null;
  requestedAt: number;
  updatedAt: number;
  completedAt: number | null;
}
```

The persisted schema may use discriminated records per operation kind rather than one wide interface. It must retain only the inputs needed for deterministic recovery. It must not store terminal output, tool payloads, or log message content. Create-and-start may need to persist the create specification because the card does not exist before its first board step; once created, later phases resolve launch data from the authoritative card.

### Write-ahead and crash windows

The operation record and board files do not need a fragile cross-file pseudo-transaction.

1. Persist `pending/requested` first.
2. Execute a board step with ID `<operationId>:<step>`.
3. Persist the accepted board revision and next phase.
4. Before each external effect, persist the effect phase.
5. After the effect, persist its typed receipt and next phase.
6. Persist the terminal outcome.

If the runtime crashes between steps 2 and 3, recovery replays the identical board command. The durable board-command receipt says whether the original command was accepted and whether it changed the board. If the runtime crashes around a process effect, recovery inspects the explicit session/launch identity before deciding to retry.

### Recovery policy

Recovery runs from runtime bootstrap or project-manager readiness, not from `RuntimeStateHub.handleConnection`.

For each non-terminal operation:

- Revalidate the project and exact task instance.
- Replay or inspect the current board step using its stable ID.
- Inspect the current session by explicit session and launch-operation identity.
- Inspect worktree state only through the operation-specific archive/ensure/purge mechanism.
- Continue an idempotent phase, compensate when its documented preconditions hold, or finish as `superseded`/`failed` with a warning.
- Never infer progress from terminal output or the presence of a browser.

Recovery must be bounded and isolate one bad operation from other projects/tasks. Repeated automatic failure should settle into a visible terminal state rather than retry forever.

## Session and Worktree Mechanism Changes

### Explicit stop result

Replace the ambiguous wait result with an internal contract similar to:

```ts
interface StopTaskSessionResult {
  summary: RuntimeTaskSessionSummary | null;
  requestedSessionInstanceId: string | null;
  didExit: boolean;
  outcome: "not_running" | "exited" | "timed_out" | "failed";
  error?: string;
}
```

- `not_running` and `exited` allow the next phase.
- `timed_out` and `failed` forbid worktree cleanup and replacement start.
- The low-level tRPC response and logs must preserve that distinction.
- A processless historical summary does not make a timeout successful.

### Explicit launch identity

Add a stable `sessionInstanceId` and `launchOperationId` to the server-owned session model.

- A new spawn gets a new session instance ID.
- A replay of the same lifecycle launch operation returns the existing matching session or its completed result.
- A different launch operation cannot reuse a session that is still exiting.
- Exit callbacks remain bound to the exact spawned `PtySession`, preserving the existing stale-exit protection.
- Persisted-summary loading handles older records without these fields.

### Split archive from purge

Replace the shared destructive meaning of `deleteTaskWorktree` with two explicit mechanisms:

```ts
archiveTaskWorktreeForTrash({ projectId, taskId, operationId })
purgeTaskWorkspaceForDelete({ projectId, taskId, operationId })
```

`archiveTaskWorktreeForTrash`:

- Captures/restores the normal saved-patch contract.
- Removes the worktree when present.
- Treats an already-absent worktree as success without deleting the saved patch.
- Is safe to replay after an ambiguous response.

`purgeTaskWorkspaceForDelete`:

- Removes the worktree if present.
- Permanently removes saved patches and task-owned residual workspace state.
- Treats already-absent resources as success.
- Runs only for a durable delete operation that still owns a Trash card.

The existing low-level helper can be refactored underneath these mechanisms, but callers must select one semantic operation explicitly.

### Resolve task launch data server-side

Lifecycle commands carry IDs and constrained options, not a browser copy of the card.

- Resolve prompt, images, agent, base ref, branch, worktree choice, working directory, and stored provider resume ID from authoritative server state.
- Optional terminal geometry remains a bounded hint.
- Start rejects a task still in Backlog or Trash unless the matching lifecycle operation has accepted the transition that makes it startable.
- Restore resume targets the stored Claude/Codex session identity when available and retains current warning behavior for best-effort fallbacks.

## Lifecycle Transition Definitions

### Start an existing Backlog task

```text
requested
  -> Backlog→In Progress accepted
  -> worktree ensured (or skipped for non-isolated task)
  -> session launched with launchOperationId
  -> completed
```

Failure policy:

- A rejected transition runs no side effect.
- Worktree or launch failure compensates In Progress back to Backlog only if the operation still owns that exact task/post-state.
- If launch response is ambiguous, inspect `launchOperationId`; a matching session is success.
- Preserve branch/worktree state on failure rather than speculatively deleting recoverable work.

### Create and start

Use the typed `ProjectTaskLifecycleService.execute(...)` contract with a `create_and_start` command and journal it.

```text
requested
  -> card created in Backlog
  -> Backlog→In Progress accepted
  -> worktree ensured
  -> session launched
  -> completed
```

Retain the existing safe properties:

- Stable create/move/recover subcommand IDs.
- First-seen no-op does not authorize launch.
- Concurrent duplicate calls coalesce.
- Failed startup returns the card to Backlog without deleting branch/worktree state.

Add durable phase/status recovery and explicit launch identity. Wire this service into production rather than keeping it integration-test-only.

### Trash

```text
requested with exact source column
  -> source→Trash accepted; original source and ready linked tasks recorded
  -> exact task session stopped and clean exit confirmed
  -> task-bound detail shell stopped
  -> isolated worktree archived, or skipped for non-isolated task
  -> linked ready tasks started as child operations
  -> completed or completed_with_warning
```

Failure policy:

- Stop timeout: do not archive the worktree. Compensate Trash back to the original source only if the operation still owns the Trash placement.
- Archive failure after clean stop: keep the card in Trash, finish with a warning, and preserve the worktree. Do not restart the task to make cleanup look atomic.
- A child linked-task start has its own derived operation ID. One child failure does not replay the primary trash effect or duplicate another child start.
- Ready linked task IDs must be captured before the Trash move normalizes/removes dependency edges.
- A later restore cannot race an old detached cleanup callback; all phases are awaited or guarded by operation ownership.

### Restore from Trash

```text
requested
  -> Trash→Review accepted
  -> any previous task session confirmed exited
  -> worktree ensured/recreated and saved patch restored
  -> provider session resumed with launchOperationId and awaitReview=true
  -> completed
```

Failure policy:

- A lingering old process that does not exit forbids resume and triggers guarded compensation to Trash.
- Worktree ensure failure triggers guarded compensation to Trash.
- Confirmed resume failure triggers guarded compensation to Trash and a visible warning.
- An ambiguous resume result is inspected by launch/session identity. If a matching replacement session exists, the operation succeeds and must never re-trash the task.
- Compensation is skipped as `superseded` if another accepted operation has changed the task or a matching session is live.
- A failed restore may leave a recoverable worktree in place; it must not run the permanent purge path.

### Stop

Stop is a lifecycle operation even though it does not require a board-column move.

- The durable operation record and exact session-instance precondition authorize the effect.
- `not_running` is idempotent success.
- `timed_out` is an explicit failure.
- Hooks/session projection retain ownership of any running/review board consequences.
- This is the operation future remote `tasks.stop` invokes; it is not raw PTY input.

### Restart

```text
requested for exact session instance
  -> old session stop confirmed
  -> replacement launch/resume with launchOperationId
  -> completed
```

- Never start while `suppressAutoRestartOnExit` is still set on an active prior entry.
- A timeout fails without launching a replacement.
- A duplicate operation cannot restart twice.
- Existing provider-specific targeted-resume and best-effort warning behavior remains behind the server adapter.

### Permanent delete

```text
requested for exact task currently in Trash
  -> durable delete claim accepted
  -> task session and task-bound shell confirmed stopped
  -> task workspace and saved patches purged
  -> card deletion accepted
  -> completed
```

The card remains authoritatively in Trash until destructive cleanup succeeds. The UI may render it as `Deleting…`, but it must not disappear authoritatively while a live process or recoverable cleanup failure remains.

### Clear Trash

Clear Trash is a bounded batch facade over child delete operations.

- Snapshot exact task identities from Trash.
- Give every child a deterministic ID derived from the batch operation ID.
- Limit concurrency.
- Report per-task completion/failure.
- Remove only cards whose delete operations completed.
- A partial failure leaves the affected cards in Trash with a retryable error instead of silently losing them from the UI.

## Internal Lifecycle API

Expose one internal provider-neutral command service to desktop adapters, browserless tests, and the future remote facade.

Illustrative commands:

```ts
type TaskLifecycleCommand =
  | { kind: "start"; operationId: string; taskId: string; taskCreatedAt: number; expectedRevision: number }
  | { kind: "trash"; operationId: string; taskId: string; taskCreatedAt: number; expectedRevision: number }
  | { kind: "restore"; operationId: string; taskId: string; taskCreatedAt: number; expectedRevision: number }
  | { kind: "stop"; operationId: string; taskId: string; taskCreatedAt: number; sessionInstanceId: string | null }
  | { kind: "restart"; operationId: string; taskId: string; taskCreatedAt: number; sessionInstanceId: string | null }
  | { kind: "delete"; operationId: string; taskId: string; taskCreatedAt: number; expectedRevision: number };
```

Create-and-start has a separate constrained create specification because no card identity exists yet. Clear-trash is a batch facade.

The service provides:

- `execute(command)` to begin, join, or resume an operation.
- `getOperation(projectId, operationId)` for reconnect/status.
- `listActiveOperations(projectId)` for initial state and recovery.
- an internal operation-update subscription used by the local runtime stream.

Return typed outcomes such as:

- `completed`
- `completed_with_warning`
- `already_applied`
- `busy`
- `stale_task`
- `invalid_transition`
- `revision_conflict`
- `stop_timed_out`
- `worktree_failed`
- `session_start_failed`
- `compensation_failed`
- `superseded`

Do not make UI code parse error strings to decide state.

## Desktop Adapter and Optimistic UX

The desktop keeps presentation policy but loses orchestration authority.

### Before a lifecycle call

- Flush ordinary pending edits for the project so the server resolves the current card data.
- If that flush fails, do not send the lifecycle command.
- Generate one operation ID and retain it across the request, animation, transport retry, and reconnect.
- Add a UI-only optimistic overlay tagged with the operation ID and base revision.

### While pending

- Preserve the current card movement animation.
- Show an operation label instead of an indefinite generic spinner.
- Disable conflicting actions for that task while allowing unrelated tasks/projects to work.
- Do not call `ensureWorktree`, `startTaskSession`, `stopTaskSession`, or `deleteWorktree` from React lifecycle hooks.

### On completion

- Apply authoritative project state through the existing single `applyAuthoritativeProjectState(...)` seam.
- Remove the matching optimistic overlay.
- Update selection and local presentation state after the authoritative outcome, not as proof the operation succeeded.

### On failure or reconnect

- Remove only the overlay matching the failed operation ID.
- Show one plain-language toast based on the typed outcome.
- Query the operation by ID after reconnect before offering Retry.
- Retry uses the same operation ID for an ambiguous transport result and a new operation ID for a deliberate new user attempt after a terminal failure.

Animation helpers may remain client-side. They must animate an operation projection rather than generate a second durable board command.

## Managed Board-Command Boundary

The generic optimistic board command API remains useful for edits, dependencies, pinning, and reorder operations. It must no longer be a lifecycle bypass.

After each lifecycle family is cut over:

- Reject corresponding cross-column `move_task` commands from the client board-command entry point.
- Reject client `delete_tasks` for lifecycle-managed task deletion.
- Let `ProjectTaskLifecycleService` call a distinct internal board-command method for managed transitions.
- Keep runtime session/metadata projection on its existing internal methods.

This distinction belongs at the server boundary, not only in drag handlers. A stale desktop, future client, or programming mistake must not be able to commit the move and separately call a process effect.

## Revisioned Project Summary Read Model

### Contract

Extend the local `RuntimeProjectSummary` with the authoritative board revision used for its counts:

```ts
interface RuntimeProjectSummary {
  id: string;
  path: string;
  name: string;
  boardRevision: number;
  taskCounts: RuntimeProjectTaskCounts;
}
```

The future remote projection maps this to its narrower path-free contract. It does not expose the local summary directly.

### Server derivation

- Add a pure `deriveProjectSummary(boardSnapshot)` function.
- Read board and meta revision under the project lock, or derive directly from an accepted `ProjectBoardCommandService` result.
- Count persisted board columns only.
- Remove `applyLiveSessionStateToProjectTaskCounts`; session projection already moves the durable card between work columns.
- Remove correctness behavior based on whether a terminal manager happens to exist.
- First ship the simple correct implementation without a count cache.
- If measurement later justifies caching, key it by project ID and board revision and make a cache miss fall back to the same authoritative read.

### Publication

Replace caller-specific project-list refreshes with one board-commit publication path:

1. The board command commits.
2. The command service emits the resulting authoritative state/revision.
3. The runtime hub broadcasts project state to project subscribers.
4. The same result derives and broadcasts the project summary to global subscribers.

Session batches may still publish session/notification deltas. They no longer independently guess whether counts changed and race a disk reread.

For the initial selected-project snapshot, the selected summary and project state must come from a coherent revision. Either build them under one read or replace the selected summary with the projection derived from the returned project state before serializing the snapshot.

### Client merge

- Store the latest authoritative summary per project and ignore lower revisions.
- Remove the unconditional rule that the active project uses `countTasksByColumn(board)` while inactive projects use streamed counts.
- When an active authoritative board at a newer revision arrives, derive/update its summary in the same state application.
- Apply optimistic count deltas only for explicit pending command/operation overlays based on a known revision.
- Cached board restore may display its cached revision immediately, but it cannot overwrite a newer streamed summary.
- Switching projects changes navigation only; it does not switch the count algorithm.

## Observability Contract

Every lifecycle operation produces structured runtime events. Default-level warnings must survive with no browser connected and appear in the recent-log snapshot after reconnect.

Required fields where applicable:

- `projectId`
- `taskId`
- `taskCreatedAt`
- `operationId`
- `operationKind`
- `phase`
- `boardCommandId`
- `expectedRevision`
- `observedRevision`
- `sessionInstanceId`
- `launchOperationId`
- `attempt`
- `outcome`
- stable error code and sanitized error message

Never log prompts, replies, terminal output, tool data, environment variables, credentials, or saved patch contents.

Log policy:

- `debug`: normal phase entry/exit and idempotent replay breadcrumbs.
- `info`: operation accepted/completed and startup recovery summary.
- `warn`: rejected transition, stop timeout, failed side effect, compensation, superseded stale work, fallback resume, or recovery that cannot safely continue.
- `error`: journal corruption, invariant violation, or failed compensation that leaves state requiring intervention.

The UI maps typed outcomes to toasts. Logging is not a substitute for user feedback, and a toast is not a substitute for a persistent runtime record.

## Migration Plan

Each stage must preserve exactly one board writer and exactly one lifecycle orchestrator for any user action. Shadow planning/comparison is allowed; duplicate side effects are not.

Implementation result: Stages 0 through 5 are complete on this branch. The staged descriptions remain below as the migration record and regression checklist.

### Stage 0: characterization and incident regression tests

Before ownership changes, capture current intended behavior:

- Start one task and start-all from Backlog.
- Drag/programmatic start animations.
- Trash from Backlog, In Progress, and Review.
- Trash confirmation cancel/confirm and worktree notice behavior.
- Linked Backlog task auto-start.
- Restore to Review, targeted resume, saved-patch warning, and non-isolated warning.
- Restore while the old process is still exiting.
- Hard delete and clear trash.
- Stop/restart and existing native terminal input.
- Project switching with cached boards and stable pills.

Add failing reproductions for the observed incidents before changing implementation.

### Stage 1: harden low-level mechanisms without moving UI ownership

- Add explicit stop outcome and tests for timeout with a live PID.
- Add session instance/launch operation identity and replay tests.
- Split archive-for-trash from purge-for-delete.
- Add defense-in-depth start validation against persisted Backlog/Trash cards.
- Add structured warning helpers and ensure runtime log retention works without clients.

Keep compatibility adapters only where necessary to preserve existing callers during the cutover.

### Stage 2: add the durable journal and expand `ProjectTaskLifecycleService`

- Implement schema, migration/default loading, corruption handling, bounds, and per-task operation ownership.
- Move the current create-and-start logic onto the journal model.
- Add operation status query/subscription and startup recovery.
- Wire the service into runtime bootstrap and production dependency injection.
- Do not route desktop gestures to it yet until integration tests cover crash and replay behavior.

### Stage 3: cut over lifecycle families

Cut over in dependency order while retaining one cohesive feature branch:

1. Start and create-and-start.
2. Trash and linked child starts.
3. Restore.
4. Stop and restart.
5. Permanent delete and clear trash.

For each family:

- Desktop calls the high-level operation.
- React orchestration and compensating `setBoard` calls are removed.
- The corresponding generic client board transition is rejected server-side.
- Existing animation becomes an operation-tagged optimistic overlay.
- Unit, integration, RuntimeStateHub, and UI behavior tests pass before moving to the next family.

### Stage 4: replace the project-count projection

- Add `boardRevision` to local project summaries.
- Derive counts from authoritative board snapshots only.
- Publish summaries from board commit results.
- Remove terminal-manager-dependent count caching and live-session count overlay.
- Replace active-project count ownership with monotonic revision merge plus explicit optimistic overlays.

This is a read-model cutover, not a second lifecycle state machine.

### Stage 5: remove bypasses and compatibility paths

- Remove browser use of low-level lifecycle tRPC calls.
- Remove dead flush-and-side-effect hook orchestration.
- Keep low-level terminal/worktree mechanisms internal to server services and focused tests.
- Audit every caller of `move_task`, `delete_tasks`, start, stop, ensure, archive, and purge.
- Update the Remote Companion prerequisite plan and active todo status only after the acceptance gate passes.

## Test and Fault-Injection Matrix

### Operation contract tests

- Same operation ID and fingerprint joins/replays one result.
- Same ID with different content is rejected.
- Different operation on the same task returns `busy`.
- Operations on different tasks/projects proceed independently.
- Reused task ID with different `createdAt` is stale.
- Optional geometry differences do not create semantic identity conflicts.

### Board and compensation tests

- Managed transitions require the correct source column.
- Unrelated revision change can rebase only after task-local preconditions still match.
- First-seen no-op never authorizes an effect.
- Lost board response replays the same receipt.
- Compensation cannot move a task changed by a newer operation.
- A stale restore failure cannot re-trash a successfully restored/restarted task.
- Generic client board commands cannot bypass managed lifecycle edges.

### Process tests

- Stop clean exit, not-running, timeout, and thrown failure are distinct.
- Stop timeout prevents cleanup and replacement start.
- Duplicate launch operation starts one process.
- Lost launch response reconciles the matching session.
- Delayed old PTY exit cannot finalize a replacement session.
- Explicit stop suppresses resume-failure auto-restart fallback.
- Claude and Codex targeted resume plus documented best-effort warnings remain intact.

### Worktree tests

- Archive captures and preserves the restore patch.
- Replaying archive against an absent worktree does not delete the patch.
- Purge removes worktree and patches and is safely repeatable.
- Restore ensure is repeatable and does not recreate an existing valid worktree.
- Cleanup never runs after a stop timeout.
- A superseded trash cleanup cannot delete a worktree created by restore.
- Non-isolated tasks skip worktree archive/purge rules appropriately.

### Crash-point integration tests

Restart the runtime after each boundary:

- Journal begin before board command.
- Board command commit before journal phase update.
- Stop request before process exit.
- Process exit before journal update.
- Worktree archive before journal update.
- Worktree ensure before resume launch.
- Resume spawn before response/journal update.
- Compensation board commit before terminal outcome.
- Delete purge before final card deletion.

Each test must prove the operation settles without duplicate launch, patch loss, stale compensation, or a hidden live process.

### RuntimeStateHub integration tests

- Accepted lifecycle transition publishes authoritative project state and matching project summary revision.
- Session projection publication cannot make the summary lead or contradict the board.
- Failed publication is logged and later reconnect returns correct state.
- Operation warnings are retained with zero clients and visible on reconnect.
- Browser disconnect does not cancel an in-flight operation.

### Project summary tests

- Counts equal the authoritative board for the advertised revision.
- A project count does not change merely because it becomes active or receives a terminal manager.
- Revision `N` cannot overwrite `N+1`.
- Selected project state and summary agree in the initial snapshot.
- Awaiting-review changes counts only after the runtime board projection commits Review.
- Optimistic count overlay appears immediately, clears on success, and rolls back on failure.
- Cached restore cannot replace a newer summary.

### Browserless acceptance tests

- Execute start, trash, restore, stop, restart, delete, and create-and-start with zero browser clients.
- Retry every operation after a simulated lost response.
- Restart the runtime with non-terminal operations and verify recovery.
- Query operation outcome after reconnect.
- Verify no UI provider or React hook is needed for correctness.

### Existing regression suite

Run at each meaningful cutover and before handoff:

```bash
npm run check
npm run web:test
npm run web:build
npm run test:integration
```

Do not launch a second Quarterdeck runtime while the user is dogfooding an existing instance.

## Acceptance Gate

The implementation satisfies the code-level and automated-validation gates below after integrating local `main` through `ede5614ac`. Manual dogfood in the user's existing Quarterdeck runtime remains before treating the behavior as release-proven.

This reliability prerequisite is complete only when:

- No desktop lifecycle action composes board, task-session, and worktree RPCs in React.
- Every managed lifecycle edge goes through `ProjectTaskLifecycleService`.
- A stop timeout cannot be mistaken for success.
- Duplicate/lost-response start and restore cannot launch twice.
- Trash archival replay cannot delete the saved restore patch.
- A stale failure cannot compensate over a newer operation.
- Hard delete cannot remove a card while its process or cleanup is unresolved.
- Project counts are versioned and do not change due to activation.
- All failures, compensations, and suppressed effects produce a typed outcome, runtime warning, and appropriate toast.
- Recovery works with no browser connected.
- Existing Claude/Codex native TUI and hook behavior passes automated and manual dogfood checks.
- The full root, web, build, and integration validation suite is green.

Only after this gate should the branch proceed with additional Remote Companion prerequisite work or any remote listener.

## Performance Expectations

Correctness comes first, but the target should not make ordinary use feel slower.

- The browser performs fewer sequential lifecycle RPCs; one high-level operation replaces flush/ensure/start or flush/stop/delete chains.
- The operation journal adds a handful of small atomic writes per lifecycle action, not per terminal output or hook event.
- Per-task serialization avoids global lifecycle blocking.
- Project summary reads may initially do more direct board reads after removing the unsafe cache. Project counts are small, and this establishes a measurable correct baseline.
- Revision-keyed memoization and batched summary publication can be added later with an off switch.
- Terminal rendering and PTY throughput are outside this path and should be unchanged.

## Security and Remote-Access Consequences

This design strengthens the future remote boundary without exposing it yet.

- Remote and desktop clients eventually share idempotent high-level commands instead of raw PTY/worktree APIs.
- A dropped phone connection can safely recover operation status by ID.
- The remote gateway can map the internal result to an allowlisted, path-free outcome.
- Lifecycle logs and journal records omit prompts, replies, files, diffs, terminal output, tool data, and environment data.
- The local `RuntimeProjectSummary` may still contain a repository path for the desktop; the remote mapper must continue constructing its separate strict projection explicitly.
- No generic board command, lifecycle journal, low-level terminal route, or worktree mechanism is exposed on the future remote listener.

## Implemented Code Areas

Server/core:

- `src/server/project-task-lifecycle-service.ts`
- `src/state/project-task-lifecycle-operation-store.ts`
- `src/state/project-board-command-service.ts`
- `src/state/project-state.ts` and project-directory lock helpers
- `src/terminal/session-lifecycle-controller.ts`
- `src/terminal/session-manager-types.ts`
- `src/trpc/handlers/start-task-session.ts`
- `src/trpc/handlers/stop-task-session.ts`
- `src/workdir/task-worktree-lifecycle.ts`
- `src/server/project-registry.ts`
- `src/server/runtime-state-hub.ts`
- `src/server/runtime-state-message-batcher.ts`
- `src/core/api/project-state.ts`
- `src/core/api/task-session.ts`

Desktop adapter:

- `web-ui/src/hooks/board/use-task-lifecycle.ts`
- `web-ui/src/hooks/board/use-task-sessions.ts`
- `web-ui/src/hooks/board/use-linked-backlog-task-actions.ts`
- `web-ui/src/hooks/board/use-trash-workflow.ts`
- `web-ui/src/hooks/board/use-task-start.ts`
- `web-ui/src/hooks/board/use-board-drag-handler.ts`
- `web-ui/src/hooks/project/use-project-sync.ts`
- `web-ui/src/hooks/project/use-project-ui-state.ts`
- the board/context provider contracts that expose lifecycle actions and pending operation state

Tests:

- `test/integration/project-task-lifecycle-service.integration.test.ts`
- new lifecycle recovery/fault-injection integration suites
- `test/runtime/server/runtime-state-hub.test.ts`
- terminal lifecycle/controller tests
- worktree integration tests
- board-interaction, trash, task-session, project-sync, and project-UI-state web tests

## Decisions Deferred Until Remote Feature Work

These do not block the reliability implementation:

- Which lifecycle phase detail, if any, is shown on mobile beyond a simple pending state.
- Whether a remote client may request restart in v1.
- Remote capability and recent-reauthentication policy for start/stop/delete.
- Remote notification delivery and relay behavior.
- Whether branch names are enabled in the remote projection.

The durable operation identity, status lookup, and safe server-side command model should support those decisions without changing lifecycle correctness.
