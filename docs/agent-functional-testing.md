# Agent Functional Testing

Quarterdeck's agent lab is a disposable copy of the runtime and browser UI that coding agents can drive without Computer Use and without attaching to the user's active app. It is designed for functional regression testing and debugging across the board, dialogs, task PTYs, session lifecycle, Git, Files, state persistence, and visual layout.

The lab provides isolation from the user's data and processes; it is not a hardened container or a security boundary. Use synthetic fixtures only.

## What one run owns

Each `start` creates:

- two dynamically selected loopback ports for the runtime and Vite UI;
- a temporary HOME, `QUARTERDECK_STATE_HOME`, Git project, and task-worktree root;
- a second synthetic Git project for Add Project and project-switching tests;
- a minimal child environment that omits API keys, cloud credentials, SSH agent access, and user Git config;
- either the default fake `codex` executable or an opt-in real-Codex launcher injected at the front of that runtime's PATH only;
- native UI disabled by launch configuration, plus recording fakes for known picker, open, and IDE launchers that fail the run if invoked;
- an atomic manifest and stop-request control channel;
- continuously captured supervisor, runtime, and web logs;
- a named, in-memory Playwright browser session restricted to loopback origins;
- the unified diagnostic recorder in its bounded rich `agent-lab` profile, enabled automatically for the run;
- semantic page snapshots, screenshots, traces, videos, console/network records, and a marked browser-action transcript;
- canonical diagnostic bundles at ready, failure, pre-shutdown, final, and explicitly requested checkpoints.

The runtime and browser still use Quarterdeck's real project registry, tRPC/WebSocket transport, board persistence, worktree lifecycle, Codex adapter, PTY, native-hook ingest, session state machine, xterm renderer, Git APIs, and Files APIs. Quarterdeck-owned host-facing effects are always simulated. The external coding agent is fake by default and can be changed to real Codex only for an explicitly authorized provider-compatibility run; real mode also replaces profile-defined hooks and disables provider integrations that would bypass the simulated boundary.

Agent Lab keeps `nativeUiAvailable: false` and selects the separate `simulated` host-integration mode. Open in IDE, scoped file/folder opening, CLI-owned external browser launch, clipboard reads/writes, and notification audio complete through the same typed production contracts while recording a simulated outcome instead of touching the desktop. The native directory picker intentionally remains unavailable: Add Project records that attempt, then completes through the existing browser-managed manual-path prompt. Ordinary browser links and terminal links remain browser-contained, observable by Playwright, and subject to the lab's loopback-only page-request policy.

## Agent modes

The default `fake` mode is deterministic, offline, CI-safe, and supports the seeded scenarios and terminal protocol documented below:

```bash
npm run --silent agent:lab -- start --name terminal-restore --json
```

Use `real-codex` only when the user has explicitly authorized their Codex account or plan to be used and the test depends on the provider's real TUI, hooks, identity, or event ordering:

```bash
npm run --silent agent:lab -- start --name codex-approval --agent real-codex --json
```

Real mode preflights `codex login status` and reuses only the cached credential from the profile already authenticated by the CLI. It does not require or forward `OPENAI_API_KEY`. `$CODEX_HOME` selects the source profile when present; otherwise the default is `~/.codex`. Pass `--codex-home <path>` to select another already-authenticated profile. Agent Lab links the file-backed credential into a private disposable Codex home on macOS/Linux, or makes a permission-restricted temporary copy on Windows; keyring-backed credentials remain in the OS store. The source profile path and credential are omitted from persistent artifacts, public manifests, and diagnostic bundles. Normal shutdown removes the staged credential even when `--keep-temp` retains the synthetic project.

The surrounding Quarterdeck runtime retains its disposable HOME and receives neither `CODEX_HOME` nor API credentials. Its generated launcher gives only the Codex process the isolated credential-only `CODEX_HOME`, resolves only the Codex executable from the host `PATH`, restores Agent Lab's `PATH` before `exec`, immediately removes the wrapper variables, and excludes `CODEX_HOME` from model-generated subprocess environments. The Codex process and its shell tools therefore keep the disposable HOME and forbidden-host-launch sentinels instead of gaining the user's account HOME or bypassing the simulated host boundary. Missing or non-reusable CLI authentication fails startup before the runtime launches, and both preflight outputs are discarded.

