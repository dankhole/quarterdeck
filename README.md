# Quarterdeck

![Quarterdeck board screenshot](https://github.com/user-attachments/assets/2aa3dcc7-94e3-4076-bcfe-6d0272007cfe)

Quarterdeck is a local orchestration board for coding agents. It gives each task a card, a terminal, git context, and a review surface so you can run multiple agents in parallel without manually juggling terminals, worktrees, diffs, and follow-up prompts.

Quarterdeck currently supports:

- Claude Code
- OpenAI Codex
- Pi, which is experimental

Quarterdeck detects installed agent CLIs from your `PATH`, starts a local runtime server, and opens the browser UI for the git repository you launch it from.

## What Quarterdeck Does

- Runs many coding-agent tasks side by side from one browser UI.
- Gives each task its own terminal, review state, git metadata, and optional isolated worktree.
- Mirrors common ignored dependencies such as `node_modules` into task worktrees so parallel agents do not need slow reinstall loops.
- Tracks latest agent activity, permission/input needs, review readiness, and file changes on each card.
- Provides task diffs, "Last Turn" checkpoint diffs, file browsing, branch comparison, line comments, commit, push, Open PR, and cherry-pick flows.
- Supports project script shortcuts for commands such as `npm run dev` and prompt shortcuts for repeatable agent instructions such as Commit or Squash Merge.
- Lets linked cards start after earlier cards complete, which makes larger agent workflows easier to sequence.

## Status

Quarterdeck is under active development. The main install path is currently from source with `npm run link`; the npm package is not the recommended path yet. Found a bug or have an idea? Open a [GitHub Issue](https://github.com/dankhole/quarterdeck/issues).

Windows support is experimental and currently untested on native Windows. macOS and Linux receive the day-to-day testing. See the [Windows support audit](docs/windows-support-audit.md) for current limitations and tracked follow-ups.

## Requirements

- Git
- Node.js 20 or newer
- npm 10 or newer
- At least one supported agent CLI installed and available on `PATH`
- Optional but recommended: a Nerd Font such as [JetBrainsMono Nerd Font](https://www.nerdfonts.com/) for cleaner terminal glyphs

Codex users need Codex 0.124.0 or newer with native hook support. Pi users need Pi 0.70.2 or newer.

## Environment Variables

Quarterdeck does not require a `.env` file for core usage. It inherits the environment from the shell that launches `quarterdeck`, so make sure your agent CLI (`claude`, `codex`, or `pi`) is available on that shell's `PATH` and already authenticated according to that agent's own setup flow.

Optional variables:

| Variable | Purpose |
| --- | --- |
| `QUARTERDECK_STATE_HOME` | Override the runtime state directory. Defaults to `~/.quarterdeck`. |
| `QUARTERDECK_BACKUP_HOME` | Override the state backup directory. Defaults to `~/.quarterdeck-backups`. |
| `QUARTERDECK_RUNTIME_HOST` | Override the runtime host. Defaults to `127.0.0.1`; the `--host` flag is usually clearer. |
| `QUARTERDECK_RUNTIME_PORT` | Override the runtime port. Defaults to `3500`; the `--port` flag is usually clearer. |
| `QUARTERDECK_DEBUG_MODE` | Enable extra debug behavior for agent availability checks. `DEBUG_MODE` and `debug_mode` are also recognized. |
| `ANTHROPIC_BEDROCK_BASE_URL` | Enable optional LLM helper features through a Bedrock/LiteLLM-compatible proxy. |
| `ANTHROPIC_AUTH_TOKEN` | Bearer token for the optional LLM helper proxy. |
| `QUARTERDECK_LLM_MODEL` | Override the optional LLM helper model. Defaults to the built-in Haiku-on-Bedrock model string. |

The LLM variables are only needed for generated task titles, branch names, summaries, and commit messages. Agent sessions themselves use your installed agent CLI and do not require these variables.

## Install From Source

Clone the repository, install dependencies for the runtime and web UI, then link the local build as the global `quarterdeck` command:

```bash
git clone https://github.com/dankhole/quarterdeck.git
cd quarterdeck
npm run install:all
npm run link
```

`npm run link` runs a production build and then `npm link`, so the global `quarterdeck` command points at this checkout.

Verify the linked command:

```bash
which quarterdeck
quarterdeck --version
```

Run Quarterdeck from any git repository:

```bash
cd /path/to/your/project
quarterdeck
```

Quarterdeck launches a local server, opens the browser UI, and stores runtime state under `~/.quarterdeck` by default. Set `QUARTERDECK_STATE_HOME` to use a different state directory. Quarterdeck itself does not require a separate account; agent access comes from the agent CLIs you have installed and authenticated.

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

   Starting a card launches the configured agent. By default, Quarterdeck creates an isolated git worktree for the task, mirrors common ignored dependencies such as `node_modules`, and injects worktree context so the agent understands where it is working. If your workflow modifies ignored files directly, worktree symlinks can be disabled in settings.

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
| `npm run install:all` | Install root and web UI dependencies. |
| `npm run link` | Build the app and link the local `quarterdeck` CLI globally. |
| `npm run unlink` | Remove the global `quarterdeck` link. |
| `npm run dev` | Run the runtime server in watch mode on port 3500. |
| `npm run dev:full` | Run the runtime and web UI together for local development. |
| `npm run web:dev` | Run the Vite web UI dev server on port 4173. |
| `npm run build` | Build the packaged runtime and web UI into `dist`. |
| `npm run check` | Run agent-instruction checks, Biome, typecheck, and tests. |

For the full development workflow, see [DEVELOPMENT.md](./DEVELOPMENT.md).

## Troubleshooting

If `quarterdeck` is not found, run `npm run link` from the Quarterdeck checkout and make sure your npm global bin directory is on `PATH`.

If no agent is available, install Claude Code, OpenAI Codex, or Pi and confirm the matching binary (`claude`, `codex`, or `pi`) is available on `PATH`.

If terminal symbols look wrong, install a Nerd Font and select it in your browser or system terminal font settings.

## Documentation

- [DEVELOPMENT.md](./DEVELOPMENT.md): local development workflow, scripts, debugging, and repo orientation
- [docs/README.md](./docs/README.md): architecture docs, conventions, roadmap, and implementation history
- [AGENTS.md](./AGENTS.md): shared repo-owned instructions for coding agents

## Help and Feedback

- [GitHub Issues](https://github.com/dankhole/quarterdeck/issues): bugs and regressions
- [GitHub Discussions](https://github.com/dankhole/quarterdeck/discussions/categories/ideas): feature ideas and workflow feedback

## License and Origin

Quarterdeck is a derivative work of [kanban-org/kanban](https://github.com/kanban-org/kanban), originally created by Cline Bot Inc. and licensed under the Apache License 2.0. Significant modifications have been made.

[Apache 2.0](./LICENSE)
