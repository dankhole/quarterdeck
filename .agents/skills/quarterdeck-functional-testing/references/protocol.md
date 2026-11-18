# Deterministic Fake Agent Protocol

The default packaged lane shadows the child runtime's Codex and Pi executables. Reusable internal fake-Claude fixtures can instead expose only a fake Claude executable and block Codex/Pi; the retired browser lab's `--agent` flag is not a packaged CLI option. Each fake reports the validated version needed by normal discovery, and every task runs through Quarterdeck's production provider adapter and hook-ingest path. The user's real agent binaries and configuration are never read by the task process.

This protocol does not apply to `real-codex` or `real-claude`; authenticated lanes use ordinary tiny synthetic prompts and the provider's actual interactive controls.

Prompt directives override the run's default scenario for one task:

- `[agent-lab:idle]` — remain interactive after printing the ready marker; a fresh explicit Start appears Running for up to 45 seconds, then Review/Unconfirmed unless `/working` supplies provider evidence.
- `[agent-lab:needs-input]` — emit a Codex permission wait and move the task to Review with approval-required semantics.
- `[agent-lab:review]` — emit a root `Stop` and move the task to Review.
- `[agent-lab:failure]` — exit non-zero to exercise failure/restart behavior.
- `[agent-lab:git-dirty]` — write `agent-lab-output.txt` in the task checkout.
- `[agent-lab:terminal-stress]` — emit 400 numbered lines for scrollback/restore testing.

Additional fake-Claude scenarios available to internal fixture configuration (not a packaged `--scenario` CLI option):

- `claude-lifecycle` — seeded sequence covering prompt, tool/permission, notification, elicitation/result, pending background work, SubagentStop, and successful Stop.
- `claude-failure` — prompt followed by StopFailure.

Interactive terminal commands:

- `/help` — print the protocol in the terminal.
- `/needs-input [message]` — send `PermissionRequest`/`permission_prompt` metadata. While it is active, a bare `y` submits the response immediately and emits the matching `PostToolUse` after a short deterministic delay; bare Escape dismisses it without a hook.
- `/needs-input-auto [message]` — emit the real Codex `PreToolUse` → identity-less `PermissionRequest` → matching `PostToolUse` sequence without local response bytes, covering provider-side or policy approval.
- `/approval-overlay` — render Codex's canonical command approval overlay without sending a native hook, for compatibility-fallback coverage. A bare `y` submits the response immediately and emits `PostToolUse` after a short deterministic delay; bare Escape dismisses it without a hook.
- `/native-interrupt` — emit Codex's reliable native `Interrupt` hook for the current session and turn without rendered failure text. Clears fake approval state and scheduled approval completion, including while a native permission is waiting. Keeps the interrupted turn identity so `/working` and `/review` can exercise delayed same-turn events; use `/new-turn` for fresh work.
- `/turn-interrupted` — render Codex's complete interrupted-turn result and returned input prompt without sending a native hook; use it to prove hookless turn failures still converge to Review/Interrupted.
- `/new-turn [message]` — emit Codex `UserPromptSubmit` under a new turn identity; use it to prove a current follow-up returns Interrupted or Review to Running.
- `/redraw-interruption-history` — redraw an old interruption above newer working content and the current input prompt; use it to prove historical terminal text cannot override the newer turn hook.
- `/local-action [message]` — accept an Enter-confirmed TUI-local action without sending a native hook; use it to prove terminal input cannot fabricate Running.
- `/notification [message]` — for Claude, emit an `agent_needs_input` Notification without creating an actionable wait.
- `/elicitation [message]` — for Claude, emit a keyed MCP `Elicitation` wait.
- `/elicitation-result [message]` — for Claude, emit the matching keyed `ElicitationResult` and resume work.
- `/background-stop [message]` — for Claude, emit a root Stop with pending background work followed by `SubagentStop`; use `/review` for the later completed root Stop.
- `/stop-failure [message]` — for Claude, emit `StopFailure` with bounded failure metadata.
- `/queued-follow-up [message]` — for Pi, emit `agent_end` for the current run followed by `agent_start` for queued input without an intervening `agent_settled`; use it to prove the task never enters Review between runs.
- `/stale-run` — for Pi, replay the last settled run identity through `agent_start`; the provider-order fence must reject it without changing Review state.
- `/fail-next-resume` — for Pi, persist a disposable one-shot marker, crash the current process, and make the exact automatic targeted replacement fail; use it to verify typed recovery failure without prompt replay.
- `/working [message]` — send `PostToolUse` and transition to running.
- `/progress [message]` — append a synthetic Codex or Pi assistant message to its transcript and emit an activity hook for grid-preview checks. Pi uses native session/message JSONL with parent-linked entries and supplies the exact source path on hooks; `/review` also persists its final assistant message.
- `/review [message]` — send root `Stop` with final-message metadata.
- `/write <relative-path> <contents>` — write inside the disposable task checkout; absolute paths and escapes are rejected.
- `/commit [message]` — stage and commit all disposable changes.
- `/status` — print short Git status.
- `/hyperlink` — enable SGR mouse tracking and print a labeled OSC 8 link to the isolated runtime health endpoint, without a visible raw URL. Use `/alt-on` first to exercise fullscreen link-click arbitration.
- `/clipboard-read` — request the renderer-owned simulated clipboard through xterm's OSC 52 protocol and print a bounded `AGENT LAB CLIPBOARD READ` marker.
- `/spam [1-2000]` — produce bounded terminal output.
- `/alt-on` and `/alt-off` — enter and leave xterm's alternate screen.
- `/delay-review <milliseconds> [message]` — schedule a review hook, bounded to 30 seconds.
- `/fail [message]` — print a marker and exit 1.
- `/exit [0-255]` — exit with a chosen code.

Every marker begins with `AGENT LAB`, making terminal-buffer checks deterministic. The initial marker is `AGENT LAB READY task=<id> scenario=<scenario>`.

## Output-processing receipts

Negative lifecycle assertions must wait for processed output and observe stable state, not immediately pass on the previous Running snapshot. Historical redraw emits an inline OSC 52 query; wait for its fresh simulated clipboard receipt without typing another command or sending a work hook. Consume replies before Readline and suppress receipt text on the historical frame: echoed base64 or a marker can destroy the canonical current prompt and fabricate an interruption. Filter only replies to outstanding queries so ordinary Escape timing is unchanged. Observe bare-Escape neutrality before typing a receipt command; Readline otherwise interprets a rapidly following slash as an Alt-key sequence. Keep the subsequent current-interruption positive assertion.

Use these commands only through the isolated packaged desktop lab's terminal. Retain the deterministic `AGENT LAB` marker evidence alongside the relevant runtime/renderer diagnostics. Keep all command payloads synthetic; the removed standalone browser wrapper is not an execution path.