The real launcher defaults to `gpt-5.6-luna`, the current Codex CLI's affordable agentic model; low reasoning effort; the standard/default service tier; the built-in OpenAI provider; read-only sandboxing; user approval on request; disabled web search and history indexing; and local task-title generation so the lab does not make a second model request. The disposable Codex home contains no source profile config, so profile MCP servers, apps/connectors, plugins, hooks, skills, and preferences never enter the run. Launch policy additionally disables integrations, subagents, memories, automatic goals, background dependencies, notifications, external file opening, feedback, analytics/telemetry, update checks, Fast mode, and login-shell/profile loading; Quarterdeck then adds only its launch-scoped lifecycle hooks. Use `--model`, `--codex-sandbox`, or `--codex-approval-policy` only when the scenario requires a different contract. Real-only flags are rejected in fake mode, and fake scenarios are deliberately rejected in real mode.

This mode is not hermetic: it makes OpenAI network calls and consumes the selected account's plan or API allowance. It reads the selected profile only to validate and stage its cached credential. Provider-owned session/resume records stay in the disposable Codex home rather than the user's normal profile and are removed on normal shutdown. Use only synthetic fixture content, keep effectful commands behind approval, never use the real lane in CI, capture its nondeterminism in the evidence report, and always stop the run. Browser navigation and Quarterdeck/provider host integrations remain isolated or disabled as described above.

## Host-integration modes and event ledger

The launch-derived host integration policy has three modes:

- `native` uses normal desktop integrations and reports `nativeUiAvailable: true`;
- `unavailable` blocks before launcher, clipboard, or audio implementations and returns typed failures;
- `simulated` keeps `nativeUiAvailable: false`, substitutes the Agent Lab implementations, and reports simulated success without invoking native launchers.

Every simulated action is written to `host-events.json`, whose absolute path is exposed as `hostEventLedgerPath` in the run manifest. Events have a monotonically increasing sequence, timestamp, origin, typed kind/outcome, and bounded semantic fields. Paths are represented only as a named fixture scope plus relative path; external URLs retain only an `http`/`https` origin and bounded path; clipboard contents are represented only by character count. Project/task identifiers are included when the public action supplies them. A candidate event is runtime-validated and atomically persisted before the endpoint or UI can acknowledge it. The ledger has a fixed capacity; validation, persistence, or overflow failures mark it unhealthy and fail final evidence capture instead of silently producing partial diagnostics.

The lab-only `/api/agent-lab/host-events` endpoint supports listing or long-polling events with `afterSequence`, `kind`, and a bounded `timeoutMs`. A `POST` to `/reset` atomically clears the ledger and restarts sequencing at one; a `POST` to `/flush` waits for queued mutations and rejects an unhealthy ledger. The endpoint is mounted only when the explicit simulation config injects the ledger; native and fail-closed runtimes return the normal API 404. Browser-owned simulations post their semantic events to this surface, while runtime-owned simulations write directly through the same ledger. Clipboard state changes only after its event is accepted, and simulated audio UI feedback waits for the notification event acknowledgement.

Each canonical checkpoint flushes and validates the current ledger while the runtime is live, then stores it at `lab/host-events.json`. The offline final checkpoint validates and copies the already durable ledger after the runtime stops. `forbidden-host-launches.log` remains a separate hard-failure signal: simulated success never calls a shadow launcher, and shutdown fails if that log is non-empty.

### Audited host crossings

| Integration class | Agent Lab disposition |
| --- | --- |
| macOS, Linux, and Windows directory pickers (`osascript`, `zenity`, `kdialog`, and PowerShell dialogs) | Intentionally unsupported with a typed result; the attempt is recorded and Add Project uses manual path entry. |
| Host file/folder open or reveal (`open`, `xdg-open`, Explorer) | Simulated through the runtime boundary; targets must resolve inside a named disposable scope. Settings exposes the reachable file-open flow; folder targets are covered at the public boundary because no current UI action reveals a folder directly. |
| Open in IDE/Finder/terminal | Simulated through the existing typed target ID and server-owned project path. No executable or command comes from the browser. |
| CLI-owned external browser launch | Simulated after URL scheme validation and credential/query/fragment removal. |
| Ordinary browser links and xterm web links | Browser-contained by design and still governed by the lab's loopback network policy; they never produce a host event. |
| Clipboard read/write, including xterm OSC 52 | Simulated by one in-memory browser clipboard; ledger events store character counts, never contents. |
| Notification sound | Simulated semantically with event type, volume, and optional project/task identity; no audio context is created. Quarterdeck has no desktop Notification API workflow; its title update remains browser-contained. |
| Credential/keychain access | Fake mode omits credentials and real agent configuration. Real Codex mode grants only its generated `codex` wrapper access to the selected existing CLI profile; the runtime still receives no API keys, cloud variables, SSH agent access, or copied authentication material. |
| Agent discovery, Git, PTY, and other runtime subprocesses | Not desktop integrations. They remain on the real runtime path inside the disposable environment; only the task agent and audited native launchers are shadowed. Binary presence never grants native-UI capability. |

