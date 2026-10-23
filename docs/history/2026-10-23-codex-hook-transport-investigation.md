# Codex hook transport investigation

Investigation snapshot: 2026-10-23. Repository baseline: `a8a47dbb`.

## Decision

**Keep command hooks; defer the MCP replacement.** Avoiding process startup is a worthwhile performance goal, but the investigated MCP route changes provider behavior and has no demonstrated speedup. No transport implementation shipped. This note records the rejected approach, not an active implementation plan or backlog.

## Findings

- Quarterdeck installs `PreToolUse` as best-effort `hooks notify` and `PostToolUse` as reliable `hooks ingest`: two Node hook invocations per ordinary tool call, excluding provider shell/launcher overhead. See [`src/codex-hooks.ts`](../../src/codex-hooks.ts). Moving only the pre-tool hook would remove one invocation; reliable post-tool delivery must retain its outbox and acknowledgement guarantees.
- Inspected Codex tags `0.157.0`, `0.163.0`, and `0.164.0` support `mcp_tool` hooks, but not native `type: "http"` hooks. MCP uses an existing connection and can hide its tool from the model. This is an MCP endpoint, not a plain HTTP callback. See the [tagged hook configuration](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/config/src/hook_config.rs).
- Templates fail on missing fields, so optional `agent_id` cannot be copied directly. Codex supplies native `_meta.threadId`; reconstructing equivalent foreground/subagent identity looks possible, but resume, fork, and internal-subagent cases were not validated. See the [template runner](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/hooks/src/engine/mcp_runner.rs) and [MCP executor](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/src/hook_mcp_executor.rs).
- MCP errors surface as hook failures, unlike Quarterdeck's silent best-effort notify failures. Early calls can fail before the connection is ready; administrative MCP policy introduces another availability dependency. See [upstream MCP hook tests](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/tests/suite/hooks_mcp.rs).
- Successful MCP hooks mark thread memory mode as `polluted` when `memories.disable_on_external_context` is enabled, regardless of whether useful context was returned. This is a provider behavior change, not merely a missing test. See [hook completion handling](https://github.com/openai/codex/blob/rust-v0.157.0/codex-rs/core/src/hook_runtime.rs#L898-L917).

## Performance evidence and limits

The earlier [hot-path audit](../reviews/2026-10-23-hot-path-performance.md) estimated about 100 ms per pre/post pair. That is historical evidence, not a current constant. An isolated installed-bundle probe during this investigation was heavily affected by host load and cannot establish expected savings. No command-versus-MCP comparison or real-Codex parity test ran; neither a speedup nor end-to-end session benefit is proven.

## Possible follow-ups

1. **Measure before optimizing.** Profile current source-built command startup separately from HTTP ingest and persistence, using matched synthetic payloads, repeated runs, successful-delivery counts, and median/p95 latency. Determine whether startup materially affects short-tool sequences.
2. **Prefer compatible local improvements.** If measurement justifies work, investigate reducing command-path cost without changing hook identity, ordering, failure behavior, or reliable delivery. Do not weaken the outbox to win a benchmark.
3. **Revisit on an upstream contract change.** Native HTTP hooks, or telemetry-safe MCP hooks without memory/failure side effects, would justify reassessment. Require measured savings including connection startup cost, plus foreground/subagent/resume parity and authenticated delivery. Real-provider validation requires explicit authorization and the isolated Agent Lab.

These are conditional options, not newly scheduled tasks. The [provider watchlist](../compatibility-watchlist.md) carries the reopening trigger.
