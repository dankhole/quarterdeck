# Provider Compatibility Watchlist

This file tracks useful upstream capabilities that Quarterdeck cannot implement locally until a provider exposes a stable contract. These are not active backlog items. Review them when updating a provider minimum version or investigating a related compatibility failure; promote an item to the primary checkout's local `docs/qDeck.yaml` only when concrete local work becomes possible.

## Codex native hooks

- **Process-free activity hooks:** Reassess when Codex exposes native HTTP hooks or an MCP telemetry contract without memory and failure-visibility side effects. The existing MCP route is not a feature-equivalent replacement for best-effort command hooks, and its performance benefit is unmeasured. See the [hook transport investigation](history/2026-10-23-codex-hook-transport-investigation.md) for evidence and conditional follow-ups.
- **Effective reviewer identity:** `PermissionRequest` currently fires before auto-review routing and does not identify whether a request reached a person. Quarterdeck can suppress false Needs Input for its exact launch-scoped Approve for me mode, but inherited user configuration remains conservatively actionable until Codex exposes effective reviewer or post-decision identity.

The rendered-screen approval fallback and unpaired slash-command behavior remain actionable local compatibility work tracked in the primary checkout's local `docs/qDeck.yaml`. That gitignored list is not distributed with documentation or copied into worktrees.

## Claude native hooks

- **Interrupt hook:** Claude emits no hook when the user interrupts a turn with Esc, and `Stop` does not fire. Quarterdeck retires Running from bounded rendered evidence instead; a native interrupt event would replace that compatibility detector.
- **Manual permission decisions:** `PermissionDenied` fires only for automatic permission-mode denials. A person's manual denial, or a direct approval hotkey, emits no hook, so Quarterdeck cannot confirm when a manual permission wait was answered.
- **Permission request identity:** `PermissionRequest` carries no `tool_use_id`; correlation depends on the preceding reliable `PreToolUse`. An identity on the request itself would remove that ordering dependency.
- **Workspace trust:** the trust dialog has no hook or launch flag, so Quarterdeck confirms it from the rendered option rows.
