# User guide

Start with the [README](../README.md) for installation and a quick overview. This guide covers agent setup, optional configuration, everyday use, and troubleshooting. For app installation, updates, window behavior, and removal, see the [desktop guide](./desktop.md#using-the-app).

## Set Up an Agent

The commands below are the shortest macOS/Linux setup path. Follow the linked official guide for platform-specific alternatives, then restart the owning runtime after installing a CLI. In the desktop app, use **Quarterdeck → Runtime Environment…** to add an executable folder or refresh discovery; see [desktop environment setup](./desktop-environment.md).

| Agent | Install | Sign in | Verify | Version required by Quarterdeck |
| --- | --- | --- | --- | --- |
| [Claude Code](https://code.claude.com/docs/en/getting-started) | `curl -fsSL https://claude.ai/install.sh \| bash` | Run `claude` and follow the browser prompt | `claude auth status` | 2.1.198+ |
| [OpenAI Codex](https://developers.openai.com/codex/cli) | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` | `codex login` | `codex login status` | 0.157.0+ with native hooks and auto-review support |
| [Pi 1.4.0](https://www.npmjs.com/package/@earendil-works/pi-coding-agent/v/1.4.0) | `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.4.0` | Run `pi`, then enter `/login` | Start `pi` successfully | Exactly 1.4.0 |

On native Windows, run the installer from PowerShell:

| Agent | PowerShell install |
| --- | --- |
| Claude Code | `irm https://claude.ai/install.ps1 \| iex` |
| OpenAI Codex | `powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 \| iex"` |
| Pi 1.4.0 | `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.4.0` |

Codex supports ChatGPT sign-in with `codex login`. For API-key authentication, set `OPENAI_API_KEY`, then run `printenv OPENAI_API_KEY | codex login --with-api-key` on macOS/Linux or `$env:OPENAI_API_KEY | codex login --with-api-key` in PowerShell. Claude Code requires an account or provider-backed authentication supported by Claude Code. Pi lets you choose a provider during `/login`.

Claude launch permissions are configurable under Settings → Harnesses → Claude Code for new or restarted sessions. Quarterdeck can inherit Claude's configured default or explicitly start in Claude's native default, accept-edits, plan, auto-preview, don't-ask, or bypass mode; provider-managed policy remains authoritative.

When creating a Claude Code task, you can choose a starting model alias (Fable, Opus, Sonnet, or Haiku) and an effort level (low, medium, high, extra high, or max); Claude default inherits your configured Claude settings. Codex new-task choices apply only to a fresh conversation, because a Codex thread keeps its model on resume. Claude task choices also apply on resume, restart, and startup recovery, because `claude --resume` otherwise reverts to the configured default. Task choices replace any `--model` or `--effort` in the configured Claude arguments.

When creating a Pi task, choose a starting model from the installed Pi CLI’s available models, or leave **Pi default** to inherit Pi’s settings and configured arguments. The provider and exact model ID are saved with single and bulk tasks, including tasks started later. Explicit choices replace configured `--provider`, `--model`, and `--models` on fresh launches only; resume and restart keep the saved Pi session’s model. The picker uses offline metadata discovery without loading extensions, MCP, or project resources or installing packages. Extension-defined and uncached models may be absent: use Pi default or Pi’s native `/model` selector for those. If discovery fails or no models are available, task creation still works with Pi default.

Pi users need exactly Pi 1.4.0. Quarterdeck deliberately rejects older and newer Pi versions until the lifecycle extension and exact-session recovery suite is validated against a new release. Pi support is currently validated on macOS.

Pi runs with its native tools, extensions, and project-trust settings. Quarterdeck adds no tool approval dialogs or project-trust override. Existing Pi tasks must be restarted to pick up this change. The retired `piToolApprovalsEnabled` setting is ignored and removed on the next configuration save. After upgrading Quarterdeck, restart the owning runtime and refresh browser clients to load the matching configuration protocol.

## Environment Variables

Quarterdeck does not require a `.env` file for core usage. Browser runtimes inherit the environment from the launching shell. The desktop app resolves executable folders without starting a shell by default; use **Quarterdeck → Runtime Environment…** to add folders or explicitly enable login-shell environment import. An app attached to an existing CLI runtime uses that runtime's environment. See [desktop environment resolution](./desktop-environment.md) for details.

Your chosen agent CLI (`claude`, `codex`, or `pi`) must be available to the runtime and already authenticated.

Optional variables:

| Variable | Purpose |
| --- | --- |
| `QUARTERDECK_STATE_HOME` | Override the runtime state directory. Defaults to `~/.quarterdeck`. |
| `QUARTERDECK_BACKUP_HOME` | Override the state backup directory. Defaults to `~/.quarterdeck-backups`. |
| `QUARTERDECK_RUNTIME_HOST` | Override the runtime host. Defaults to `127.0.0.1`; the `--host` flag is usually clearer. |
| `QUARTERDECK_RUNTIME_PORT` | Override the runtime port. Defaults to `3500`; the `--port` flag is usually clearer. |
| `QUARTERDECK_DEBUG_MODE` | Enable extra debug behavior for agent availability checks. `DEBUG_MODE` and `debug_mode` are also recognized. |
| `QUARTERDECK_TITLE_PROVIDER` | Select task-title generation: `codex` (default; tries Codex, then Claude, then gateway), `claude` (tries Claude, then gateway; skips Codex), `llm` (gateway only), or `local` (no model call). Initial generation falls back to deterministic local text; failed follow-up generation keeps the current title. |
| `QUARTERDECK_CODEX_TITLE_MODEL` | Override the Codex model used for task titles. Defaults to `gpt-6-luna`. |
| `QUARTERDECK_CLAUDE_TITLE_MODEL` | Override the Claude model used for task titles. Defaults to `haiku`. |
| `QUARTERDECK_LLM_BASE_URL` | Base URL for an optional LiteLLM or other OpenAI-compatible helper gateway. |
| `QUARTERDECK_LLM_API_KEY` | Bearer token for the optional helper gateway. Prefer a scoped LiteLLM virtual key over a shared master key. |
| `QUARTERDECK_LLM_MODEL` | Model name or gateway alias. Required for generic gateways; legacy base URLs ending in `/bedrock` retain the `bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0` fallback. |

Titles, branch names, and commit messages first use the installed Codex CLI’s saved login (including ChatGPT sign-in), with `gpt-6-luna` in an ephemeral, read-only invocation. If Codex is missing, signed out, times out, or returns no usable text, generation tries the installed Claude Code CLI’s saved login next, with its `haiku` model in a `--safe-mode`, no-tools, non-persistent invocation that runs from a private, per-call temporary directory (removed again afterward) and loads only user-level settings (`--setting-sources user`): CLAUDE.md, skills, plugins, hooks, custom commands, and project/local settings and MCP servers are all disabled, while a configured auth method (including an OAuth/keychain login or a user-level settings API key or `apiKeyHelper`) keeps working normally. **If `claude` is on PATH and already signed in, Quarterdeck automatically uses that login—and so your Claude subscription or API usage—for these background calls once Codex is unavailable, with no separate opt-in.** If Claude is also missing, signed out, times out, or returns no usable text, generation falls back to the configured OpenAI-compatible gateway. No gateway is needed when Codex or Claude succeeds. Codex and Claude each own their saved credentials; Quarterdeck does not read or copy them. A saved ChatGPT or Claude login uses that provider's hosted models, not an offline model. Each provider's own call is also capped by whatever is left of the caller's overall budget for that title/branch/commit-message request (for example, about 6 seconds for a title), so a slow Codex attempt cannot silently consume the time meant for Claude or the gateway. A Claude call that fails for a non-retryable reason (for example, a signed-out CLI, or a flag an older installed Claude version rejects) backs off Claude for a bounded period so later calls do not keep paying for a failed launch; a Claude timeout gets its own, much shorter backoff. A failed Codex launch/auth failure is also backed off for a shorter bounded period, independently of Claude (a Codex timeout is not backed off, since large diffs can legitimately use the whole budget). The gateway is never backed off.

To stop Quarterdeck from using a locally signed-in Claude login for these background calls—for example, to avoid spending Claude usage on automatic titles—sign Claude out, remove `claude` from Quarterdeck's PATH, or set `QUARTERDECK_TITLE_PROVIDER=llm` (gateway only) or `QUARTERDECK_TITLE_PROVIDER=local` (no model calls for titles); setting `QUARTERDECK_TITLE_PROVIDER=codex` alone is not enough, since that mode still falls through to Claude once Codex fails. Branch-name/commit-message generation follow the same Codex → Claude → gateway chain and are not controlled by `QUARTERDECK_TITLE_PROVIDER`; signing Claude out or removing it from PATH is the way to keep those calls off a local Claude login.

Conversation-summary display controls and AI summary polishing have been removed. Task cards retain completed agent responses and live progress without a separate generated synopsis. When upgrading from runtime protocol 7 or 8, restart Quarterdeck and refresh open browser tabs. Existing completed responses migrate automatically; retired summary settings are ignored.

New task titles fall back to deterministic local text if all providers fail. Initial titles describe the broad subject or purpose, such as “UI Work” or “Kafka Investigation.” Titles stay unchanged as the conversation progresses. Use Auto-generate title to explicitly regenerate from bounded recent conversation history when the thread’s direction changes; failed follow-up generation keeps the current name. `QUARTERDECK_TITLE_PROVIDER=local` skips model calls for titles; `QUARTERDECK_TITLE_PROVIDER=llm` skips Codex and Claude for titles; `QUARTERDECK_TITLE_PROVIDER=claude` skips Codex for titles. `QUARTERDECK_CODEX_TITLE_MODEL` overrides the Codex title model; `QUARTERDECK_CLAUDE_TITLE_MODEL` overrides the Claude title model. Branch-name and commit-message generation report failure if no provider succeeds; generating a message does not commit files.

### Optional LiteLLM or OpenAI-Compatible Helper

This gateway is optional. It provides fallback generation for titles, branch names, and commit messages when the saved Codex and Claude logins cannot produce a result. An explicit `QUARTERDECK_TITLE_PROVIDER=llm` override uses it directly for titles.

Choose one of these setups:

- **Saved Codex or Claude login (default):** sign in with ChatGPT through Codex, or with Claude Code. No gateway variables or additional service are required for AI text generation.
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

## Everyday Workflow

1. Add projects.

   Quarterdeck can track Git repositories and ordinary folders. Each project has its own board, task cards, settings, shortcuts, and runtime state.

   For a parent folder that contains several repositories, choose **Use as folder project** from its project menu. Its board and tasks stay in place, while each child can be added as an independent project. You can also choose **Add without Git** when adding a folder. Adding a child never silently opens its parent repository; initialize Git in the child if it needs its own repository.

   Folder projects keep task agents and the file browser, but disable Git controls and new isolated worktrees. New tasks run directly in the folder. Conversion preserves existing files, Git history, and task workspaces; it does not delete `.git` or restrict Git commands an agent runs itself. Choose **Enable Git** from the same menu to switch back.

2. Create task cards.

   Add cards manually or paste prompts into the sidebar. You can split a list into multiple unstarted cards, then start each task individually.

3. Start agents.

   Starting a card launches the configured agent. New Git-project tasks use isolated worktrees by default: Quarterdeck copies ignored files selected by `.worktreeinclude`, runs the project’s optional setup script, and injects worktree context. Configure **Worktree setup script** in project Settings to install task-local dependencies automatically. Tasks using the project folder directly skip that preparation. See [worktree setup](./worktree-setup.md) for include patterns, script behavior, and failure recovery.

4. Monitor progress.

   Cards show task state, latest agent activity, review readiness, permission/input needs, and git change indicators. Opening a card shows the live agent terminal.

   For a connected Claude, Codex, or Pi task, use **Copy full conversation** in the top toolbar to copy saved prompts and replies as Markdown, including messages outside the terminal viewport. For Codex it reads all history pages through Codex’s API and also includes progress messages and plans; attachments appear as labels. For Claude it reads the task’s exact saved session transcript under the launch profile (`CLAUDE_CONFIG_DIR` or `~/.claude`), follows the active branch after rewinds, and marks each compaction with `[Context compacted]` while keeping the earlier history; attachments are omitted. For Pi it reads only the exact saved session file reported by the current launch, including custom session-storage locations, and follows the saved active branch while preserving pre-compaction prompts and replies. It marks compactions with `[Context compacted]` and branch changes with `[Branch changed]`; in-memory tree navigation without a saved append does not change the copied branch. Pi tools, reasoning, attachments, and extension/system context are excluded; tool logs are excluded for all providers. The copy fails explicitly if the full result exceeds 8 MB, a Claude or Pi transcript exceeds 128 MB, or the history cannot be read completely or belongs to another session. Messages still being generated may not have been saved yet. Restart Pi processes launched before session-source reporting was installed to enable full-conversation copy.

   Claude `/rename` titles follow the task card while its title is still automatic. Codex native thread names and Claude’s automatic summaries are not adopted. A manual title edit stops this synchronization for that task.

5. Review changes.

   The task detail view includes terminal output, git diffs, a file browser, branch comparison, and line comments that can be sent back to the agent. The git view can also compare branches and inspect uncommitted work in either the home repo or the selected task worktree.

6. Land the work.

   Use Commit, Open PR, Squash Merge, cherry-pick, or the git view to move reviewed work back toward your base branch. Prompt shortcuts help automate repetitive landing steps.

7. Clean up or resume.

   Moving a card to Trash stops its agent and detail shell while preserving the task worktree, files, and provider resume identity. For an isolated worktree on a branch, Trash detaches it at the current commit so another checkout can use that branch. Staged and unstaged changes stay in place.

   Restore the card to resume work when the agent supports it. Quarterdeck tries to reattach the original branch if it still points to the saved commit and is available. If the branch moved, was deleted, or is checked out elsewhere, the task resumes with detached HEAD and a warning; its saved files and commit remain intact. Tasks that were already detached stay detached. Permanent deletion removes the task workspace; Trash itself does not reclaim that disk space.

   If an unfinished Git operation or a worktree verification failure prevents safe detachment, Trash preserves the checkout and reports a warning. Its branch can remain occupied until the issue is resolved or the task is permanently deleted. Existing Trash worktrees are not automatically detached during an upgrade.

## File browser discovery

Files loads immediate children of the project root, then loads folders as you expand them. Wide folders offer **Load more**; there is no whole-project entry cap. Each request returns at most 500 visible entries and examines at most 4,096 entries. A filtered page can be empty while more entries remain. The tree filter searches loaded entries only; use the file finder to search unopened folders.

VCS metadata directories and `node_modules` remain hidden. Git projects also prune ignored directories while preserving tracked content and individually ignored files such as `.env.local`. Folder projects do not consult Git. Generated agent worktrees under `.claude/worktrees` are hidden at any depth; **Show generated worktrees** reveals them without hiding other `.claude` files or changing Git rules and mutation permissions. Symlinked directories are leaves, not browsable subtrees.

While Files is active, only the root and expanded visible folders are polled. First pages are reused for 30 seconds; external changes appear on a later poll after expiry. Quarterdeck file-entry mutations, `.gitignore` saves, and worktree-changing Git actions invalidate affected listings. Paths accessed through different symlink aliases may still wait for expiry. Ordinary content saves do not rescan directories. Pagination cursors are temporary: expiry, eviction, or invalidation restarts that directory's enumeration rather than failing the whole project. Refreshes restore the number of pages you already loaded before replacing the displayed entries. Enumeration is not a frozen filesystem snapshot, so listing absence never closes an open file or discards a draft.

File search is independent of tree expansion. Folder-project searches use bounded filesystem scans and report partial results when their work/time budget is reached; generated agent worktrees are excluded. Git and ref search retain their separate indexes. Ref browsing is read-only; unusually wide ref directories remain subject to Git subprocess output-size and retained-data limits.

## Troubleshooting

If `quarterdeck` is not found after `npm install --global quarterdeck`, make sure your npm global bin directory is on `PATH`. Contributors using a source checkout can run `npm run link` instead.

If no agent is available, install Claude Code, OpenAI Codex, or Pi and confirm the matching binary (`claude`, `codex`, or `pi`) is available on `PATH`. Quarterdeck requires Claude Code 2.1.198+, Codex 0.157.0+, or exactly Pi 1.4.0 for supported task-agent launches.

If terminal symbols look wrong, install [JetBrainsMono Nerd Font](https://www.nerdfonts.com/), which Quarterdeck prefers when available, then reopen the app or browser.

If startup reports an unconfirmed prior shutdown, choose **Recover sessions…** in the desktop app, or run `quarterdeck recover`. After checking and stopping any remaining agents or background commands, confirm in the app or run `quarterdeck recover --confirm-stopped`, then reopen Quarterdeck. Recovery preserves saved projects, task work, and session history. It refuses live saved processes or unreadable evidence and does not kill processes. Older runs cannot account for detached commands; reboot remains an option when you cannot verify those commands have stopped.

If an incident is difficult to explain, run `quarterdeck diagnostics doctor --request-browser` or `quarterdeck diagnostics capture --request-browser`. Quarterdeck automatically retains a small recent metadata-only history; you do not need to enable logging before the incident. Diagnostic bundles stay local under the Quarterdeck state directory, use owner-only filesystem access including protected Windows ACLs, and exclude prompts, terminal transcripts, files, diffs, environment values, and secrets by default. See [DEVELOPMENT.md](../DEVELOPMENT.md#unified-diagnostics) for filters, temporary deep recording, privacy limits, and isolated visual testing.
