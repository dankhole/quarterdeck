# Historical records

These are frozen records of earlier work. They may describe superseded behavior, unresolved work that later landed, or validation of a different candidate. They are not active agent instructions, current setup guidance, or proof of release readiness. Start with the [current documentation](../README.md).

## Retired change logs

The handwritten changelog and chronological implementation log were retired on 2026-10-19. Routine changes now live in PRs and Git history; published versions use [generated release notes](https://github.com/dankhole/quarterdeck/releases). See [documentation policy](../maintenance.md#documentation-lifecycle) for exceptional rationale worth keeping in a current guide.

- [Final changelog snapshot](changelog-through-2026-10-19.md), including its then-unreleased changes.
- [Final implementation-log snapshot](implementation-log-through-2026-10-19.md).
- Earlier changelogs: [through 0.11.0](changelog-through-0.11.0.md), [0.10.0](changelog-through-0.10.0.md), [0.9.4](changelog-through-0.9.4.md).
- Earlier implementation logs: [through 0.12.0](implementation-log-through-0.12.0.md), [0.11.0](implementation-log-through-0.11.0.md), [0.10.0](implementation-log-through-0.10.0.md), [0.9.4](implementation-log-through-0.9.4.md), [2026-05-01](implementation-log-through-2026-05-01.md), [2026-04-15](implementation-log-through-2026-04-15.md), [2026-04-12](implementation-log-through-2026-04-12.md).

## Plans and evidence

- [Desktop design](macos-desktop-plan.md), [unified installation design](unified-installation-plan.md), and [npm update design](desktop-update-plan.md): original implementation context. Current contracts live in the [desktop guide](../desktop.md) and [release runbook](../desktop-release.md).
- [Desktop validation evidence](desktop-validation-evidence.md): detailed candidate receipts. The [active ledger](../desktop-validation.md) owns current gates and limitations.
- [September backlog execution](backlog-execution-2026-09.md) and [Chit migration snapshot](todo-migration-2026-09-30.md): former work sequencing and task-list source, not current priorities.
- [Diagnostics design](agent-diagnostics-plan.md): completed design and migration; see the [current contract](../diagnostics.md).
- [LSP proposal](lsp-code-navigation-plan.md): original phased design; see the [current code-navigation contract](../lsp-code-navigation-plan.md).
- [Claude terminal validation](claude-terminal-rendering-evidence.md): rollout receipts; see the [current rendering contract](../claude-terminal-rendering-plan.md).
- [Pi implementation plan](pi-first-class-support-plan.md): original acceptance design; see the [current support contract](../pi-first-class-support-plan.md).
- [Claude parity plan](claude-parity-plan.md): completed workstreams that closed Claude-vs-Codex gaps; see the [session lifecycle contract](../conventions/session-lifecycle.md).

Other files in this directory retain earlier investigations and designs. `docs/archive/` contains older imported material and remains frozen. Preserve evidence and provenance; do not update historical claims to make them sound current.
