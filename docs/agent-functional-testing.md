# Agent Functional Testing

Quarterdeck's agent lab is a disposable copy of the runtime and browser UI that coding agents can drive without Computer Use and without attaching to the user's active app. It is designed for functional regression testing and debugging across the board, dialogs, task PTYs, session lifecycle, Git, Files, state persistence, and visual layout.

The lab provides isolation from the user's data and processes; it is not a hardened container or a security boundary. Use synthetic fixtures only.

## What one run owns

Each `start` creates:

- two dynamically selected loopback ports for the runtime and Vite UI;
- a temporary HOME, `QUARTERDECK_STATE_HOME`, Git project, and task-worktree root;
- a second synthetic Git project for Add Project and project-switching tests;
- a minimal child environment that omits API keys, cloud credentials, SSH agent access, user Git config, and real agent configuration;
- a fake `codex` executable injected at the front of that runtime's PATH only;
- native UI disabled by launch configuration, plus recording fakes for known picker, open, and IDE launchers that fail the run if invoked;
- an atomic manifest and stop-request control channel;
- continuously captured supervisor, runtime, and web logs;
- a named, in-memory Playwright browser session restricted to loopback origins;
- the unified diagnostic recorder in its bounded rich `agent-lab` profile, enabled automatically for the run;
- semantic page snapshots, screenshots, traces, videos, console/network records, and a marked browser-action transcript;
- canonical diagnostic bundles at ready, failure, pre-shutdown, final, and explicitly requested checkpoints.

The runtime and browser still use Quarterdeck's real project registry, tRPC/WebSocket transport, board persistence, worktree lifecycle, Codex adapter, PTY, native-hook ingest, session state machine, xterm renderer, Git APIs, and Files APIs. Only the external coding agent is replaced.

Native folder/file dialogs, external host openers, Open in IDE, clipboard integration, and notification audio are unavailable in the lab. UI flows must handle the typed unavailable result and stay browser-manageable—for example, Add Project uses the JavaScript manual-path prompt. Ordinary browser links and terminal links remain browser-contained, observable by Playwright, and subject to the lab's loopback-only page-request policy. The manifest records the disabled capability, second project path, and forbidden-launch log path.

## First-time setup

Install project dependencies normally, then install the browser used only by the agent wrapper:

```bash
npm run install:all
npm run agent:browser -- install-browser chromium
```

The Chromium build lives in an ignored cache under `web-ui/node_modules/.cache/`; it does not replace the browser revision used by `@playwright/test`.

## Lifecycle commands

Start a detached run and ask for machine-readable discovery data:

```bash
npm run --silent agent:lab -- start --name terminal-restore --json
```

The manifest includes the run id, status, URLs, temporary paths, artifact paths, browser config/session/output paths, PIDs, scenario, timestamps, and any startup failure. Ports default to `auto`; fixed `--runtime-port` and `--web-port` values exist for E2E and targeted debugging. `--keep-temp` retains the synthetic project/state after shutdown when filesystem inspection is necessary.

Use an explicit run id when several agents are testing concurrently:

```bash
npm run --silent agent:lab -- status <run-id> --json
npm run --silent agent:lab -- snapshot <run-id> --label before-restart --json
npm run --silent agent:lab -- stop <run-id> --json
npm run --silent agent:lab -- list --json
```

`snapshot` writes a canonical diagnostic bundle at `test-results/agent-lab/<run-id>/snapshots/<timestamp>-<checkpoint>/`. Start with its `manifest.json`, which hashes and indexes every retained artifact. In addition to the shared timeline, doctor findings, and live subsystem snapshots, the synthetic lab bundle can include:

- the public lab manifest and checkpoint metadata;
- bounded fixture state, excluding the private diagnostic descriptor/token directory;
- Git status, recent log, working-tree diff, and staged diff for the main fixture and task worktrees;
- supervisor, runtime, and web logs;
- Playwright semantic snapshots, screenshots, traces, videos, console/network records, and browser actions available at that checkpoint.

The supervisor automatically captures `ready`, `failure` when applicable, `pre-shutdown`, and `final`. The pre-shutdown checkpoint preserves the last connected browser snapshot. The supervisor then closes the browser, stops the web/runtime child trees, finalizes the lab manifest, and captures `final` from the stopped runtime's descriptor and crash-surviving journal while the disposable state still exists. Manual labels are normalized and de-duplicated so a checkpoint never overwrites an earlier one. A missing or timed-out provider produces a partial bundle with a warning instead of failing the run.

Shutdown closes the named browser session, terminates both child process trees, finalizes and captures its offline evidence, and removes temporary files unless `--keep-temp` was selected. Evidence under `test-results/agent-lab/<run-id>/` is retained.

