# Conversation Provider Boundary Spike

Status: Decisions A and B completed on 2026-08-24. P2B is unblocked, and the separately authorized ownership experiment established the constraints for a future P3 implementation. No provider integration, task handoff, remote listener, authentication, or mobile UI is implemented on `main` by these decision records.

This document is the self-contained handoff for deciding how Quarterdeck should read recent Claude Code and Codex conversations and, separately, whether a future mobile interaction service should take exclusive execution ownership from the native desktop TUI.

The parent plan is [`remote-companion-plan.md`](./remote-companion-plan.md). Current prioritization is in [`todo.md`](./todo.md). The architecture rules in [`conventions/architecture-guardrails.md`](./conventions/architecture-guardrails.md) apply throughout this investigation.

## Executive Summary

The P2 read-source spike is complete. Production P2B conversation adapters may now be implemented against the decision and limits below.

Two discoveries changed the original P2 assumptions:

1. Mobile v1 needs only a small recent window of meaningful user and assistant messages. It does not need full-history browsing, mature tool rendering, terminal output, reasoning, or provider metadata.
2. Both supported providers now expose official structured session interfaces that may remove or reduce the need for Quarterdeck to parse raw provider JSONL:
   - Claude Code's Agent SDK can read messages for an exact stored session and can resume that session programmatically.
   - Codex app-server can read and resume an exact stored thread, stream structured turn events, and has an experimental newest-first paginated history API.

The interfaces are useful for structured execution, but the read experiments found that neither is an acceptable P2 durable-history boundary:

- Claude Agent SDK `getSessionMessages(...)` reconstructs the session before applying `offset`/`limit`, and `limit` selects the oldest prefix rather than the recent tail.
- Codex app-server history pagination is experimental. For the legacy rollout format used by both tested Quarterdeck-supported Codex versions, a page request still replays the complete rollout before returning the bounded page. App-server also synthesized different item IDs for the same persisted record across tested versions.

The spike records two separate outcomes:

- **Decision A — P2 read source:** use bounded raw provider-history parsing for both Claude Code and Codex. The service owns exact-session resolution, canonical containment, resource limits, stable normalization, and typed degradation.
- **Decision B — future P3 execution ownership:** supported with documented constraints for both providers. Authenticated native-TUI -> structured owner -> native-TUI round trips preserved exact Claude and Codex session identity, durable lineage, and single-writer stop/wait ordering; production still requires a durable coordinator and compatibility gates.

Decision A unblocks P2B. Decision B unblocks the separately scoped P3 ownership implementation, but does not add it; P2B remains strictly read-only and independent of execution ownership.

Live structured events may later accelerate an already-active structured owner, but they are not the durable read source and must not become a second Quarterdeck-owned transcript.

## Product Decision

Remote Companion v1 is a recent-context product, not a transcript browser.

The phone needs enough context to understand the current task state and respond. P2B therefore returns 10 meaningful messages by default and permits at most 24. Ten is approximately five user/assistant exchanges and sits in the original 8–12 product range; 24 is a deliberate escape hatch, not a full-history mode. The aggregate read examines at most 4 MiB and 4,096 records, an individual provider record may contribute at most 1 MiB to parsing, normalized message text is capped at 32 KiB, and the serialized provider-neutral result is capped at 128 KiB. At most four presentation boundaries may accompany the messages. Diagnostics are capped at 2 KiB and the complete lookup/read operation has a two-second deadline.

These limits favor a useful recent tail while staying well below Quarterdeck's existing MiB-scale request and diagnostics boundaries. The response cap intentionally prevents the entry-count and per-message maxima from multiplying into a large mobile payload. Hitting any reconstruction limit is represented honestly; it never triggers an unbounded retry.

The consumer-facing conversation contains only:

- User-authored text.
- Assistant-authored text.
- Useful presentation boundaries: started, resumed, restarted, compacted, and history gap/truncation.
- Explicit availability or degradation information.

It excludes:

- Tool calls and tool results.
- Thinking, reasoning, plans, hidden chain-of-thought, and system prompts.
- Commands, working directories, paths, files, diffs, patches, and terminal output.
- Raw errors, provider records, usage/account metadata, and launch arguments.
- Pi. Pi is legacy and experimental and must not shape this boundary.

Full-history browsing, load-older pagination, and rich tool rendering may be added later only after demonstrated product need. The contract may reserve an opaque older-window cursor, but P2 must not implement an expensive general-purpose transcript browser merely for theoretical flexibility.

## Terminology

Use these terms consistently during the spike and implementation:

- **Provider session identity:** the exact Claude session UUID or Codex thread/resume ID stored by Quarterdeck for a task.
- **Provider durable history:** the provider-owned persisted conversation used to resume an exact session. Today both providers ultimately persist local session records.
- **Structured live stream:** JSON/JSONL or SDK/app-server events emitted while a programmatic runner is active. A live stream is not automatically durable or replayable.
- **Recent window:** the bounded provider-neutral user/assistant tail returned by P2.
- **Execution owner:** the one process/interface allowed to append turns, answer prompts, approve actions, interrupt work, or otherwise control a task session.
- **Read consumer:** a local or future remote projection that may observe a recent window without owning execution.
- **Ownership handoff:** a confirmed stop-and-wait of one execution owner followed by an exact-session resume under another owner.
- **Native mode:** the existing Claude Code or Codex interactive TUI running in Quarterdeck's task PTY.
- **Structured mode:** a future Claude Agent SDK or Codex app-server runner owned by Quarterdeck and projected as typed events rather than terminal bytes.

Multiple read consumers are safe in principle. Multiple execution owners are not.

## Current Quarterdeck Baseline

Current work context when this handoff was written:

