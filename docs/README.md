# Engineering Docs

This folder is the starting point for engineers working on Quarterdeck itself.

This follows the usual split a small engineering team would want:

- `README.md` explains the product, local setup, and everyday usage.
- `DEVELOPMENT.md` is the human-facing developer guide for local commands, workflow, and repo orientation.
- `docs/` holds stable onboarding and architecture references for humans.
- `AGENTS.md` is the canonical repo-owned shared agent-instructions file. `CLAUDE.md` is only a Claude Code compatibility shim that imports it.
- `.plan/docs/` holds active plans, handoffs, and deeper change-history context for larger refactors.

If you are new to the codebase, read these in order:

1. [`../README.md`](../README.md) for the product overview and local setup.
2. [`architecture.md`](./architecture.md) for the system map, runtime model, and key file guide.
3. [`design-weaknesses-roadmap.md`](./design-weaknesses-roadmap.md) for the current ranked architectural risks and prevention priorities.
4. [`terminal-architecture-refactor-brief.md`](./terminal-architecture-refactor-brief.md) for the self-contained terminal refactor brief and target design.
5. [`terminal-ws-server-refactor-brief.md`](./terminal-ws-server-refactor-brief.md) for the backend websocket-bridge refactor brief and target module split.
6. [`design-guardrails.md`](./design-guardrails.md) for reusable rules on adding clever features without letting optimization define the architecture.
7. [`optimization-shaped-architecture-followups.md`](./optimization-shaped-architecture-followups.md) for the current non-terminal subsystems showing the same design smell.

## Refactor Docs Map

Use this map when you are planning or evaluating refactor work.

### Live planning and prioritization

- [`todo.md`](./todo.md): active engineering backlog, including currently tracked refactor work.
- [`design-weaknesses-roadmap.md`](./design-weaknesses-roadmap.md): ranked list of the biggest architectural weaknesses.
- [`design-guardrails.md`](./design-guardrails.md): reusable design rules for preventing optimization-shaped architecture.
- [`optimization-shaped-architecture-followups.md`](./optimization-shaped-architecture-followups.md): current non-terminal subsystems showing that same smell.
- [`terminal-architecture-refactor-brief.md`](./terminal-architecture-refactor-brief.md): self-contained terminal refactor planning brief.
- [`terminal-ws-server-refactor-brief.md`](./terminal-ws-server-refactor-brief.md): self-contained websocket bridge refactor planning brief.

### Live architecture and implementation guidance

- [`architecture.md`](./architecture.md): system-wide architecture overview.
- [`plan-design-investigation.md`](./plan-design-investigation.md): ownership-boundary investigations and conclusions.
- [`plan-csharp-readability-followups.md`](./plan-csharp-readability-followups.md): readability/navigation follow-up slices.
- [`patterns-frontend-service-extraction.md`](./patterns-frontend-service-extraction.md): domain-module extraction pattern for frontend hooks and services.
- [`web-ui-conventions.md`](./web-ui-conventions.md): frontend conventions and hooks architecture guidance.
- [`ui-layout-architecture.md`](./ui-layout-architecture.md): UI composition and layout ownership model.
- [`task-state-system.md`](./task-state-system.md): end-to-end task/session state explanation.

### Forensic history

- [`implementation-log.md`](./implementation-log.md): current detailed implementation history.
- [`implementation-archive/`](./implementation-archive): archived implementation logs from earlier milestones.

### Historical refactor and investigation context

- [`archive/`](./archive): older focused design investigations, debugging notes, and completed refactor context that may still be useful for background but is not the current source of truth.

This `docs/` folder should stand on its own for normal onboarding. Active plans and handoffs may still exist in `.plan/docs`, but a new engineer should not need those to understand the current architecture.

When adding new engineering docs, prefer putting stable explanations here and linking them from this index.
