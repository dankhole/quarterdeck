---
name: quarterdeck-functional-testing
description: Boot, inspect, and drive Quarterdeck through an isolated browser UI with a deterministic fake coding agent. Use for Quarterdeck functional testing, visual debugging, browser/terminal lifecycle regressions, Git or Files workflow checks, and reproducible UI failure reports. Do not use for ordinary unit tests or against the user's active Quarterdeck instance.
---

# Quarterdeck Functional Testing

Use the repo-owned agent lab instead of `npm run dev`, `npm run dev:full`, `npm run dogfood`, or an already-running Quarterdeck instance. The lab uses dynamic loopback ports; disposable HOME, state, project, and worktree directories; a fake `codex`; and a browser that is restricted to loopback origins.

## Start and discover the run

Run `npm run --silent agent:lab -- start --name <short-name> --json`. Parse the returned manifest and retain `runId`, `projectUrl`, `browserConfigPath`, `browserOutputPath`, `browserSession`, `hostEventLedgerPath`, and `forbiddenHostLaunchLogPath`.

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

## Drive deterministic agent behavior

Use a prompt directive such as `[agent-lab:idle] investigate terminal restore` when creating the task. Then type deterministic commands into the task's `Terminal input` textbox. See [references/protocol.md](references/protocol.md) for scenarios and commands.

### Verify state projections in two phases

For lifecycle, startup, project-pill, or notification work, do not stop after the seeded/static state looks correct:

1. Create ordinary Review and genuine Needs Input tasks and assert the board columns, project-row pills, card labels, and notification markers together. Review is the full column total and Needs Input overlaps it; two Review cards with one blocked task must show `R 2 · NI 1`.
2. Capture a diagnostic checkpoint, open each task, and submit the deterministic fake-agent response/new-turn command required to return it to Running.
3. Wait for the card, project pill, and Needs Input marker to converge; switch away and back when a second project is present, then assert them again. Capture the post-transition checkpoint.

This proves notification clearing and cross-projection convergence. It does not prove cold-start hydration: browser reconnect and runtime restart are separate regression classes, and Agent Lab cannot yet perform a same-state runtime restart. Use the persisted-state matrix/integration coverage and record that limitation explicitly.

Capture runtime/state evidence with `npm run --silent agent:lab -- snapshot <runId> --label <checkpoint> --json`. The checkpoint directory is a canonical unified diagnostic bundle: start with `manifest.json`, then correlate `records.jsonl`, `doctor.json`, live provider snapshots, fixture state/Git evidence, process logs, and Playwright artifacts. The lab enables the bounded rich diagnostic profile automatically; never start a separate deep-recording mode for it.

For persisted hydration, startup recovery, project-pill classification, or browser reconnection across a real process boundary, restart only the runtime while preserving the disposable HOME, state, projects, web process, and browser session:

```text
npm run --silent agent:lab -- restart-runtime <runId> --mode graceful --json
```

The supervisor automatically captures `pre-runtime-restart-<generation>` and `post-runtime-restart-<generation>` checkpoints and records the old/new process generations in the manifest. Do not replace this operation with a browser refresh or reconnect when validating cold-start behavior. A completed command means the old runtime exited, the replacement became healthy on the same port, and the post-restart checkpoint was attempted.

The bundle stores the validated simulated host-event ledger at `lab/host-events.json`. Use its typed sequences for host-workflow assertions and keep `forbidden-host-launches.log` as the separate hard failure signal.

Every session-linked `agent:browser` command is recorded in `browser-actions.jsonl` with bounded arguments, outcome, and diagnostic marks before and after the action. Checkpoints copy the transcript available at capture time. Do not put real credentials or data into browser actions: the lab retains synthetic fill/type/eval text to make failures replayable.

## Finish and report

Always stop the run, even after a failed reproduction:

```text
npm run --silent agent:lab -- stop <runId> --json
```

Shutdown captures connected-browser evidence, closes the named browser session, writes the final canonical bundle, terminates both child process trees, and removes temporary state unless `--keep-temp` was explicitly requested. The supervisor also captures ready, runtime-restart, failure when applicable, and pre-shutdown checkpoints. Evidence remains under the manifest's `artifactDir` (normally `test-results/agent-lab/<runId>/`; legacy worktrees with a shared `test-results` symlink use `.agent-lab-results/<runId>/`).

A useful failure report includes the run id, exact UI/terminal actions, expected and observed behavior, relevant screenshot/trace paths, console or request errors, canonical checkpoint path and doctor findings, relevant host-event sequences, and confirmation that the forbidden-launch log is empty. Treat the lab as data/process isolation from the user's app, not as a hardened security sandbox; use only synthetic data.