- Working branch: `feature/remote-conversation-reads`.
- Local base: `feature/remote-access` at `5cf2c00b` (`docs: record remote readiness validation`).
- The base satisfies the original requirement that local `feature/remote-access` contain `5cf2c00b` or newer.
- No P2 production implementation or provider dependency has been added. The branch contains only the documentation that reframes P2 around this evidence gate.
- The repository currently has no `@anthropic-ai/claude-agent-sdk` dependency and no Codex app-server client. Verify this again before starting because the branch may advance.
- Do not merge another branch merely to begin the spike. Preserve unrelated work and any existing untracked `docs/archive` item.

The fresh investigator must verify these statements against current code before relying on them:

- Claude Code and Codex are the only supported forward-looking task agents. Current minimum versions are declared in `src/config/agent-registry.ts`; at the time this document was written they were Claude Code `2.1.198` and Codex `0.142.5`.
- Quarterdeck launches both providers as native interactive TUIs inside task PTYs.
- `RuntimeTaskSessionSummary.resumeSessionId` is server-owned and populated from provider identity hooks. It is the exact resume/session identity to use; never substitute a provider-global latest session.
- `RuntimeTaskSessionSummary.sessionLaunchPath` is the cwd used to launch the current session, not a continuously updated cwd stream and not the authoritative task worktree identity.
- Native hooks and `SessionTransitionController` own lifecycle semantics. Conversation content, timestamps, terminal output, and provider history cannot move cards or change session state.
- `ProjectBoardCommandService` is the only production durable board writer. Conversation reads and provider experiments must not write board state or consume a board revision.
- Generic PTY input is a local desktop capability and is not a future remote capability.
- Task-agent terminals and shell terminals are separate lifecycle domains.
- Missing, pruned, or malformed provider history must degrade only conversation reading.

Before experiments that touch task lifecycle, also read:

- `AGENTS.md`
- `docs/remote-companion-plan.md`
- `docs/todo.md`
- `docs/conventions/architecture-guardrails.md`
- `src/terminal/session-summary-store.ts`
- `src/terminal/session-transition-controller.ts`
- `src/terminal/session-lifecycle-controller.ts`
- `src/terminal/session-reconciliation.ts`
- `src/terminal/agent-session-adapters.ts`
- `src/server/startup-session-recovery.ts`
- `src/server/project-task-lifecycle-service.ts`

Do not use the user's active Quarterdeck runtime or real provider history. Use isolated temporary HOME/state/project roots and fake or purpose-created provider sessions.

Automated evidence must use fake provider processes, synthetic provider history, and disposable roots. If a claim cannot be verified without an authenticated real-provider run, stop and request explicit authorization plus a credential-isolation plan. Do not copy credentials into a temporary HOME, fixture, log, diagnostic bundle, or test artifact, and do not quietly relax Agent Lab's credential stripping.

## Provider Capabilities To Verify

Documentation establishes possibilities, not Quarterdeck compatibility. Record the exact provider binary and SDK versions used for every result.

### Claude Code

Relevant official documentation:

