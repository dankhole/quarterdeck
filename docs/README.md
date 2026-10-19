# Documentation

Start with the guide for the work in front of you. Current guides describe the product as implemented; Git history and PRs explain ordinary changes. [Documentation policy](maintenance.md#documentation-lifecycle) defines what merits a durable note.

## Use Quarterdeck

- [Quick start](../README.md): requirements, npm installation, desktop/browser modes, and updates.
- [User guide](usage.md): agent setup, configuration, everyday workflow, and troubleshooting.
- [Desktop guide](desktop.md#using-the-app): installation, window behavior, updates, and recovery.
- [Desktop environment](desktop-environment.md): executable discovery and optional shell import.
- [Worktree setup](worktree-setup.md): ignored-file copying and project setup scripts.
- [Project management](project-management.md): naming, unavailable folders, and relocation.
- [GitHub Releases](https://github.com/dankhole/quarterdeck/releases): generated release notes.

## Develop and diagnose

- [Development](../DEVELOPMENT.md): dependencies, builds, linking, local workflow, and debugging.
- [Architecture](architecture.md): system map, ownership, and source navigation.
- [Testing](testing.md): select the smallest check that establishes the changed behavior.
- [Agent Lab](agent-functional-testing.md): isolated browser/desktop functional testing and evidence.
- [Diagnostics](diagnostics.md): recorder, privacy, and ownership; [commands](../DEVELOPMENT.md#unified-diagnostics).
- [Agent instructions](../AGENTS.md): compact shared rules and routing; `CLAUDE.md` imports them.

## Maintain a subsystem

| Area | Current reference |
| --- | --- |
| Architecture and performance policy | [Architecture guardrails](conventions/architecture-guardrails.md) |
| React components and hooks | [Web UI](conventions/web-ui.md), [hooks and domains](conventions/frontend-hooks.md) |
| Navigation and layout | [UI layout](conventions/ui-layout.md) |
| Board state and browser hydration | [Runtime state](conventions/runtime-state.md) |
| Agents, PTYs, Trash, and resume | [Session lifecycle](conventions/session-lifecycle.md) |
| Structured provider execution | [Structured execution](conventions/structured-execution.md) |
| Files, diffs, and conflict editing | [Files/review contract](files-review-surface-plan.md) |
| Language servers | [LSP contract and deferred scope](lsp-code-navigation-plan.md) |
| Provider-specific constraints | [Pi support](pi-first-class-support-plan.md), [Claude rendering](claude-terminal-rendering-plan.md) |
| Native shell and process ownership | [Desktop architecture](desktop.md), [environment resolution](desktop-environment.md) |

Some contract filenames retain their original `-plan` suffix for existing references. Their opening status identifies implemented behavior and deferred scope; they are not parallel task trackers.

## Release and platform acceptance

- [Release workflow](../RELEASE_WORKFLOW.md): versioning, immutable tags, generated notes, npm publication, and verification.
- [Desktop release](desktop-release.md): signing, packaging, coordinated publication, and upgrades.
- [Desktop acceptance](desktop-validation.md): current release gates and links to candidate evidence.
- [Windows acceptance](windows-compatibility-todo.md): remaining support gates; [native validation](windows-native-smoke.md) and [support audit](windows-support-audit.md).
- [Security](../SECURITY.md): reporting and supported security boundary.

## Planning and history

The active backlog is the local, gitignored `docs/qDeck.yaml` in the primary checkout. Use `chit --file <primary-checkout>/docs/qDeck.yaml read`; do not create a worktree copy. It is not part of a public clone. [Repository maintenance](maintenance.md), the [provider watchlist](compatibility-watchlist.md), and [upstream review](upstream-sync.md) cover ongoing maintenance decisions.

PR descriptions and Git history are the normal change record. There is no maintained changelog or implementation diary. The [history index](history/README.md) preserves old release notes, implementation logs, completed plans, and detailed validation receipts. Dated [review reports](reviews/README.md) are audit evidence, not a current backlog. Neither is required onboarding reading.
