# Development

`README.md` is the product overview. This file is the human-facing developer guide for working on Quarterdeck itself.

`AGENTS.md` is the canonical repo-owned agent-instructions file. `CLAUDE.md` is only a Claude Code compatibility shim and should not hold duplicated project docs.

## Requirements

- Node.js 22.22.2+ (`nvm use` reads the repository `.nvmrc`)
- npm 11.19.0 (pinned by `packageManager`)

## Install

```bash
npm run bootstrap
```

Quarterdeck has two independent dependency trees: the repository root and `web-ui/`. Bootstrap preserves or migrates the clone-wide Agent Lab browser cache before running `npm ci` for both trees. Task worktrees start without shared `node_modules`; run bootstrap (or the individual `npm ci` commands) inside a worktree before building or testing there. Stop a globally linked Quarterdeck runtime before reinstalling or relinking its checkout.

## Quick reference

```bash
npm run bootstrap        # Locked install of root + web-ui deps
npm run dev              # Runtime server (watch mode, port 3500)
npm run dev:full         # Runtime + web UI together
npm run web:dev          # Web UI dev server (Vite HMR, port 4173)
npm run build            # Web typecheck/build + runtime package build
npm run check            # Agent docs + Biome + runtime typecheck/tests
npm run test             # All root runtime + integration tests
npm run test:fast        # Runtime + utility tests only
npm run test:integration # Integration tests only
npm run web:test         # Web UI unit tests
npm run web:e2e          # Playwright smoke tests with isolated runtime state
npm run agent:lab -- --help       # Disposable Quarterdeck runtime/UI/fake-agent lab
npm run agent:browser -- --help   # Isolated Playwright CLI for semantic + visual UI driving
quarterdeck diagnostics --help    # Discover and inspect local runtime diagnostics
npm run web:typecheck    # Web UI typecheck
npm run typecheck        # Runtime typecheck
npm run lint             # Biome lint
npm run format           # Biome check --write
npm run dogfood          # Build and launch against a target project
npm run link             # Global CLI symlink for local dev
```

## Repo orientation

For deeper architecture reading, start with [`docs/README.md`](./docs/README.md) and [`docs/architecture.md`](./docs/architecture.md). The quick mental model is:

```text
Browser UI (React + Vite, port 4173)
  | tRPC + WebSocket
  v
Runtime server (Node.js, port 3500)
  | spawns PTY sessions
  v
Agent processes (Claude, Codex, shell)
  | emit hook events / terminal output
  v
Quarterdeck task and review state
```

Major directories:

- `src/`: runtime, terminal session management, tRPC, state, config, worktree lifecycle
- `web-ui/src/`: React app, components, hooks, runtime client, stores, terminal surfaces
- `test/`: runtime and integration tests
- `docs/`: human-facing architecture, conventions, plans, and implementation history
- `scripts/`: build/dev utility scripts

Choose validation with [`docs/testing.md`](./docs/testing.md). When that strategy calls for agent-driven functional or visual debugging, use [`docs/agent-functional-testing.md`](./docs/agent-functional-testing.md); the workflow is isolated from the normal dev/dogfood runtime and the user's Quarterdeck state.

## Hot reload workflow

Run two terminals:

1. Runtime server (API + PTY agent runtime):

```bash
npm run dev
```

- Runs on `http://127.0.0.1:3500`

2. Web UI (Vite HMR):

```bash
npm run web:dev
```

- Runs on `http://127.0.0.1:4173`
- `/api/*` requests from Vite are proxied to `http://127.0.0.1:3500`

Use `http://127.0.0.1:4173` while developing UI so changes hot reload.

## VS Code F5 debugging

The repo includes `.vscode/launch.json` with two configurations:

- **Dev Server**: Launches the runtime server with `tsx watch` (same as `npm run dev`) with the debugger attached. Run `npm run web:dev` in a separate terminal for the web UI.
- **Run Tests**: Runs `vitest run` with the debugger so you can set breakpoints in tests.

## Build and run packaged CLI

```bash
npm run build
node dist/cli.js
```

This mode serves built web assets from `dist/web-ui` and does not hot reload the web UI.

Runtime port options:

