# Structured Execution Ownership

Read this before changing or integrating non-PTY task execution, native/structured handoff, structured task interaction, provider session ownership, or provider-history compatibility.

This is the stable contract for the integrated provider-neutral execution owner. Historical experiments live in Git history; ordinary changes should start here.

## Single-writer ownership

- Exactly one owner may write to a provider session at a time.
- Persist a pending handoff before stopping the old owner.
- Confirm that the old owner lost write authority before starting its replacement.
- Fence old callbacks by operation identity, owner generation, and session instance.
- Reject mid-turn handoff by default. Do not silently transfer a provider session while its turn outcome is unresolved.
- After an ambiguous structured-runner crash, report `turn_outcome_unknown`; never replay the prompt speculatively.

## Exact provider identity

- Restart with the exact provider session and profile identity, not a provider-global latest/continue fallback.
- Codex identity includes the exact server-owned `CODEX_HOME` profile.
- Claude identity includes an explicitly pinned Agent SDK native executable and configuration manifest.
- Compatibility is gated by provider version, protocol/schema, configuration, and history mode.
- Provider-history reads are independent, bounded, and read-only. Do not add a Quarterdeck transcript store.

## Interaction ownership

- Internal callers use `ProjectBoardCommandService`, `ProjectTaskLifecycleService`, and the provider-owned interaction boundary directly. They do not reuse browser presentation adapters or raw PTY input.
- Never accept browser-supplied provider, process, executable, profile, or filesystem identity.
- The native foreground `outstandingInteraction` lifecycle is intentionally singular.
- Structured Codex callbacks use exact keyed interaction identity.
- Concurrent Claude or background-agent structured interaction remains unsupported until it has a durable keyed model. Do not route subagent/global Agent View notifications through the foreground record.
- Pi structured compatibility is out of scope until its ownership and exact-resume contract is designed and validated explicitly.

## Validation

Follow [`../testing.md`](../testing.md). Start with focused coordinator, adapter, interaction, and recovery tests. Use purpose-built browserless integration coverage for structured ownership when no browser is involved. Use deterministic Agent Lab only for a desktop browser/PTY projection, and use an authorized real provider only when the provider's native protocol or exact-session behavior is the unresolved risk.
