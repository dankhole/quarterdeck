---
name: quarterdeck-functional-testing
description: Boot, inspect, and drive Quarterdeck through an isolated browser UI with either its deterministic fake coding agent or an explicitly authorized real Codex provider. Use for Quarterdeck functional testing, visual debugging, browser/terminal lifecycle regressions, Git or Files workflow checks, real-provider compatibility checks, and reproducible UI failure reports. Do not use for ordinary unit tests or against the user's active Quarterdeck instance.
---

# Quarterdeck Functional Testing

Use the repo-owned agent lab instead of `npm run dev`, `npm run dev:full`, `npm run dogfood`, or an already-running Quarterdeck instance. The lab uses dynamic loopback ports; disposable HOME, state, project, and worktree directories; and a browser restricted to loopback origins. Its default agent is a deterministic fake `codex`; real Codex is an explicit, non-CI mode for provider-behavior questions the fake cannot answer.

## Start and discover the run

Run `npm run --silent agent:lab -- start --name <short-name> --json`. Parse the returned manifest and retain `runId`, `projectUrl`, `browserConfigPath`, `browserOutputPath`, `browserSession`, `hostEventLedgerPath`, and `forbiddenHostLaunchLogPath`.

### Choose the agent mode

Omit `--agent` for the deterministic fake lane. Use it for routine regression work, seeded scenarios, CI, and replayable state assertions.

Use the authenticated lane only when the user has authorized real provider/account use and the question depends on Codex's actual TUI, hooks, model behavior, or event ordering:

```text
npm run --silent agent:lab -- start --name <short-name> --agent real-codex --json
```

The command runs `codex login status` before startup and reuses only the cached credential from the selected current CLI profile. It does not forward `OPENAI_API_KEY` or load that profile's configuration. The source profile is `$CODEX_HOME` when set and otherwise `~/.codex`; use `--codex-home <path>` for another already-authenticated profile. Agent Lab stages the cached credential into a private disposable Codex home, records only `profileSource` publicly, and removes the staged credential during normal shutdown even with `--keep-temp`. Codex and its tool subprocesses retain the disposable HOME and Agent Lab `PATH`, including the forbidden-host-launch sentinels; only the Codex process receives the isolated `CODEX_HOME`, and model-generated subprocess environments exclude it. The wrapper resolves only the Codex executable from the host `PATH` before restoring the lab `PATH`.

Real mode defaults to `gpt-5.6-luna`, low reasoning, the standard/default service tier, the built-in OpenAI provider, read-only sandboxing, user approval on request, disabled web search/history indexing, and local task titles. Because the disposable Codex home contains no source profile configuration, its MCP servers, apps, plugins, hooks, skills, and preferences are absent; launch policy also disables integrations, subagents, memories/goals, background dependencies, notifications, analytics/telemetry, update checks, and login-shell/profile loading before Quarterdeck installs only its launch-scoped hooks. `--model`, `--codex-sandbox`, and `--codex-approval-policy` are explicit real-only overrides. It accepts only the `idle` lab scenario; fake prompt directives and fake terminal commands do not apply.

Real mode is nondeterministic and makes OpenAI provider calls against the user's Codex account or plan. Codex receives only synthetic fixture content; provider-owned session/resume records remain in its disposable profile and normal shutdown removes them with the rest of the run state. Use synthetic prompts, keep effectful commands behind approval, never run this lane in CI, and always stop it. Quarterdeck host integrations remain simulated in both modes; provider integrations are disabled in real mode.

If Chromium has not been installed for this clone, ask before downloading it, then run `npm run agent:browser -- install-browser chromium`. The wrapper stores only browser binaries under Git's common directory at `quarterdeck/agent-lab/playwright-browsers`, outside every `node_modules`, so linked worktrees reuse one download and dependency reinstalls cannot remove it. A complete symlink-free legacy cache may be copied there on first use without deleting the source. Browser profiles, daemon state, and artifacts remain worktree-local. Do not invoke `playwright-cli` directly.

Open the run once with configuration:

```text
npm run --silent agent:browser -- --config <browserConfigPath> -s=<browserSession> open <projectUrl>
```

The config is accepted when the session opens. For every later browser command, omit `--config` and keep only `-s=<browserSession>`.

## Observe, interact, and see pixels

Start with `snapshot` and use returned semantic refs for `click`, `fill`, `type`, `press`, `hover`, and `find`. Do not guess refs after navigation or a large UI update; take another snapshot.

