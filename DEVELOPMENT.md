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

Quarterdeck uses independent dependency trees in the repository root, `web-ui/` and `desktop/`. Shared source builds and tests need root and web dependencies; packaged desktop validation also needs the separate Electron tree. Ordinary bootstrap and root builds do not install Electron. Task worktrees start without shared `node_modules`; run bootstrap (or the individual `npm ci` commands) inside a worktree before building or testing there. Stop a globally linked Quarterdeck runtime before reinstalling or relinking its checkout.

Update shared Zod and tRPC dependencies in both trees together. The renderer imports runtime schemas and router types directly, so independently resolved versions can break the web build even when both ranges permit the upgrade. Dependabot groups these updates across both directories; the root dependency-contract test checks the committed lockfiles. Keep the Claude Agent SDK update separate because its version is paired with an exact native executable in `src/execution/claude-structured-owner.ts`.

## Quick reference

```bash
npm run bootstrap        # Locked install of root + web-ui dependencies
npm run build            # Renderer typecheck/build + runtime package
npm run check            # Instruction bridge, lint, runtime types/tests and release policy
npm run test -- <paths>   # Focused root tests
npm run web:test -- <paths> # Focused renderer tests
npm run test:package     # Isolated npm artifact, native PTY and internal runtime checks
npm run typecheck        # Runtime TypeScript
npm run web:typecheck    # Renderer TypeScript
npm --prefix desktop ci  # Separate native-shell dependencies
npm --prefix desktop run check # Desktop source validation
npm run agent:desktop -- smoke --app <path> --json # Isolated packaged test
npm run link             # Build/link/install the exact desktop pair
quarterdeck diagnostics --help # Read-only runtime investigation
```

## Repo orientation

For deeper architecture reading, start with [`docs/README.md`](./docs/README.md) and [`docs/architecture.md`](./docs/architecture.md). The quick mental model is:

