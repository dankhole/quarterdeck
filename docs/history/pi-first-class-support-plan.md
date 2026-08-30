# Pi First-Class Desktop Support Plan (Historical)

Status: implemented on 2026-08-26 for the macOS desktop target. This frozen plan records the pre-implementation gaps and acceptance design; the current support contract lives in [`../pi-first-class-support-plan.md`](../pi-first-class-support-plan.md).

## Implementation Outcome

Pi is now a maintained desktop task agent pinned to exactly `0.84.3`. Durable create/start selection, launch-scoped lifecycle ordering, keyed approvals, project trust, exact-session restart and startup recovery, terminal restore, diagnostics, settings/onboarding, and deterministic Agent Lab coverage use the same authoritative ownership paths as Claude Code and Codex.

The isolated acceptance runs created and persisted Pi tasks, exercised approval acceptance and denial, settlement, queued input before settlement, stale completed-run rejection, stop/restart, trash/restore/permanent delete, project switching, runtime cold replacement, and exact-session recovery. A deterministic one-shot replacement failure exposed and fixed an exit-classification edge: a targeted replacement that spawns and exits before interactive-session evidence now produces the typed stored-session recovery error, clears the unusable exact identity, and allows only a later explicit `--continue` fallback. The canonical checkpoint completed without Doctor findings or forbidden host launches.

The installed macOS Pi `0.84.3` CLI then loaded the production extension against a deterministic loopback model. Native runs verified project trust, tool approval and denial, stable run/tool/session identities, `agent_end` followed by `agent_settled`, exact `--session` recovery, and the expected effect or non-effect on a disposable file. A final user-authorized, no-tools authenticated provider smoke returned the exact expected token and settled through the same production extension. Credentials were neither copied nor inspected, sessions were isolated under a temporary directory, and no active Quarterdeck instance was used.

Authenticated real-model dogfood remains a normal release-confidence activity, not permission to weaken the exact-version, project-trust, default approval, or no-replay boundaries. The explicit global tool-approval opt-out affects only new or restarted Pi tool calls; it does not bypass project trust or lifecycle ownership.

## Decision Summary

Quarterdeck will promote Pi from a legacy experimental integration to a supported desktop task agent.

The first supported version will be exactly Pi `0.84.3`, the latest release validated when this plan was written. Quarterdeck will not automatically accept whatever npm currently labels `latest`. A newly released Pi version remains unsupported until its lifecycle extension, session behavior, and smoke suite pass; the exact required version can then move deliberately.

Desktop first-class support means:

- Pi can be selected, persisted, created, started, stopped, restarted, trashed, restored, and recovered through the same authoritative task-lifecycle paths as Claude Code and Codex.
- The native Pi TUI remains the desktop execution owner.
- Launch-scoped Pi events, rather than terminal output or browser input, author Running, Review, Needs Input, and interaction-resolution state.
- Automatic recovery resumes the exact stored Pi session and never replays a prompt after an ambiguous failure.
- Pi project trust always fails closed. Effectful tool approvals default to a fail-closed Quarterdeck-owned policy and may be disabled only through the explicit global Settings control for new or restarted sessions.
- Availability, lifecycle, recovery, interaction, diagnostics, and Agent Lab coverage meet the same release standard as the maintained agents.

## Why the Existing Integration Is Not First Class

Pi remains in the broad runtime agent ID and has a native launch adapter, PATH/version detection, lifecycle-extension injection, exact `--session` resume support, a `--continue` fallback, orphan cleanup, and desktop display metadata.

The maintained product contracts deliberately exclude it:

- `runtimeMaintainedAgentIdSchema` contains only Claude Code and Codex.
- New board commands and `create_and_start` exclude or strip Pi, so a visible Pi selection is not reliably durable.
- The transition controller, provider ordering, reliable hook delivery, interaction pipeline, automatic restart, startup recovery, and terminal restore policies contain Claude/Codex-only gates.
- The current Pi extension treats `agent_end` as completion even though modern Pi may retry, compact, or process queued input before `agent_settled`.
- Pi has no Quarterdeck-supported project-trust and approval policy equivalent to the Codex integration.
These gaps are desktop blockers.

## Supported-Version Contract

Start with an exact `0.84.3` requirement.

For every future Pi version bump:

1. Review the upstream release notes and relevant extension/RPC/session-format changes.
2. Run the Pi lifecycle-extension contract tests and native synthetic smoke suite.
3. Verify exact-session new/start/resume/restart/recovery behavior.
4. Verify project trust and effectful-tool allow/deny behavior.
5. Update the exact supported version and committed fixtures together.

Do not use only a minimum-version check. Accepting an untested newer Pi would turn upstream API drift into a supported Quarterdeck failure. Return a typed availability result that names the exact required and detected versions.

