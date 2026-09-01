# Quarterdeck

![Quarterdeck board screenshot](https://github.com/user-attachments/assets/2aa3dcc7-94e3-4076-bcfe-6d0272007cfe)

Quarterdeck is a local orchestration board for coding agents. It gives each task a card, a terminal, git context, and a review surface so you can run multiple agents in parallel without manually juggling terminals, worktrees, diffs, and follow-up prompts.

Quarterdeck currently supports:

- Claude Code
- OpenAI Codex
- Pi

Quarterdeck detects installed agent CLIs from your `PATH`, starts a local runtime server, and opens the browser UI for the git repository you launch it from.

## What Quarterdeck Does

- Runs many coding-agent tasks side by side from one browser UI.
- Gives each task its own terminal, review state, git metadata, and optional isolated worktree.
- Mirrors eligible ignored project setup paths into task worktrees while keeping mutable dependency trees such as `node_modules` isolated per checkout.
- Tracks latest agent activity, permission/input needs, review readiness, and file changes on each card.
- Provides task diffs, "Last Turn" checkpoint diffs, file browsing, branch comparison, line comments, commit, push, Open PR, and cherry-pick flows.
- Supports project script shortcuts for commands such as `npm run dev` and prompt shortcuts for repeatable agent instructions such as Commit or Squash Merge.
- Lets linked cards start after earlier cards complete, which makes larger agent workflows easier to sequence.

## Status

Quarterdeck is under active development and is distributed as a public npm CLI package. Found a bug or have an idea? Open a [GitHub Issue](https://github.com/dankhole/quarterdeck/issues).

Windows support remains experimental, although the code-remediation audit is complete and native install, build, packaged/source CLI, ConPTY resize/reconnect/restore, Git/worktree fidelity, hook/status-line transport, exact process ownership, host launch, graceful shutdown, and diagnostic DACL coverage are now part of the required CI workflow. Promotion awaits that job on the committed revision plus the manual real-provider matrix; see the [Windows support audit](docs/windows-support-audit.md), [acceptance ledger](docs/windows-compatibility-todo.md), and [native validation guide](docs/windows-native-smoke.md).

## Requirements

- Git
- Node.js 22.22.2 or newer (pinned by `.nvmrc` for local development)
- At least one supported agent CLI installed and available on `PATH`
- Optional but recommended: a Nerd Font such as [JetBrainsMono Nerd Font](https://www.nerdfonts.com/) for cleaner terminal glyphs

You only need one task agent. Quarterdeck checks whether its CLI is on the inherited `PATH` and whether the installed version is supported; provider authentication stays in the provider CLI and is not inspected by Quarterdeck.

## Set Up an Agent

The commands below are the shortest macOS/Linux setup path. Follow the linked official guide for platform-specific alternatives, then restart Quarterdeck after installing a CLI so the runtime inherits the updated `PATH`.

| Agent | Install | Sign in | Verify | Version required by Quarterdeck |
| --- | --- | --- | --- | --- |
| [Claude Code](https://code.claude.com/docs/en/getting-started) | `curl -fsSL https://claude.ai/install.sh \| bash` | Run `claude` and follow the browser prompt | `claude auth status` | 2.1.198+ |
| [OpenAI Codex](https://developers.openai.com/codex/cli) | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` | `codex login` | `codex login status` | 0.147.0+ with native hooks |
| [Pi 0.84.3](https://www.npmjs.com/package/@earendil-works/pi-coding-agent/v/0.84.3) | `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.3` | Run `pi`, then enter `/login` | Start `pi` successfully | Exactly 0.84.3 |

On native Windows, run the installer from PowerShell:

| Agent | PowerShell install |
| --- | --- |
| Claude Code | `irm https://claude.ai/install.ps1 \| iex` |
| OpenAI Codex | `powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 \| iex"` |
| Pi 0.84.3 | `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.3` |

Codex supports ChatGPT sign-in with `codex login`. For API-key authentication, set `OPENAI_API_KEY`, then run `printenv OPENAI_API_KEY | codex login --with-api-key` on macOS/Linux or `$env:OPENAI_API_KEY | codex login --with-api-key` in PowerShell. Claude Code requires an account or provider-backed authentication supported by Claude Code. Pi lets you choose a provider during `/login`.

Codex users need Codex 0.147.0 or newer with native hook and auto-review support.

Claude launch permissions are configurable under Settings → Harnesses → Claude Code for new or restarted sessions. Quarterdeck can inherit Claude's configured default or explicitly start in Claude's native default, accept-edits, plan, auto-preview, don't-ask, or bypass mode; provider-managed policy remains authoritative.

Pi users need exactly Pi 0.84.3. Quarterdeck deliberately rejects older and newer Pi versions until the lifecycle extension, approval policy, and exact-session recovery suite is validated against a new release. Pi support is currently validated on macOS.

Pi tool approvals default on. Under Settings → Harnesses → Pi, you can disable per-tool confirmations for new or restarted sessions; the once-per-launch project-trust confirmation remains required.

## Environment Variables

Quarterdeck does not require a `.env` file for core usage. It inherits the environment from the shell that launches `quarterdeck`, so make sure your supported agent CLI (`claude`, `codex`, or `pi`) is available on that shell's `PATH` and already authenticated according to that agent's own setup flow.

Optional variables:

| Variable | Purpose |
| --- | --- |
| `QUARTERDECK_STATE_HOME` | Override the runtime state directory. Defaults to `~/.quarterdeck`. |
| `QUARTERDECK_BACKUP_HOME` | Override the state backup directory. Defaults to `~/.quarterdeck-backups`. |
| `QUARTERDECK_RUNTIME_HOST` | Override the runtime host. Defaults to `127.0.0.1`; the `--host` flag is usually clearer. |
| `QUARTERDECK_RUNTIME_PORT` | Override the runtime port. Defaults to `3500`; the `--port` flag is usually clearer. |
| `QUARTERDECK_DEBUG_MODE` | Enable extra debug behavior for agent availability checks. `DEBUG_MODE` and `debug_mode` are also recognized. |
| `QUARTERDECK_TITLE_PROVIDER` | Select task-title generation: `local` (default), `codex`, or `llm`. Either remote provider falls back directly to deterministic local generation. |
| `QUARTERDECK_CODEX_TITLE_MODEL` | Override the Codex model used for task titles. Defaults to `gpt-5.6-luna`. |
| `QUARTERDECK_LLM_BASE_URL` | Base URL for an optional LiteLLM or other OpenAI-compatible helper gateway. |
| `QUARTERDECK_LLM_API_KEY` | Bearer token for the optional helper gateway. Prefer a scoped LiteLLM virtual key over a shared master key. |
| `QUARTERDECK_LLM_MODEL` | Model name or gateway alias. Required for generic gateways; legacy base URLs ending in `/bedrock` retain the `bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0` fallback. |

Task titles use deterministic local generation by default. Set `QUARTERDECK_TITLE_PROVIDER=codex` to opt in to `codex exec --ephemeral`, which reuses the installed Codex CLI's saved authentication and defaults to `gpt-5.6-luna`; `QUARTERDECK_CODEX_TITLE_MODEL` selects another Codex model. Set `QUARTERDECK_TITLE_PROVIDER=llm` to use the OpenAI-compatible helper instead. A failed remote invocation falls back directly to the local title, keeping the Codex and LiteLLM failure domains separate.

### Optional LiteLLM or OpenAI-Compatible Helper

This helper is not needed to run agents. It enables generated branch names, generated commit messages, optional polished card summaries, and task titles only when `QUARTERDECK_TITLE_PROVIDER=llm` is selected.

Choose one of these setups:

- **No helper (default):** no variables or additional service. Task titles stay local, and helper-backed actions remain unavailable.
- **Existing team gateway:** point Quarterdeck at a LiteLLM proxy or another OpenAI-compatible endpoint and use the gateway's scoped key and configured model alias.
- **Self-hosted LiteLLM:** run the LiteLLM proxy separately, then point Quarterdeck at its loopback or network URL. Quarterdeck does not install, start, update, or store configuration for the proxy. See the [official LiteLLM proxy quick start](https://docs.litellm.ai/).

For an existing gateway:

```bash
export QUARTERDECK_LLM_BASE_URL=https://your-llm-gateway.example.com
export QUARTERDECK_LLM_API_KEY=your-virtual-key
export QUARTERDECK_LLM_MODEL=your-model-alias
```

For a local proxy using LiteLLM's default port:

```bash
export QUARTERDECK_LLM_BASE_URL=http://127.0.0.1:4000
export QUARTERDECK_LLM_API_KEY=your-litellm-key
export QUARTERDECK_LLM_MODEL=your-model-alias
```

In Windows PowerShell, set the same values for the process that launches Quarterdeck:

```powershell
$env:QUARTERDECK_LLM_BASE_URL = "http://127.0.0.1:4000"
$env:QUARTERDECK_LLM_API_KEY = "your-litellm-key"
$env:QUARTERDECK_LLM_MODEL = "your-model-alias"
```

The model must match a model name or alias exposed by the gateway. Quarterdeck requires a non-empty API-key value; an unauthenticated loopback-only development proxy can use a placeholder, but shared or network-accessible proxies should use authentication—preferably a scoped LiteLLM virtual key with an appropriate budget. Keep the key out of tracked files and supply it through the shell environment or your secret manager.

The endpoint must accept OpenAI-style `/v1/chat/completions`. Base URLs ending in `/v1` or `/v1/chat/completions` are accepted directly. Gateway base URLs ending in `/bedrock` are normalized to the gateway root before Quarterdeck appends `/v1/chat/completions`.

To keep the configuration across shell sessions, add the exports to the shell startup file or launcher environment that starts Quarterdeck. Open a new shell—or reload that environment—then restart Quarterdeck so the runtime receives the new values.

## Install

Install Quarterdeck globally for regular use:

```bash
npm install --global quarterdeck
```

Or try it without keeping a global installation:

```bash
npx --yes quarterdeck@latest
```

npm does not automatically update global installations. Upgrade an installed copy explicitly when a new release is available:

```bash
npm install --global quarterdeck@latest
```

The `npx` form resolves `@latest` for you and may reuse npm's download cache.

On interactive startup, Quarterdeck checks npm at most once per day in the background and prints the explicit global update command when a newer stable release is available. It never installs an update automatically. Set `NO_UPDATE_NOTIFIER=1` or pass `--no-update-notifier` to disable the check.

Verify and run the installed command from any git repository:

```bash
quarterdeck --version
cd /path/to/your/project
quarterdeck
```

Quarterdeck launches a local server, opens the browser UI, and stores runtime state under `~/.quarterdeck` by default. Set `QUARTERDECK_STATE_HOME` to use a different state directory. Quarterdeck itself does not require a separate account; agent access comes from the agent CLIs you have installed and authenticated.

### Install From Source

For development, clone the repository, install the runtime and web UI dependencies, then link the local build as the global `quarterdeck` command:

```bash
git clone https://github.com/dankhole/quarterdeck.git
cd quarterdeck
npm run bootstrap
npm run link
```

`npm run bootstrap` preserves or migrates the clone-wide Agent Lab browser cache, then performs locked installs for both the runtime and the separate web UI dependency tree. `npm run link` verifies those prerequisites, runs a production build, and then creates the development symlink used by the global `quarterdeck` command. Stop a Quarterdeck runtime launched from this linked checkout before bootstrapping or relinking; the scripts refuse to replace files underneath that live process.

When you pull new Quarterdeck changes, switch worktrees, or want the global command to point at a different checkout, run `npm run link` again from that checkout. To remove the global link:

```bash
npm run unlink
```

## Everyday Workflow

1. Add projects.

   Quarterdeck can track multiple git repositories. Each project has its own board, task cards, settings, shortcuts, and runtime state.

2. Create task cards.

   Add cards manually, paste prompts into the sidebar, or ask an agent session to break a larger goal into linked tasks. Link cards when one task should start after another is finished.

3. Start agents.

   Starting a card launches the configured agent. By default, Quarterdeck creates an isolated git worktree for the task, mirrors eligible ignored setup paths, and injects worktree context so the agent understands where it is working. Mutable installed dependency directories such as `node_modules` are never shared; install task-specific dependencies inside the worktree when needed. If your workflow modifies other ignored files directly, worktree symlinks can be disabled in settings.

4. Monitor progress.

   Cards show task state, latest agent activity, review readiness, permission/input needs, and git change indicators. Opening a card shows the live agent terminal.

5. Review changes.

   The task detail view includes terminal output, git diffs, the "Last Turn" checkpoint diff, a file browser, branch comparison, and line comments that can be sent back to the agent. The git view can also compare branches and inspect uncommitted work in either the home repo or the selected task worktree.

6. Land the work.

   Use Commit, Open PR, Squash Merge, cherry-pick, or the git view to move reviewed work back toward your base branch. Prompt shortcuts and linked-card starts help automate repetitive landing steps and larger dependency chains.

7. Clean up or resume.

   Moving a card to Trash stops the session and removes the task worktree after capturing uncommitted work as needed. Quarterdeck stores resume metadata so interrupted tasks can be resumed later when the agent supports it.

## Useful Commands

| Command | Purpose |
| --- | --- |
| `npm run bootstrap` | Preserve the Agent Lab browser cache, then install locked root and web UI dependencies; refuses to run beneath an active linked runtime. |
| `npm run install:all` | Backward-compatible alias for `npm run bootstrap`. |
| `npm run link` | Build the app and link the local `quarterdeck` CLI globally. |
| `npm run unlink` | Remove the global `quarterdeck` link. |
| `npm run dev` | Run the runtime server in watch mode on port 3500. |
| `npm run dev:full` | Run the runtime and web UI together for local development. |
| `npm run web:dev` | Run the Vite web UI dev server on port 4173. |
| `npm run build` | Build the packaged runtime and web UI into `dist`. |
| `npm run check` | Run agent-instruction checks, Biome, runtime typecheck, and root tests. |
| `quarterdeck diagnostics --help` | Discover and inspect private local runtime diagnostics. |

For the full development workflow, see [DEVELOPMENT.md](./DEVELOPMENT.md).

## Troubleshooting

If `quarterdeck` is not found after `npm install --global quarterdeck`, make sure your npm global bin directory is on `PATH`. Contributors using a source checkout can run `npm run link` instead.

If no agent is available, install Claude Code, OpenAI Codex, or Pi and confirm the matching binary (`claude`, `codex`, or `pi`) is available on `PATH`. Quarterdeck requires Claude Code 2.1.198+, Codex 0.147.0+, or exactly Pi 0.84.3 for supported task-agent launches.

If terminal symbols look wrong, install a Nerd Font and select it in your browser or system terminal font settings.

If an incident is difficult to explain, run `quarterdeck diagnostics doctor --request-browser` or `quarterdeck diagnostics capture --request-browser`. Quarterdeck automatically retains a small recent metadata-only history; you do not need to enable logging before the incident. Diagnostic bundles stay local under the Quarterdeck state directory, use owner-only filesystem access including protected Windows ACLs, and exclude prompts, terminal transcripts, files, diffs, environment values, and secrets by default. See [DEVELOPMENT.md](./DEVELOPMENT.md#unified-diagnostics) for filters, temporary deep recording, privacy limits, and isolated visual testing.

## Documentation

- [DEVELOPMENT.md](./DEVELOPMENT.md): local development workflow, scripts, debugging, and repo orientation
- [docs/testing.md](./docs/testing.md): proportionate validation strategy and testing-layer selection
- [docs/README.md](./docs/README.md): architecture docs, conventions, roadmap, and implementation history
- [AGENTS.md](./AGENTS.md): shared repo-owned instructions for coding agents

## Help and Feedback

- [GitHub Issues](https://github.com/dankhole/quarterdeck/issues): bugs and regressions
- [GitHub Discussions](https://github.com/dankhole/quarterdeck/discussions/categories/ideas): feature ideas and workflow feedback

## License and Origin

Quarterdeck is a derivative work of [kanban-org/kanban](https://github.com/kanban-org/kanban), originally created by Cline Bot Inc. and licensed under the Apache License 2.0. Significant modifications have been made.

[Apache 2.0](./LICENSE)
