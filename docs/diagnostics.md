# Unified Diagnostics Contract

Quarterdeck has one diagnostics system for runtime, native desktop, browser, terminal, and isolated Agent Lab evidence. The system is designed for post-incident investigation: its lightweight recorder starts automatically, so a newly started agent can inspect recent behavior without asking the user to reproduce the problem after enabling logs.

For commands and operator workflow, see [Unified diagnostics](../DEVELOPMENT.md#unified-diagnostics). For deterministic UI and lifecycle testing, see [Agent functional testing](./agent-functional-testing.md). The completed design plan and migration record are retained in [history](./history/agent-diagnostics-plan.md).

## Stable invariants

- One recorder, schema family, journal, CLI, Diagnostics panel, and bundle format own retained support evidence. Do not introduce a second debug-log ring, WebSocket stream, subsystem buffer, or panel-owned capture path.
- The recorder is metadata-only and bounded by default. Production records exclude prompts, task text, terminal transcripts, file contents, diffs, environment values, full process arguments, request bodies, DOM text, and secrets.
- Deep recording is explicit, scoped, automatically expires within 15 minutes, and remains content-safe. Rich terminal, Git, screenshot, and trace evidence is limited to the synthetic Agent Lab profile.
- Subsystems expose bounded, metadata-only snapshot providers beside their existing state owner. Diagnostics observes those owners; it does not become a second state store or repair path.
- Explicit capture is the durable evidence boundary. A bundle flushes and merges the rotating journal with the memory tail, adds read-only doctor findings and provider snapshots, and records hashes in its manifest.
- Journal write failure retains a bounded pending queue and schedules capped retry without waiting for another event. The smaller memory ring and record-only filtering are not substitutes for the scoped durable bundle.
- Diagnostic reads must not connect as a board client, write project state, attach or resize a PTY, refresh Git, or repair runtime state.
- Live browser delivery is a replaceable projection for the open Diagnostics panel, not the recorder. Only the exact connection capability with the panel open subscribes; closing or revoking it unsubscribes, and browser refresh hydrates a bounded canonical tail explicitly rather than seeding every board WebSocket. Backpressure drops diagnostic traffic before primary runtime-state traffic.
- Production compatibility logs remain content-free even at warning and error levels. Prefer structured, bounded metadata and validated error classes over arbitrary logger payloads or thrown messages.
- Diagnostic filesystem privacy is enforced before content is written. POSIX directories/files remain owner-only; Windows directories receive a protected inheritable DACL granting full control only to the current user and LocalSystem. ACL failure must not write a descriptor, journal, bundle, Agent Lab manifest/evidence, or browser-profile tail into a broadly inherited directory. Generated evidence names must also remain Windows-safe after truncation (including device-name, alternate-data-stream, control-character, and trailing-dot/space checks), and path redaction must recognize drive/UNC paths containing spaces.

## Operator entry points

Start an investigation with the CLI:

```text
quarterdeck diagnostics list
quarterdeck diagnostics status
quarterdeck diagnostics doctor
quarterdeck diagnostics capture
quarterdeck diagnostics watch
```

Use `record` only when the automatic lightweight history is insufficient, and use `mark` to place a bounded correlation point in the timeline. `doctor` and `capture` can request a fresh metadata-only browser snapshot when a connected browser is available.

Start bundle analysis at `manifest.json`, then correlate:

- `records.jsonl` for ordered runtime, browser, and lab events;
- `doctor.json` for scoped findings;
- provider snapshots for bounded current state; and
- indexed evidence for synthetic lab screenshots, traces, Git state, and terminal viewport text.

Diagnostics can report layout bounds and terminal metrics, but it cannot reconstruct historical pixels. Use Agent Lab screenshots or Playwright traces when visual truth matters.

## Desktop evidence

The native main process uses the same bounded recorder and private journal under the canonical state home. Its descriptor has `processKind: "desktop"` and no HTTP endpoint. Older descriptors without a role remain runtime evidence. Desktop evidence never participates in runtime admission, project ownership, relocation exclusion, or authenticated endpoint discovery.

Fixed metadata events cover startup, window/lifecycle decisions, helper generations, updater state, and shutdown outcomes. Each carries a bounded observed state; no environment values, command arguments, arbitrary errors, prompts, or editor contents are accepted. A normal forced quit remains explicitly unconfirmed and does not report safe ownership release or update installation. Recorder closure describes evidence finalization, not runtime cleanup.

An owned helper receives validated desktop metadata over private parent IPC and records it in its existing recorder. Its desktop snapshot provider retains only the latest observed state and timestamp. Canonical main records can be replayed in batches of at most 100; transport backpressure may discard pending projection records while the main journal retains the evidence. Attached runtimes do not ingest another app's desktop records.

`diagnostics list` identifies desktop journals. `status`, `watch`, `doctor`, and `capture --instance <id>` read them locally, including failures before a helper becomes ready. Journal snapshots are explicitly last-observed evidence; current recorder health and subsystem state are unavailable through this path. The default selector prefers an authenticated runtime when present. `record` and `mark` require the owning runtime's authenticated endpoint and never write another process's journal.

Native desktop export uses a folder picker and the canonical bundle writer. It exports authenticated owned-helper evidence when that generation is still selected, otherwise the exact main-process journal. An attached desktop exports its own journal; use the shared Diagnostics UI or CLI to export the independent runtime. Export accepts no renderer-supplied destination, enables no unrestricted downloads, and cancellation produces no export effects. Bundle descriptors identify the exported role and omit credentials.

## Implementation ownership

The core schema, recorder, journal, bundle writer, doctor, and capture policy live under `src/diagnostics/`. Runtime discovery and authenticated read-only access are wired by the server. Native event admission and export live under `desktop/src/`, with fixed contracts in `src/core/api/desktop-diagnostics.ts`. Browser recording and panel projection live under `web-ui/src/diagnostics/`. Agent Lab enriches the shared bundle contract under `scripts/agent-lab/` without widening production capture.

When changing the system, preserve these ownership boundaries:

1. Record structured events at the subsystem that owns the state transition.
2. Keep queues, rings, snapshots, and payloads bounded.
3. Propagate project, task, session, operation, and connection identifiers when available.
4. Keep capture and doctor checks read-only.
5. Add synthetic-only evidence through Agent Lab's explicit evidence index.
6. Update the CLI and bundle schema together when the public diagnostic contract changes.

## Validation

Follow [`testing.md`](./testing.md). Validate schema and recorder changes with the focused diagnostics tests, adding the relevant HTTP, bundle, or browser-delivery boundary when it changed. Use isolated Agent Lab for synthetic browser delivery, terminal metrics, lifecycle races, or visual evidence only when those surfaces are part of the claim; never use the user's active Quarterdeck instance. A normal repository check is a final broad gate, not a required companion to every diagnostics test run.
