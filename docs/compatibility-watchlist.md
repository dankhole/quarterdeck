# Provider Compatibility Watchlist

This file tracks useful upstream capabilities that Quarterdeck cannot implement locally until a provider exposes a stable contract. These are not active backlog items. Review them when updating a provider minimum version or investigating a related compatibility failure; promote an item to [`todo.md`](./todo.md) only when concrete local work becomes possible.

## Codex native hooks

- **Effective reviewer identity:** `PermissionRequest` currently fires before auto-review routing and does not identify whether a request reached a person. Quarterdeck can suppress false Needs Input for its exact launch-scoped Approve for me mode, but inherited user configuration remains conservatively actionable until Codex exposes effective reviewer or post-decision identity.
- **Turn abort/failure granularity:** Native hooks cover tool, prompt, compaction, subagent, permission, and stop lifecycle but do not expose the old wrapper/parser's `task_started`, `turn_aborted`, and `task_complete` distinctions. Reconsider finer failure attribution if Codex adds explicit abort/failure events.

The rendered-screen approval fallback and unpaired slash-command behavior remain actionable local compatibility work and stay in [`todo.md`](./todo.md).