```bash
# fixed port
node dist/cli.js --port 3500

# pick the first free port starting at 3500
node dist/cli.js --port auto
```

You can still use `QUARTERDECK_RUNTIME_PORT` if needed, but `--port` is preferred for local multi-instance runs.

## Dogfooding with two Quarterdeck instances

Run your stable orchestrator first (main checkout):

```bash
cd /path/to/quarterdeck-main
npm run build
node dist/cli.js --port 3500
```

Then run a test checkout against a target project (feature worktree):

```bash
cd /path/to/quarterdeck-feature-worktree
npm run dogfood -- --project /path/to/target/repo --port auto
```

If `--project` is omitted, the launcher starts Quarterdeck from a non-git cwd so runtime behaves like launching outside a git repo and opens the first indexed project (if any):

```bash
npm run dogfood -- --port auto
```

Dogfood launcher behavior:

- builds the current checkout by default
- launches `dist/cli.js` with `cwd` set to the target project
- supports `--port <number|auto>`
- supports `--no-open`
- supports `--skip-build` when you already built and want faster restarts

## Unified diagnostics

Quarterdeck has one local diagnostic system shared by normal runtimes and the isolated agent lab. It replaces the former runtime/browser debug-log buffers and panel; do not add a second ring buffer, WebSocket log feed, or panel-owned recorder.

### What happens automatically

Every normal runtime creates a private descriptor and starts a lightweight flight recorder before startup cleanup. No setting, panel, or reproduction step is required. A fresh coding agent can therefore investigate an event that happened earlier in the current run, or read the bounded journal from a recently finalized run.

The default recorder keeps metadata rather than content:

- essential runtime, project-save, task/session, hook-delivery, terminal-transport, browser-connectivity, Git-operation, backup, and recorder-health events;
- content-free shape summaries for warning/error compatibility logs, plus explicit diagnostic marks;
- at most 2,000 recent records in memory;
- an asynchronous journal with a 1,000-record queue, 250 ms/64-record batching, and four rotating 2 MiB JSONL segments;
- bounded/redacted records: 8 KiB maximum, 2 KiB strings, limited object depth/key/array counts, and path aliases.

It excludes prompts, task text, arbitrary logger messages/data, terminal output/transcripts, file contents, Git diffs, environment values, full process arguments, request bodies, DOM text, secrets, render-loop noise, PTY output chunks, and polling samples. Diagnostics failure is isolated from application behavior; queue or journal pressure is reported and bounded rather than allowed to block the runtime. Transient journal failures keep their bounded pending evidence and retry with capped exponential backoff without waiting for a new event.

The browser recorder also starts automatically, independently of whether its panel is open. It retains essential connectivity, persistence, navigation, and browser-error evidence, batches up to 25 records or one second through a connection-scoped capability, and keeps a bounded 24-hour session-storage tail for reconnect. The runtime can request a fresh metadata-only browser snapshot, but inspection never becomes a second board writer, resizes a PTY, starts/stops a session, or repairs state.

The top-bar Activity button and `Cmd/Ctrl+Shift+D` open Diagnostics. The panel shows the unified timeline, filters, recorder health, doctor findings, and subsystem snapshots. Opening it explicitly subscribes that connection to bounded best-effort timeline batches; closing it unsubscribes, and socket backpressure drops this replaceable projection before it can compete with application state. Neither action changes capture policy: the recorder and journal remain automatic either way. Console verbosity is still a separate setting and does not control flight-recorder admission.

### Investigate a current or recent runtime

The CLI discovers runtime descriptors under `QUARTERDECK_STATE_HOME` (normally `~/.quarterdeck`) and defaults to the newest active instance, then the newest retained stopped, failed, or crashed instance. Quarterdeck retains the latest three dead instances and prunes older journals at the next startup. Use `--instance <runtime-id>` when more than one instance matters. Every inspection command has stable JSON output where applicable.

```bash
quarterdeck diagnostics list --json
quarterdeck diagnostics status --json
quarterdeck diagnostics doctor --request-browser --json
quarterdeck diagnostics capture --request-browser --json
quarterdeck diagnostics watch --duration 60s --jsonl
quarterdeck diagnostics mark "before restarting task" --task <task-id> --json
```

