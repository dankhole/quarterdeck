# Deterministic Fake Codex Protocol

The lab shadows only the child runtime's `codex` executable. `codex --version` and `codex features list` report a hook-capable version so Quarterdeck exercises its normal Codex launch adapter and hook ingestion path. The user's real agent binaries and configuration are never read by the task process.

Prompt directives override the run's default scenario for one task:

- `[agent-lab:idle]` — remain interactive after printing the ready marker.
- `[agent-lab:needs-input]` — emit a Codex permission wait and move the task to Review with approval-required semantics.
- `[agent-lab:review]` — emit a root `Stop` and move the task to Review.
- `[agent-lab:failure]` — exit non-zero to exercise failure/restart behavior.
- `[agent-lab:git-dirty]` — write `agent-lab-output.txt` in the task checkout.
- `[agent-lab:terminal-stress]` — emit 400 numbered lines for scrollback/restore testing.

Interactive terminal commands:

- `/help` — print the protocol in the terminal.
- `/needs-input [message]` — send `PermissionRequest`/`permission_prompt` metadata.
- `/approval-overlay` — render Codex's canonical command approval overlay without sending a native hook, for compatibility-fallback coverage.
- `/working [message]` — send `PostToolUse` and transition to running.
- `/review [message]` — send root `Stop` with final-message metadata.
- `/write <relative-path> <contents>` — write inside the disposable task checkout; absolute paths and escapes are rejected.
- `/commit [message]` — stage and commit all disposable changes.
- `/status` — print short Git status.
- `/clipboard-read` — request the browser-owned clipboard through xterm's OSC 52 protocol and print a bounded `AGENT LAB CLIPBOARD READ` marker.
- `/spam [1-2000]` — produce bounded terminal output.
- `/alt-on` and `/alt-off` — enter and leave xterm's alternate screen.
- `/delay-review <milliseconds> [message]` — schedule a review hook, bounded to 30 seconds.
- `/fail [message]` — print a marker and exit 1.
- `/exit [0-255]` — exit with a chosen code.

Every marker begins with `AGENT LAB`, making terminal-buffer checks deterministic. The initial marker is `AGENT LAB READY task=<id> scenario=<scenario>`.

The browser wrapper records synthetic terminal input actions and surrounds each action with unified diagnostic marks. A later lab checkpoint therefore contains both the deterministic `AGENT LAB` marker evidence and the causally adjacent runtime/browser records. Keep command payloads synthetic even though they are bounded and path-aliased in the action transcript.