## First-time setup

Install project dependencies normally, then install the browser used only by the agent wrapper:

```bash
npm run bootstrap
npm run agent:browser -- install-browser chromium
```

The Chromium build lives under Git's common directory at `.git/quarterdeck/agent-lab/playwright-browsers`, so all worktrees for the clone reuse it while `npm ci`, builds, and relinks leave it intact. Before replacing either dependency tree, `npm run bootstrap` copies a complete symlink-free cache from the legacy `web-ui/node_modules/.cache/agent-lab-playwright` location atomically and retains the source; browser startup performs the same preparation for clones that have not bootstrapped. Only downloaded browser binaries are shared: browser profiles, daemon state, disposable runtime/project state, screenshots, traces, and other artifacts stay under the active worktree's `test-results/agent-lab/` or its disposable temp root.

Each task worktree still needs its own root and web UI npm dependencies to invoke Agent Lab. Do not restore shared `node_modules` links to avoid that local bootstrap.

Mutable installed-dependency directories must never be mirrored into task worktrees. If a legacy dependency symlink already exists, unlink only the symlink at the worktree path. Never follow it, mutate its target, or automatically delete a real task-owned dependency directory.

## Lifecycle commands

Start a detached run and ask for machine-readable discovery data:

```bash
npm run --silent agent:lab -- start --name terminal-restore --json
```

The manifest includes the run id, status, URLs, temporary paths, artifact paths, browser config/session/output paths, host-event ledger and forbidden-launch log paths, launch capabilities, sanitized agent mode/configuration, PIDs, scenario, timestamps, and any startup failure. Ports default to `auto`; fixed `--runtime-port` and `--web-port` values exist for E2E and targeted debugging. `--keep-temp` retains the synthetic project/state after shutdown when filesystem inspection is necessary. Lifecycle commands can read manifest versions 1 through 4 so older active runs can still be listed, inspected, snapshotted, and stopped after an update; same-state runtime restart requires version 3 or newer, and manifests before version 4 are treated as fake-agent runs.

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

Shutdown fences new browser commands, closes the named browser session, resolves and discovers every detached Playwright daemon owned by that exact lab session, and terminates surviving daemon/browser trees until consecutive process snapshots confirm quiescence. It then stops both managed child process trees, finalizes and captures its offline evidence, and removes temporary files unless `--keep-temp` was selected. Cleanup is scoped by both the worktree-local Playwright daemon entrypoint and the exact `qd-<run-id>` session name, so parallel lab sessions are not targeted. A residual browser process fails the run instead of being silently ignored. Evidence under `test-results/agent-lab/<run-id>/` is retained.

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

The scenarios and commands in this section exist only in default `fake` mode. For real Codex, use ordinary synthetic prompts and interact with the provider's actual form, including its numeric or arrow-selection controls.

Select a default with `start --scenario <name>` or override one task by including a prompt directive:

- `idle` — interactive terminal seeded as Review/Unconfirmed until `/working` emits provider evidence;
- `needs-input` — Codex permission wait;
- `review` — completed root turn;
- `failure` — non-zero process exit;
- `git-dirty` — synthetic file edit;
- `terminal-stress` — bounded scrollback output.

The interactive protocol includes `/needs-input`, `/needs-input-auto`, `/approval-overlay`, `/turn-interrupted`, `/new-turn`, `/redraw-interruption-history`, `/local-action`, `/working`, `/review`, `/write`, `/commit`, `/status`, `/clipboard-read`, `/spam`, `/alt-on`, `/alt-off`, `/delay-review`, `/fail`, and `/exit`. A bare `y` accepts either native `/needs-input` or hookless `/approval-overlay` immediately and emits the matching `PostToolUse` after a short deterministic delay, mirroring Codex's approval hotkey without requiring Enter while leaving time to assert response-pending state. `/needs-input-auto` proves the real identity-bearing Codex sequence can resolve without nonexistent local input. `/new-turn` followed by `/redraw-interruption-history` proves a historical rendered failure cannot override a newer authoritative hook; a later `/turn-interrupted` must still remove false Running. `/clipboard-read` exercises the browser clipboard through xterm's OSC 52 path and prints a bounded `AGENT LAB CLIPBOARD READ` marker. Run `/help` inside the fake terminal for exact syntax. File writes are restricted to the disposable checkout. All stable terminal markers begin with `AGENT LAB`; startup prints `AGENT LAB READY`.

