# Quarterdeck

![Quarterdeck board screenshot](https://github.com/user-attachments/assets/2aa3dcc7-94e3-4076-bcfe-6d0272007cfe)

Quarterdeck is a local board for running coding agents in parallel. Each task gets a card, a terminal, Git context, and a review surface, with optional isolated worktrees. It supports **Claude Code, OpenAI Codex, and Pi** through their installed CLIs.

Use the macOS desktop app or browser mode. Both share the same projects, tasks, settings, and agent integrations.

## Install via npm

You need **Node.js 22.22.2+**, **Git**, and at least one supported agent CLI installed and signed in:

| Agent | Required version |
| --- | --- |
| Claude Code | 2.1.198+ |
| OpenAI Codex | 0.157.0+ with native hooks and auto-review support |
| Pi | Exactly 0.84.3; currently validated on macOS |

See [agent setup](docs/usage.md#set-up-an-agent) for install and sign-in instructions. Quarterdeck does not require its own account.

Install the [npm package](https://www.npmjs.com/package/quarterdeck), then launch from your project:

```bash
npm install --global quarterdeck
cd /path/to/your/project
quarterdeck
```

Global installation installs the browser/CLI package on every supported platform. The macOS desktop app is optional and experimental: signed public distribution still has [pending release gates](docs/desktop-validation.md). Until matching signed assets are published, use the [local desktop build](docs/desktop-release.md#local-unsigned-candidate).

When signed assets are available for the version, opt into desktop installation on macOS 13+ (Apple Silicon or Intel):

```bash
QUARTERDECK_INSTALL_MODE=desktop npm install --global quarterdeck
quarterdeck --desktop
```

To try browser mode without a global installation:

```bash
npx --yes quarterdeck@latest --browser
```

## Desktop and browser modes

```bash
quarterdeck             # Browser mode on every platform
quarterdeck --browser   # Browser mode, including on macOS
quarterdeck --desktop   # Explicit macOS app launch
```

The desktop app also opens from Finder or the Dock. Closing its window keeps tasks running; **Quit** checks unsaved work and live sessions before shutdown. **File → Open in Browser** opens the same runtime in your browser.

If the app cannot find Git or an agent, use **Quarterdeck → Runtime Environment…** to add its executable folder and refresh. Desktop startup does not load shell startup files by default; shell environment import is opt-in. Local builds are ad-hoc signed and may prompt for **Quarterdeck Safe Storage** Keychain access again after updates.

See the [desktop guide](docs/desktop.md#using-the-app) for installation repair, window behavior, environment setup, and recovery. Windows browser support is also [experimental](docs/windows-support-audit.md).

## What Quarterdeck Does

- Runs multiple agents side by side, with task status, activity, and permission/input indicators.
- Gives tasks isolated Git worktrees, with optional setup scripts and selected ignored files copied into each checkout.
- Provides diffs, file browsing, branch comparison, and line comments to send back to an agent.
- Supports Commit, Push, Open PR, Squash Merge, and cherry-pick workflows.
- Offers project script shortcuts and reusable agent prompts.

## Everyday Workflow

1. **Add a project:** a Git repository or an ordinary folder. Folder projects support agents and files without Git controls or isolated worktrees.
2. **Create and start tasks:** enter prompts, choose an agent, and work in an isolated worktree or the project folder. Configure a [worktree setup script](docs/worktree-setup.md) when tasks need their own dependencies.
3. **Monitor and review:** open a card's terminal, inspect changes, and send feedback through line comments or prompts.
4. **Land the work:** commit, open a PR, merge, or cherry-pick reviewed changes.
5. **Clean up or resume:** Trash stops a task while preserving its worktree and resume identity. Permanent deletion removes the task workspace.

See the [user guide](docs/usage.md#everyday-workflow) for folder-project options, conversation copying, and workflow details.

## Updates and removal

npm installations do not update automatically. Update the browser/CLI package with:

```bash
npm install --global quarterdeck@latest
```

For an opted-in desktop installation, quit the app and use `QUARTERDECK_INSTALL_MODE=desktop npm install --global quarterdeck@latest` to update both parts. A browser-only npm update does not replace the app; an outdated pair refuses desktop startup until repaired.

An npm-installed desktop app checks for updates at startup or through **Check for Updates**. **Update Quarterdeck** confirms unsaved work and live sessions, quits cleanly, then runs the update in Terminal. Reopen the app when it finishes. Linked source builds use `npm run link` instead.

Use `quarterdeck desktop status` to inspect an incomplete CLI/app installation and `quarterdeck desktop install` to repair it. For removal, quit the app and run `quarterdeck desktop uninstall` before `npm uninstall --global quarterdeck`. npm removal alone leaves the app behind. Projects, settings, and saved sessions are preserved; see the [desktop guide](docs/desktop.md#using-the-app) for ownership and migration details.

## Configuration and troubleshooting

Settings covers project and agent preferences. Runtime state lives in `~/.quarterdeck` by default; `QUARTERDECK_STATE_HOME` overrides it. No `.env` file or helper gateway is required. Optional AI text generation uses your saved Codex login first, with configurable gateway fallback; see [environment variables and helper configuration](docs/usage.md#environment-variables).

- **Command not found:** check that your npm global bin directory is on `PATH`.
- **Agent unavailable:** check its supported version, sign-in, and executable path; see [agent setup](docs/usage.md#set-up-an-agent).
- **Unconfirmed prior shutdown:** use **Recover sessions…** or `quarterdeck recover`, then follow the [recovery guidance](docs/usage.md#troubleshooting).
- **Other runtime problems:** run `quarterdeck diagnostics doctor --request-browser` or [capture diagnostics](docs/usage.md#troubleshooting). Recent metadata is retained automatically; bundles stay local and exclude prompts, terminal transcripts, and file contents by default.

## Development and documentation

For a source install:

```bash
git clone https://github.com/dankhole/quarterdeck.git
cd quarterdeck
npm run link
```

On supported Macs this builds and installs the matching desktop app. Use `npm run link -- --browser` for CLI-only development. Stop a linked runtime and quit the installed app before rebuilding or replacement.

- [User guide](docs/usage.md): agent setup, configuration, workflow, and troubleshooting
- [Desktop guide](docs/desktop.md): app operation, installation, and recovery
- [GitHub Releases](https://github.com/dankhole/quarterdeck/releases): generated release notes
- [Development](DEVELOPMENT.md): build, link, test, and debugging commands
- [Engineering docs](docs/README.md): architecture, conventions, and validation

## Help and Feedback

Quarterdeck is under active development. Use [GitHub Issues](https://github.com/dankhole/quarterdeck/issues) for bugs and [GitHub Discussions](https://github.com/dankhole/quarterdeck/discussions/categories/ideas) for ideas and workflow feedback.

## License and Origin

Quarterdeck is a derivative work of [kanban-org/kanban](https://github.com/kanban-org/kanban), originally created by Cline Bot Inc. and licensed under the Apache License 2.0. Significant modifications have been made.

[Apache 2.0](./LICENSE)