## Drive and visually inspect the UI

Read `browserConfigPath`, `browserSession`, `browserOutputPath`, and `projectUrl` from the manifest. The first command creates the isolated session:

```bash
npm run --silent agent:browser -- --config <browser-config> -s=<session> open <project-url>
```

Pass the config only to `open`. Subsequent commands address the existing named session without `--config`:

```bash
npm run --silent agent:browser -- -s=<session> snapshot
npm run --silent agent:browser -- -s=<session> click <ref>
npm run --silent agent:browser -- -s=<session> fill <ref> "[agent-lab:idle] inspect terminal"
npm run --silent agent:browser -- -s=<session> press Enter
```

Snapshots expose accessible roles, names, states, and stable action refs. Refresh the snapshot after navigation or a large state change rather than reusing stale refs.

Every session-linked browser command is appended to `browser-actions.jsonl` with a stable action id, start/end timestamps, monotonic offset, bounded arguments, exit/signal/error outcome, and diagnostic mark ids immediately before and after the action. Artifact paths are rewritten to `$LAB_ARTIFACT`, temporary paths to `$LAB_TMP`, and repo paths to `$REPO`; unrelated absolute paths are replaced. Synthetic `fill`, `type`, and `eval` values may be retained because the lab forbids real data. This transcript is copied into each later canonical checkpoint so runtime events can be correlated with the exact browser action without relying on shell history.

For visual debugging, save to an absolute path inside `browserOutputPath`, then inspect the PNG with the agent's local image-viewing capability:

```bash
npm run --silent agent:browser -- -s=<session> screenshot --filename=<browser-output>/board-wide.png --hires
npm run --silent agent:browser -- -s=<session> resize 390 844
npm run --silent agent:browser -- -s=<session> screenshot --filename=<browser-output>/board-narrow.png --hires
```

This lets an agent directly assess pixel-level spacing, clipping, layering, contrast, terminal paint, and responsive behavior. For intermittent failures, bracket the reproduction with `tracing-start` / `tracing-stop`, and inspect `console` plus `requests`. Playwright traces contain DOM snapshots, screenshots, console output, and network activity.

The unified recorder cannot reconstruct historical pixels from a browser that was never screenshotted. Capture explicit last-good and failed-state PNGs when the problem is visual. The runtime/browser metadata snapshot can explain layout bounds, visibility, connection state, persistence state, and terminal metrics, but the PNG or Playwright trace remains visual truth.

The lab also extends `window.__quarterdeckDumpTerminalState()` with bounded visible viewport lines. Query it through browser `eval` to correlate pixels with exact xterm buffer/session state:

```bash
npm run --silent agent:browser -- -s=<session> eval "JSON.stringify(window.__quarterdeckDumpTerminalState?.())"
```

The same terminal provider exists in production, but visible terminal lines are deliberately omitted there. Do not copy lab assumptions about terminal content into live-instance diagnostics.

## Deterministic fake agent

Select a default with `start --scenario <name>` or override one task by including a prompt directive:

- `idle` — interactive terminal;
- `needs-input` — Codex permission wait;
- `review` — completed root turn;
- `failure` — non-zero process exit;
- `git-dirty` — synthetic file edit;
- `terminal-stress` — bounded scrollback output.

The interactive protocol includes `/needs-input`, `/working`, `/review`, `/write`, `/commit`, `/status`, `/spam`, `/alt-on`, `/alt-off`, `/delay-review`, `/fail`, and `/exit`. Run `/help` inside the fake terminal for exact syntax. File writes are restricted to the disposable checkout. All stable terminal markers begin with `AGENT LAB`; startup prints `AGENT LAB READY`.

## Automated regression suite

`npm run web:e2e` uses the same supervisor and allocates dynamic loopback ports before Playwright loads its configuration. CI can still pin them with `QUARTERDECK_E2E_RUNTIME_PORT` and `QUARTERDECK_E2E_WEB_PORT` when its runner requires explicit ports. Playwright Test blocks non-loopback page requests, attaches browser console/network logs, and retains screenshots, video, and traces on failure. Functional smoke paths add the second synthetic repository through the browser manual-path prompt, verify the forbidden-launch log stays empty, open the unified Diagnostics panel, and create/start a task through the fake agent until its card moves to Review.

## Failure reports

Include:

1. run id and exact command/action sequence;
2. expected and observed state;
3. last-good and failed screenshot paths;
4. trace, console, and request evidence;
5. runtime/web log excerpts;
6. canonical checkpoint path and any doctor findings;
7. whether the failure reproduces in a fresh run.

This is enough for another agent to replay the failure without the original browser or runtime process.
