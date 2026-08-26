---
name: quarterdeck-functional-testing
description: Boot, inspect, and drive Quarterdeck through an isolated browser UI with either its deterministic fake coding agent or an explicitly authorized real Codex provider. Use for Quarterdeck functional testing, visual debugging, browser/terminal lifecycle regressions, Git or Files workflow checks, real-provider compatibility checks, and reproducible UI failure reports. Do not use for ordinary unit tests or against the user's active Quarterdeck instance.
---

# Quarterdeck Functional Testing

Use this skill only after [`docs/testing.md`](../../../docs/testing.md) selects the Agent Lab layer. Run the narrowest scenario that proves the changed browser/runtime/PTY, persistence, Git/Files, host-integration, or visual invariant.

Use the repo-owned agent lab instead of `npm run dev`, `npm run dev:full`, `npm run dogfood`, or an already-running Quarterdeck instance. The lab uses disposable state and synthetic projects; its default agent is a deterministic fake `codex`.

## Start and discover the run

Run `npm run --silent agent:lab -- start --name <short-name> --json`. Parse the returned manifest and retain `runId`, `projectUrl`, `browserConfigPath`, `browserOutputPath`, `browserSession`, `hostEventLedgerPath`, and `forbiddenHostLaunchLogPath`.

### Choose the agent mode

Omit `--agent` for the deterministic fake lane. Use it for routine regression work, seeded scenarios, CI, and replayable state assertions.

Use the authenticated lane only when the user has authorized real provider/account use and the question depends on Codex's actual TUI, hooks, model behavior, or event ordering:

```text
npm run --silent agent:lab -- start --name <short-name> --agent real-codex --json
```

Real mode preflights the selected authenticated CLI profile, stages only its cached credential into a disposable Codex home, and does not forward API keys or profile integrations. It is nondeterministic and consumes the user's provider plan. Use only synthetic prompts, keep effectful commands behind approval, never run it in CI, and always stop it. See [`docs/agent-functional-testing.md`](../../../docs/agent-functional-testing.md#agent-modes) for the isolation contract and supported overrides.

If Chromium has not been installed for this clone, ask before downloading it, then run `npm run agent:browser -- install-browser chromium`. Use the wrapper, not `playwright-cli`; the wrapper keeps shared browser binaries and run-specific profiles/artifacts in their documented isolated locations.

Open the run once with configuration:

```text
npm run --silent agent:browser -- --config <browserConfigPath> -s=<browserSession> open <projectUrl>
```

The config is accepted when the session opens. For every later browser command, omit `--config` and keep only `-s=<browserSession>`.

## Observe, interact, and see pixels

Start with `snapshot` and use returned semantic refs for `click`, `fill`, `type`, `press`, `hover`, and `find`. Do not guess refs after navigation or a large UI update; take another snapshot.

For visual issues, capture an explicit pixel artifact with an absolute filename inside `browserOutputPath`. Skip screenshots when the claim is purely semantic:

```text
npm run --silent agent:browser -- -s=<browserSession> screenshot --filename=<browserOutputPath>/checkpoint.png --hires
```

Inspect that PNG with the available local image-viewing capability. Use `resize <width> <height>` plus named screenshots for responsive checkpoints. The screenshot is the source of truth for spacing, clipping, contrast, stacking, terminal paint, and other visual behavior; the semantic snapshot is the source of truth for accessible names and interactions.

For a difficult failure, use `tracing-start` before reproduction and `tracing-stop` afterward. Inspect `console` and `requests`; capture last-good and failed screenshots only when pixels matter. The CLI writes snapshots, console records, network records, traces, and videos to `browserOutputPath`.

Quarterdeck exposes `window.__quarterdeckDumpTerminalState()` in the lab. Use `eval "JSON.stringify(window.__quarterdeckDumpTerminalState?.())"` to inspect each slot's task identity, session state, buffer metrics, and bounded visible terminal lines without OCR.

For host-integration work, assert the typed simulated-host event ledger's sanitized target and outcome instead of claiming a real IDE, picker, clipboard, or sound was used. Keep `forbidden-host-launches.log` as the separate hard-failure assertion. The endpoint and event contract are documented in [`docs/agent-functional-testing.md`](../../../docs/agent-functional-testing.md#host-integration-modes-and-event-ledger).

