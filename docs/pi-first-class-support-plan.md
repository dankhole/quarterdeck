# Pi Desktop Support Contract

Status: maintained on macOS and pinned to exactly Pi `0.84.3`.

## Product contract

Pi is a first-class desktop task agent alongside Claude Code and Codex. Quarterdeck preserves Pi selection through task creation, create-and-start, authoritative hydration, project switching, linked-card starts, restart, Trash/restore, and startup recovery.

Quarterdeck deliberately accepts exactly Pi `0.84.3`, not an open-ended minimum version. Older or newer versions return a typed availability failure naming the detected and required versions. Advancing the supported version requires a fresh compatibility review and the validation gate below.

The native Pi TUI remains the execution owner. Pi does not participate in the internal structured-execution handoff currently supported for exact Claude Code and Codex sessions.

## Lifecycle and interaction ownership

- The launch-scoped Pi lifecycle extension owns project trust, provider session/run/tool identity, lifecycle delivery, and managed-session replacement guards.
- `input` and `agent_start` provide current-launch working evidence. `agent_end` is activity only; `agent_settled` is the completion boundary.
- Terminal output, browser input, spinner state, and conversation-file changes never establish Running or Review.
- Pi hooks may affect a task only when project, task, provider session, launch session instance, run/tool identity, and delivery ordering match current runtime authority.
- Managed sessions block Pi-local `/new`, `/resume`, and `/fork` operations that would replace provider identity outside Quarterdeck's lifecycle owner.

Project trust always fails closed and is required once per launch. Tool approvals default on for shell, PowerShell, file write/edit, overridden, and unknown tools. Settings may disable per-tool confirmation for new or restarted sessions, but that opt-out never bypasses project trust, lifecycle delivery, exact-session recovery, or managed-session identity guards.

## Recovery contract

- Automatic restart and startup recovery require the exact stored Pi session ID and use `--session <id>`.
- A targeted resume must report the expected provider session before it becomes authoritative.
- Missing, mismatched, or unusable stored sessions produce a typed Review/Error result. Quarterdeck never replays an ambiguous prompt or silently starts a different session.
- `--continue` is available only for an explicit user restart when no exact session ID exists, with the ambiguity disclosed to the user.
- Browser connection and active-project selection do not own or trigger recovery.

## Platform scope

Pi `0.84.3` has completed deterministic Agent Lab coverage, native synthetic macOS validation, and an explicitly authorized no-tools authenticated macOS smoke. Linux and Windows Pi support remain outside the validated Pi platform claim until their native PTY, path, process-tree, trust, approval, and exact-resume cases pass.

Quarterdeck's broader Windows support remains experimental under the separate [Windows acceptance ledger](./windows-compatibility-todo.md).

## Version-advance gate

For every proposed Pi version change:

1. Review upstream release notes plus extension, event, session, and trust changes.
2. Update the exact supported version and committed fixtures together.
3. Run lifecycle-extension contract tests and the deterministic Pi Agent Lab scenarios.
4. Verify new task, input, settlement, approval accept/deny, stop, exact resume, restart, cold recovery, stale-event rejection, and ambiguous-failure behavior.
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