`list` and finalized-instance capture can use the private on-disk descriptor/journal without the server. Live status, browser requests, marks, and recording controls use an authenticated loopback endpoint; the token never appears in public descriptors, CLI output, bundle manifests, or lab evidence. Read-only commands do not connect as a normal browser client and cannot bump the board revision.

Useful filters are `--project`, `--task`, `--session`, `--operation`, `--source`, `--level`, `--event`, `--since`, and `--until`. Project/task scope is applied both to timeline records and to subsystem-owned snapshot projections and findings, rather than packaging unrelated projects beside filtered records. Names use hierarchical prefixes, so `--event terminal` matches terminal events. `watch` is polling-based and bounded to 15 minutes; it does not subscribe to or attach to a task PTY.

`doctor` captures bounded subsystem snapshots with per-provider deadlines and derives findings. It reports partial/unavailable providers instead of mutating or repairing them. Use `--fail-on-error` for automation that should exit 5 on error-severity findings.

`capture` writes a new private directory atomically, normally under `~/.quarterdeck/diagnostics/bundles/`. Start with `manifest.json`, then use:

- `records.jsonl` for the sequence-ordered correlated timeline;
- `doctor.json` for findings;
- `runtime/descriptor.json` and `runtime/recorder-health.json` for discovery/retention state;
- the provider JSON files under `runtime/`, `projects/`, and `browser/`;
- `README.md` for capture limitations and disclosure notes.

The manifest records capture tier, time range, filters, content flags, warnings, counts, every file's size, and SHA-256. A timeout or unavailable browser creates a clearly marked partial bundle rather than an apparently complete one. Bundles are local and never uploaded automatically; review them before sharing.

### Temporary deep recording

When the always-on metadata is insufficient, explicitly start a bounded window:

```bash
quarterdeck diagnostics record --duration 5m --project <project-id> --category terminal --category browser --json
quarterdeck diagnostics record --status --json
quarterdeck diagnostics record --stop --json
```

Deep recording admits lower-level candidates matching the optional project/task/category scope. It expires automatically, is capped at 15 minutes, is not persisted across runtime restart, and still passes through the same size limits, redaction, and prohibited-value policy. It does not enable terminal transcripts or Git diffs. Live capture does not expose content-enrichment flags until a concrete provider can honor each flag with its own reviewed allowlist; manifest content flags therefore describe data actually collected rather than inert authorization intent.

### Isolated lab behavior and visual evidence

`QUARTERDECK_AGENT_LAB=1` is set only by the agent-lab supervisor. It automatically selects the richer bounded `agent-lab` admission profile for synthetic data and cannot be stopped through deep-recording controls. Lab ready/failure/pre-shutdown/final/manual checkpoints use the same canonical bundle format and may additionally contain synthetic fixture state, Git diffs, terminal viewport text, process logs, Playwright artifacts, and a causally marked browser-action transcript. Pre-shutdown preserves the connected browser view; the final checkpoint is deliberately captured only after the browser and child processes stop and the lab manifest is finalized, while disposable state still exists.

Live diagnostics can describe viewport/layout bounds, terminal buffer metrics, and application state, but they cannot recreate pixels that were never captured. For spacing, clipping, contrast, stacking, responsive, or terminal-paint failures, use the isolated lab and save explicit screenshots or a Playwright trace as described in [`docs/agent-functional-testing.md`](./docs/agent-functional-testing.md).

## Run `quarterdeck` from any directory

After cloning and installing dependencies, create/update the global CLI link from this repo:

```bash
npm run link
```

`npm run link` does not install dependencies. It checks both dependency trees, builds, and then updates the development symlink. If either tree is missing, it prints the exact `npm ci` remediation. If the globally linked runtime is currently running from this checkout, stop it before relinking.

Verify:

```bash
which quarterdeck
quarterdeck --version
```

Then run from any project directory:

```bash
cd /path/to/your/project
quarterdeck
```

After local code changes, run `npm run build` again before using the linked command.

When switching between worktrees, re-run `npm run link` from the worktree you want to test so the global `quarterdeck` binary points at the right `dist/cli.js`.

Remove the global link:

```bash
npm run unlink
```

## Validation and test layout