## Automated regression suite

`npm run web:e2e` uses the same supervisor and allocates dynamic loopback ports before Playwright loads its configuration. CI can still pin them with `QUARTERDECK_E2E_RUNTIME_PORT` and `QUARTERDECK_E2E_WEB_PORT` when its runner requires explicit ports. Playwright Test blocks non-loopback page requests, attaches browser console/network logs, and retains screenshots, video, and traces on failure. Functional smoke paths assert the startup host-URL simulation while ordinary links remain browser-contained, Open in IDE, config-file opening, notification audio, in-memory clipboard write/read through xterm, Add Project's manual fallback, the unified Diagnostics panel, and the proof-backed lifecycle: launch remains Review, `/working` establishes Running, Escape interrupts immediately, approval cancellation/acceptance clears Needs Input without input claiming Running, and the matching provider hook resumes work. Shutdown verifies the forbidden-launch log stays empty.

## Lifecycle regression classes

Browser reconnect and runtime cold restart are different tests. A reconnect does not exercise persisted-session hydration, stale-PID correction, startup recovery, or initial project-pill classification. For those changes, run the deterministic cold-start state-matrix and integration tests, including an unproven legacy `attention` record with a stale durable recovery flag, then use:

```bash
npm run --silent agent:lab -- restart-runtime <run-id> --mode graceful --json
```

This preserves disposable state, the web process, and the browser while replacing only the runtime. Leave the affected project inactive before restart, then verify its cards, notifications, and project pills before selecting it.

State-projection dogfood has three phases:

1. Assert static board columns, project pills, and notifications for ordinary Review and genuine Needs Input tasks. A blocked card remains in Review, but Needs Input overrides Review in navigation pills, so three Review cards with one blocked task display `R 2 · NI 1`.
2. Submit a new turn or response, wait for the authoritative transition to Running, and assert all three projections after switching away and back.
3. Send bare Escape or Ctrl-C to a synthetic Running task, wait past interrupt recovery, and require Review/Interrupted without any Needs Input card, pill, notification, or sound. Cover both convergence paths: `/working` must return the exact live session to Running before `/review` completes it, and a separate interrupted task receiving `/review` directly must become ordinary Ready for review when the intermediate working hook is absent.

Before phase 2, submit `/local-action model-changed` from a Review task. The terminal must print `AGENT LAB LOCAL ACTION`, while the card, project pills, and notifications remain in Review. Only a subsequent `/working` provider hook may move them to Running. This reproduces Codex commands such as `/model`, whose Enter key accepts local TUI state rather than starting agent work.

For Codex rendered-failure changes, submit `/turn-interrupted` from Running and require immediate Review/Interrupted convergence across the card and project pill without Needs Input, notification, or sound. Submit `/new-turn`, require provider-confirmed Running, then submit `/redraw-interruption-history` and require Running to survive the historical redraw. A later real `/turn-interrupted` must still converge to Review/Interrupted. Restart the runtime against the same state and require the conservative classification to survive cold hydration.

For authenticated Codex approval compatibility, cover three distinct real-provider paths: numeric approval must become response-pending before a current hook proves Running; Escape cancellation must clear the exact wait when Codex renders its complete interrupted result without a completion hook; and a runtime restart performed while the provider is waiting must clear stale Needs Input if the exactly resumed TUI renders that same terminal result and returns to its composer. Also launch one effectful synthetic command with Approve for me enabled and assert that the generated real-provider wrapper does not add conflicting `--ask-for-approval` or `--sandbox` arguments, no user-facing Needs Input appears, and current provider hooks still own Running and completion.

A static startup screenshot does not cover transition convergence, notification clearing, or false-positive attention after interruption.

Bulk lifecycle dogfood uses the multi-task dialog to create and start at least four synthetic tasks spanning unconfirmed idle/Review, provider-confirmed Running, ordinary Review, genuine Needs Input, and deterministic failure while automatic titles are enabled. Assert every requested identity persists, no lifecycle revision-conflict toast appears, and final cards, pills, notifications, and persisted evidence agree.

## Failure reports

Include:

1. run id and exact command/action sequence;
2. expected and observed state;
3. last-good and failed screenshot paths;
4. trace, console, and request evidence;
5. runtime/web log excerpts;
6. canonical checkpoint path and any doctor findings;
7. relevant host-event sequence(s) and `lab/host-events.json` path;
8. whether the forbidden-launch log is empty;
9. whether the failure reproduces in a fresh run.

This is enough for another agent to replay the failure without the original browser or runtime process.