For visual issues, capture an explicit pixel artifact with an absolute filename inside `browserOutputPath`:

```text
npm run --silent agent:browser -- -s=<browserSession> screenshot --filename=<browserOutputPath>/checkpoint.png --hires
```

Inspect that PNG with the available local image-viewing capability. Use `resize <width> <height>` plus named screenshots for responsive checkpoints. The screenshot is the source of truth for spacing, clipping, contrast, stacking, terminal paint, and other visual behavior; the semantic snapshot is the source of truth for accessible names and interactions.

For a difficult failure, use `tracing-start` before reproduction and `tracing-stop` afterward. Inspect `console` and `requests`; capture a screenshot on both the last good state and the failed state. The CLI writes snapshots, console records, network records, traces, and videos to `browserOutputPath`.

Quarterdeck exposes `window.__quarterdeckDumpTerminalState()` in the lab. Use `eval "JSON.stringify(window.__quarterdeckDumpTerminalState?.())"` to inspect each slot's task identity, session state, buffer metrics, and bounded visible terminal lines without OCR.

Agent Lab also exposes a typed simulated-host event ledger at `/api/agent-lab/host-events`. Use browser `eval` with a GET request to list events or await a kind with `afterSequence`, `kind`, and `timeoutMs`; assert the sanitized scope/target and `outcome: "simulated"` instead of claiming that a real IDE, Finder window, clipboard, or sound was used. The directory picker is deliberately recorded as `unsupported` before Add Project uses manual path entry. Browser-owned workflows acknowledge success only after the event is durably recorded. The event endpoint exists only in simulated lab runtimes; `/flush` is reserved for live snapshot lifecycle checks. Live Agent Lab checkpoints flush and validate `host-events.json`; the offline final checkpoint validates the already durable file after runtime shutdown. `forbidden-host-launches.log` stays a separate shutdown-failing assertion.

## Drive deterministic fake-agent behavior

Use a prompt directive such as `[agent-lab:idle] investigate terminal restore` when creating the task. Then type deterministic commands into the task's `Terminal input` textbox. See [references/protocol.md](references/protocol.md) for scenarios and commands, including `/turn-interrupted` for Codex's hookless rendered turn-failure path.

This protocol is available only in the default fake lane. In real mode, use an ordinary synthetic prompt and interact with the provider's actual forms exactly as rendered, including numeric choices and arrow selection plus Enter when relevant.

A newly spawned `[agent-lab:idle]` native session must appear as Review/Unconfirmed, not Running. Use `/working` whenever a scenario needs authoritative Running before testing interruption, permission, or completion convergence.

### Verify state projections in three phases

For lifecycle, startup, project-pill, or notification work, do not stop after the seeded/static state looks correct:

1. Create ordinary Review and genuine Needs Input tasks and assert the board columns, project-row pills, card labels, and notification markers together. A blocked card remains in Review, but Needs Input overrides Review in navigation pills; two Review cards with one blocked task must show `R 1 · NI 1`.
2. Capture a diagnostic checkpoint, open each task, and submit the deterministic fake-agent response/new-turn command required to return it to Running. Wait for the card, project pill, and Needs Input marker to converge; switch away and back when a second project is present, then assert them again and capture the post-transition checkpoint.
3. On a synthetic Running task, send a bare Escape or Ctrl-C through the terminal, wait longer than the interrupt-recovery window, and assert that the card settles in Review as Interrupted while every Needs Input projection remains clear. Confirm `session.interrupt_recovery_scheduled` and `session.interrupt_recovery_applied` identify the signal and resulting state, then capture a checkpoint.

For Codex approval changes, exercise `/needs-input`, `/needs-input-auto`, and `/approval-overlay`. Accept the explicit waits with the single `y` hotkey and require an intermediate response-pending Review followed by provider-confirmed Running. The automatic case must converge through the exact preceding `PreToolUse` and matching `PostToolUse` without local response bytes. Assert the card, project pills, notification marker, and sound ledger together; neither input delivery nor overlay disappearance may claim Running.

When real-Codex approval compatibility is in scope, also exercise the provider's rendered numeric approval choice, Escape cancellation, and an exact-session runtime restart while the permission is waiting. Numeric acceptance must pass through response-pending before a current hook establishes Running. Escape and a recovered TUI that has already rendered the interrupted result must converge to Review/Interrupted, clear Needs Input and the outstanding interaction, and remain conservative across another restart. In Approve for me mode, require a real effectful synthetic command to launch without conflicting approval-policy or sandbox flags and complete without a user-facing Needs Input projection.

