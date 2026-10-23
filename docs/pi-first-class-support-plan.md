# Pi Desktop Support Contract

Status: maintained on macOS and pinned to exactly Pi `1.4.0`.

## Product contract

Pi is a first-class desktop task agent alongside Claude Code and Codex. Quarterdeck preserves Pi selection through task creation, create-and-start, authoritative hydration, project switching, restart, Trash/restore, and startup recovery.

Quarterdeck deliberately accepts exactly Pi `1.4.0`, not an open-ended minimum version. Older or newer versions return a typed availability failure naming the detected and required versions. Advancing the supported version requires a fresh compatibility review and the validation gate below.

The native Pi TUI remains the execution owner. Pi does not participate in the internal structured-execution handoff currently supported for exact Claude Code and Codex sessions.

## Lifecycle and interaction ownership

- The launch-scoped Pi lifecycle extension owns provider session/run/tool identity, lifecycle delivery, and managed-session replacement guards.
- `agent_start` provides current-launch working evidence. Input may be consumed by another extension without starting a run. `agent_end` is activity only; `agent_settled` is the completion boundary, with aborted runs reported as Interrupted and native assistant errors as Error.
- Terminal output, browser input, spinner state, and conversation-file changes never establish Running or Review.
- Pi hooks may affect a task only when project, task, provider session, launch session instance, run/tool identity, and delivery ordering match current runtime authority.
- Managed sessions block Pi-local `/new`, `/resume`, and `/fork` operations that would replace provider identity outside Quarterdeck's lifecycle owner.

Quarterdeck automatically grants session-only Pi trust to the exact registered task worktree verified inside its managed worktrees area. The launch-scoped lifecycle extension uses Pi's native `project_trust` event and does not save a trust decision, trust the parent directory, or change Pi's global configuration. Each fresh start, resume, restart, and recovery verifies its own scope. Shared checkouts and directories outside that scope retain Pi's normal trust handling, and Pi's explicit trust overrides retain their native precedence. Restart existing sessions to load the updated extension.

Pi evaluates extension trust decisions before saved folder decisions and `defaultProjectTrust`, so Quarterdeck's session grant takes precedence over those settings for an eligible task worktree. Pi's first decisive extension response wins; an earlier explicit extension can supply its own decision. Quarterdeck preserves extension ordering.

Pi owns saved trust decisions and tool execution. Quarterdeck does not register `tool_call` handlers or add confirmation dialogs. Dialogs created by user extensions remain in Pi’s terminal and are not mapped to Quarterdeck input notifications. Any remaining native startup trust prompts also remain in Pi’s terminal without Quarterdeck approval notifications.

## Recovery contract

- Automatic restart and startup recovery require the exact stored Pi session ID and use `--session <id>`.
- A targeted resume must report the expected provider session before it becomes authoritative.
- Missing, mismatched, or unusable stored sessions produce a typed Review/Error result. Quarterdeck never replays an ambiguous prompt or silently starts a different session.
- `--continue` is available only for an explicit user restart when no exact session ID exists, with the ambiguity disclosed to the user.
- Browser connection and active-project selection do not own or trigger recovery.

## Platform scope

Pi support targets macOS. Version validation uses deterministic Agent Lab coverage and native synthetic checks; authenticated provider behavior is a separate gate requiring explicit authorization. Linux and Windows Pi support remain outside the validated Pi platform claim until their native PTY, path, process-tree, trust, and exact-resume cases pass.

Quarterdeck's broader Windows support remains experimental under the separate [Windows acceptance ledger](./windows-compatibility-todo.md).

## Version-advance gate

For every proposed Pi version change:

1. Review upstream release notes plus extension, event, session, and trust changes.
2. Update the exact supported version and committed fixtures together.
3. Run lifecycle-extension contract tests and the deterministic Pi Agent Lab scenarios.
4. Verify new task, consumed input, settlement, cancellation, native trust, stop, exact resume, restart, cold recovery, stale-event rejection, and ambiguous-failure behavior.
5. Run a native synthetic smoke on every platform claimed for Pi.
6. Use an authenticated provider only with explicit authorization when real provider behavior remains the unresolved risk.

Do not replace this gate with a minimum-version range. Pi versions older than `0.79.0` are below the project-trust security floor, and unvalidated newer versions remain unsupported.

## Ownership references

- [Session and terminal lifecycle](./conventions/session-lifecycle.md)
- [Runtime state and board ownership](./conventions/runtime-state.md)
- [Agent functional testing](./agent-functional-testing.md)
- [Historical implementation plan](./history/pi-first-class-support-plan.md)
- [Pi releases](https://github.com/earendil-works/pi/releases)
- [Pi coding-agent documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)
- [Project-trust security advisory](https://github.com/earendil-works/pi/security/advisories/GHSA-mqxh-6gq7-558m)
