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
3. [`testing.md`](./testing.md) for proportionate validation and testing-layer selection.
4. [`todo.md`](./todo.md) for the active engineering backlog and current refactor queue.
5. [`conventions/architecture-guardrails.md`](./conventions/architecture-guardrails.md) for reusable rules on adding clever features without letting optimization define the architecture.

For test selection, start with [`testing.md`](./testing.md). For live-instance diagnostics, use [`../DEVELOPMENT.md#unified-diagnostics`](../DEVELOPMENT.md#unified-diagnostics). The stable architecture and privacy boundary is in [`diagnostics.md`](./diagnostics.md). When the testing strategy calls for isolated browser, terminal, Git, Files, lifecycle, or visual validation, use [`agent-functional-testing.md`](./agent-functional-testing.md).

If you only need the current refactor state, start with:

1. [`todo.md`](./todo.md) for the active backlog.
2. The convention or architecture doc linked from the todo item you are actually picking up.

## Refactor Docs Map

Use this map when you are planning or evaluating refactor work.

### Live planning and prioritization

- Start here for current refactor status: [`todo.md`](./todo.md).
- [`todo.md`](./todo.md): active engineering backlog, including currently tracked refactor work.
- [`pi-first-class-support-plan.md`](./pi-first-class-support-plan.md): implemented Pi compatibility contract and release gates.
- [`claude-terminal-rendering-plan.md`](./claude-terminal-rendering-plan.md): completed Claude fullscreen design, dogfood evidence, and default-on rollout decision with a classic-renderer escape hatch.
- [`lsp-code-navigation-plan.md`](./lsp-code-navigation-plan.md): plan for bring-your-own language server code navigation in the Files editor.

### Live architecture and implementation guidance

- [`architecture.md`](./architecture.md): system-wide architecture overview.
- [`diagnostics.md`](./diagnostics.md): stable unified diagnostics contract, privacy boundary, ownership, and validation entry points.
- [`testing.md`](./testing.md): canonical validation-selection policy, command scopes, and heavy-lane criteria.
- [`agent-functional-testing.md`](./agent-functional-testing.md): disposable Quarterdeck lab, deterministic fake agent, browser UI driving, visual artifacts, and failure evidence.
- [`windows-support-audit.md`](./windows-support-audit.md): completed Windows remediation audit, verified compatibility boundaries, and remaining native acceptance evidence.
- [`windows-compatibility-todo.md`](./windows-compatibility-todo.md): completed remediation ledger and the two remaining release-acceptance gates.
- [`windows-native-smoke.md`](./windows-native-smoke.md): required CI coverage, reproducible native commands, and real-provider acceptance matrix.
- [`conventions/frontend-hooks.md`](./conventions/frontend-hooks.md): domain-module extraction pattern for frontend hooks and services.
- [`conventions/web-ui.md`](./conventions/web-ui.md): frontend conventions and hooks architecture guidance.
- [`conventions/ui-layout.md`](./conventions/ui-layout.md): UI region names, shell layout ownership, and main-view/sidebar rules.
- [`conventions/runtime-state.md`](./conventions/runtime-state.md): durable board ownership, command receipts, authoritative browser hydration, runtime projections, notifications, and task-indicator semantics.
- [`conventions/session-lifecycle.md`](./conventions/session-lifecycle.md): task-session stop/resume/recovery, reconciliation, PTY and restore identity, provider hooks, input semantics, and launch boundaries.
- [`conventions/structured-execution.md`](./conventions/structured-execution.md): stable single-writer and exact-provider-identity rules for structured/non-PTY execution and handoff.
- [`conventions/architecture-guardrails.md`](./conventions/architecture-guardrails.md): reusable design rules for preventing optimization-shaped architecture.

### Maintenance references

- [`maintenance.md`](./maintenance.md): recurring upstream-review, documentation-lifecycle, and provider-compatibility routines.
- [`compatibility-watchlist.md`](./compatibility-watchlist.md): upstream provider capabilities that are not yet actionable local backlog work.
- [`upstream-sync.md`](./upstream-sync.md): living review tracker for ideas and fixes evaluated from the diverged `cline/kanban` upstream.
- [`../RELEASE_WORKFLOW.md`](../RELEASE_WORKFLOW.md): version, changelog, validation, tag, and publish process.
- [`../SECURITY.md`](../SECURITY.md): vulnerability reporting and supported security boundary.

### Forensic history

- [`implementation-log.md`](./implementation-log.md): current detailed implementation history.
- [`history/`](./history): frozen historical records — version-scoped implementation logs and changelogs from earlier milestones.
- [`history/agent-diagnostics-plan.md`](./history/agent-diagnostics-plan.md): exhaustive completed diagnostics implementation plan and migration decisions.
- [`history/task-state-system-stale.md`](./history/task-state-system-stale.md): superseded task/session state explanation, retained only for forensic context.

`docs/archive/` contains imported legacy planning and research material that predates the current documentation map. Treat it as frozen forensic context and do not route normal work there. New superseded records belong in `docs/history/`; migrate legacy archive material only when a focused cleanup can preserve its links and provenance.

This `docs/` folder should stand on its own for normal onboarding. A new engineer should not need archived handoffs or historical plans to understand the current architecture.

When adding new engineering docs, prefer putting stable explanations here and linking them from this index.