For Codex rendered-failure changes, separately submit `/turn-interrupted` from Running. Require immediate Review/Interrupted convergence across card and project pill without a native Stop hook, Needs Input, notification, or sound. Then submit `/new-turn`, require provider-confirmed Running, and submit `/redraw-interruption-history`; the historical failure must not defeat the newer hook. A subsequent real `/turn-interrupted` must still converge to Review/Interrupted. Perform a same-state runtime restart and assert the final conservative state survives hydration.

This proves notification clearing, cross-projection convergence, and that a user interrupt cannot fabricate an agent input request. It does not prove cold-start hydration: browser reconnect and runtime restart are separate regression classes. Use the same-state `restart-runtime` operation below for persisted-state coverage.

### Verify bulk create-and-start

For lifecycle or board-revision work, paste a numbered list containing at least four prompt directives spanning `[agent-lab:idle]`, `[agent-lab:review]`, `[agent-lab:needs-input]`, and `[agent-lab:failure]`. Choose **Split into 4 tasks**, then **Start 4 tasks**. With automatic title generation active, wait for all lifecycle outcomes and assert:

1. Every requested task identity exists in the authoritative board; none silently disappeared.
2. No lifecycle revision-conflict toast or diagnostic occurred because a title/session projection advanced the board between operations.
3. Running, Review, Needs Input, and failure behavior agree across cards, project pills, notifications, and the persisted checkpoint.

Do this through the multi-task UI. Four independent single-task submissions do not exercise the bulk-start regression class.

Capture runtime/state evidence with `npm run --silent agent:lab -- snapshot <runId> --label <checkpoint> --json`. The checkpoint directory is a canonical unified diagnostic bundle: start with `manifest.json`, then correlate `records.jsonl`, `doctor.json`, live provider snapshots, fixture state/Git evidence, process logs, and Playwright artifacts. The lab enables the bounded rich diagnostic profile automatically; never start a separate deep-recording mode for it.

For persisted hydration, startup recovery, project-pill classification, or browser reconnection across a real process boundary, restart only the runtime while preserving the disposable HOME, state, projects, web process, and browser session:

```text
npm run --silent agent:lab -- restart-runtime <runId> --mode graceful --json
```

The supervisor automatically captures `pre-runtime-restart-<generation>` and `post-runtime-restart-<generation>` checkpoints and records the old/new process generations in the manifest. Do not replace this operation with a browser refresh or reconnect when validating cold-start behavior. A completed command means the old runtime exited, the replacement became healthy on the same port, and the post-restart checkpoint was attempted.

For a multi-project startup regression, leave the affected project inactive before restarting. After the replacement runtime is healthy, inspect that inactive project's pills and notification marker before selecting it, then select it and assert the board and pills remain unchanged. This specifically catches recovery or session hydration that is still accidentally gated on project selection.

The bundle stores the validated simulated host-event ledger at `lab/host-events.json`. Use its typed sequences for host-workflow assertions and keep `forbidden-host-launches.log` as the separate hard failure signal.

Every session-linked `agent:browser` command is recorded in `browser-actions.jsonl` with bounded arguments, outcome, and diagnostic marks before and after the action. Checkpoints copy the transcript available at capture time. Do not put real credentials or data into browser actions: the lab retains synthetic fill/type/eval text to make failures replayable.

## Finish and report

Always stop the run, even after a failed reproduction:

```text
npm run --silent agent:lab -- stop <runId> --json
```

Shutdown captures connected-browser evidence, fences new browser commands, closes the named browser session, and terminates every surviving Playwright daemon/browser tree scoped to that exact lab session until consecutive process snapshots confirm quiescence. It writes the final canonical bundle, terminates both managed child process trees, and removes temporary state unless `--keep-temp` was explicitly requested. A residual browser process fails the run. The supervisor also captures ready, runtime-restart, failure when applicable, and pre-shutdown checkpoints. Evidence remains under the manifest's `artifactDir` (normally `test-results/agent-lab/<runId>/`; legacy worktrees with a shared `test-results` symlink use `.agent-lab-results/<runId>/`).

A useful failure report includes the run id, exact UI/terminal actions, expected and observed behavior, relevant screenshot/trace paths, console or request errors, canonical checkpoint path and doctor findings, relevant host-event sequences, and confirmation that the forbidden-launch log is empty. Treat the lab as data/process isolation from the user's app, not as a hardened security sandbox; use only synthetic data.
