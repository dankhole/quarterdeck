# Development

`README.md` is the product overview. This file is the human-facing developer guide for working on Quarterdeck itself.

`AGENTS.md` is the canonical repo-owned agent-instructions file. `CLAUDE.md` is only a Claude Code compatibility shim and should not hold duplicated project docs.

## Documentation and change history

Update the guide that owns a changed workflow or contract. Keep the README brief; use the [documentation map](docs/README.md) to find the detailed reference. Routine changes and validation belong in PR descriptions and Git history. GitHub Releases uses generated notes, so write PR titles that explain the resulting behavior.

There is no maintained changelog or chronological implementation log. Record exceptional rationale in the owning architecture document, and keep user actions for breaking changes or migrations next to the affected setup or workflow. See [documentation policy](docs/maintenance.md#documentation-lifecycle) and the [release workflow](RELEASE_WORKFLOW.md).

## Requirements

- Node.js 22.22.2+ (`nvm use` selects Node 22.23.2 from the repository `.nvmrc`)
- npm 11.19.1 (`packageManager` pins the repository toolchain; package consumers do not need this exact npm release)

## Install

```bash
npm run bootstrap
```

Quarterdeck's npm/browser development uses two independent dependency trees: the repository root and `web-ui/`. The optional `desktop/` package has a third, separately installed tree; ordinary bootstrap and root builds do not install Electron. Bootstrap preserves or migrates the clone-wide Agent Lab browser cache before running `npm ci` for the root and web UI. Task worktrees start without shared `node_modules`; run bootstrap (or the individual `npm ci` commands) inside a worktree before building or testing there. Stop a globally linked Quarterdeck runtime before reinstalling or relinking its checkout.

Update shared Zod and tRPC dependencies in both trees together. The browser imports runtime schemas and router types directly, so independently resolved versions can break the web build even when both ranges permit the upgrade. Dependabot groups these updates across both directories; the root dependency-contract test checks the committed lockfiles. Keep the Claude Agent SDK update separate because its version is paired with an exact native executable in `src/execution/claude-structured-owner.ts`.

## Quick reference

```bash
npm run bootstrap        # Locked install of root + web-ui deps
npm run dev -- --browser --port 3500 # Runtime server with managed source restarts
npm run dev:full -- --browser --port 3500 # Runtime + web UI together
npm run web:dev          # Web UI dev server (Vite HMR, port 4173)
npm run build            # Web typecheck/build + runtime package build
npm run check            # Agent docs + Biome + runtime typecheck/tests
npm run test             # All root runtime + integration tests
npm run test:fast        # Runtime + utility tests only
npm run test:integration # Integration tests only
npm run test:package     # Pack, clean-install, launch, fetch, and stop the publishable tarball
npm run test:windows-smoke # Built CLI + focused native checks (Windows only)
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
npm run link             # Build/link and install the app on supported Macs
npm run link -- --browser # Build and link only the CLI/browser mode
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
Agent processes (Claude, Codex, Pi, shell)
  | emit hook events / terminal output
  v
Quarterdeck task and review state
```

Major directories:

- `src/`: runtime, terminal session management, tRPC, state, config, worktree lifecycle
- `web-ui/src/`: React app, components, hooks, runtime client, stores, terminal surfaces
- `test/`: runtime and integration tests
- `docs/`: current architecture, conventions, developer guides, and explicitly archived history
- `scripts/`: build/dev utility scripts

Choose validation with [`docs/testing.md`](./docs/testing.md). When that strategy calls for agent-driven functional or visual debugging, use [`docs/agent-functional-testing.md`](./docs/agent-functional-testing.md); the workflow is isolated from the normal dev/dogfood runtime and the user's Quarterdeck state.

## Hot reload workflow

These manual development commands use the normal runtime state home unless `QUARTERDECK_STATE_HOME` is explicitly set. Stop an existing owner before reusing that home, or choose a separate development state home; a different port alone does not isolate runtime ownership or data. Agent-driven functional work uses the isolated [Agent Lab](docs/agent-functional-testing.md).

Run two terminals:

1. Runtime server (API + PTY agent runtime):

```bash
npm run dev -- --browser --port 3500
```

- Runs on `http://127.0.0.1:3500`

2. Web UI (Vite HMR):

```bash
npm run web:dev
```

- Runs on `http://127.0.0.1:4173`
- `/api/*` requests from Vite are proxied to `http://127.0.0.1:3500`

Use `http://127.0.0.1:4173` while developing UI so changes hot reload. `--browser` and a plain launch select the source runtime; `--desktop` explicitly selects the installed native app on a supported graphical Mac. The explicit port also matches Vite's default API proxy. If you change it, set `QUARTERDECK_RUNTIME_PORT` for the Vite process to match.

## VS Code F5 debugging

The repo includes `.vscode/launch.json` with two configurations:

- **Dev Server**: Directly runs `tsx watch src/cli.ts` with the debugger attached; it does not use the managed restart/shutdown wrapper from `npm run dev`. Add `--browser` and `--port 3500` to its `args` when debugging the source runtime, and set `NODE_ENV=development` plus a separate `QUARTERDECK_STATE_HOME` in its `env` for Vite admission and isolated development. Run `npm run web:dev` separately for the UI.
- **Run Tests**: Runs `vitest run` with the debugger so you can set breakpoints in tests.

## Build and run packaged CLI

```bash
npm run build
node dist/cli.js --browser
```

This explicitly starts or attaches to the shared runtime; plain `node dist/cli.js` selects the installed desktop on supported graphical Macs. Browser mode serves built web assets from `dist/web-ui` and does not hot reload the web UI.

Runtime port options:

```bash
# fixed port
node dist/cli.js --port 3500

# pick the first free port starting at 3500
node dist/cli.js --port auto
```

You can still use `QUARTERDECK_RUNTIME_PORT` if needed, but `--port` is preferred for explicit runtime launches. Separate runtime instances also require separate canonical state homes; port selection alone attaches to a compatible existing owner.

### Browser/runtime compatibility

`QUARTERDECK_RUNTIME_PROTOCOL_VERSION` in [`src/core/api/runtime-protocol.ts`](src/core/api/runtime-protocol.ts) declares the shared browser/runtime contract. Different package versions and build IDs may connect when this version matches. Build IDs remain available for diagnostics and packaged-artifact verification; rebuilding alone does not require a browser reload.

Increment the protocol version deliberately when compatibility breaks in **either direction**: removing or changing an API, changing a WebSocket message shape or meaning, or requiring a new runtime endpoint/field from the browser without a fallback. Optional additions, bug fixes, and presentation changes keep the version when both older browsers and older runtimes still work. Cover any fallback with a regression test; do not derive this version from package semver or generate it during builds.

Every initial runtime snapshot includes `runtimeProtocolVersion`. Keep the snapshot `type` and this field stable across protocol bumps so an older browser can reject the contract before applying state. The browser accepts the connection only after this check. An unequal, missing, or malformed version permits one automatic reload per protocol pair, then shows restart/refresh guidance if the served browser still cannot use the running process. Storage failures block incompatible connections without a reload loop and do not block compatible ones.

Runtimes predating the protocol field require a one-time restart when upgrading to this policy. Older browsers that compare build IDs reload into the served browser; the existing production guard still rejects clients that predate even build identity because they cannot check snapshot compatibility. This browser admission check is separate from API authentication. Protocol version 4 requires a one-use browser launch capability, exchanged for an HttpOnly session cookie, or a private desktop client credential. Reopen Quarterdeck from the CLI or app when browser access expires. Desktop attachment additionally checks the independent bridge and transport capabilities before loading the owner's UI.

## Dogfooding with isolated Quarterdeck instances

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

A canonical state home has one writable runtime. A second compatible CLI or desktop launch attaches to that owner even when it requests another port; it never takes shutdown ownership. A live legacy runtime must be stopped or upgraded first. Backup restore uses exclusive maintenance admission. State homes must be on a host-local filesystem with hard-link support.

Dogfood launcher behavior:

- uses a stable, checkout-specific state home under `~/.quarterdeck-dogfood/checkouts/` by default; an explicit `QUARTERDECK_STATE_HOME` override is honored
- builds the current checkout by default
- launches `dist/cli.js` with `cwd` set to the target project
- supports `--port <number|auto>`
- supports `--no-open`
- supports `--skip-build` when you already built and want faster restarts

## Unified diagnostics

Quarterdeck has one local diagnostic system shared by normal runtimes and the isolated agent lab. It replaces the former runtime/browser debug-log buffers and panel; do not add a second ring buffer, WebSocket log feed, or panel-owned recorder.

### What happens automatically

Every normal runtime creates a private descriptor and starts a lightweight flight recorder before startup cleanup. No setting, panel, or reproduction step is required. A fresh coding agent can therefore investigate an event that happened earlier in the current run, or read the bounded journal from a recently finalized run.

Diagnostic directories are secured before their first content write. On Windows, Quarterdeck replaces inherited permissions with a protected DACL that grants full control only to the current user and LocalSystem; this also applies to custom `QUARTERDECK_STATE_HOME` locations, exported bundle roots, Agent Lab artifacts/disposable state, and the lab browser profile that stores its reconnect tail. If that ACL cannot be installed, runtime persistence degrades to the bounded in-memory recorder and explicit bundle or lab creation fails instead of writing into a broadly readable directory.

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

After cloning, prepare dependencies and create/update the global CLI link from this repo:

```bash
npm run link
```

`npm run link` checks dependency trees against their lockfiles, prepares the required independent trees, builds once, and updates the global CLI link. On supported Macs it packages and installs the same build at `~/Applications/Quarterdeck.app`. `-- --desktop` remains a redundant compatibility option; use `-- --browser` to link only the CLI. Shared dependency symlinks are rejected. Stop a linked runtime before rebuilding its checkout and quit the installed app before replacement. If either global linking or app installation fails, resolve the reported incomplete pairing before launching the app.

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

After local code changes, run `npm run link` again to update both the linked command and installed app. `npm run build` updates only runtime/UI assets; a desktop launch will reject stale pairing until the matching app is installed.

When switching between worktrees, re-run `npm run link` from the worktree you want to test so the global `quarterdeck` binary points at the right `dist/cli.js`.

For a CLI-only link created with `--browser`, launch with `quarterdeck --browser`.

Remove the global link:

```bash
npm run unlink
```

On macOS, first run `quarterdeck desktop uninstall` if you also want to remove the owned app. `npm run unlink` removes the command link only; it leaves the app with a missing npm owner. Both operations preserve project and runtime state.

## Validation and test layout

[`docs/testing.md`](./docs/testing.md) is the canonical guide for choosing a proportionate validation set. It includes the change-to-test matrix, command scopes, overlap rules, and the criteria for Playwright, deterministic Agent Lab, real-provider runs, cold restarts, and screenshots.

Important command boundaries:

- `npm run check` covers the instruction bridge, repository Biome check, runtime typecheck, release-policy tests, and all root Vitest tests. It does not cover web typechecking/tests, Playwright, or Agent Lab.
- `npm run build` already performs the web typecheck as part of the production web build before packaging the runtime.
- The pre-commit hook runs staged Biome and ownership-based checks: documentation skips code tests, package-specific edits check that package, and shared inputs take the conservative cross-package gate. See [test selection](docs/testing.md#command-scopes) before repeating validation manually.
- `npm run web:e2e` is the automated disposable-browser smoke suite.
- `npm run agent:lab` plus `npm run agent:browser` is the interactive isolated functional lane.

See [`test/README.md`](./test/README.md) for root-test placement and naming. Web unit tests are colocated under `web-ui/src`; Playwright smoke tests live under `web-ui/tests`.

## CI/CD

- `ci.yml`: runs on pushes to `main` and PRs targeting `main`, delegating to reusable test workflow(s)
- `test.yml`: Ubuntu/macOS matrix plus a non-optional native Windows job covering clean installs, the build (including web typecheck), packaged CLI fetch/shutdown, native ConPTY resize/reconnect/restore, Git/worktree/path fidelity, exact process ownership and DACLs, hook/status-line transport, lint, runtime typecheck/tests, and web-ui tests without repeating the standalone web typecheck
- `publish.yml`: runs on version-tag pushes (`v*.*.*`), tests the exact release commit, publishes npm via OIDC, optionally publishing and anonymously verifying matching signed desktop assets first when `QUARTERDECK_DESKTOP_RELEASES=1`; manual dispatch remains available for retries. See the [release workflow](RELEASE_WORKFLOW.md) for immutable assets, generated notes, and retry ordering.

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
- Pi
  - input receipt, agent start, and approval resolution emit `to_in_progress`
  - project-trust requests, tool-approval requests, denied trust, and `agent_settled` emit `to_review`
  - session identity, `agent_end`, and tool execution emit metadata-only `activity`; only `agent_settled` is a completion boundary

Important behavior details:

- Hook activity is best-effort, but state transitions are delivered reliably enough to avoid leaving cards stuck after a transient runtime request failure.
- Session-start hooks capture resumable provider identity without changing task state.
- Runtime transition guards remain authoritative and prevent stale hooks or redraws from flapping state.
- Terminal output is not work-state truth. Fix missed state at the hook, identity, or ordering layer rather than adding output-volume or timestamp heuristics.
- Hook transport is implemented in Node and invoked through `quarterdeck hooks ...`. Windows hook and status-line strings invoke the absolute PowerShell executable beneath the system root and use an encoded launcher that starts the resolved Quarterdeck executable through a direct argv contract, preventing working-directory/`PATH` interception, `cmd.exe` variable expansion, or metacharacter splitting while preserving stdin/stdout.

See [`docs/conventions/session-lifecycle.md`](./docs/conventions/session-lifecycle.md) before changing hook mappings, transition ownership, resume identity, or approval fallbacks.
