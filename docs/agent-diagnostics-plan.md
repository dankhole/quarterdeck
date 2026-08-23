# Unified Agent Diagnostics Plan

Status: implemented on 2026-08-23; retained as the exhaustive architecture and operations source of truth

Last reviewed: 2026-08-23

This document is the architecture source of truth for Quarterdeck's unified runtime, browser, terminal, and agent-lab diagnostics. It intentionally records more detail than an ordinary architecture overview so later maintenance can survive conversation compaction, a fresh agent, or a multi-stage investigation without losing the decisions and constraints that motivated it.

The operator workflow for isolated testing is documented in [`agent-functional-testing.md`](./agent-functional-testing.md), while the live-instance CLI workflow is documented in [`DEVELOPMENT.md`](../DEVELOPMENT.md#unified-diagnostics). The implementation follows the shared foundation described here: the user's runtime and isolated lab use the same schemas, recorder, providers, doctor, and canonical bundle writer, with synthetic-only evidence added by the lab.

Implementation outcome: the legacy runtime/browser debug-log buffers and panel were removed rather than kept as a parallel system. Console verbosity remains a separate presentation setting, but all retained diagnostic records flow through the unified recorder. The lightweight flight recorder starts automatically with every runtime and needs no user toggle. The lab automatically uses the richer bounded `agent-lab` tier. Temporary production deep recording and explicit lab pixel/trace capture require deliberate action. Live content-enrichment flags are intentionally not exposed until a concrete provider can honor each flag through a reviewed allowlist; synthetic lab enrichment is the only implemented content-bearing tier.

Architecture-audit outcome: implementation was reviewed after the first complete pass specifically for layered workarounds. The resulting boundaries are deliberate: each runtime has one recorder and journal; the project registry owns its read-only project-state observation cache; terminal, metadata, runtime-stream, hook-outbox, and browser owners expose typed bounded snapshots; browser capability/request coordination lives on the runtime while queueing and snapshot collection are separate browser modules; and the panel only presents or controls policy. All asynchronous buffering layers are bounded and report loss, journal/descriptor failure reporting cannot recurse into failed storage, active runtime selection requires an authenticated instance match, browser HTTP responses use shared schemas, production capture rejects lab-only evidence, and board/session checks reuse the same shared projection semantic as browser hydration.

## Executive decision

Quarterdeck should have one diagnostics system, not a new flight recorder beside the existing debug logger, browser debug panel, terminal dumps, and lab snapshots.

The unified system will have several record kinds and capture tiers, but one vocabulary, schema, retention policy, export format, runtime discovery mechanism, CLI, and user-facing Diagnostics panel. Existing diagnostic producers that remain valuable will move behind this system. Duplicate buffers, transports, console-only dumps, and debug-panel-only capture will be removed after their consumers migrate.

The default production behavior will be a lightweight, always-on flight recorder. It must retain enough recent control-plane evidence for a newly started coding agent to investigate an incident after it happened, without requiring the user to enable debug mode or recreate the problem. High-volume or content-bearing evidence will remain explicitly opt-in and time bounded. The isolated lab uses synthetic data, so it can enable richer capture by default while keeping its artifact volume bounded to the run.

The simple explanation must remain:

> Quarterdeck records a small recent history of important lifecycle events. On demand, it takes read-only subsystem snapshots and packages those records into one private diagnostic bundle.

Batching, rotation, filtering, deep recording, and lab enrichment are policies around that mechanism. They must not become correctness dependencies.

## Why this work is needed

Quarterdeck already has useful diagnostic pieces, but an agent currently has to know where each one lives and often must reproduce the problem after enabling it:

- the runtime tagged logger writes to console, retains 200 in-memory entries, and streams them to connected browsers;
- the default runtime log threshold is `warn`, including in the current agent-lab fixture unless the UI changes it;
- oversized runtime log metadata is not reliably bounded because truncating serialized JSON can make it invalid and fall back to an unhelpful string representation;
- the browser client logger and global-error callback feed the debug panel only while that panel is open;
- browser console output, runtime log entries, terminal DOM health, and terminal buffer diagnostics have separate capture paths;
- the production terminal debug hook exposes useful metrics, but its direct output is primarily a browser-console dump;
- bounded visible terminal lines are correctly available only in the synthetic agent lab;
- the agent lab continuously captures process logs and Playwright evidence, while its state snapshot copies persisted JSON and Git state rather than authoritative live runtime internals;
- the runtime has no versioned live-instance descriptor or diagnostics CLI, so an agent must already know the active port and manually understand internal tRPC or WebSocket contracts;
- existing records are message-oriented and do not consistently carry an operation id, session-instance id, connection id, causal event, or before/after state needed to reconstruct a race.

This fragmentation is particularly painful for Quarterdeck because its difficult failures cross ownership boundaries: browser persistence, runtime session truth, native hooks, PTY processes, restore sockets, terminal pooling, Git worktrees, and asynchronous project metadata. A list of loosely related log lines is not enough to explain those races reliably.

## Goals

The implementation must satisfy all of the following goals.

### Post-incident investigation without reproduction

If a problem occurs and the user starts a new coding agent afterward, the agent should normally be able to run one read-only command and recover recent evidence from the current or immediately previous runtime instance. The user should not have needed to enable diagnostics before the incident.

### One system and one vocabulary

Runtime logs, structured lifecycle events, browser errors, health findings, explicit diagnostic marks, and subsystem snapshots must share one schema family and one bundle manifest. They may have different typed payloads and capture thresholds, but they must not maintain unrelated buffers or user-facing workflows.

### Low and bounded production cost

Always-on capture must exclude PTY output chunks, render loops, mouse activity, polling samples, file contents, diffs, prompts, and other high-volume data. It must use bounded memory and disk, asynchronous batched persistence, explicit queue limits, and rate-limited degraded-mode reporting.

### Read-only live inspection

An agent must be able to inspect a running Quarterdeck instance without opening a second writable board client, changing the board revision, resizing a live PTY, starting or stopping sessions, repairing state, or altering the persisted log level.

### Shared live and lab diagnostics

The live runtime and isolated lab must use the same recorder, schemas, snapshot providers, doctor checks, and bundle layout. Lab-only collectors may enrich that bundle with synthetic terminal text, raw fixture state, Git diffs, Playwright actions, screenshots, traces, and video.

### Privacy and deliberate disclosure

Default records must be metadata-only. Diagnostic capture must never collect secrets, credentials, environment values, full process arguments, prompts, terminal transcripts, file contents, or Git diffs by default. Content-bearing additions require narrow explicit flags, and some values remain prohibited even with those flags.

### Agent-friendly evidence

Every command must support stable machine-readable output. Bundles should be directories of documented JSON or JSONL plus indexed artifacts, not an opaque proprietary database. A future agent should be able to start from the manifest, identify the relevant task/session/operation, and reconstruct the timeline without reverse-engineering the app.

### Preserve Quarterdeck ownership invariants

Diagnostics must observe existing owners rather than become another owner:

- the browser remains the only writer of durable board state while connected;
- the terminal runtime remains the source of session/process truth;
- diagnostic health checks report divergence but never reconcile or repair it;
- PTY output remains terminal presentation data, not evidence that an agent is working;
- snapshot providers expose bounded read models rather than leaking private mutable maps to a central god object.

## Non-goals

The initial implementation will not provide:

- remote telemetry, automatic uploads, analytics, or a hosted observability service;
- full OpenTelemetry adoption or distributed tracing outside the local Quarterdeck process;
- continuous screenshots, DOM recording, or session replay of a user's active browser;
- attachment to the user's normal browser profile or Chrome remote-debugging port;
- recording of terminal transcripts, prompts, model responses, file contents, Git diffs, or environment variables in the production flight recorder;
- a new stalled-agent heuristic based on terminal output volume or `lastOutputAt`;
- automatic repair, cleanup, process termination, board persistence, session restart, or Git probing from `doctor`;
- replacement of Playwright traces, screenshots, or videos with custom browser-recording code;
- a general application performance profiler in the first milestone;
- a guarantee that exact pixels from an already changed or closed live browser can be reconstructed after the fact.

## Primary workflows

### Investigate something that already happened in a live instance

The user tells an agent to investigate the active Quarterdeck instance. That request grants authority to read the instance's private local diagnostics, but not to mutate the board or sessions.

The agent runs:

```text
quarterdeck diagnostics capture --latest --json
```

The CLI discovers active and recent runtime descriptors, authenticates to the active runtime when it is reachable, requests a read-only snapshot and doctor report, copies the relevant bounded journal window, and writes a private bundle. If the runtime has already exited, the CLI builds the best available bundle from the finalized descriptor and persisted journal.

The command returns the bundle path, runtime instance id, time range, partial-capture warnings, redaction profile, and top-level doctor finding counts. The agent starts with `manifest.json`, then follows record ids and context fields into the timeline and snapshots.

The user does not recreate the problem unless the always-on evidence is insufficient.

### Watch a live task without controlling it

The agent runs a bounded, read-only stream:

```text
quarterdeck diagnostics watch --task <task-id> --duration 60s --jsonl
```

The CLI follows the diagnostic journal or a dedicated authenticated diagnostic stream. It does not connect as a normal board client, trigger interrupted-session resume, participate in project metadata visibility, attach a terminal output listener, or request terminal restore.

### Escalate to temporary deep recording

If the flight recorder does not contain enough detail, the agent can ask the runtime to arm a bounded recording window:

```text
quarterdeck diagnostics record --duration 2m --project <project-id> --task <task-id> --json
```

Deep recording temporarily admits debug-level records and richer timing data for the selected scope. It expires automatically even if the initiating CLI exits. It does not silently enable terminal content, prompts, file contents, request bodies, or full command arguments.

The user reproduces the problem once while the existing UI remains the only board client. The agent then captures the bundle. The Diagnostics panel visibly indicates that deep recording is active and when it will expire.

### Investigate an isolated functional run

The agent starts the existing lab normally. The lab enables its richer safe-for-synthetic-data profile, records browser commands, and asks the same runtime diagnostics API for a snapshot at every explicit checkpoint. Failure and shutdown automatically capture final diagnostic evidence before temporary state is removed.

The resulting artifact directory contains one canonical diagnostic manifest that indexes both shared diagnostics and lab-specific Playwright/Git/state evidence.

### Investigate a visual issue

In the isolated lab, the agent continues to use explicit Playwright screenshots and inspect the image pixels. Semantic browser snapshots and terminal diagnostics supplement rather than replace the screenshot.

For a user's already-running browser, the flight recorder can retain viewport dimensions, layout measurements, terminal slot/socket state, errors, and route/view metadata. It cannot recover exact historical pixels. Exact live visual evidence still requires a user-provided screenshot or an explicitly authorized reproduction in the isolated lab. The implementation must not attach automation to the user's normal browser profile by default.

## Capture tiers

| Tier | Default | Intended use | Included | Excluded |
| --- | --- | --- | --- | --- |
| Flight recorder | always on in every runtime | post-incident lifecycle and failure reconstruction | typed control-plane events, warnings/errors, selected operation timings, health/degraded events, bounded browser essentials | PTY output, prompts, files, diffs, request bodies, render activity, routine successful high-frequency operations |
| Deep recording | manual, scoped, time bounded | reproduce a difficult live issue once | debug records, additional operation stages/timings, more browser transport detail, optional targeted snapshot cadence | terminal or task content unless separately and explicitly requested; secrets are always excluded |
| Agent lab | automatically rich for synthetic runs | autonomous functional and visual debugging | flight recorder, debug records, browser action transcript, browser console/network, live snapshots, synthetic terminal viewport lines, fixture state/Git evidence | user data, real browser profile, real agent credentials/configuration |
| Playwright trace | failure-retained or manually bracketed | intermittent interaction/render/network analysis | DOM snapshots, screenshots, browser console, network timing, video according to Playwright policy | continuous production/live-user capture |

The flight recorder is independent of the configured runtime log level. Normal `logLevel: "warn"` remains appropriate for console verbosity, while essential typed events are always recorded. Deep recording temporarily broadens the recorder's admission policy without persisting a user preference unless the user separately changes the log-level setting.

## Target architecture

```text
Runtime lifecycle  Session transitions  Hooks  Terminal transport  Project state
        |                 |                |            |                 |
        +-----------------+----------------+------------+-----------------+
                                          |
                                  typed record producers
                                          |
                                          v
                              +--------------------------+
                              | Runtime Diagnostics Core |
                              |                          |
                              | admission and redaction  |
                              | bounded memory recorder  |
                              | rotating JSONL journal   |
                              | subscriptions/queries    |
                              +------------+-------------+
                                           |
                   +-----------------------+-----------------------+
                   |                       |                       |
                   v                       v                       v
          Diagnostics CLI         Diagnostics panel       Agent-lab capture
                   |                       ^                       |
                   |                       |                       |
                   |               browser essential batch        |
                   |                       |                       |
                   +-----------------------+-----------------------+
                                           |
                                           v
                                canonical bundle manifest
```

There is one canonical runtime recorder. Browser code maintains only the small local queue necessary to survive temporary runtime disconnection and batch essential client records into the runtime. Once acknowledged, those records become part of the runtime journal and are removed from the browser queue. The Diagnostics panel reads the unified runtime timeline plus the current browser's not-yet-flushed tail; it does not own another historical buffer.

Snapshot collection is separate from continuous recording. Each subsystem owns a narrow read-only diagnostic provider. The bundle/doctor coordinator asks providers for current bounded snapshots on demand. The recorder does not continuously serialize full application state.

## Terminology

### Diagnostic record

A bounded, schema-validated envelope representing one log, lifecycle event, explicit mark, recorder-health event, or browser observation.

### Typed event

A diagnostic record whose `name` and payload have a specific schema, such as `session.process_spawned`, `hook.order_rejected`, or `terminal.restore_completed`.

### Log record

A compatibility record produced by the tagged logging API. In the production flight recorder it preserves level, tag, message length, and content-free data shape/error class—not the arbitrary message or data itself. The synthetic Agent Lab profile may retain the richer bounded message and metadata because real user data is forbidden there. Typed events are preferred for lifecycle reconstruction in both tiers.

### Flight recorder

The always-on admission profile plus its bounded in-memory and rotating on-disk history.

### Deep recording

A scoped, automatically expiring admission profile that includes additional debug/timing records. It is a policy toggle, not a separate recorder.

### Snapshot provider

A subsystem-owned function that returns a bounded immutable diagnostic read model without repairing, mutating, or triggering expensive refresh work.

### Doctor finding

A stable, coded statement produced by comparing current diagnostic snapshots against known invariants. It includes evidence and an explanation but performs no remediation.

### Diagnostic bundle

A directory with a versioned manifest, bounded records, snapshots, findings, and optional indexed artifacts.

### Runtime descriptor

A private atomic file that identifies one current or completed runtime instance and tells the CLI how to authenticate to its diagnostic API or find its persisted journal.

## Diagnostic record model

The exact TypeScript names may evolve during implementation, but the public schema should follow this shape:

```ts
interface DiagnosticRecordEnvelope<TName extends string, TPayload> {
	version: 1;
	id: string;
	sequence: number;
	timestamp: number;
	monotonicOffsetMs: number;
	runtimeInstanceId: string;
	source: "runtime" | "browser" | "agent-lab";
	kind: "event" | "log" | "mark" | "recorder_health";
	level: "debug" | "info" | "warn" | "error";
	name: TName;
	context: DiagnosticContext;
	payload: TPayload;
	truncation?: DiagnosticTruncationSummary;
}

interface DiagnosticContext {
	operationId?: string;
	parentOperationId?: string;
	projectId?: string;
	taskId?: string;
	sessionInstanceId?: string;
	clientId?: string;
	connectionId?: string;
	deliveryId?: string;
	requestId?: string;
}
```

Important schema rules:

- `sequence` is monotonically increasing within one runtime instance and is the primary ordering key; timestamps are supporting evidence rather than the sole ordering mechanism.
- `monotonicOffsetMs` is measured from runtime start so wall-clock changes do not corrupt duration or ordering analysis.
- `runtimeInstanceId` distinguishes restarts that reuse the same state home, port, process id, project, or task ids.
- `sessionInstanceId` distinguishes replacement PTYs for the same task. Diagnostics must never infer process identity from task id alone.
- connection and operation ids are allocated at the boundary where the work begins and propagated through subsequent stages when practical.
- names are stable dotted identifiers rather than free-form messages.
- payloads for typed events are discriminated and bounded. Unknown arbitrary metadata is accepted only through the compatibility log facade and is sanitized before admission.
- records include truncation metadata when fields, arrays, depth, or total size were reduced. Truncation must never produce invalid JSON.
- schema parsing happens at browser ingestion and persisted-journal read boundaries. A malformed record is rejected and counted; it cannot corrupt the rest of the journal.

### Initial record-size policy

The first implementation should use explicit limits, covered by tests:

- maximum serialized record size: 8 KiB;
- maximum individual string: 2 KiB;
- maximum object depth: 6;
- maximum object keys per level: 50;
- maximum array entries: 100;
- circular values become a stable marker;
- errors become bounded `{ name, message, stack }` objects with path normalization;
- values that cannot be represented are replaced with a type marker, not `String(object)`.

The values may be tuned after dogfooding, but unbounded serialization is never permitted.

## Event taxonomy

The first milestone should record the following event families. Not every normal method call needs a record; these are lifecycle boundaries and abnormal outcomes that materially help reconstruct behavior.

### Runtime lifecycle

- `runtime.starting`
- `runtime.listening`
- `runtime.shutdown_requested`
- `runtime.shutdown_completed`
- `runtime.shutdown_failed`
- `runtime.parent_disconnected`
- `runtime.uncaught_error`
- `runtime.unhandled_rejection`
- `runtime.descriptor_write_failed`

Payloads include version, platform family, Node major version, configured host classification, selected port, uptime/duration, and outcome. They do not include environment values, command lines, home paths, or tokens.

### Project and board state

- `project.registered`
- `project.removed`
- `project.stream_snapshot_started`
- `project.stream_snapshot_completed`
- `project.stream_snapshot_failed`
- `project.board_save_started`
- `project.board_save_completed`
- `project.board_save_conflict`
- `project.board_projection_diverged`
- `project.state_load_failed`
- `project.state_parse_failed`

Board-save events include expected/current/result revision and operation duration, not board content. Snapshot events identify whether authoritative session reconciliation changed the projected board, without recording titles, prompts, summaries, or columns wholesale.

### Task session and process lifecycle

- `session.start_requested`
- `session.start_rejected`
- `session.launch_prepared`
- `session.process_spawned`
- `session.process_exit_observed`
- `session.stop_requested`
- `session.stop_wait_completed`
- `session.stop_wait_timed_out`
- `session.resume_requested`
- `session.resume_fallback_used`
- `session.resume_failed`
- `session.auto_restart_scheduled`
- `session.auto_restart_denied`
- `session.reconciliation_applied`
- `session.reconciliation_failed`
- `session.transition_applied`
- `session.transition_ignored`

The payload records agent id, process id, exit code/signal category, previous and next semantic state, transition cause, whether a targeted resume id existed, and high-level launch-path classification. It never records the prompt, image data, command arguments, environment, full executable path, or terminal output.

### Native hooks and delivery

- `hook.received`
- `hook.metadata_applied`
- `hook.order_accepted`
- `hook.order_rejected`
- `hook.transition_applied`
- `hook.transition_ignored`
- `hook.delivery_queued`
- `hook.delivery_acknowledged`
- `hook.delivery_replay_started`
- `hook.delivery_replay_deferred`
- `hook.delivery_expired`
- `hook.ingest_failed`

Payloads use the already-minimized metadata concepts: source, event name, session instance, turn id, tool-use id when documented, delivery id, ordering decision code, and transition result. Native message text, tool input, transcript paths, and conversation summaries are excluded.

### Terminal server transport and restore

- `terminal.io_connected`
- `terminal.io_disconnected`
- `terminal.control_connected`
- `terminal.control_disconnected`
- `terminal.restore_requested`
- `terminal.restore_started`
- `terminal.restore_sent`
- `terminal.restore_completed`
- `terminal.restore_failed`
- `terminal.output_paused_for_restore`
- `terminal.output_resumed_after_restore`
- `terminal.backpressure_entered`
- `terminal.backpressure_cleared`
- `terminal.resize_applied`

Normal PTY output chunks, output byte counters per chunk, cursor changes, and redraws are explicitly excluded. A restore record may include snapshot byte size, rows/columns, elapsed time, queued live-byte count, and connection/session ids, but never the snapshot content in production.

Resize events should be sampled or recorded only when they cross an important attachment/session boundary, are forced for restore, or fail. Routine browser resize noise must not fill the recorder.

### Browser runtime stream and persistence

- `browser.started`
- `browser.runtime_stream_connected`
- `browser.runtime_stream_disconnected`
- `browser.runtime_stream_reconnecting`
- `browser.runtime_message_rejected`
- `browser.project_hydration_applied`
- `browser.project_persist_scheduled`
- `browser.project_persist_completed`
- `browser.project_persist_failed`
- `browser.project_conflict_shown`
- `browser.uncaught_error`
- `browser.unhandled_rejection`
- `browser.request_failed`
- `browser.terminal_slot_role_changed`
- `browser.terminal_restore_ready`
- `browser.terminal_restore_fallback_used`
- `browser.terminal_dom_ceiling_exceeded`

The browser should record semantic state changes and errors, not every runtime message, render, terminal write, hover, focus, or keystroke. Project hydration payloads contain revision/decision metadata only. Browser request failures contain the procedure/category, status/error class, and duration, never request bodies or sensitive URL queries.

### Git and metadata operations

- `git.operation_slow`
- `git.operation_timed_out`
- `git.operation_failed`
- `metadata.refresh_slow`
- `metadata.refresh_timed_out`
- `metadata.refresh_failed`
- `metadata.remote_fetch_failed`

Only slow or failed routine metadata operations belong in the always-on recorder. Deep recording may include successful stage timings. Payloads use a stable operation category, timeout class, limiter queue duration, execution duration, and result code. They do not include arbitrary Git arguments, commit messages, file paths, remote URLs, or command output.

### Recorder health and explicit marks

- `diagnostics.recording_started`
- `diagnostics.recording_expired`
- `diagnostics.recording_stopped`
- `diagnostics.records_dropped`
- `diagnostics.journal_write_failed`
- `diagnostics.browser_batch_rejected`
- `diagnostics.bundle_partial`
- `diagnostics.mark`

Marks allow a user or agent to bracket reproduction without changing application state:

```text
quarterdeck diagnostics mark "before restore reproduction"
```

Mark text is bounded and treated as user-provided diagnostic content. Lab browser actions may create automatic synthetic marks.

## Explicitly prohibited always-on events

The following must never enter the production flight recorder:

- PTY output chunks, aggregate output-rate samples, or `lastOutputAt` updates;
- terminal buffer contents or serialized restore snapshots;
- task prompts, assistant messages, final messages, summaries, or activity text;
- keystrokes, pasted input, shell commands, or prompt shortcut bodies;
- file contents, diff hunks, commit messages, branch names that contain user text, or Git command output;
- environment variables, inherited environment keys, API tokens, authorization headers, cookies, SSH agent details, or user/global agent configuration;
- full process argument vectors or command strings because agent prompts can be positional arguments;
- arbitrary HTTP request/response bodies;
- full repository, home, state-home, or worktree paths before normalization;
- DOM text, form values, or accessibility snapshots from a live user browser;
- routine React renders, pointer events, terminal writes, animation frames, or metadata poll successes.

## Correlation and causal reconstruction

The difficult Quarterdeck bugs are usually ordering bugs. Correlation must therefore be designed into producers rather than inferred later from timestamps.

### Runtime instance

Every runtime creates a random instance id before it initializes diagnostic persistence. All records, descriptors, snapshots, and bundles include it. A PID or port is not a durable runtime identity because both can be reused.

### Operation id

Every user or system operation that crosses asynchronous boundaries should receive an operation id at its entry point. Initial scope:

- task start, resume, restart, and stop;
- project state save;
- hook ingest/delivery replay;
- terminal restore handshake;
- project snapshot load;
- Git mutation and slow metadata refresh.

Nested work carries `parentOperationId` when that relationship is meaningful. This is not a requirement to turn every helper into a tracing span.

### Session instance

PTY-related records must carry the launch-specific `sessionInstanceId` whenever available. A delayed exit from an old PTY must be distinguishable from the currently active replacement for the same task.

### Browser client and connection ids

The browser already has a runtime client identity concept. Diagnostic records should additionally distinguish logical browser client, runtime-stream connection, terminal IO connection, and terminal control connection. Reconnects receive new connection ids while preserving client id.

### Native-hook delivery ids

Reliable hook delivery records reuse the existing delivery id and native turn/session metadata. The diagnostic system observes ordering decisions; it does not create a competing hook chronology.

## Runtime recorder

### Ownership

A focused runtime diagnostics module owns:

- record validation and admission;
- redaction and bounded serialization;
- sequence allocation;
- an in-memory ring;
- asynchronous journal persistence;
- deep-recording policy and expiry;
- subscriptions for the diagnostics API/UI;
- recorder health counters.

It does not own subsystem state, doctor rules, bundle filesystem traversal, browser rendering, runtime state fanout, or application recovery.

Suggested module boundaries:

```text
src/core/api/diagnostics.ts            shared public schemas
src/diagnostics/diagnostic-record.ts   internal typed record helpers
src/diagnostics/bounded-value.ts       redaction and valid bounded serialization
src/diagnostics/recorder.ts            admission, sequence, memory ring
src/diagnostics/journal.ts             rotating JSONL persistence
src/diagnostics/recording-policy.ts    flight/deep admission policy
src/diagnostics/runtime-instance.ts    descriptor lifecycle and authentication token
src/diagnostics/snapshot.ts            provider coordination
src/diagnostics/doctor.ts              pure finding rules
src/diagnostics/bundle.ts              canonical bundle writer
src/commands/diagnostics.ts            CLI registration and output
```

Exact filenames may change to match implementation pressure, but these responsibilities should remain separate.

### Admission policy

The recorder receives candidate records through one API. Admission depends on record kind, level, event name, deep-recording scope, and source category.

Flight-recorder admission includes:

- all typed lifecycle events designated essential;
- all warnings and errors after redaction;
- slow-operation records above subsystem-specific thresholds;
- recorder degradation and dropped-event summaries.

Deep recording additionally includes:

- debug/info compatibility logs for matching project/task/tag scopes;
- successful operation stage timings that are normally suppressed;
- additional browser connection and request timing records;
- explicitly selected diagnostic categories.

Source-level filtering belongs in this admission policy. UI filtering remains a presentation concern. The existing todo for source-level debug filtering should be absorbed here rather than implemented as another logger-specific filter system.

### Memory retention

Proposed initial defaults:

- 2,000 admitted records in the runtime memory ring;
- a separate small reserve for the most recent warnings/errors so a debug flood cannot evict every failure;
- at most 1,000 pending records awaiting disk flush;
- when the pending queue is full, drop lowest-priority debug/info records first;
- summarize dropped counts by source/kind/level in a later `diagnostics.records_dropped` record;
- `getRecentRecords()` returns immutable copies or read-only views.

These values are policy constants with tests and can be tuned without changing producer APIs.

### Journal persistence

Proposed initial defaults:

- JSONL segments under the runtime state home;
- 2 MiB per segment;
- four segments per runtime instance, for an 8 MiB maximum;
- retain the three most recent dead stopped, failed, or unfinalized crashed runtime instances plus the active instance;
- batch flush after 250 ms or 64 queued records, whichever occurs first;
- no per-record `fsync` and no awaited write from application lifecycle code;
- best-effort final flush during graceful shutdown;
- private directory/file permissions (`0700`/`0600` where supported);
- atomic manifest/descriptor updates;
- checksum or byte/count metadata per finalized segment so partial crash tails are detectable.

On startup, a new runtime creates a new instance directory. It never appends to an older runtime's journal. Crash-truncated final JSONL lines are skipped with a partial-journal warning; earlier valid lines remain usable.

Journal failure cannot fail the application. The recorder keeps its memory ring, increments a failure counter, and emits one rate-limited raw stderr warning because the normal persisted sink is degraded. It must not recursively attempt to diagnose every failed diagnostic write.

### Performance acceptance budget

The implementation should adopt measurable gates rather than relying on intuition:

- zero records generated per ordinary PTY output chunk;
- zero board/runtime-state broadcasts caused solely by journal admission or flush;
- zero automatic Git commands, state reloads, terminal snapshots, or DOM walks caused by routine journal persistence;
- no awaited filesystem work in session transition, hook ordering, terminal IO, browser input, or runtime stream fanout paths;
- bounded serializer time and output for adversarial deep/circular metadata;
- less than 1% sustained CPU regression in an isolated terminal-stress comparison, with normal test variance documented;
- no meaningful regression in PTY-to-browser throughput, task transition latency, or `web:e2e` duration;
- bounded memory under an intentional debug flood, with observable dropped-record accounting.

The correctness mechanism still works if journal persistence is disabled or failing; only historical evidence is reduced.

## Runtime instance discovery and authentication

### Descriptor layout

Each runtime writes a private descriptor under its resolved state home, for example:

```text
$QUARTERDECK_STATE_HOME/diagnostics/instances/<runtime-instance-id>/runtime.json
```

Proposed descriptor fields:

```ts
interface RuntimeDiagnosticDescriptor {
	version: 1;
	runtimeInstanceId: string;
	status: "starting" | "ready" | "stopping" | "stopped" | "failed";
	pid: number;
	host: string;
	port: number;
	quarterdeckVersion: string;
	nodeMajorVersion: number;
	platform: "mac" | "linux" | "windows" | "other";
	startedAt: string;
	readyAt: string | null;
	stoppedAt: string | null;
	diagnosticToken: string;
	journalDirectory: string;
	failure: string | null;
}
```

The token is never included in diagnostic bundle output or ordinary `list` JSON. The CLI reads it only from the private descriptor when contacting the runtime.

### Lifecycle rules

- Write `starting` atomically before server listen and update to `ready` after the diagnostic endpoint is reachable.
- Update the selected dynamic port before declaring readiness.
- On graceful shutdown, mark the same instance descriptor stopped only if its instance id still matches; do not delete another process's descriptor.
- Keep finalized descriptors with their bounded journals until retention pruning removes the whole old instance directory.
- On discovery, validate both process liveness and an authenticated runtime instance-id challenge. PID liveness alone is not enough because PIDs can be reused.
- Treat a live PID with a failed challenge as unknown/stale, never as authority to signal or terminate that process.
- Support multiple descriptors in one state home. `--latest` chooses the newest authenticated ready instance, then the newest finalized instance when none are active.
- The isolated lab naturally gets its own descriptor because it already uses a disposable `QUARTERDECK_STATE_HOME`.

### Diagnostic API security

The enriched diagnostic API must require the private random token even though Quarterdeck's ordinary runtime is usually loopback-only. Users can bind Quarterdeck to another interface, and diagnostics expose more internal metadata than the normal UI needs.

Requirements:

- accept the token only in a dedicated header;
- constant-time compare where practical;
- reject it from query parameters so it does not enter URLs or logs;
- never send the descriptor token to the normal browser app;
- keep CORS/host validation in place;
- do not make token failure itself verbose enough to become a probing oracle;
- support CLI access on the same machine without requiring a browser session;
- ensure bundles and `--json` output redact the token.

The browser's essential-record ingest uses a separate random connection-scoped client capability issued through its existing runtime stream, not the descriptor token. That capability authorizes browser diagnostic endpoints only, is replaced when the same client reconnects, and is revoked by the matching client/runtime connection lifecycle rather than an unrelated wall-clock timer.

## Read-only snapshot providers

### Provider contract

Each owning subsystem should expose a narrow method such as `getDiagnosticSnapshot()` or register a provider with the snapshot coordinator. A provider must:

- return a schema-validated bounded object;
- read existing in-memory/cache state where possible;
- avoid repairs, writes, restarts, refresh scheduling, socket attachment, or user-visible effects;
- avoid arbitrary Git or filesystem probes;
- normalize paths and exclude content at the provider boundary;
- report unavailable data explicitly rather than throwing away the entire bundle;
- complete under a short timeout;
- remain independently testable.

The central snapshot coordinator should not reach into private maps across the codebase. That would turn diagnostics into a second architecture owner and make ordinary refactors depend on a giant internal object graph.

### Initial providers

#### Runtime provider

- instance id, version, platform, uptime, host classification, port;
- current console log level and deep-recording state;
- recorder counts, dropped records, journal health, last successful flush;
- shutdown state and registered provider status.

#### Project registry provider

- active project id;
- managed project ids and availability classification;
- per-project terminal-manager presence;
- last project snapshot success/failure metadata;
- no raw project titles, repository paths, remote URLs, or full board content.

#### Project state provider

- project id, board revision, card counts by column, session count;
- last load/save/conflict timestamps and operation ids when available;
- whether authoritative session projection would differ from persisted board placement;
- path aliases rather than actual paths;
- no prompts, task titles, summaries, descriptions, or issue text by default.

#### Terminal session provider

- task id and session instance id;
- summary state/review reason/agent id;
- PID and read-only liveness result;
- pending start, exiting, suppress-restart, restart count, listener counts;
- launch-path classification and existence flag, not raw path;
- hook count/order-state summary without message content;
- terminal mirror presence, rows/columns, serialized byte count, batching state;
- no PTY output or restore snapshot content.

The manager/provider may need purpose-built diagnostic accessors for private process-entry facts. Those accessors should construct immutable bounded summaries inside the terminal layer rather than exposing `entries` directly.

#### Terminal WebSocket provider

- IO/control connection counts;
- connection ids, client/task/session ids;
- attach time, last protocol activity time, current restore stage;
- paused-output and queued-byte counts;
- backpressure state and last transition;
- no socket payloads or terminal bytes.

#### Runtime state-stream provider

- global/project client counts;
- connection ids and project/client association;
- queued batch counts and oldest pending age;
- last snapshot/fanout failure;
- no serialized project payloads.

#### Metadata monitor provider

- focused task/document visibility classification;
- per-project last scheduled/start/success/failure timestamps;
- current in-flight category and age;
- limiter queue counts and oldest wait;
- cached metadata age;
- no automatic refresh triggered by snapshot collection.

#### Hook outbox provider

- pending valid record count;
- oldest/newest age and next expiry;
- replay in-progress state and last replay outcome;
- invalid/expired count observed by the current runtime;
- delivery/task/session identifiers only, never payload text.

#### Persistence/backup/lock provider

- state-home availability and aliased location;
- recent atomic-write/lock failure metadata;
- last successful backup trigger/time and failure;
- stale-lock observations already known to the runtime;
- no cleanup or backup creation caused by diagnostics.

#### Browser provider

When an existing browser client has recently submitted a snapshot:

- client id, route/view category, viewport dimensions, document visibility;
- active project/task ids and board revision metadata;
- runtime-stream connection/reconnect state;
- pending project persistence state;
- terminal pool roles, slot ids, task/session association, socket/restore states;
- terminal DOM counts and layout rectangles for major app surfaces;
- recent redacted warning/error summaries;
- snapshot timestamp and staleness.

No DOM text, form values, task text, terminal content, accessibility tree, or screenshot is included by default.

## Doctor

`doctor` is a pure evaluation layer over collected snapshots and recent record summaries. It reports contradictions and degraded conditions with stable codes. It never fixes them.

Proposed finding shape:

```ts
interface DiagnosticFinding {
	code: string;
	severity: "info" | "warn" | "error";
	summary: string;
	explanation: string;
	context: DiagnosticContext;
	evidenceRecordIds: string[];
	observedAt: number;
	limitations?: string[];
}
```

The finding catalog below includes both implemented rules and evidence-driven candidates. The implemented 2026-08-23 doctor codes are:

- `BOARD_REVISION_CONFLICT_RECENT`
- `BOARD_SESSION_PROJECTION_DIVERGED`
- `DIAGNOSTIC_JOURNAL_DEGRADED`
- `DIAGNOSTIC_PROVIDER_TIMED_OUT`
- `DIAGNOSTIC_RECORDS_DROPPED`
- `DIAGNOSTIC_STREAM_DELIVERIES_DROPPED`
- `HOOK_OUTBOX_DELIVERY_OVERDUE`
- `HOOK_REPLAY_REPEATEDLY_DEFERRED`
- `METADATA_OPERATION_OVERDUE`
- `PROJECT_MANAGER_MISSING`
- `PROJECT_STATE_LOAD_FAILED`
- `RUNTIME_DESCRIPTOR_PERSISTENCE_DEGRADED`
- `RUNTIME_DESCRIPTOR_UNREACHABLE`
- `RUNTIME_STREAM_RECONNECT_LOOP`
- `SESSION_LAUNCH_PATH_MISSING`
- `SESSION_PID_NOT_ALIVE`
- `SESSION_PROCESS_ENTRY_MISSING`
- `SESSION_START_PENDING_TOO_LONG`
- `TERMINAL_BACKPRESSURE_STUCK`
- `TERMINAL_CONTROL_WITHOUT_IO`
- `TERMINAL_DOM_INSTANCE_CEILING_EXCEEDED`
- `TERMINAL_PROCESS_WITHOUT_SESSION_SUMMARY`
- `TERMINAL_RESTORE_HANDSHAKE_STALLED`

The remaining names in the catalog are candidates, not silent implementation claims. Add one only when an owning snapshot or correlated record supplies enough evidence and a lifecycle grace period prevents false positives.

The complete catalog is organized by subsystem:

### Runtime and recorder

- `RUNTIME_DESCRIPTOR_UNREACHABLE`
- `RUNTIME_DESCRIPTOR_PERSISTENCE_DEGRADED`
- `RUNTIME_DESCRIPTOR_INSTANCE_MISMATCH`
- `RUNTIME_SHUTDOWN_INCOMPLETE`
- `DIAGNOSTIC_JOURNAL_DEGRADED`
- `DIAGNOSTIC_RECORDS_DROPPED`
- `DIAGNOSTIC_STREAM_DELIVERIES_DROPPED`
- `DIAGNOSTIC_PROVIDER_TIMED_OUT`

### Board and project state

- `BOARD_SESSION_PROJECTION_DIVERGED`
- `BOARD_REVISION_CONFLICT_RECENT`
- `PROJECT_STATE_LOAD_FAILED`
- `PROJECT_MANAGER_MISSING`

The divergence check is read-only. It must not invoke `saveProjectState` or the low-level state writer.

### Session/process lifecycle

- `SESSION_PID_NOT_ALIVE`
- `SESSION_PROCESS_ENTRY_MISSING`
- `TERMINAL_PROCESS_WITHOUT_SESSION_SUMMARY` (implemented as the combined process/mirror ownership contradiction)
- `PROCESS_EXIT_PENDING_TOO_LONG`
- `SESSION_START_PENDING_TOO_LONG`
- `SESSION_STOP_SUPPRESSION_STUCK`
- `SESSION_LAUNCH_PATH_MISSING`
- `SESSION_WORKTREE_IDENTITY_DIVERGED`
- `RESUME_TARGET_REPEATEDLY_FAILED`

### Hooks

- `HOOK_OUTBOX_DELIVERY_OVERDUE`
- `HOOK_REPLAY_REPEATEDLY_DEFERRED`
- `HOOK_SESSION_INSTANCE_MISMATCH`
- `HOOK_ORDER_REJECTIONS_CLUSTERED`

### Terminal transport

- `TERMINAL_RESTORE_HANDSHAKE_STALLED`
- `TERMINAL_OUTPUT_LEFT_PAUSED`
- `TERMINAL_BACKPRESSURE_STUCK`
- `TERMINAL_CONTROL_WITHOUT_IO`
- `TERMINAL_IO_WITHOUT_PROCESS`
- `TERMINAL_MIRROR_WITHOUT_SESSION` (covered by `TERMINAL_PROCESS_WITHOUT_SESSION_SUMMARY`; split only if remediation differs)
- `TERMINAL_BROWSER_SERVER_SESSION_MISMATCH`
- `TERMINAL_DOM_INSTANCE_CEILING_EXCEEDED`

### Runtime stream and metadata

- `RUNTIME_STREAM_RECONNECT_LOOP`
- `RUNTIME_STREAM_BATCH_STALE`
- `METADATA_OPERATION_OVERDUE`
- `METADATA_LIMITER_QUEUE_STALLED`

Each rule must account for incomplete evidence and lifecycle grace periods. A missing browser snapshot cannot prove a browser-side failure. A just-started or just-exiting process is not stale. Findings should state their limitation instead of manufacturing certainty.

## Browser diagnostics

### Recorder independence from the panel

The browser recorder must initialize with the app, independently of whether the Diagnostics panel is open. The panel is a consumer, not the capture switch.

Flight mode retains only:

- warnings and errors from Quarterdeck client loggers;
- uncaught errors and unhandled rejections;
- selected failed requests;
- runtime-stream connection state changes;
- board persistence conflicts/failures;
- terminal lifecycle/restore/backpressure anomalies;
- terminal DOM ceiling warnings.

Debug and routine info records remain disabled unless deep recording or a user-selected verbose level admits them.

### Browser batching and offline tail

- Maintain a small bounded in-memory queue.
- Batch admitted records to the runtime only when the queue is non-empty, initially every one second or 25 records.
- Use a dedicated typed ingest path, not board persistence or ordinary debug-log fanout.
- Acknowledge the highest accepted browser sequence so the client can drop sent records.
- Keep a capped redacted tail in session storage while disconnected so a page reload can retry it.
- Proposed session-storage cap: 256 KiB with a 24-hour hard expiry.
- Never block navigation, rendering, user input, or unload on diagnostic delivery.
- A best-effort unload beacon may flush the remaining essential tail, but correctness cannot depend on it.
- Record aggregate local drops after reconnect rather than growing unbounded.

### Browser snapshot request

An authenticated CLI capture can ask the runtime to request a one-time diagnostic snapshot from already-connected browser clients. The request travels over the existing runtime connection, but it is explicitly diagnostic and does not make the CLI a board client. Browser clients respond through the diagnostics ingest channel.

The request must:

- have a nonce, deadline, and requested provider list;
- never enable terminal text or content-bearing DOM collection by default;
- gather existing state without clicking, focusing, changing route, attaching a terminal, or resizing a PTY;
- return partial results when some providers are unavailable;
- avoid continuous browser heartbeat snapshots when no capture is requested.

### Diagnostics panel

The current Debug Log panel should become a Diagnostics panel with a single data source and these sections:

- **Timeline**: unified records with level, source, event/tag, context, and search/filtering;
- **Health**: current doctor findings and evidence links;
- **System**: bounded current runtime/browser/provider snapshot;
- **Capture**: export bundle, add mark, start/stop time-bounded deep recording, and view retention/privacy details.

Diagnostics should be discoverable without `QUARTERDECK_DEBUG_MODE`. Developer-only actions such as reopening onboarding should live in a separate Developer Tools dialog still gated by debug mode.

Source/category controls in Diagnostics configure recorder admission for deep recording; visual filters affect only the displayed timeline. The UI must clearly distinguish those two concepts.

### Terminal browser diagnostics

The existing terminal diagnostic collector remains valuable, but its ownership changes:

- `collectTerminalDebugState` or its successor becomes the bounded provider;
- production snapshots retain counts, identities, roles, buffer metrics, socket/restore state, and DOM measurements;
- visible terminal lines remain empty in production;
- the lab profile may include the current bounded visible lines because all data is synthetic;
- `window.__quarterdeckDumpTerminalState()` may remain as a lab/developer compatibility facade that returns the provider snapshot;
- direct console group/table dumping is removed once the Diagnostics panel and lab consume the provider;
- the terminal DOM health monitor emits a typed anomaly record through the browser recorder, retaining only one rate-limited raw-console fallback for recorder failure.

## CLI contract

All commands support human output by default and stable JSON with `--json`. Commands that can run indefinitely require an explicit duration or have a safe default maximum.

### `quarterdeck diagnostics list`

Lists active and recently finalized runtime descriptors for the resolved state home.

Useful fields:

- runtime instance id;
- status and authenticated reachability;
- PID and liveness classification;
- version, host, port, started/stopped time;
- journal availability and time range;
- whether the descriptor appears stale or mismatched.

It never prints diagnostic tokens.

### `quarterdeck diagnostics status`

Returns a lightweight authenticated recorder/runtime status for one instance. It does not invoke every snapshot provider or doctor rule.

### `quarterdeck diagnostics doctor`

Collects read-only snapshots, evaluates invariant rules, and returns findings. Filters include runtime instance, project, task, and provider. A finding-only command should not write a full bundle unless `--output` is supplied.

### `quarterdeck diagnostics capture`

Writes the canonical bundle. Proposed flags:

```text
--latest
--instance <id>
--project <id>
--task <id>
--since <duration>
--until <timestamp>
--output <directory>
--request-browser
--include-terminal
--include-git-diff
--json
```

Content flags are independent and reflected in the manifest. `--include-terminal` and `--include-git-diff` should be rejected for a live production capture in the initial milestone unless a separately reviewed safe implementation exists. They are supported by the synthetic lab enrichment path.

Implementation note: path and task-text flags are intentionally not exposed by the live CLI until a reviewed provider implements the corresponding allowlist. Publishing an inert flag would make a manifest claim authorization without proving that any content was actually collected.

### `quarterdeck diagnostics watch`

Streams existing/new records without joining the normal runtime-state WebSocket. Required safeguards:

- default maximum duration, proposed 60 seconds;
- explicit `--duration` with a reasonable upper bound;
- filters for source, level, event/tag, project, task, session instance, and operation;
- reconnect from last sequence when the active runtime is still the same instance;
- clear termination when the runtime instance changes.

### `quarterdeck diagnostics record`

Starts, reports, or stops deep recording. Start requires a duration and may take project/task/category filters. Proposed maximum duration is 15 minutes unless a future user setting intentionally broadens it. Runtime restart clears deep recording.

### `quarterdeck diagnostics mark`

Adds a bounded explicit mark to the active runtime journal. This is a diagnostic-only mutation and does not touch application state.

### Exit codes

Proposed stable meanings:

- `0`: requested diagnostic operation completed;
- `1`: invalid invocation or unexpected failure;
- `2`: no matching runtime instance;
- `3`: runtime descriptor found but authentication/reachability failed;
- `4`: capture completed partially; bundle exists and contains warnings;
- `5`: doctor completed and found one or more error-severity findings when `--fail-on-error` was requested.

Partial capture should normally return success in human workflows but identify its status in JSON. CI-oriented behavior uses an explicit failure flag rather than making every stale browser snapshot fail the command.

## Canonical bundle

### Directory layout

```text
quarterdeck-diagnostics-<timestamp>-<instance>/
  manifest.json
  README.md
  records.jsonl
  doctor.json
  runtime/
    descriptor.json
    snapshot.json
    recorder-health.json
  projects/
    <project-id>/snapshot.json
  browser/
    clients.json
    <client-id>/snapshot.json
  lab/
    manifest.json
    state/
    git/
    browser-actions.jsonl
    playwright/
      screenshots/
      traces/
      videos/
      console/
      network/
```

Only relevant directories are present. A normal live capture will usually omit `lab/` entirely.

### Manifest

The manifest is the entry point and includes:

- bundle schema version and Quarterdeck version;
- bundle id and source runtime instance id;
- creation time and requested/effective time range;
- selected project/task filters;
- redaction profile and explicitly enabled content flags;
- active/deep/lab capture tier;
- provider completion/timeout/error status;
- record counts by kind/source/level/name family;
- doctor finding counts;
- file inventory with size and SHA-256 hash;
- journal gaps, dropped counts, crash-tail warnings, or missing browser evidence;
- paths represented only relative to bundle root.

The runtime authentication token is never copied.

### Generated README

Every bundle contains a small generated README explaining:

- how to start with the manifest;
- the privacy profile and whether content flags were used;
- how record ordering and context ids work;
- which providers were incomplete;
- where lab/Playwright artifacts live when present;
- that the bundle is local and was not uploaded automatically.

### Atomicity and partial capture

Write a bundle into a temporary sibling directory and finalize it with an atomic rename when possible. If a provider fails, keep the rest of the bundle and record the failure in the manifest. If finalization itself fails, return the temporary path and a clear partial status rather than silently deleting evidence.

## Redaction and privacy model

### Default aliases

Normalize paths before they leave a provider:

- user home becomes `$HOME`;
- runtime state home becomes `$STATE`;
- registered project roots become `$PROJECT:<project-id>`;
- task worktrees become `$WORKTREE:<task-id>`;
- temporary lab root becomes `$LAB_TMP`.

Prefer existence/classification booleans over even aliased paths when the path itself is not necessary.

### Default exclusions

Default live bundles exclude:

- task title, prompt, description, activity text, final message, and conversation summary;
- branch/ref names and commit messages when they may encode user text;
- terminal text and restore snapshots;
- file names when not needed for a finding, file contents, diffs, and Git output;
- request bodies and response bodies;
- full URLs, queries, remote origins, and repository remotes;
- full error data objects before bounded redaction;
- browser DOM/accessibility text and form values;
- process arguments and environment.

### Explicit content flags

Flags must be narrow and independently documented. Enabling one never implies another. The manifest lists each effective flag.

- `includePaths`: retain normalized full local paths where diagnostically required;
- `includeTaskText`: retain selected task titles/summaries, but not prompts or terminal transcript unless a future flag explicitly covers them;
- `includeTerminal`: lab-only initially;
- `includeGitDiff`: lab-only initially.

There should not be a single `--include-everything` escape hatch.

### Values that remain prohibited

Even explicit content capture must never include:

- authorization tokens, cookies, API keys, cloud credentials, private keys, SSH agent material, or diagnostic tokens;
- raw environment dumps;
- global/user agent configuration contents;
- unrelated browser tabs, browser profile data, or stored sessions;
- arbitrary process command lines;
- production data dumps.

### Local storage and sharing

- Diagnostic directories and files are private to the user where the platform supports Unix modes.
- Windows uses the user's state directory and best available private-file semantics; native validation must confirm ACL behavior.
- Quarterdeck never uploads a bundle automatically.
- The UI and CLI warn before producing content-enriched bundles intended for external sharing.
- Automatic retention removes old diagnostic instance directories only within the exact diagnostics root and only after validating their schema/ownership.

## Agent-lab integration

The current lab remains process/data isolated and continues to avoid the user's active Quarterdeck, repositories, browser profile, credentials, and real coding-agent configuration.

### Fixture defaults

The lab fixture should explicitly set `logLevel: "debug"` rather than relying on `QUARTERDECK_DEBUG_MODE`, which only exposes developer UI. Rich logging is appropriate because the fixture is synthetic and the artifact lifetime is bounded.

### Shared diagnostic capture

`agent:lab snapshot` should contact the live disposable runtime first and request the same diagnostic bundle/snapshot used for production. It then adds lab-only evidence:

- raw bounded fixture state JSON;
- main and task-worktree Git status/log/diffs;
- fake-agent protocol/scenario metadata;
- browser action transcript;
- semantic snapshots and explicit screenshots;
- Playwright console/network files, traces, and videos;
- bounded visible terminal viewport lines.

If the disposable runtime is unreachable, snapshot still copies persisted journal/fixture evidence and records that live providers were unavailable.

### Browser action transcript

The `agent:browser` wrapper should append a structured action record for every command associated with a lab session:

- timestamp and monotonic offset when available;
- run/session id;
- command category (`open`, `snapshot`, `click`, `fill`, `type`, `press`, `resize`, `screenshot`, trace controls, console, requests, eval);
- target semantic reference or safe argument summary;
- result/exit status and artifact paths;
- before/after diagnostic mark ids when applicable.

Because lab data is synthetic, text typed into the fake task prompt/terminal may be retained, but wrapper-level environment values and unrelated filesystem arguments remain excluded. The action transcript must never be enabled for a user's normal browser profile.

### Automatic checkpoints

The lab captures shared diagnostics:

- after runtime/browser readiness;
- on explicit `agent:lab snapshot`;
- when a managed runtime or web child exits unexpectedly;
- before shutdown removes temporary state;
- after E2E failure, alongside Playwright failure artifacts.

Tracing remains failure-retained or explicitly bracketed rather than continuously retained for every exploratory action. Screenshots remain explicit because meaningful visual checkpoints require intent.

### Future deterministic fault injection

After the recorder and doctor are stable, the lab can add bounded deterministic fault scenarios that exercise diagnostics:

- delayed/dropped/reordered native hooks;
- hook outbox replay and expiry;
- PTY exit arriving after replacement spawn;
- restore handshake stall or empty snapshot;
- IO/control socket disconnect/reconnect;
- backpressure entry/clear;
- slow/timed-out Git metadata operation;
- board revision conflict between synthetic clients;
- corrupt or partially written persisted state;
- resume-target failure and best-effort fallback.

Fault injection is not required to establish the unified diagnostics foundation and should not be mixed into production runtime policy.

## Migration and removal map

The implementation should move useful producers and delete duplicate infrastructure. Temporary adapters may exist within the feature branch, but the merged result must have one user-facing system.

| Current area | Keep | Move/replace | Delete after migration |
| --- | --- | --- | --- |
| `src/core/runtime-logger.ts` | tagged logger call-site API initially | implement it as a compatibility facade over bounded diagnostics records; preserve console threshold separately | private 200-entry ring, unsafe truncation, independent listener/buffer ownership |
| `src/server/runtime-state-hub.ts` debug logging integration | ability for UI to observe admitted records | use diagnostics subscription/snapshot APIs | `debug_logging_state` and `debug_log_batch` fanout paths |
| `src/server/runtime-state-message-batcher.ts` debug queue | none beyond reusable batching lessons | diagnostic journal/subscription batching owned by diagnostics | debug-log-specific batch queue |
| `src/core/api/streams.ts` debug message schemas | shared log level enum if still useful | shared diagnostics schemas in `src/core/api/diagnostics.ts` | legacy debug stream message schemas after browser migration |
| `web-ui/src/utils/client-logger.ts` | tagged client logger call-site API initially | browser recorder facade with flight/deep admission | global enabled boolean and panel-owned callback history |
| `web-ui/src/utils/global-error-capture.ts` | uncaught error/rejection and console fallback concepts | always-on bounded browser essential capture | panel-only callback wiring and duplicate console interception paths |
| `web-ui/src/hooks/debug/use-debug-logging.ts` | filtering/search UX concepts | diagnostics query/view-model hooks backed by unified records | separate client entries array, cleared-at merging, panel-as-capture-switch behavior |
| `web-ui/src/hooks/debug/debug-logging.ts` | pure filtering helpers that generalize | diagnostics timeline domain module | debug-specific merge logic once one ordered source exists |
| `web-ui/src/components/debug/debug-log-panel.tsx` | virtualized timeline presentation and filters | Diagnostics panel with Timeline/Health/System/Capture | standalone Debug Log panel identity |
| `web-ui/src/components/debug/debug-dialog.tsx` | onboarding test action | separate Developer Tools dialog gated by debug mode | diagnostics association with onboarding |
| `web-ui/src/hooks/debug/use-debug-tools.ts` | developer-mode gating for developer-only actions | separate developer-tools domain | use of debug mode to gate normal diagnostics access |
| `web-ui/src/terminal/terminal-pool-diagnostics.ts` | bounded provider data and lab-only visible-line guard | browser diagnostic snapshot provider and typed anomaly events | console group/table as primary output path |
| `web-ui/src/terminal/terminal-dom-diagnostics.ts` | DOM counting and bounded structural descriptions | terminal diagnostic provider | duplicate consumers once provider is canonical |
| agent-lab supervisor/log files | continuous child stdout/stderr capture | index in canonical lab bundle and explicitly enable debug fixture log level | nothing until shared recorder proves complete; raw child logs remain useful crash fallback |
| `scripts/agent-lab/snapshot.ts` | bounded fixture state and Git artifact collection | call shared live capture first, then enrich under `lab/` | treating copied persisted JSON as the complete runtime diagnostic snapshot |
| `scripts/agent-browser.ts` | isolated Playwright wrapper and loopback restrictions | append lab-only action transcript and diagnostic marks | no live-user attach mode |
| global `logLevel` config | user control over console/verbose log admission | diagnostics Capture UI clarifies persistent log level vs temporary deep recording | nothing initially |
| `QUARTERDECK_DEBUG_MODE` / `debugModeEnabled` | developer-only tooling gate | no longer gates Diagnostics panel | debug-mode coupling to support diagnostics |
| `docs/todo.md` source-level filtering item | requirement | fold into diagnostics admission policy | standalone competing backlog item |

Raw runtime/web process logs remain in agent-lab artifacts as a crash fallback. They are indexed by the same bundle manifest rather than treated as a second user-facing diagnostics system.

## Implementation phases

The phases protect correctness and make removal gates explicit. The work can land as one final feature branch, but validation should happen at each boundary.

### Phase 0: Baseline and contract tests

Before changing behavior:

- record current terminal-stress throughput and E2E duration in the same environment used for after-comparison;
- add characterization tests for runtime logger level gating, ring behavior, browser panel capture behavior, debug stream seeding/batching, terminal diagnostics, and lab snapshot contents where missing;
- define shared diagnostics schemas and privacy sentinel fixtures;
- identify every consumer of legacy debug stream messages and logger listeners;
- verify the feature branch starts from current local `main` before broad edits.

Exit criteria:

- baseline commands and measurements are documented;
- all existing consumers are enumerated;
- no production behavior has changed.

### Phase 1: Core recorder, sanitizer, and journal

Implement:

- shared record schemas;
- safe bounded serializer/redactor;
- runtime instance id;
- admission policy;
- memory ring and priority reserve;
- bounded queue/drop accounting;
- rotating JSONL journal;
- compatibility server tagged-logger facade;
- recorder failure behavior.

Keep the existing browser debug stream temporarily fed by an adapter so the UI remains functional during migration. Do not maintain both histories: the adapter reads the recorder.

Exit criteria:

- structured and log records survive round trip through journal parsing;
- oversized/circular/adversarial values remain valid and bounded;
- recorder/journal failure cannot fail application operations;
- legacy debug UI shows records sourced from the new recorder;
- performance and privacy unit tests pass.

### Phase 2: Runtime producers, descriptor, providers, doctor, and CLI

Implement:

- essential runtime/session/hook/terminal/project event producers at ownership boundaries;
- runtime descriptor lifecycle and authenticated diagnostic API;
- narrow read-only provider snapshots;
- pure doctor rules and stable finding codes;
- `list`, `status`, `doctor`, `capture`, `watch`, `record`, and `mark` CLI commands;
- canonical bundle writer and manifest.

Do not add browser ingestion yet beyond any minimal compatibility needed. Live bundles may state that browser evidence is unavailable.

Exit criteria:

- a new CLI process discovers a dynamic-port runtime and captures it;
- a finalized/crashed instance journal can be captured without a live server;
- `doctor` performs no writes or refreshes;
- diagnostics API rejects missing/invalid tokens;
- task/session/restore races are distinguishable by instance/operation ids;
- default bundles contain no privacy sentinels.

### Phase 3: Browser recorder, snapshot, and Diagnostics panel

Implement:

- always-on essential browser recorder;
- bounded offline tail and acknowledged batch ingestion;
- runtime-issued browser diagnostic capability;
- one-time browser snapshot request/response;
- unified diagnostics timeline store and hooks;
- Diagnostics panel sections;
- explicit deep-recording UI with auto-expiry;
- separate Developer Tools dialog for onboarding/testing actions;
- terminal provider integration.

Migrate every browser consumer away from legacy debug stream messages and panel-owned capture.

Exit criteria:

- errors before the panel opens appear in the unified timeline/bundle;
- opening/closing the panel has no effect on flight capture;
- browser batching does not alter board persistence or normal runtime state;
- production browser snapshots contain no terminal/DOM/task text;
- existing terminal DOM ceiling warning appears as a typed record;
- panel and CLI report the same runtime record ids/order.

### Phase 4: Agent-lab integration

Implement:

- debug log level in the synthetic fixture;
- shared diagnostic capture at lab readiness/checkpoint/failure/shutdown;
- browser action transcript;
- canonical bundle manifest indexing existing Playwright/process/state/Git evidence;
- lab-only bounded terminal visible lines through the shared provider;
- failure fallback when runtime diagnostic API is unreachable.

Exit criteria:

- one lab run produces a self-contained replay-oriented bundle;
- action transcript, diagnostic timeline, screenshots, and state snapshot use comparable timestamps/marks;
- lab stop still closes the browser and removes disposable state;
- user environment, browser profile, repository, and credentials remain isolated.

### Phase 5: Legacy deletion and naming cleanup

Delete:

- runtime logger's independent ring/listener history;
- debug-log-specific runtime stream schemas/messages/batching;
- browser panel-owned client entry arrays and enable callback;
- console-only terminal dump plumbing no longer used as a degraded fallback;
- duplicate filtering/merge utilities;
- old Debug Log naming and docs;
- standalone source-level filtering todo.

Run repository-wide searches to prove no legacy symbols or message types remain. Update architecture, development/testing documentation, the repo skill, changelog, todo, and implementation log as required by release hygiene.

Exit criteria:

- exactly one canonical recorder/history exists per runtime;
- exactly one browser diagnostic queue exists per client;
- exactly one Diagnostics panel and one bundle format exist;
- developer-only tools are clearly separate;
- no compatibility adapter remains without a documented reason and deletion trigger.

### Phase 6: Dogfood and performance gate

Validate on an isolated lab first, then with explicit permission against a live instance:

- incident occurs before agent starts;
- current runtime remains alive;
- runtime crashes and restarts before capture;
- browser refreshes after an error;
- browser is disconnected while essential events occur;
- task PTY is replaced while an old exit arrives;
- restore handshake stalls;
- hook delivery queues and replays;
- board revision conflict occurs;
- terminal stress produces high output volume;
- debug flood hits queue/rotation bounds;
- disk journal becomes unwritable;
- multiple runtime descriptors exist;
- dynamic port discovery works;
- content sentinel values never appear in default bundles.

Do not declare the migration complete until performance comparison confirms the always-on recorder stayed within budget and a post-incident investigation succeeds without pre-enabling debug mode.

## Testing strategy

### Unit tests

- schema acceptance/rejection for every record kind;
- stable sequence and runtime-instance behavior;
- bounded serializer depth/string/key/array/record limits;
- circular structures, errors, BigInt, buffers, maps/sets, getters that throw, and invalid Unicode where relevant;
- path, URL, header, token, and error-stack redaction;
- admission policy by tier/level/source/category/scope;
- deep-recording expiry and restart reset;
- memory-ring eviction and warning/error reserve;
- queue overflow priority and dropped summary;
- JSONL rotation, crash-tail parsing, checksums, and retention;
- recorder/journal failure isolation;
- pure doctor findings, grace periods, incomplete evidence, and severity;
- descriptor schema, atomic updates, PID reuse challenge, stale/finalized selection;
- bundle manifest hashes and partial-provider behavior;
- CLI option parsing, JSON output, exit codes, and token redaction;
- browser queue batching, acknowledgment, reconnect retry, session-storage cap/expiry, and local drops;
- Diagnostics panel filtering versus admission controls;
- terminal provider production/lab content boundary.

### Integration tests

- launch on dynamic port, discover descriptor, authenticate, and capture;
- reject unauthenticated diagnostic API requests;
- capture a stopped/crashed runtime from persisted journal;
- multiple runtime instances under one state home;
- snapshot every runtime provider without application mutations;
- verify board revision/files remain unchanged after `doctor` and `capture`;
- verify no terminal attach/resize/restore request occurs from diagnostics inspection;
- correlate task start, hook transition, process exit, and replacement session;
- client diagnostic batch enters the canonical runtime sequence once;
- runtime reconnect requests browser tail without duplication;
- bundle privacy sentinel scan.

### Browser tests

- client warning/error before panel open is retained;
- routine debug record is excluded in flight mode and included during scoped deep recording;
- recording visibly expires;
- browser snapshot collects metrics without DOM/terminal text;
- terminal DOM ceiling produces one rate-limited typed record;
- panel uses the unified ordered timeline;
- developer onboarding action remains available only in Developer Tools;
- no board persistence call is triggered by opening Diagnostics or exporting a browser snapshot.

### E2E and lab tests

- existing create/start/review fake-agent smoke path still passes;
- diagnostic events reconstruct the same state transition;
- `agent:lab snapshot` includes shared and lab-only evidence;
- browser action transcript records exact synthetic steps;
- a forced child failure still leaves a partial bundle;
- screenshot, trace, console, requests, and diagnostic manifest paths resolve;
- lab final cleanup and stale-run handling remain correct.

### Performance tests

- compare terminal-stress CPU, memory, runtime-state broadcast count, PTY throughput, and browser frame responsiveness before/after;
- prove journal record count does not scale with PTY output chunk count;
- flood debug candidates and confirm fixed memory/disk/queue limits;
- verify journal batching does not create one write per record;
- verify disconnected browser queue remains bounded;
- measure snapshot/doctor latency separately because it is on demand.

### Privacy tests

Seed unmistakable sentinel values into:

- task prompts/titles/summaries;
- terminal output and input;
- environment/API token fields;
- project/home/worktree paths;
- Git branches, commit messages, remotes, diffs, and files;
- HTTP bodies/headers/query strings;
- browser DOM/form values.

Generate a default live bundle and assert no prohibited sentinel occurs anywhere, including generated README, manifest, hashes metadata, error messages, and partial-capture warnings. Then test each narrow content flag independently.

## Failure behavior

Diagnostics must degrade safely:

- recorder unavailable: application continues, tagged logs still honor console policy, one rate-limited raw warning is allowed;
- journal unwritable: memory history remains, health reports degraded persistence;
- descriptor unwritable: runtime may still start, but prints a clear bounded warning and `diagnostics list` cannot discover it automatically;
- one provider times out: bundle is partial and identifies that provider;
- browser client does not respond: runtime bundle completes with a stale/missing-browser limitation;
- malformed browser batch: reject batch, preserve runtime, count/rate-limit the rejection;
- journal final line is partial after crash: skip only that line;
- bundle hash/final rename fails: return partial directory and explicit error;
- deep-recording initiator disappears: recording still expires at its deadline;
- runtime restarts: new instance id and flight recorder; deep recording is not inherited;
- diagnostic consumer is slow: bounded subscription queue drops low-priority records and reports the gap rather than pressuring application streams.

## Cross-platform requirements

- Use platform-neutral path construction and atomic-write helpers already established in the repo.
- Unix descriptors/journals/bundles use private modes.
- Validate Windows privacy semantics rather than assuming `mode: 0o600` enforces ACLs.
- Runtime/PID validation must account for PID reuse on every platform.
- Do not use Unix signals as the diagnostics discovery mechanism.
- JSONL uses UTF-8 and `\n`; parsers tolerate the platform's final-line behavior.
- Watch mode must handle Windows file-watching differences or use authenticated polling/streaming instead of depending on `fs.watch` semantics.
- Diagnostic path aliases use normalized separators so bundles compare across platforms.

## Documentation and release hygiene

When implementation begins and lands:

- update [`architecture.md`](./architecture.md) with the stable diagnostics ownership boundary;
- update [`agent-functional-testing.md`](./agent-functional-testing.md) with the new shared bundle/snapshot workflow;
- update the repo-owned `quarterdeck-functional-testing` skill with canonical commands and artifact interpretation;
- update `DEVELOPMENT.md` with diagnostics CLI and performance/privacy expectations;
- replace the active todo item with any genuinely remaining follow-ups;
- remove the standalone source-level debug filtering todo because its requirement belongs to admission policy;
- add a `CHANGELOG.md` entry under the current version;
- add a high-signal `docs/implementation-log.md` entry because this changes cross-cutting diagnostics ownership, persistence, runtime lifecycle, browser transport, and agent-lab behavior;
- retain this exhaustive plan in the live docs map as the diagnostics architecture/operations source of truth; unlike ordinary completed plans, the user explicitly requested preservation of its full context. Keep status and staged coverage accurate as implementation evolves.

## Decisions already made

These decisions should not be reopened without new evidence:

- one unified diagnostics system will replace fragmented debug histories;
- lightweight flight recording is automatic and does not require prior user enablement;
- deep recording is manual, scoped, and automatically expires;
- the flight recorder is independent from console log level;
- typed lifecycle events are preferred over adding many free-form log messages;
- logs and events are record kinds within one recorder, not parallel subsystems;
- production capture excludes terminal/task/file/environment content by default;
- essential browser errors and lifecycle events must be captured even when the Diagnostics panel is closed;
- live inspection is read-only and must not open a second writable Quarterdeck board client;
- doctor reports but never repairs;
- no diagnostic event is driven by ordinary PTY output;
- lab and live runtime share core schemas/providers/bundles;
- the lab may enrich shared diagnostics with synthetic content and Playwright artifacts;
- exact pixels from a past live browser state cannot be promised;
- Playwright must not attach to the user's normal browser profile by default;
- old buffers, transports, and UI capture switches are deleted after migration rather than retained indefinitely.

## Recommended initial defaults requiring dogfood confirmation

These are concrete starting points, not immutable architecture:

- runtime memory ring: 2,000 records;
- browser essential offline tail: 256 KiB and 24 hours;
- pending runtime journal queue: 1,000 records;
- record limit: 8 KiB;
- string limit: 2 KiB;
- journal segment: 2 MiB;
- journal segments per runtime: four;
- completed runtime instances retained: three;
- journal flush: 250 ms or 64 records;
- browser batch: one second or 25 records;
- default watch duration: 60 seconds;
- maximum initial deep-recording duration: 15 minutes;
- provider timeout: short and provider-specific, with an initial default around two seconds;
- terminal/layout snapshot collection: only on explicit capture, not a continuous heartbeat.

Tune these with measured artifact size, incident usefulness, CPU, memory, and disk behavior. Keep them in replaceable policy modules.

## Resolved implementation choices and remaining validation

- The journal uses batched `appendFile` operations with bounded priority-preserving recovery, rotating JSONL segments, reader-side id deduplication after partial append failures, and capped exponential retries that do not require another event to restart persistence.
- Diagnostics watch uses bounded authenticated polling and resumes by canonical sequence within one runtime instance.
- Browser ingestion uses a connection-scoped capability issued through the existing runtime-state handshake; the capability is revoked with that client connection.
- Runtime memory, journal pending records, browser reconnect records, and live diagnostic delivery use priority-aware eviction in one bounded queue each rather than parallel warning rings. Explicit capture flushes and merges the journal with the memory tail, so the smaller in-memory ring is not mistaken for the complete retained evidence window.
- Slow-operation thresholds stay beside the owning operation; metadata fetches report completion to the runtime diagnostics adapter without importing diagnostics into the policy.
- Diagnostics opens from the top bar or `Cmd/Ctrl+Shift+D`; opening the panel has no admission side effect, but it does connection-scope an explicit best-effort live-delivery subscription. Closing it unsubscribes, and socket backpressure drops that replaceable projection before primary runtime-state traffic.
- Project/task filters propagate through snapshot providers and doctor findings as well as records. Providers omit unrelated project/task-owned lists instead of placing globally captured subsystem state beside a filtered timeline.
- Agent Lab shutdown captures the connected `pre-shutdown` boundary first, then closes the browser, stops the child trees, finalizes the manifest, and only then captures the offline `final` bundle before disposable state removal.
- Production browser layout capture has a fixed allowlist for root, top bar, and terminal parking bounds.
- Three finalized/crashed instances are retained; bundle output is a private checksummed directory in the initial format.
- Windows private-file/ACL semantics remain the precise unvalidated cross-platform item and are tracked in `docs/todo.md`.

These choices remain replaceable policies. Application correctness does not depend on batching, retention, doctor, or capture availability.

## Definition of done

This effort is complete only when all of the following are true:

- a newly started agent can discover and capture a current or recently crashed runtime without prior debug enablement;
- the capture contains a correlated lifecycle timeline and read-only doctor report;
- browser errors that occurred before opening Diagnostics are available when successfully delivered to the runtime;
- default bundles pass privacy sentinel tests;
- exact limits bound runtime memory, browser memory, pending queues, record size, journal disk, and retained instances;
- terminal-stress validation shows no diagnostic work proportional to PTY output volume and remains within the performance budget;
- live diagnostic inspection does not write board state, attach/resize terminals, start/stop sessions, refresh Git metadata, or repair persistence;
- agent-lab snapshots include the shared diagnostic bundle and indexed Playwright/Git/state enrichment;
- one Diagnostics panel, one CLI family, one record schema, one runtime history, and one bundle format remain;
- legacy debug stream messages, independent log buffers, panel-owned capture, and console-only terminal dumps are removed or retained only as explicitly documented degraded fallbacks;
- developer test tools are separated from support diagnostics;
- architecture, testing docs, skill instructions, todo, changelog, and implementation log reflect the final system;
- the feature is validated on macOS and Linux, with Windows behavior either validated or called out by a precise remaining todo.

## First implementation touchpoints

A future implementing agent should begin by re-reading this plan, the architecture guardrails, current `AGENTS.md`, and these files rather than bulk-reading the repo:

- `src/core/runtime-logger.ts`
- `src/core/api/streams.ts`
- `src/core/service-interfaces.ts`
- `src/server/runtime-state-hub.ts`
- `src/server/runtime-state-message-batcher.ts`
- `src/server/runtime-state-client-registry.ts`
- `src/server/runtime-server.ts`
- `src/cli.ts`
- `src/terminal/session-transition-controller.ts`
- `src/terminal/session-lifecycle.ts`
- `src/terminal/session-manager.ts`
- `src/terminal/terminal-state-mirror.ts`
- `src/terminal/ws-server.ts`
- `src/hook-transition-outbox.ts`
- `web-ui/src/utils/client-logger.ts`
- `web-ui/src/utils/global-error-capture.ts`
- `web-ui/src/hooks/debug/`
- `web-ui/src/components/debug/`
- `web-ui/src/runtime/runtime-state-stream-store.ts`
- `web-ui/src/terminal/terminal-pool-diagnostics.ts`
- `web-ui/src/terminal/terminal-dom-diagnostics.ts`
- `scripts/agent-lab/`
- `scripts/agent-browser.ts`
- `web-ui/tests/fixtures.ts`
- `web-ui/playwright.config.ts`

Before frontend implementation, also read [`conventions/web-ui.md`](./conventions/web-ui.md) and [`conventions/frontend-hooks.md`](./conventions/frontend-hooks.md). Before changing the Diagnostics panel's place in the app layout, read [`conventions/ui-layout.md`](./conventions/ui-layout.md).

The first concrete code task should be the shared record schema and bounded serializer with privacy tests. Do not begin by adding new log calls throughout the codebase; producers should be added only after the recorder, limits, redaction, and causal context are established.
