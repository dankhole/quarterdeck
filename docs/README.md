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
3. [`architecture-roadmap.md`](./architecture-roadmap.md) for the ranked architectural risks, current refactor queue, per-item pickup briefs, recent completions, and extended code-validated backlog.
4. [`conventions/architecture-guardrails.md`](./conventions/architecture-guardrails.md) for reusable rules on adding clever features without letting optimization define the architecture.

If you only need the current refactor state, start with:

1. [`todo.md`](./todo.md) for the active backlog.
2. [`architecture-roadmap.md`](./architecture-roadmap.md) for current ordering, backlog context, and links out to deeper briefs.
3. The dedicated brief/follow-up linked from the roadmap item you are actually picking up.

## Refactor Docs Map

Use this map when you are planning or evaluating refactor work.

### Live planning and prioritization

- Start here for current refactor status: [`todo.md`](./todo.md) + [`architecture-roadmap.md`](./architecture-roadmap.md).
- [`todo.md`](./todo.md): active engineering backlog, including currently tracked refactor work.
- [`architecture-roadmap.md`](./architecture-roadmap.md): ranked architectural weaknesses, current refactor ordering, recent completions, and the extended code-validated backlog.
- [`conventions/architecture-guardrails.md`](./conventions/architecture-guardrails.md): reusable design rules for preventing optimization-shaped architecture.

### Live architecture and implementation guidance

- [`architecture.md`](./architecture.md): system-wide architecture overview.
- [`conventions/frontend-hooks.md`](./conventions/frontend-hooks.md): domain-module extraction pattern for frontend hooks and services.
- [`conventions/web-ui.md`](./conventions/web-ui.md): frontend conventions and hooks architecture guidance.
- [`conventions/ui-layout.md`](./conventions/ui-layout.md): UI region names, shell layout ownership, and main-view/sidebar rules.
- [`task-state-system-stale.md`](./task-state-system-stale.md): end-to-end task/session state explanation. Marked stale — verify against current code before acting on it.

### Forensic history

- [`implementation-log.md`](./implementation-log.md): current detailed implementation history.
- [`history/`](./history): frozen historical records — version-scoped implementation logs and changelogs from earlier milestones.

### Historical refactor and investigation context

- [`archive/`](./archive): older focused design investigations, debugging notes, and completed refactor context that may still be useful for background but is not the current source of truth.

This `docs/` folder should stand on its own for normal onboarding. Active plans and handoffs may still exist in `.plan/docs`, but a new engineer should not need those to understand the current architecture.

When adding new engineering docs, prefer putting stable explanations here and linking them from this index.
