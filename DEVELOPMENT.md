# Development

`README.md` is the product overview. This file is the human-facing developer guide for working on Quarterdeck itself.

`AGENTS.md` is the canonical repo-owned agent-instructions file. `CLAUDE.md` is only a Claude Code compatibility shim and should not hold duplicated project docs.

## Requirements

- Node.js 20+
- npm 10+

## Install

```bash
npm run install:all
```

## Quick reference

```bash
npm run install:all      # Install root + web-ui deps
npm run dev              # Runtime server (watch mode, port 3500)
npm run dev:full         # Runtime + web UI together
npm run web:dev          # Web UI dev server (Vite HMR, port 4173)
npm run build            # Full production build
npm run check            # Agent-doc check + lint + typecheck + tests
npm run test             # All runtime tests
npm run test:fast        # Runtime + utility tests only
npm run test:integration # Integration tests only
npm run web:test         # Web UI unit tests
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

## Run `quarterdeck` from any directory

After cloning and installing dependencies, create/update the global CLI link from this repo:

```bash
npm run link
```

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

## Scripts

- `npm run build`: build runtime and bundled web UI into `dist`
- `npm run check:agent-instructions`: verify `AGENTS.md`/`CLAUDE.md` stay in the canonical+shim shape
- `npm run dogfood -- [--project <path>] [--port <number|auto>] [--no-open] [--skip-build]`: build and launch this checkout, optionally targeting a specific project path
- `npm run dev`: run CLI in watch mode
- `npm run web:dev`: run web UI dev server
- `npm run web:build`: build web UI
- `npm run typecheck`: typecheck runtime
- `npm run web:typecheck`: typecheck web UI
- `npm run test`: run runtime tests
- `npm run web:test`: run web UI tests
- `npm run check`: lint, typecheck, and test runtime package

## Tests

- `test/integration`: integration tests for runtime behavior and startup flows
- `test/runtime`: runtime unit tests
- `test/utilities`: shared test helpers

## CI/CD

- `ci.yml`: runs on pushes to `main` and PRs targeting `main`, delegating to reusable test workflow(s)
- `test.yml`: Ubuntu and macOS matrix covering build, lint, typecheck, runtime tests, and web-ui tests
- `publish.yml`: manual release workflow that verifies the tag, runs tests, publishes to npm via OIDC, creates the GitHub Release, and posts to Slack

## Agent tracking and runtime hooks

Quarterdeck tracks agent session state with runtime hook events. The core transition model is:

- `in_progress -> review`
- `review -> in_progress`

Internal runtime session states are named `running` and `awaiting_review`, and hook events are transition intents:

- `to_in_progress` for `review -> in_progress`
- `to_review` for `in_progress -> review`

How it works end to end:

1. `prepareAgentLaunch` wires each agent with hook commands or hook-aware wrappers.
2. Hook handlers call `quarterdeck hooks ...` subcommands.
3. `quarterdeck hooks ingest --event <to_review|to_in_progress>` reads hook context from env:
   - `QUARTERDECK_HOOK_TASK_ID`
   - `QUARTERDECK_HOOK_WORKSPACE_ID`
   - `QUARTERDECK_HOOK_PORT`
4. The ingest command calls runtime TRPC `hooks.ingest`.
5. The runtime applies guarded transitions and ignores duplicates or invalid transitions as no-ops.

Current agent mappings:

- Claude
  - `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure` emit `to_in_progress`
  - `Stop`, `PermissionRequest`, and `Notification` with `permission_prompt` emit `to_review`
- Codex
  - wrapper enables TUI session logging and maps:
    - `task_started` and `exec_command_begin` to `to_in_progress`
    - `*_approval_request` to `to_review`
  - Codex `notify` completion path also emits `to_review`

Important behavior details:

- Hooks are best-effort and should not crash or block the underlying agent process.
- Hook notify paths are asynchronous to keep agent UX responsive.
- Runtime transition guards are authoritative and prevent state flapping from duplicate events.
- Hook transport is implemented in Node and invoked through `quarterdeck hooks ...`, so the behavior is consistent across Windows and non-Windows environments.

For a full technical breakdown, see:

- `.plan/docs/runtime-hooks-architecture.md`