- [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Agent SDK session management](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Claude Code session management](https://code.claude.com/docs/en/sessions)
- [Programmatic/headless mode](https://code.claude.com/docs/en/headless)
- [Streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)

Documented capabilities that require verification:

- `getSessionMessages(sessionId, { dir, limit, offset })` reads user and assistant records for a stored session and exposes message UUIDs.
- Exact `resume` continues a specific session rather than a cwd-global latest session.
- Programmatic sessions remain resumable by the native CLI using an exact session ID even when they do not appear in the normal picker.
- Programmatic output can be emitted as structured JSON/JSONL.
- The Agent SDK can run a persistent interactive stream with structured events, questions, and permissions.
- Claude persists session history beneath its provider-owned project history root.

Unknowns the spike must answer:

- Does `getSessionMessages(..., limit)` select a recent tail or the oldest prefix?
- Does it avoid reading/scanning an unbounded file internally? Measure or inspect the installed implementation; do not infer from the parameter name.
- Does the reader return only the post-compaction linked chain, and how is older-history availability represented?
- Does it preserve native UUIDs for every user/assistant message Quarterdeck needs?
- Does an interactive-TUI-created session resume cleanly in the Agent SDK with the same cwd, instructions, settings, hooks, tools, model, permissions, sandbox, and session identity?
- Does an SDK-owned session hand back cleanly to `claude --resume <exact-id>`?
- What happens if the same session is accidentally opened by two writers? Claude documentation warns that messages interleave when the same session is resumed in two terminals; Quarterdeck must prevent this state rather than reconcile it afterward.
- How do incomplete JSONL tails, isolated malformed records, pruned files, retention cleanup, and compaction surface through the SDK reader?
- Is adding `@anthropic-ai/claude-agent-sdk` necessary, and if so can Quarterdeck use the separately installed Claude executable rather than introducing a second mismatched provider binary?

### Codex

Relevant official OpenAI documentation:

- [Codex app-server](https://developers.openai.com/codex/app-server)
- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)

Documented capabilities that require verification:

- `codex exec --json` emits a JSONL live event stream, including thread, turn, item, and error events.
- `codex app-server` exposes a versioned JSON-RPC protocol and can generate TypeScript or JSON Schema definitions matching the installed Codex version.
- `thread/read` reads an exact stored thread without resuming it.
- `thread/resume` reopens an exact stored thread so later `turn/start` calls append to it.
- `turn/start`, `turn/steer`, and `turn/interrupt` provide structured control and events.
- `thread/turns/list` and `thread/items/list` can page stored history; the documented turns API defaults newest-first, but these APIs are currently experimental.
- app-server can surface structured approval and user-input requests.

Unknowns the spike must answer:

- Which of these methods exist and are stable in Quarterdeck's minimum supported Codex version, not merely the investigator's latest installed version?
- Does current `thread/read(includeTurns: true)` materialize full history and therefore violate the bounded-tail rule?
- Does experimental newest-first pagination behave deterministically for legacy rollout files, appended history, compaction, and restart?
- Can Quarterdeck opt into the experimental read methods without making correctness depend permanently on an unstable interface?
- Do thread and item IDs remain stable across app-server reconstruction and native-TUI resume?
- Does a native-TUI-created thread resume cleanly through app-server with equivalent cwd, instructions, hooks, model, effort, sandbox, approvals, MCP configuration, and session identity?
- Does an app-server-owned thread hand back cleanly to the native Codex TUI using the exact stored ID?
- What happens when an old native PTY exit arrives after app-server ownership begins?
- Can app-server be spawned with a narrow stdio-only composition and terminated without leaving a loaded thread or process tree?
- app-server also exposes file, command, configuration, authentication, and other powerful methods. How will Quarterdeck make those unreachable from the conversation service and every future remote caller?

Do not expose app-server's WebSocket listener as the Remote Companion gateway. If used, it is a private local provider adapter, preferably over stdio, behind a narrow Quarterdeck-owned interface.

## Live JSON Is Not Durable History

Do not collapse the structured live stream and the durable conversation source into one concept.

While structured mode is active, provider events can update an in-memory recent-window projection immediately. That is useful for low-latency UI, but it is optional optimization. Correctness must survive:

- Quarterdeck starting after earlier turns already exist.
- Native-to-structured conversion after a long desktop conversation.
- Browser or phone reconnect.
- Quarterdeck restart.
- Provider runner crash or replacement.
- Missed, duplicated, or reordered live events.
- A task returning from structured mode to native mode.

The simple correct path is to reconstruct the bounded recent window from the provider's durable exact session. A live projection may accelerate subsequent reads, but disabling or losing it must leave a slower correct read path.

Avoid creating a second Quarterdeck-owned durable transcript store solely to preserve live events. Doing so would introduce a new source of truth, retention policy, privacy surface, migration burden, and reconciliation problem. If evidence eventually requires a small durable normalized tail, that is a separate architecture decision with explicit ownership, retention, corruption, and recovery rules.

## Decision A: P2 Read Source

Evaluate these candidates.

### A. Official provider readers only

Claude uses Agent SDK session-message reads. Codex uses app-server stored-thread pagination. Quarterdeck normalizes and filters their typed results.

Advantages:

- Provider-owned parsing and format evolution.
- Native IDs and semantics.
- Less direct filesystem and malformed-record code in Quarterdeck.
- Better alignment with installed authoritative types and generated schemas.

Risks:

- A nominal limit may still perform an unbounded internal scan.
- Required APIs may be experimental or absent at the minimum supported version.
- Provider readers may search globally unless exact cwd/session scope is supplied.
- Provider error surfaces may include unsafe content and need classification.
- A broad local server/SDK may expose more authority than the narrow read service requires.

### B. Bounded raw provider-history parsing

Quarterdeck resolves and validates the exact provider file, reads backward in bounded chunks, and parses only enough records to construct the requested recent window.

Advantages:

- Explicit control over bytes and records examined.
- Deterministic partial-tail and malformed-record policy.
- No dependency on experimental provider read APIs.

Risks:

- Quarterdeck owns provider format drift and compaction/resume stitching.
- Larger path-containment and symlink security surface.
- Greater chance of subtly misrepresenting provider semantics.
- More fixtures and ongoing maintenance.

### C. Hybrid

Prefer an official exact-session reader when it satisfies a requirement. Use a raw bounded reader only for the provider/version/case where evidence shows the official reader cannot provide bounded recent context.

Advantages:

- Uses supported semantics where available without surrendering hard resource bounds.
- Can isolate experimental Codex pagination or Claude boundedness limitations.

Risks:

- Two paths can drift.
- Fallback selection becomes policy and must remain explicit, observable, and testable.
- Results from both paths must have equivalent provider-neutral semantics and stable IDs.

### Decision A acceptance criteria

The selected strategy must prove all of the following for Claude and Codex independently:

- Exact server-owned task/provider/session targeting.
- No caller-supplied path, provider session ID, or arbitrary filesystem locator.
- A true bounded recent read with hard byte, record, entry, text, response, and diagnostic limits.
- No full-history load followed by slicing.
- Stable IDs after append, reread, service reconstruction, and runtime restart.
- Honest `hasOlder`/incomplete/gap representation.
- Correct compaction/resume/restart boundaries without duplicate user/assistant messages.
- Unknown, malformed, partial, missing, and pruned history degrades only the read feature.
- No tools, results, reasoning, paths, commands, terminal data, raw records, or arbitrary errors cross the provider-neutral boundary.
- Logs and diagnostics remain content-free.
- Reads cause no provider, board, lifecycle, hook, session-summary, terminal, task-metadata, or worktree mutation.
- The minimum supported provider version is either compatible or produces an explicit `unsupported` result with a documented compatibility gate.

If an official reader is used, the adapter still owns timeout, result-size, error-classification, and concurrency bounds. “The provider library handles it” is not evidence of boundedness.

## Decision B: Future Execution Ownership

This decision informs P3. Do not implement it as part of P2.

### Option 1. Native TUI remains execution owner

The phone reads normalized history while Quarterdeck delivers safe structured commands through a provider/session interaction adapter into the existing TUI.

This preserves the current process but requires reliable safe-prompt detection or a provider-supported way to address the active interactive session. Raw PTY input must never become a remote capability.

### Option 2. Explicit exclusive ownership handoff

A task is in exactly one execution mode:

```text
native_tui
    -> handoff_to_structured_pending
    -> structured
    -> handoff_to_native_pending
    -> native_tui
```

The transition is not “hide the terminal.” It is a lifecycle operation:

1. Resolve the exact task, provider, session instance, provider session ID, and launch cwd server-side.
2. Stop or interrupt the current execution owner and wait for a confirmed terminal outcome.
3. Refuse handoff on timeout, ambiguous exit, identity mismatch, missing worktree, or unsupported provider state.
4. Fence delayed callbacks from the former owner by exact process/session instance.
5. Resume the exact provider session under the new owner with frozen launch configuration.
6. Publish ownership and lifecycle state atomically through existing owners; do not infer it from conversation output.
7. On handback, repeat the same stop-and-wait discipline before resuming the native TUI.

Read-only desktop and mobile projections may coexist. Only one execution owner may append turns or answer/approve/interrupt.

Potential advantages:

- Structured messages, progress, questions, approvals, interruption, and completion.
- No terminal scraping or keystroke injection for mobile interaction.
- Cleaner stale-session and command-deduplication semantics.
- Mobile-owned tasks can continue without a mounted terminal viewer.

Potential costs:

- A new durable lifecycle/ownership state machine.
- Exact configuration parity across TUI and programmatic launches.
- More startup recovery, trash/restore, restart, reconciliation, and process-fencing work.
- Native terminal scrollback will not necessarily survive handback even though provider conversation context does.
- Provider upgrades may change session compatibility or structured event behavior.

### Decision B acceptance criteria

Prefer explicit ownership handoff only if both supported providers prove:

- Native TUI -> structured runner -> native TUI round trips on the exact session ID.
- No duplicated, lost, or interleaved turns.
- Equivalent cwd/worktree, model, effort, instructions, hooks, tools, MCP, sandbox, environment, and permission behavior, or documented safe differences.
- Structured questions and approvals can be addressed using stable request identity.
- Mid-turn conversion has an explicit wait/interrupt/reject policy.
- Runtime restart reconstructs the sole owner without launching two writers.
- Explicit stop, trash, restore, restart, hard delete, and missing-worktree reconciliation remain correct.
- Old PTY/app-server callbacks cannot finalize a replacement owner.
- Handback remains possible after structured-runner failure.
- No provider-global latest-session fallback is needed.

If either provider cannot satisfy these requirements, P3 may choose provider-specific `unsupported` behavior rather than weakening the safety model.

## Spike Scope

The spike is evidence work, not a production integration.

Allowed outputs:

- Disposable scripts or tests using isolated state and purpose-created provider sessions.
- Recorded provider versions, generated schemas, timings, byte/record measurements, and typed event inventories.
- Minimal throwaway adapters if needed to exercise the APIs.
- A completed decision record in this document.
- Updates to the parent plan and todo once a decision is made.

Not allowed during the spike:

- A remote listener, pairing/authentication, phone UI, or remotely reachable provider endpoint.
- Use of real user history, credentials copied into fixtures, active projects, or the active Quarterdeck runtime.
- A production conversation cache or durable Quarterdeck transcript database.
- Direct provider-history mutation.
- Broad app-server proxying.
- Lifecycle semantics derived from text, timestamps, terminal output, or conversation files.
- Pi investigation or compatibility work.
- A silent change to current task launch behavior.

Use the repository's pinned Node/npm baseline. If a provider dependency or binary must be installed or upgraded for the spike, record why and do not silently change the production minimum version.

## Required Experiment Matrix

Run each applicable case against the minimum supported provider version and the current supported/latest candidate. If an old binary cannot expose the proposed API, record an explicit compatibility result rather than skipping it.

### Read experiments for each provider

- Empty session history.
- Normal recent conversation.
- More messages than the proposed default.
- More messages than the proposed hard maximum.
- Very large synthetic history with the relevant messages near the tail.
- Correct newest-message selection.
- Honest older-history/gap indication.
- Append one user/assistant turn and reread.
- Reconstruct the reader/service and reread.
- Restart the containing runtime/process and reread.
- Resume and restart boundaries without duplicate messages.
- Manual and automatic compaction where the provider exposes them.
- Partial final JSONL/provider record.
- Isolated malformed middle record.
- Unknown record/item type.
- Missing or pruned source.
- Oversized individual message.
- Oversized aggregate response.
- Excessive record scanning.
- Invalid Unicode and unsafe control characters.
- Exact session mismatch.
- Valid exact source/session within the provider-owned root.
- `..` traversal and symlink escape if Quarterdeck opens any provider path.
- Equivalent provider-neutral output shapes for equivalent Claude and Codex sessions.
- Pi absent from the adapter registry or explicitly `unsupported`.

Record for every read:

- Provider and exact version.
- API/method or fallback used.
- Requested and returned entry counts.
- Source size.
- Bytes and records actually examined when observable.
- Duration and peak memory when practical.
- Whether older history exists.
- Stable IDs before and after append/restart.
- Typed result/degradation class.
- Whether any provider file timestamp/content changed.

### Ownership-handoff experiments for each provider

- Create a purpose-built native TUI session and capture its exact provider session ID.
- Complete at least two native turns.
- Stop the exact native process and wait for confirmed exit.
- Resume through the structured interface and complete at least two turns.
- Stop/unload the structured runner.
- Resume the exact session in the native TUI and complete another turn.
- Verify one continuous conversation with no duplicated messages.
- Repeat from review-ready, needs-input/question, permission wait, and idle prompt states.
- Attempt conversion during an active tool/turn and record wait, interrupt, and reject behavior.
- Kill Quarterdeck/the structured runner during conversion and after ownership transfer; verify recoverability.
- Trigger a delayed old-owner exit callback after replacement ownership in the harness.
- Remove the launch worktree during structured ownership and verify reconciliation.
- Trash, restore, restart, stop, and permanently delete in isolated state.
- Verify targeted resume failure never falls back to a global latest conversation.
- Verify content-free logs and diagnostics throughout.

The ownership experiments may use a purpose-built harness rather than Agent Lab if no browser is needed. If desktop terminal behavior is exercised, use the repo-owned `quarterdeck-functional-testing` skill and isolated Agent Lab; never use the user's active Quarterdeck instance.

## Security and Isolation Requirements

Provider history and provider protocol responses are untrusted local input.

- Browser/mobile input may identify only a Quarterdeck-owned project/task and a bounded requested count. It may not supply provider, session ID, cwd, path, cursor minted by a provider, or arbitrary source locator.
- Quarterdeck resolves the current task agent, exact provider session ID, project root, assigned task/worktree identity, and launch cwd server-side.
- If raw files are opened, canonicalize with `realpath` and require containment under a provider-owned canonical history root. Reject traversal, symlink escapes, identity mismatches, and non-regular files.
- If an official API accepts `dir` or `cwd`, supply only a server-resolved canonical directory. Never omit it if omission causes global provider-history search.
- Wrap official APIs in narrow interfaces that expose only the methods Quarterdeck needs. Do not pass through provider DTOs or arbitrary method names.
- Apply hard timeouts, process-output limits, entry/text/response limits, and bounded error classification at the Quarterdeck boundary.
- Strip or reject unsafe controls while preserving normal Unicode and Markdown.
- Logs and diagnostics may include provider, Quarterdeck project/task/session identifiers, result class, counts, sizes, durations, and bounded validated error categories. They may not include conversation text, raw records, provider paths, commands, arguments, environment values, tool data, or thrown provider messages.
- Reads must be observably read-only. Snapshot board revision, lifecycle/session summary, hook activity, terminal state, task/worktree metadata, and provider file metadata/content before and after representative reads.

## Result Contract Direction

The exact production types are chosen during P2, after Decision A, but the spike should evaluate providers against this shape:

```ts
type ConversationReadStatus =
  | "available"
  | "unavailable"
  | "unsupported"
  | "degraded"
  | "source_missing"
  | "session_mismatch"
  | "invalid_source";

type ConversationEntry =
  | {
      type: "message";
      id: string;
      role: "user" | "assistant";
      text: string;
      createdAt: number | null;
    }
  | {
      type: "boundary";
      id: string;
      kind: "started" | "resumed" | "restarted" | "compacted" | "history_gap";
    };
```

The final result must distinguish the primary status from bounded metadata such as returned count, older-history presence, incompleteness, and degradation categories. Do not expose source paths, provider IDs, provider cursors, raw diagnostics, or provider DTOs.

Stable ID policy:

1. Prefer an immutable provider-native user/assistant message or content ID.
2. Otherwise derive a deterministic ID from provider identity, exact provider session identity, and immutable source coordinates.
3. Never use returned-window position, current time, mutable text alone, or a process-local counter.

Appending provider records must not change existing IDs.

## Expected P2 Structure After The Spike

Decision A should result in a focused domain, likely under `src/conversation/`, with separate responsibilities:

1. Provider-neutral recent-window contracts and typed outcomes.
2. Server-owned task/provider/session resolution.
3. Claude official-reader adapter and/or bounded fallback.
4. Codex official-reader adapter and/or bounded fallback.
5. Bounded normalization, content filtering, Unicode/control handling, and response budgeting.
6. Runtime-owned `ConversationReadService` accepting only Quarterdeck project/task identity plus bounded product options.
7. Provider fixtures and pure tests.
8. Isolated integration coverage proving read-only behavior.

The P2 service must not depend on a mobile-mode ownership feature. It should read a task whether its execution owner is native, structured, or stopped. A future structured owner may feed an optional live projection, but the durable read remains correct without it.

## P2B Completion Obligations

After Decision A passes, the production P2B implementation is not complete merely because provider fixtures pass. The implementation branch must satisfy the complete boundary, validation, review, documentation, and handoff obligations below.

### Production behavior

- Claude and Codex return correct bounded recent user/assistant windows for the exact Quarterdeck task session.
- Long histories are not read, parsed, retained, or transmitted in full when a bounded recent tail can be obtained.
- Existing entry IDs remain stable after append, reread, service reconstruction, runtime restart, and reconnect.
- Older or unavailable context is represented honestly.
- Source paths, provider identity, and provider cursors are entirely server-owned.
- Canonical containment and symlink-escape protections pass wherever Quarterdeck opens files.
- Malformed or missing history degrades only conversation reading.
- No conversation read changes board state/revision, lifecycle state, hook activity, terminal/session state, provider files, task/worktree metadata, or launch behavior.
- No tool, reasoning, terminal, file, path, command, system prompt, raw error, or raw-provider content leaks through the consumer-facing result.
- Existing Claude/Codex native TUI and xterm behavior remains unchanged.
- No Pi conversation feature or compatibility gate is added.
- No listener, remote authentication, pairing flow, mobile renderer, networking, or remotely reachable endpoint is added.

### Focused and complete validation

Run focused provider/domain/service tests throughout development. When the implementation is ready, run the complete required gates using the repository's pinned Node/npm baseline:

```bash
npm run check
npm run web:test
npm run web:build
npm run test:integration
npm run check:dead-code
git diff --check
```

Do not omit web gates merely because P2 is server-owned; they protect shared contract and composition boundaries. If a command fails, record and resolve the root cause rather than narrowing the gate without explanation.

### Isolated desktop regression

Because P2B has zero intended desktop behavior change, run a proportionate isolated Agent Lab regression using the repo-owned `quarterdeck-functional-testing` skill. Do not use `npm run dev`, `npm run dogfood`, or the user's active Quarterdeck instance.

At minimum verify that a normal fake-agent task:

- Launches successfully.
- Displays its native fake-agent terminal.
- Transitions through needs-input and review.
- Accepts local terminal input.
- Survives browser reconnect with the terminal restored and usable.

Stop the lab run cleanly and retain/report its run ID and canonical evidence location.

### Final branch review

After all implementation and documentation changes are present:

1. Use the `review-branch` skill for a final read-only review against local `feature/remote-access`.
2. Review the complete branch diff, not only the latest commit.
3. Address every substantive correctness, regression, missing-test, security, and architectural-fit finding.
4. Rerun every affected focused test and the relevant complete gates.
5. Repeat the review if fixes materially change the design.

The branch review has not passed while a substantive finding remains unresolved or merely documented as future work.

### Release documentation

When P2B genuinely satisfies its exit gate, update all of the following in the same final implementation change:

- `docs/remote-companion-plan.md`: mark P2A and P2B implemented, record the selected provider strategies and recent-message-only decision, and keep full-history browsing/rich tool rendering outside mobile v1.
- `docs/conversation-provider-boundary-spike.md`: complete the decision record with reproducible evidence, limits, versions, rejected alternatives, and known assumptions.
- `docs/todo.md`: advance the active Remote Companion prerequisite from P2 to the next remaining phase.
- `CHANGELOG.md`: add an Unreleased entry describing the provider-neutral bounded recent-conversation read boundary. Do not claim remote access exists.
- `docs/implementation-log.md`: add a concise forensic entry covering source ownership, path/session scoping, bounded tail reads, stable IDs, degraded behavior, notable files, and final validation.

Update `AGENTS.md` only if the investigation discovers genuinely non-obvious tribal knowledge that future work would otherwise have to rediscover. Do not add routine implementation detail.

### Commit and final handoff

The original implementation authorization requires the completed P2B implementation and documentation to be committed on `feature/remote-conversation-reads` after validation and final review pass. Do not commit an incomplete spike as though P2 shipped, and never push unless the user separately requests it.

The final P2B handoff must report:

- Branch name and final commit.
- Exact Claude and Codex history/session interface formats supported.
- Selected official-reader/raw-fallback strategy for each provider.
- Default and hard limits for returned entries, source bytes/records, individual text, total response, diagnostics, and time/process output.
- Stable-ID generation policy and provider-native IDs used.
- Server-side source/session resolution and validation flow.
- Every degraded, unavailable, invalid, mismatched, or unsupported result consumers may encounter.
- Focused and complete validation matrix.
- Agent Lab run ID and evidence location.
- Final review result and any findings fixed.
- Remaining provider-format/API/version assumptions and risks.
- Confirmation that no remote transport, mobile UI, authentication flow, listener, or desktop behavior change was introduced.

## Historical Foundation Review

Commit `28c987584` (`feature/conversation-foundation`) is reference material, not an implementation to cherry-pick.

It contains:

- `src/core/api/conversation.ts`: an earlier provider-neutral contract.
- `src/conversation/task-conversation-source.ts`: earlier server-owned source resolution and canonical containment work.
- `src/trpc/conversation-api.ts` and router/context changes: an earlier local API surface.
- `test/runtime/core/conversation.test.ts`: contract tests.
- `test/runtime/conversation/task-conversation-source.test.ts`: path/session/source tests.
- `test/runtime/trpc/conversation-api.test.ts`: API boundary tests.
- `docs/conversation-view-plan.md` and `docs/remote-access-options.md`: historical product and transport research.
- Release-document updates tied to that abandoned foundation.

Review every changed file with `git show 28c987584:<path>` before reusing it. Current code, `AGENTS.md`, the recent-message-only decision, supported-agent policy, board/lifecycle ownership, and this spike are authoritative.

Likely reusable concepts:

- Discriminated provider-neutral results.
- Server-owned task-to-session resolution.
- Canonical-root containment tests.
- Stable identifier helpers if they use immutable coordinates.
- Strict local API input that cannot accept a provider path or session ID.

Likely stale assumptions to reject or re-evaluate:

- Full or broadly paginated transcript browsing.
- Rich tool/thinking rendering as a P2 or mobile-v1 requirement.
- Pi compatibility.
- Public/browser contracts that expose internal provider detail.
- Pre-P1 browser board ownership or older runtime composition.
- Raw-file parsing when a current official provider reader proves sufficient.
- Any transcript-derived lifecycle behavior.

Do not copy historical release notes or mark P2 complete merely because the old foundation compiles.

## Completed Decision Record

### Evidence date and versions

- Date: 2026-08-24
- Quarterdeck base commit: `5cf2c00b2431`
- Node/npm: Node `22.22.2`, npm `11.19.0`
- Quarterdeck provider minimums: Claude Code `2.1.198`, Codex `0.142.5`
- Claude Code versions examined: minimum `2.1.198` package/native binary and installed `2.1.224`
- Claude Agent SDK examined: `@anthropic-ai/claude-agent-sdk@0.3.241`, which reports bundled Claude Code `2.1.241`
- Codex versions exercised: `0.142.5`, `0.149.0`, and authenticated native/app-server `0.149.1`
- Generated Codex app-server schemas: standard and `--experimental` schemas from `0.142.5` and `0.149.0`
- Codex implementation source examined: official `rust-v0.142.5` and `rust-v0.149.0` tags

### Decision A — P2 read source

- Claude strategy: bounded backward reads of the exact Claude JSONL transcript; do not add the Agent SDK as the P2 reader.
- Codex strategy: bounded backward reads of the exact Codex rollout JSONL; do not start app-server for P2 reads.
- Raw fallback policy: there is no official-reader primary path in P2B. Raw bounded history is the single durable read strategy for both supported providers.
- Default returned messages: 10 meaningful user/assistant entries.
- Hard maximum returned messages: 24 meaningful user/assistant entries, plus at most four presentation boundaries; 28 total entries.
- Maximum source bytes examined: 4 MiB aggregate per request.
- Maximum records examined: 4,096 aggregate per request.
- Maximum individual raw record: 1 MiB. An oversized record is skipped with degraded/gap semantics without buffering beyond the aggregate source limit.
- Maximum individual normalized message text: 32 KiB of UTF-8 after control-character normalization.
- Maximum total serialized result: 128 KiB, including entries and consumer-visible metadata.
- Maximum diagnostic metadata: 2 KiB, content-free.
- Timeout/process-output limits: two seconds for source lookup plus read; the raw reader starts no child process and therefore has no provider stdout/stderr surface.
- Source lookup limit: 10,000 directory entries aggregate beneath approved provider history roots, within the same two-second deadline. Exceeding it returns a typed unavailable/degraded result rather than selecting a global latest session.
- Older-history/incomplete semantics: read newest to oldest until the requested messages plus the minimum evidence needed to prove older context are found. Return messages chronologically. Set `hasOlder` and prepend a deterministic `history_gap` boundary when older meaningful history is known or when earlier bytes, compaction, malformed/oversized records, or a scan limit prevent proving completeness. A normal size-limited window may remain `available`; use `degraded` only when the requested recent window itself cannot be reconstructed faithfully.
- Compatibility gates: only `claude` and `codex` register adapters. A missing exact stored session ID is `unavailable`; a stored ID with no matching source is `source_missing`; an unknown record envelope or provider version that cannot be interpreted safely is `unsupported` or `degraded`. Pi is absent or `unsupported` and never participates in source lookup.

#### Claude evidence

The official SDK types describe `getSessionMessages(sessionId, { dir, limit, offset })`, but the installed implementation locates and parses the transcript, reconstructs the parent-UUID conversation chain, and only then applies `slice(offset, offset + limit)`. A synthetic `SessionStore` returned six records to the SDK when the caller requested two; the result contained the first two records, not the recent two. The implementation also reads an entire transcript below its internal 5 MiB threshold. Its limit therefore bounds returned entries, not Quarterdeck's bytes, records, or memory, and it has the wrong direction for this product.

P2B should parse only native Claude `user` and `assistant` records and known compact/resume boundaries. Preserve the native record `uuid`; when a consumer-visible boundary lacks a native ID, derive a SHA-256 ID from provider, exact stored session ID, immutable source byte offset, boundary kind, and content-block index. The hook-provided `transcript_path` is only a locator hint. The adapter must resolve the configured Claude history root server-side, canonicalize both root and candidate with `realpath`, require a regular file contained beneath the root, require the filename/in-record session identity to match Quarterdeck's exact stored Claude session ID, and never use `--continue` or global recency for reads.

The minimum Claude `2.1.198` native package was installed only under the disposable root, reported the expected version, and contained the same `user`/`assistant`, `sessionId`, `parentUuid`, `compact_boundary`, and `isCompactSummary` record markers. It was not used for an authenticated turn or taken as proof that every detailed record variant is identical. P2B must retain fixtures for the native envelope shapes accepted at Quarterdeck's minimum and current versions and degrade an unknown shape; it must not silently broaden parsing based on the current SDK.

#### Codex evidence

App-server `0.149.0` exposes newest-first `thread/turns/list` and `thread/items/list` only through its experimental schema; `0.142.5` used `thread/turns/items/list` for the item method, demonstrating version churn. Both official source tags state that legacy `thread/turns/list` still replays the entire rollout for each request so rollback and compaction can rebuild state. Bounded storage pagination applies only to the newer paginated history mode; a purpose-created `0.149.0` thread used `historyMode: "legacy"`. `thread/read(includeTurns: true)` returns full turns, while `codex exec --json` is a live event stream rather than durable historical pagination.

An isolated no-credential app-server session confirmed newest-first turn paging and exact-thread rereads, including after restarting app-server. It also exposed an identity problem: the same persisted user item was synthesized as `item-1` by `0.149.0` and `item-2` by `0.142.5`. The rollout's native `response_item.payload.id` remained stable. An 8 KiB backward read of a 38,489-byte synthetic rollout recovered the two newest meaningful messages after examining eight records and left older source bytes unread, demonstrating that the native append-oriented format supports the required bounded-tail strategy.

P2B should parse `session_meta` for exact identity and `response_item` message records whose roles are `user` or `assistant`, accepting only documented input/output text content. It should discard tool calls/results, reasoning, commands, system/developer prompts, provider events, and maintenance records except recognized presentation boundaries. Preserve `response_item.payload.id`; if absent, use the same deterministic session/byte-offset/content-index SHA-256 fallback. Resolve the configured `CODEX_HOME` server-side and search only its approved `sessions` and supported archived-session roots for the exact ID suffix, within the lookup limits. Then canonicalize, contain, require a regular file, and verify the in-record session ID. Never call `resume --last`, `thread/list`, or another global latest lookup.

#### Rejected alternatives

- Official readers only: rejected because neither provider proved bounded source work, Claude selects the wrong end, and Codex pagination is experimental for current legacy histories.
- Hybrid official/raw reads: rejected for P2B because the official branches do not satisfy a requirement the raw branch can delegate safely. A hybrid would duplicate normalization, error, stable-ID, and compatibility policy without reducing the raw security/parser obligation.
- Live structured JSON as durable history: rejected because it disappears across disconnect/restart unless Quarterdeck creates a second transcript source of truth.
- App-server as a read-only sidecar: rejected because it adds a long-lived process and broad filesystem/network/protocol authority to a boundary that only needs bounded file reads.

### Decision B — P3 execution ownership

- Claude strategy: **supported with documented constraints** through exact-session Agent SDK ownership and exact native handback.
- Codex strategy: **supported with documented constraints** through exact-thread stdio app-server ownership and exact native handback.
- Single-owner state model: `native_tui -> handoff_to_structured_pending -> structured -> handoff_to_native_pending -> native_tui`, with one durable owner, exact process/session/profile fencing, idempotent operation IDs, and confirmed stop-and-wait on both transitions.
- Mid-turn handoff policy: reject by default; an explicit interrupt-and-wait path must target the current provider turn, await terminal resolution, reread durable history, and only then replace the owner. Never attach a structured writer concurrently.
- Handback policy: stop the exact structured runner, wait for confirmed exit, then target the same provider session ID under the frozen native launch configuration.
- Restart/recovery policy: reconstruct one owner from durable identity and generation state. A crash after provider turn acceptance is `turn_outcome_unknown`; reread and handback are allowed, automatic prompt replay is not.
- Unsupported/degraded provider behavior: refuse conversion provider-by-provider. Do not weaken exact-session or single-writer rules to claim parity.

The authenticated follow-up used isolated synthetic projects and provider histories, inherited Bedrock authentication for Claude, and an OS-Keychain Codex login scoped to one disposable `CODEX_HOME`; no credential value or file was copied. Both providers passed native-to-structured-to-native exact-session handoff, process reconstruction, interrupt, killed-runner handback, append-only identity stability, and live question identity. Codex also passed a declined command-approval request. Configuration parity, compaction, every approval subtype, and future provider-format changes remain explicit compatibility gates. Full evidence and reproduction templates are in [`remote-task-ownership-handoff-spike-results.md`](./remote-task-ownership-handoff-spike-results.md).

### Validation performed

- Read `AGENTS.md`, the parent Remote Companion plan/todo/architecture guardrails, current session ownership code, official provider documentation, authoritative installed SDK types/implementation, generated app-server schemas, official Codex implementation source at both tested tags, and historical commit `28c987584` file by file without cherry-picking it.
- Generated standard and experimental app-server schemas for Codex `0.142.5` and `0.149.0` under a disposable temporary root.
- Ran a pure synthetic Claude `SessionStore` experiment proving full input materialization and oldest-prefix limit behavior without user history or credentials.
- Ran Codex app-server under an isolated `CODEX_HOME` with no credentials, created a purpose-built thread, persisted synthetic user/assistant-shaped records without a model response, exercised newest-first turn paging and process-restart rereads at `0.149.0`, and reread the same rollout at `0.142.5` to compare identity behavior.
- Ran a content-free bounded-tail proof that read only the final 8 KiB of a 38,489-byte synthetic Codex rollout, examined eight records, found the two recent meaningful messages, and did not read the older source bytes.
- Confirmed all isolated app-server processes were stopped. Temporary evidence remained under `/private/tmp/quarterdeck-provider-spike.<suffix>/`; it contains no Quarterdeck/user runtime state or credentials and is not a committed artifact.
- Agent Lab run ID: not used. The spike made no production code or desktop behavior change, and authenticated native-TUI handoff was outside the authorized experiment.
- Known limitations: Claude `2.1.198` was inspected and version-checked but did not create an authenticated transcript; no authenticated assistant turn or native/structured/native round trip was run; compaction, malformed tails, containment, and limit enforcement remain production fixture/test obligations in P2B rather than claims established by the interface spike.
- Separately authorized follow-up: authenticated Claude `2.1.224`/Agent SDK `0.3.241` and Codex `0.149.1` native/structured/native handoff evidence completed Decision B. The content-free safety and validation record is in the ownership-handoff results document.

### Gate result

- Decision A ready for P2B: yes.
- Decision B ready for P3 implementation: yes, provider-by-provider with the documented compatibility and single-writer constraints.
- Recorded by: architecture spike, 2026-08-24.

## Handoff Checklist

A fresh agent implementing P2B should proceed in this order:

1. Read `AGENTS.md` completely.
2. Read this document, `docs/remote-companion-plan.md`, `docs/todo.md`, and `docs/conventions/architecture-guardrails.md`.
3. Confirm the branch base and current worktree state; preserve unrelated changes and do not touch `docs/archive` if it exists untracked elsewhere.
4. Verify current minimum provider versions and installed authoritative types; treat version drift as a compatibility review, not a reason to reopen the product scope.
5. Review commit `28c987584` file by file without cherry-picking it.
6. Implement the provider-neutral contracts, bounded source locator, backward JSONL reader, Claude adapter, Codex adapter, and runtime-owned service as separate responsibilities under `src/conversation/`.
7. Encode every limit and source/session invariant from Decision A in focused fixtures and isolated integration tests before runtime composition.
8. Keep P3 ownership handoff out of the P2B branch; do not start an SDK/app-server runner or add a second transcript.
9. Update release documentation only when the P2B exit gate is genuinely satisfied.
10. Run the complete P2B validation, isolated Agent Lab regression, and final read-only branch review required above before committing the implementation.

Decision A is complete because another engineer can reproduce the evidence, understand why bounded raw history was selected, and implement P2B without reopening its read-source question. Decision B is also complete as an evidence gate, but production P3 remains separate because safe task conversion still requires the durable ownership coordinator, provider-specific compatibility gates, and single-writer recovery design.