```text
Desktop renderer (React + Vite assets in Electron)
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

Choose validation with [`docs/testing.md`](./docs/testing.md). When that strategy calls for agent-driven functional or visual debugging, use [`docs/agent-functional-testing.md`](./docs/agent-functional-testing.md); the workflow is isolated from source-development runtimes and the user's Quarterdeck state.

## Development and internal runtimes

Quarterdeck is a desktop-only product. Opening a Vite HTTP page or running the CLI with a port no longer provides a standalone browser application. Use focused renderer/component tests for fast UI iteration and a freshly packaged local app in Agent Lab for complete product behavior. Source Vite tooling remains an asset-build tool, not an authenticated desktop substitute.

The app still needs a local Node runtime, and tests still need isolated headless runtimes. Those are explicit internal execution paths, not product launch modes. Source runtime development uses `npm run dev -- --port 3500` (the wrapper explicitly adds `--internal-runtime`); the source checkout, an isolated lab launcher, or a desktop helper must authorize that entrypoint. Runtime flags alone never select it. Keep desktop admission, scoped management authentication, provider hooks, process custody and shutdown safeguards enabled. Internal fixture access must not restore browser launch URLs, cookies or unauthenticated product routes.

Before manual development against any runtime, stop its owner or choose a separate `QUARTERDECK_STATE_HOME`; a different port alone does not isolate data or ownership. Do not start an extra source-development runtime while the user's app may already be running. Agent-driven functional work uses the isolated [packaged Agent Lab](docs/agent-functional-testing.md).

## VS Code debugging

The **Internal Runtime** configuration passes `--internal-runtime` and uses a checkout-local `.quarterdeck-debug-state` state home. It is for explicit internal source execution only; stop another owner of that state before starting it. Tests can be debugged through the Vitest configuration. Neither path grants native renderer authority or creates a browser product.

## Build and launch

```bash
npm run build
npm run link
quarterdeck
```

Linking installs a matching local desktop pair on supported macOS/Windows hosts; it changes the global link and app installation, so use it intentionally. Build-only validation belongs in a different worktree from the installed app's owning checkout. For isolated packaged execution, follow [desktop packaging](docs/desktop-release.md) and pass the resulting candidate to Agent Lab instead.

### Browser/runtime compatibility

The heading remains a stable documentation anchor; this is now the **renderer/runtime** contract.

`QUARTERDECK_RUNTIME_PROTOCOL_VERSION` in [`src/core/api/runtime-protocol.ts`](src/core/api/runtime-protocol.ts) declares the shared renderer/runtime contract. Increment it when compatibility breaks in either direction: removed/changed APIs, WebSocket shapes or meaning, or newly required fields/endpoints without a fallback. Optional compatible additions do not require a bump. Do not derive this version from package semver or generate it during builds.

Desktop-only admission removes browser bootstrap URLs, cookie sessions and standalone HTTP UI entrypoints. Quit the previous runtime before upgrading and install the matching desktop pair. Existing projects, settings and provider identities need no state-home migration; unsaved browser-profile data must be saved before upgrade. See [migration guidance](docs/desktop.md#desktop-installation-and-migration).

Every initial snapshot retains its stable `type` and `runtimeProtocolVersion` so clients can reject incompatible state before applying it. A missing/malformed/different version blocks normal operation and provides app/runtime restart guidance. Build IDs remain diagnostic and packaged-identity evidence, not a substitute for protocol compatibility. Desktop bridge/capability admission is separate from API authentication.

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

`QUARTERDECK_AGENT_LAB=1` is set by isolated lab/fixture launchers. It automatically selects the richer bounded `agent-lab` admission profile for synthetic data and cannot be stopped through deep-recording controls. Packaged lab checkpoints use the same canonical bundle format and may additionally contain synthetic fixture state, Git diffs, terminal viewport text, process logs and Playwright artifacts. Cleanup evidence must distinguish a confirmed graceful stop from fallback termination or unconfirmed remaining processes.

Live diagnostics can describe viewport/layout bounds, terminal buffer metrics, and application state, but they cannot recreate pixels that were never captured. For spacing, clipping, contrast, stacking, responsive, or terminal-paint failures, use the isolated lab and save explicit screenshots or a Playwright trace as described in [`docs/agent-functional-testing.md`](./docs/agent-functional-testing.md).

## Run `quarterdeck` from any directory

After cloning, prepare dependencies and create/update the global CLI link from this repo:

```bash
npm run link
```

`npm run link` checks dependency trees against their lockfiles, prepares the required independent trees, builds once, and updates the global CLI link. On supported macOS and Windows hosts it packages and installs the same desktop build. `-- --desktop` remains a redundant compatibility option; browser-only linking is removed. Shared dependency symlinks are rejected. Stop a linked runtime before rebuilding its checkout and quit the installed app before replacement. If either global linking or app installation fails, resolve the reported incomplete pairing before launching the app.

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

After local code changes, run `npm run link -- --desktop` again to update both the linked command and installed app. Standalone build and clean commands refuse to replace output in the checkout that owns the installed desktop app. This includes `npm run build`, `npm run desktop:build`, and paired desktop builds. Use another worktree for build-only validation.

The paired workflow reports success only after verifying that the installed app and linked CLI match the new build and have no pending installation work. A failed paired build or install may still require rerunning `npm run link -- --desktop`; rebuilding and replacing the app are not one atomic operation. Dock startup continues to reject mismatched installations.

When switching between worktrees, re-run `npm run link` from the worktree you want to test so the global `quarterdeck` binary points at the right `dist/cli.js`.

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
- The pre-commit hook runs local Biome on staged paths and checks the instruction bridge when its inputs change. It does not run typechecks or tests; complete the appropriate checks before review using the [test selection guide](docs/testing.md#command-scopes). Checks read working-tree contents and never restage files. Local root tests default to two workers, with a standard `--maxWorkers` override; CI retains its existing parallelism.
- `npm run agent:desktop -- smoke --app <path>` is the isolated packaged functional lane, hidden and fake-provider by default. Internal headless source tests and shared Linux checks remain supported.

See [`test/README.md`](./test/README.md) for root-test placement and naming. Renderer unit tests are colocated under `web-ui/src`; packaged Electron scenarios live under `scripts/agent-lab`.

## CI/CD

- `ci.yml`: runs on pushes to `main` and PRs targeting `main`, delegating to reusable test workflow(s)
- `test.yml`: Ubuntu/macOS matrix plus a non-optional native Windows job covering clean installs, the build (including web typecheck), packaged CLI fetch/shutdown, native ConPTY resize/reconnect/restore, Git/worktree/path fidelity, exact process ownership and DACLs, hook transport, lint, runtime typecheck/tests, and web-ui tests without repeating the standalone web typecheck
- `publish.yml`: runs on version-tag pushes (`v*.*.*`), tests the exact release commit, publishes npm via OIDC, publishing and anonymously verifying matching macOS and Windows desktop assets first; paid macOS signing remains optional; manual dispatch remains available for retries. See the [release workflow](RELEASE_WORKFLOW.md) for immutable assets, generated notes, and retry ordering.

## Agent tracking and runtime hooks

Quarterdeck tracks agent session state with runtime hook events. The core transition model is:

- `in_progress -> review`
- `review -> in_progress`

Internal runtime session states are named `running` and `awaiting_review`, and hook events are transition intents:

- `to_in_progress` for `review -> in_progress`
- `to_review` for `in_progress -> review`

How it works end to end:

1. `prepareAgentLaunch` installs a launch-scoped hook configuration for the selected agent. Claude receives a Quarterdeck-owned settings file; Codex receives inline `-c hooks...` configuration, the native `hooks` feature flag, and matching launch-scoped trust entries. Quarterdeck does not modify repository or user-global Codex hook files.
2. Hook handlers invoke `hooks ingest|notify`. A bundled install resolves and runs the lightweight `dist/hooks.js` entry (built from `src/hook-main.ts`/`src/hook-entry.ts`) directly with the bundled Node. Each reliable command hook still spawns a full Node process, but that bundle avoids the full CLI's startup cost; a tsx dev run from `src/cli.ts` runs the same entry from source (`src/hook-main.ts`), and any other unbundled install or one missing a sibling `dist/hooks.js` falls back to `quarterdeck hooks ...` through the full CLI. All paths share one implementation (`src/hooks-runtime-client.ts`).
3. `hooks ingest --event <to_review|to_in_progress|activity>` reads process identity from env:
   - `QUARTERDECK_HOOK_TASK_ID`
   - `QUARTERDECK_HOOK_PROJECT_ID`
   - `QUARTERDECK_HOOK_SESSION_INSTANCE_ID`
4. State transitions use the reliable `ingest` path with a bounded retry and a lock-free replay outbox: a private temporary file is normalized to POSIX `0600`, closed, then atomically renamed before sending. A queued transition exits successfully even if live delivery fails, retaining its record for replay; acknowledgement removes it. This provides runtime-process restart recovery, not power-loss durability (no fsync). High-frequency metadata-only activity can use the short, best-effort `notify` path.
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
- Command-hook transport uses a small `node:http.request` client with a 1 MiB response bound and cancellation through the complete response body; Node owns HTTP framing. It retains the non-batched tRPC wire format without loading the full CLI, a lock library, or a custom HTTP parser. A bundled install's hook command lines run the bundled Node directly against the lightweight `dist/hooks.js` entry next to `dist/cli.js`; a tsx dev run uses `src/hook-main.ts`, and any other unbundled run (or install without that sibling bundle) falls back to invoking the full CLI through `quarterdeck hooks ...`. Windows hook strings invoke the absolute PowerShell executable beneath the system root and use an encoded launcher that starts the resolved executable (`dist/hooks.js` or the full CLI) through a direct argv contract, preventing working-directory/`PATH` interception, `cmd.exe` variable expansion, or metacharacter splitting while preserving stdin/stdout.

See [`docs/conventions/session-lifecycle.md`](./docs/conventions/session-lifecycle.md) before changing hook mappings, transition ownership, resume identity, or approval fallbacks.