Pi versions older than `0.79.0` must never be accepted because the project-trust fix shipped in that release. The exact `0.84.3` requirement is stronger than that security floor.

Upstream references:

- [Pi releases](https://github.com/earendil-works/pi/releases)
- [Pi coding-agent documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)
- [Extension API types](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts)
- [Project-trust security advisory](https://github.com/earendil-works/pi/security/advisories/GHSA-mqxh-6gq7-558m)

## Desktop Ownership Model

```text
desktop task intent
        |
        v
ProjectTaskLifecycleService
        |
        v
TerminalSessionManager ---- launches ----> native Pi TUI
        |                                      |
        |                                      v
        +<---- authenticated lifecycle extension events
        |
        v
SessionTransitionController
        |
        v
ProjectBoardCommandService
```

The existing ownership invariants remain unchanged:

- `ProjectBoardCommandService` is the only durable board writer.
- `ProjectTaskLifecycleService` owns managed lifecycle intent and recovery.
- `SessionTransitionController` is the only authority that converts launch-scoped provider evidence into task-session state.
- Terminal output, input submission, spinner changes, and conversation-file changes are never proof that Pi is working or finished.
- A Pi hook may affect a task only when its project, task, provider session, launch session instance, and event identity match current runtime authority.

## Phase D1: Supported Catalog and Durable Selection

1. Change Pi from a preserved legacy ID to a maintained runtime agent ID.
2. Allow Pi in create-task and create-and-start schemas.
3. Stop browser command derivation from stripping Pi.
4. Preserve Pi through optimistic commands, authoritative hydration, reload, project switching, linked-card starts, and configuration-default fallback.
5. Replace the `0.70.2` version floor with the exact `0.84.3` compatibility result.
6. Update installation and remediation text for the current `@earendil-works/pi-coding-agent` package.

Required tests:

- Create a Pi task and reload before starting it.
- Create and start a Pi task directly.
- Start an existing Pi backlog task when the global default is another agent.
- Change the global default after creating a Pi task and verify that the task remains Pi-owned.
- Load existing persisted Pi cards without migration loss.

## Phase D2: Native Lifecycle and Event Ordering

Rewrite the injected extension against the supported Pi event surface.

### Completion semantics

- `input` and `agent_start` may provide live evidence that the current Pi session resumed work.
- `agent_end` is activity and result capture only; it must not move the task to Review.
- `agent_settled` is the completion boundary because Pi has no pending automatic retry, compaction retry, or queued continuation at that point.
- Capture the last bounded assistant summary before settlement without putting raw conversation content into the durable hook outbox or production diagnostics.

### Identity and ordering

- Generate a Quarterdeck run identity at `agent_start`.
- Preserve Pi's stable `toolCallId` for every tool interaction.
- Carry the exact Pi provider-session ID, Quarterdeck `sessionInstanceId`, delivery UUID, and occurrence timestamp.
- Add a Pi-specific event-order reducer rather than treating Pi as Claude or Codex by analogy.
- Deduplicate retries and replay durable events in provider order.
- Reject events from prior launches, prior provider sessions, completed operations, or mismatched projects/tasks.

### Interaction lifecycle

- Model every approval as one exact foreground interaction.
- Keep an accepted response in `response_submitted` until Pi reports the corresponding resolved or denied result.
- If the Pi process exits after submission but before resolution, report `resolution_unknown` rather than claiming success or replaying the response.
- Ensure delayed tool-completion and settlement events cannot resolve a newer interaction.

### Pi-local session commands

For the first desktop release, block managed-session commands that replace provider identity, including `/new`, `/resume`, and `/fork`. Supporting them safely requires a durable provider-session-generation handoff. Commands such as `/tree` may remain available when they stay within the exact stored session.

## Phase D3: Exact Resume, Restart, and Startup Recovery

1. Automatic restore and startup recovery must use `--session <stored-provider-session-id>` exclusively.
2. `--continue` is allowed only for an explicit user restart when no exact provider-session ID exists. The UI must disclose that the most recent matching Pi session may be selected.
3. Before declaring resume successful, verify that the launched Pi session reports the expected exact provider-session ID.
4. Freeze launch identity across recovery: Pi binary path and version, cwd, configuration policy, trust policy, extension source fingerprint, task ID, project ID, and Quarterdeck session instance.
5. Add Pi to automatic restart, startup recovery, restore, process-exit, and terminal reconnect policies.
6. Preserve the existing rule that a failed targeted resume becomes a typed Review/Error recovery result. Do not start a fresh session or replay the original prompt.
7. Keep browser connection and project selection out of recovery authority. Cold startup must reconcile Pi tasks before any browser connects.

Required failure tests include missing session files, session-ID mismatch, unsupported Pi version, extension startup failure, process exit before live evidence, process exit after prompt acceptance, stale hooks from the old process, and runtime restart during response-pending state.

## Phase D4: Project Trust and Approval Security

Pi intentionally does not provide a Codex-style built-in sandbox and approval system. First-class support therefore requires a Quarterdeck-owned Pi policy; relabeling tool activity as an approval would not provide parity.

### Project trust

- Surface Pi's project-trust request as a typed launch interaction.
- Bind the decision to the exact canonical project/worktree path and launch identity.
- Never pass a blanket approval flag silently.
- Denial or unresolved trust must prevent effectful agent execution and produce a typed, actionable state.

### Effectful tools

- Gate shell, PowerShell, file write/edit, and known effectful extension tools by default.
- Allow only explicitly classified read-only tools without interaction.
- Deny unknown effectful custom tools by default.
- Permit an explicit global opt-out for new or restarted sessions. The opt-out bypasses per-tool confirmation only; it must preserve project trust, lifecycle hooks, exact-session recovery, and managed-session identity guards.
- Initially support approve-once and deny. Add broader grants only with an explicit persisted scope and revocation model.
- Never infer approval from terminal keystrokes or rendered prompts.
- Keep raw command arguments, file contents, tool results, and model text out of production diagnostics and durable transition metadata.

Automated approval review remains separate from the explicit bypass setting. The bypass does not classify or sandbox actions; it delegates every Pi tool call directly to the configured tool implementation for that launch.

## Phase D5: Desktop UI, Diagnostics, and Documentation

- Replace the Experimental presentation only after all desktop gates pass.
- Show the exact supported and detected Pi versions with an actionable install/upgrade message.
- Add settings and onboarding copy for Pi project trust and approval behavior.
- Keep Pi provider/model authentication owned by Pi; Quarterdeck must not copy or expose credentials.
- Add content-safe diagnostic events for version checks, extension preparation, provider-session verification, hook admission/rejection, ordering decisions, recovery, and interaction resolution.
- Extend `quarterdeck diagnostics doctor` to check the Pi binary, exact version, injected extension asset/fingerprint, and known session source without reading conversation content.
- Update `README.md`, `AGENTS.md`, and compatibility promises only when the desktop promotion gate passes.

## Phase D6: Desktop Acceptance Gate

Use the isolated Agent Lab and synthetic data. Never automate the user's active Quarterdeck instance.

The deterministic fake Pi provider must cover:

- New task, create-and-start, follow-up prompt, stop, restart, trash, restore, and delete.
- Running, Review, Needs Input, response-submitted, Interrupted, Error, and recovery-required states.
- Approval accept, deny, delayed resolution, process loss, duplicate delivery, and stale interaction identity.
- Automatic retry and compaction where `agent_end` occurs before `agent_settled`.
- Queued follow-up input before settlement.
- Stale and out-of-order hooks from a previous launch.
- Exact-session success, missing session, mismatched session, and ambiguous crash.
- Browser reconnect versus complete runtime cold restart.
- Project switching and authoritative project-pill/notification convergence.

Run a native synthetic smoke suite against exactly Pi `0.84.3` on every desktop platform Quarterdeck claims to support. The initial release must cover macOS. Linux and Windows may remain explicitly unsupported for Pi until their native PTY, path, process-tree, trust, permission, and resume cases pass.

Pi may be promoted to first-class desktop support only when:

1. Every desktop task path preserves Pi ownership.
2. Lifecycle state is driven by current launch-scoped Pi evidence.
3. Retry, compaction, and queued input cannot cause premature Review.
4. Exact resume and cold recovery never select another session or replay an ambiguous prompt.
5. Trust and effectful-tool decisions fail closed.
6. Diagnostics remain content-safe.
7. Unit, integration, Agent Lab, and native Pi `0.84.3` smoke suites pass.
8. The Experimental label, legacy documentation, changelog, and compatibility statement are updated together.

## Recommended Change Sequence

Keep the work reviewable and avoid mixing security policy with presentation changes:

1. Supported-version contract, maintained-agent schemas, and durable selection.
2. Modern Pi lifecycle extension, identities, ordering, and reliable delivery.
3. Exact resume, restart, startup recovery, and terminal restoration.
4. Project trust and effectful-tool approval policy.
5. Desktop UI, settings, diagnostics, Agent Lab, and native smoke coverage.
6. Desktop promotion documentation and release changes.
Each phase must preserve the runtime-state and session-lifecycle ownership rules. Do not temporarily bypass managed lifecycle services, accept browser-supplied provider identity, infer work from PTY output, or add prompt replay as a recovery shortcut.