[`docs/testing.md`](./docs/testing.md) is the canonical guide for choosing a proportionate validation set. It includes the change-to-test matrix, command scopes, overlap rules, and the criteria for Playwright, deterministic Agent Lab, real-provider runs, cold restarts, and screenshots.

Important command boundaries:

- `npm run check` covers the instruction bridge, repository Biome check, runtime typecheck, and all root Vitest tests. It does not cover web typechecking/tests, Playwright, or Agent Lab.
- `npm run build` already performs the web typecheck as part of the production web build before packaging the runtime.
- The pre-commit hook already runs staged Biome, the runtime typecheck, and `test:fast`.
- `npm run web:e2e` is the automated disposable-browser smoke suite.
- `npm run agent:lab` plus `npm run agent:browser` is the interactive isolated functional lane.

See [`test/README.md`](./test/README.md) for root-test placement and naming. Web unit tests are colocated under `web-ui/src`; Playwright smoke tests live under `web-ui/tests`.

## CI/CD

- `ci.yml`: runs on pushes to `main` and PRs targeting `main`, delegating to reusable test workflow(s)
- `test.yml`: Ubuntu and macOS matrix covering the build (including web typecheck), lint, runtime typecheck/tests, and web-ui tests without repeating the standalone web typecheck
- `publish.yml`: manual release workflow that verifies the tag, runs tests, publishes to npm via OIDC, and creates the GitHub Release

## Agent tracking and runtime hooks

Quarterdeck tracks agent session state with runtime hook events. The core transition model is:

- `in_progress -> review`
- `review -> in_progress`

Internal runtime session states are named `running` and `awaiting_review`, and hook events are transition intents:

- `to_in_progress` for `review -> in_progress`
- `to_review` for `in_progress -> review`

How it works end to end:

1. `prepareAgentLaunch` installs a launch-scoped hook configuration for the selected agent. Claude receives a Quarterdeck-owned settings file; Codex receives inline `-c hooks...` configuration, the native `hooks` feature flag, and matching launch-scoped trust entries. Quarterdeck does not modify repository or user-global Codex hook files.
2. Hook handlers call `quarterdeck hooks ...` subcommands.
3. `quarterdeck hooks ingest --event <to_review|to_in_progress|activity>` reads process identity from env:
   - `QUARTERDECK_HOOK_TASK_ID`
   - `QUARTERDECK_HOOK_PROJECT_ID`
   - `QUARTERDECK_HOOK_SESSION_INSTANCE_ID`
4. State transitions use the reliable `ingest` path with a bounded retry and durable replay outbox. High-frequency metadata-only activity can use the short, best-effort `notify` path.
5. The runtime validates task, project, session-instance, and hook ordering identity, then applies state and hook metadata through the session transition owner. Duplicate, stale, or invalid transitions are ignored safely.

Current agent mappings:

- Claude
  - prompt submission, tool completion/failure, and elicitation response emit `to_in_progress`
  - permission/input waits, plan or user questions, elicitation, and root turn completion/failure emit `to_review`
  - session identity, tool starts, subagent activity, compaction, and ordinary notifications emit metadata-only `activity`
- Codex
  - prompt submission, tool completion, and manual compaction start emit `to_in_progress`
  - native permission requests, manual compaction completion, and root `Stop` emit `to_review`
  - session identity and tool starts emit metadata-only `activity`; a narrow rendered-screen detector covers nested approval overlays that do not produce the native permission hook

Important behavior details:

- Hook activity is best-effort, but state transitions are delivered reliably enough to avoid leaving cards stuck after a transient runtime request failure.
- Session-start hooks capture resumable provider identity without changing task state.
- Runtime transition guards remain authoritative and prevent stale hooks or redraws from flapping state.
- Terminal output is not work-state truth. Fix missed state at the hook, identity, or ordering layer rather than adding output-volume or timestamp heuristics.
- Hook transport is implemented in Node and invoked through `quarterdeck hooks ...`, so the behavior is consistent across Windows and non-Windows environments.

See [`docs/conventions/session-lifecycle.md`](./docs/conventions/session-lifecycle.md) before changing hook mappings, transition ownership, resume identity, or approval fallbacks.