## Drive deterministic fake-agent behavior

Use a prompt directive such as `[agent-lab:idle] investigate terminal restore` when creating the task. Then type deterministic commands into the task's `Terminal input` textbox. See [references/protocol.md](references/protocol.md) for scenarios and commands, including `/turn-interrupted` for Codex's hookless rendered turn-failure path.

This protocol is available only in the default fake lane. In real mode, use an ordinary synthetic prompt and interact with the provider's actual forms exactly as rendered, including numeric choices and arrow selection plus Enter when relevant.

A newly spawned `[agent-lab:idle]` native session must appear as Review/Unconfirmed, not Running. Use `/working` whenever a scenario needs authoritative Running before testing interruption, permission, or completion convergence.

### Select only the relevant regression class

- For state projections, drive the exact changed transition and assert every affected projection together. Do not run the complete lifecycle matrix for an unrelated change.
- For approvals, use only the fake protocol path whose ownership changed: native wait, automatic resolution, rendered-overlay fallback, cancellation, or response-pending convergence.
- For interruption or rendered-failure work, establish authoritative Running first, then assert the affected interruption and any newer-turn ordering fence.
- For bulk board-revision work, use the multi-task UI; independent single-task submissions do not exercise that regression class.
- For ordinary Git, Files, or host-integration work, use the matching UI action and ledger assertion without adding lifecycle scenarios.

Neither terminal input nor overlay disappearance proves Running. Require a current provider hook for that transition. A browser reconnect does not prove cold-start behavior; use `restart-runtime` only when persisted hydration, startup recovery, or exact-session restore is in scope.

Capture runtime/state evidence with `npm run --silent agent:lab -- snapshot <runId> --label <checkpoint> --json`. The checkpoint directory is a canonical unified diagnostic bundle: start with `manifest.json`, then correlate `records.jsonl`, `doctor.json`, live provider snapshots, fixture state/Git evidence, process logs, and Playwright artifacts. The lab enables the bounded rich diagnostic profile automatically; never start a separate deep-recording mode for it.

For persisted hydration, startup recovery, project-pill classification, or browser reconnection across a real process boundary, restart only the runtime while preserving the disposable HOME, state, projects, web process, and browser session:

```text
npm run --silent agent:lab -- restart-runtime <runId> --mode graceful --json
```

The supervisor automatically captures `pre-runtime-restart-<generation>` and `post-runtime-restart-<generation>` checkpoints and records the old/new process generations in the manifest. Do not replace this operation with a browser refresh or reconnect when validating cold-start behavior. A completed command means the old runtime exited, the replacement became healthy on the same port, and the post-restart checkpoint was attempted.

For a multi-project startup regression, leave the affected project inactive before restarting, inspect its projections before selecting it, then confirm selection does not change them. Skip this expansion when project-scoped startup is not part of the claim.

The bundle stores the validated simulated host-event ledger at `lab/host-events.json`. Use its typed sequences for host-workflow assertions and keep `forbidden-host-launches.log` as the separate hard failure signal.

Every session-linked `agent:browser` command is recorded in `browser-actions.jsonl` with bounded arguments, outcome, and diagnostic marks before and after the action. Checkpoints copy the transcript available at capture time. Do not put real credentials or data into browser actions: the lab retains synthetic fill/type/eval text to make failures replayable.

## Finish and report

Always stop the run, even after a failed reproduction:

```text
npm run --silent agent:lab -- stop <runId> --json
```

Shutdown captures the final evidence, closes the named browser and owned daemon tree, terminates the managed runtime/web processes, and removes temporary state unless `--keep-temp` was selected. Evidence remains under the manifest's `artifactDir`; a residual owned browser process fails the run.

A useful failure report includes the run id, exact actions, expected and observed behavior, the relevant semantic/diagnostic evidence, visual artifacts only when pixels matter, and confirmation that the forbidden-launch log is empty. Treat the lab as data/process isolation from the user's app, not as a hardened security sandbox; use only synthetic data.
