# Engineering Docs

This folder is the starting point for engineers working on Quarterdeck itself.

This follows the usual split a small engineering team would want:

- `README.md` explains the product, local setup, and everyday usage.
- `DEVELOPMENT.md` is the human-facing developer guide for local commands, workflow, and repo orientation.
- `docs/` holds stable onboarding and architecture references for humans.
- `AGENTS.md` is the canonical repo-owned shared agent-instructions file. `CLAUDE.md` is only a Claude Code compatibility shim that imports it.
- Superseded implementation plans and investigation context belong in tracked `docs/history/`, not in the active docs map. Completed decision records that still constrain active, unimplemented work remain here until that downstream work lands.

If you are new to the codebase, read these in order:

1. [`../README.md`](../README.md) for the product overview and local setup.
2. [`architecture.md`](./architecture.md) for the system map, runtime model, and key file guide.
3. [`todo.md`](./todo.md) for the active engineering backlog and current refactor queue.
4. [`conventions/architecture-guardrails.md`](./conventions/architecture-guardrails.md) for reusable rules on adding clever features without letting optimization define the architecture.

For live-instance diagnostics, use [`../DEVELOPMENT.md#unified-diagnostics`](../DEVELOPMENT.md#unified-diagnostics). The stable architecture and privacy boundary is in [`diagnostics.md`](./diagnostics.md). For isolated browser, terminal, Git, Files, lifecycle, and visual regression testing, use [`agent-functional-testing.md`](./agent-functional-testing.md).

If you only need the current refactor state, start with:

1. [`todo.md`](./todo.md) for the active backlog.
2. The convention or architecture doc linked from the todo item you are actually picking up.

## Refactor Docs Map

Use this map when you are planning or evaluating refactor work.

### Live planning and prioritization

- Start here for current refactor status: [`todo.md`](./todo.md).
- [`todo.md`](./todo.md): active engineering backlog, including currently tracked refactor work.
- [`remote-companion-plan.md`](./remote-companion-plan.md): behavior-preserving prerequisites and phased implementation plan for the text-only mobile remote companion.
- [`claude-terminal-rendering-plan.md`](./claude-terminal-rendering-plan.md): implemented default-off fullscreen experiment and its remaining interactive dogfood and rollout gates.
- [`lsp-code-navigation-plan.md`](./lsp-code-navigation-plan.md): plan for bring-your-own language server code navigation in the Files editor.

### Active decision records and rollout gates

- [`conversation-provider-boundary-spike.md`](./conversation-provider-boundary-spike.md): completed P2 read-source decision and evidence that still constrain the unimplemented P3 execution-owner work.
- [`remote-task-ownership-handoff-spike-results.md`](./remote-task-ownership-handoff-spike-results.md): authenticated native/structured/native handoff evidence, provider gates, and the required P3 single-writer design.
- [`task-lifecycle-reliability-plan.md`](./task-lifecycle-reliability-plan.md): implemented lifecycle-operation and revisioned project-summary design; retained while its final live-runtime release-confidence dogfood remains.

### Live architecture and implementation guidance

- [`architecture.md`](./architecture.md): system-wide architecture overview.
- [`diagnostics.md`](./diagnostics.md): stable unified diagnostics contract, privacy boundary, ownership, and validation entry points.
- [`agent-functional-testing.md`](./agent-functional-testing.md): disposable Quarterdeck lab, deterministic fake agent, browser UI driving, visual artifacts, and failure evidence.
- [`windows-support-audit.md`](./windows-support-audit.md): current Windows support boundary, verified compatibility work, and remaining follow-ups.
- [`conventions/frontend-hooks.md`](./conventions/frontend-hooks.md): domain-module extraction pattern for frontend hooks and services.
- [`conventions/web-ui.md`](./conventions/web-ui.md): frontend conventions and hooks architecture guidance.
- [`conventions/ui-layout.md`](./conventions/ui-layout.md): UI region names, shell layout ownership, and main-view/sidebar rules.
- [`conventions/runtime-state.md`](./conventions/runtime-state.md): durable board ownership, command receipts, authoritative browser hydration, runtime projections, notifications, and task-indicator semantics.
- [`conventions/session-lifecycle.md`](./conventions/session-lifecycle.md): task-session stop/resume/recovery, reconciliation, PTY and restore identity, provider hooks, input semantics, and launch boundaries.
- [`conventions/architecture-guardrails.md`](./conventions/architecture-guardrails.md): reusable design rules for preventing optimization-shaped architecture.

### Maintenance references

- [`upstream-sync.md`](./upstream-sync.md): living review tracker for ideas and fixes evaluated from the diverged `cline/kanban` upstream.
- [`../RELEASE_WORKFLOW.md`](../RELEASE_WORKFLOW.md): version, changelog, validation, tag, and publish process.
- [`../SECURITY.md`](../SECURITY.md): vulnerability reporting and supported security boundary.

### Forensic history

- [`implementation-log.md`](./implementation-log.md): current detailed implementation history.
- [`history/`](./history): frozen historical records — version-scoped implementation logs and changelogs from earlier milestones.
- [`history/agent-diagnostics-plan.md`](./history/agent-diagnostics-plan.md): exhaustive completed diagnostics implementation plan and migration decisions.
- [`history/task-state-system-stale.md`](./history/task-state-system-stale.md): superseded task/session state explanation, retained only for forensic context.

This `docs/` folder should stand on its own for normal onboarding. A new engineer should not need archived handoffs or historical plans to understand the current architecture.

When adding new engineering docs, prefer putting stable explanations here and linking them from this index.
