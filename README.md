# Quarterdeck

![Quarterdeck board screenshot](https://github.com/user-attachments/assets/2aa3dcc7-94e3-4076-bcfe-6d0272007cfe)

Quarterdeck is a local board for running coding agents in parallel. Each task gets a card, a terminal, Git context, and a review surface, with optional isolated worktrees. It supports **Claude Code, OpenAI Codex, and Pi** through their installed CLIs.

Use the macOS or Windows desktop app. Quarterdeck no longer offers a standalone browser or Linux desktop product.

## Install via npm

You need **Node.js 22.22.2+**, **Git**, and at least one supported agent CLI installed and signed in:

| Agent | Required version |
| --- | --- |
| Claude Code | 2.1.198+ |
| OpenAI Codex | 0.157.0+ with native hooks and auto-review support |
| Pi | Exactly 1.4.0; currently validated on macOS |

See [agent setup](docs/usage.md#set-up-an-agent) for install and sign-in instructions. Quarterdeck does not require its own account.

Install the [npm package](https://www.npmjs.com/package/quarterdeck), then launch from your project:

```bash
npm install --global quarterdeck
cd /path/to/your/project
quarterdeck
```

On macOS 13+ (Apple Silicon or Intel), a global installation installs the matching desktop app at `~/Applications/Quarterdeck.app`. Native x64/ARM64 Windows 10/11 uses a per-user app and Start menu shortcut. `quarterdeck` opens the installed app in a local graphical session. npm owns installation and updates, including for Finder/Dock and Windows Start menu launches. See the [validation gates](docs/desktop-validation.md) for platform combinations and installation scenarios that still need acceptance evidence.

Windows builds are **unsigned**; SmartScreen or organization policy may require approval or block launch. There is no browser fallback.

The Mac app is **ad-hoc signed, not Apple-notarized**. macOS may require **System Settings → Privacy & Security → Open Anyway** after a blocked launch; managed Macs may disallow approval. Updates may prompt again for Keychain access. See [first-launch guidance](docs/desktop.md#macos-security-and-first-launch).

### Upgrading from browser mode

Quit the old runtime, remove any `QUARTERDECK_INSTALL_MODE=browser` setting from your shell or installation command, then run `npm install --global quarterdeck@latest`. If installation scripts were disabled, run `quarterdeck desktop install` to install the matching app. Existing projects, tasks, settings, and provider resume identities remain in the same state home; do not delete it. Save browser-profile-only unsaved work before upgrading, then close old Quarterdeck tabs. If an old offline page keeps refreshing, clear that site's data to remove its retired service worker.

`--browser`, browser URLs, browser installation opt-outs, and standalone Linux/headless product use are no longer supported. Saved browser installation preferences do not retain the old mode. Internal headless runtimes and hidden desktop tests remain development infrastructure, not a separate product.

## Using desktop

```bash
quarterdeck             # Open the installed desktop app
quarterdeck --desktop   # Explicit equivalent
```

The desktop app also opens from Finder, the Dock, or the Windows Start menu. Closing its macOS window keeps tasks running; closing the Windows window requests Quit. **Quit** checks unsaved work and live sessions before shutdown.

The macOS app imports your login shell’s exported environment by default; Windows inherits its launch environment. Use **Settings → Runtime Environment** to disable import, add executable folders, or refresh the runtime; existing explicit opt-outs remain disabled. Ad-hoc-signed builds may prompt for **Quarterdeck Safe Storage** Keychain access again after updates.

See the [desktop guide](docs/desktop.md#using-the-app) for installation repair, window behavior, environment setup, and recovery. See also [Windows setup and provider limitations](docs/windows-support-audit.md).

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

npm installations do not update automatically. Quit the desktop app before updating, then run:

```bash
npm install --global quarterdeck@latest
```

This updates the npm package and its matching app. An incomplete or outdated pair refuses desktop startup until repaired; launch does not fall back to a browser.

An npm-installed desktop app checks for updates at startup or through **Check for Updates**. **Update Quarterdeck** confirms unsaved work and live sessions, quits cleanly, then runs the update in Terminal. Reopen the app when it finishes. Linked source builds use `npm run link` instead.

Use `quarterdeck desktop status` to inspect an incomplete CLI/app installation and `quarterdeck desktop install` to repair it, including when npm lifecycle scripts were disabled. Launch never downloads, repairs, or silently falls back from a mismatched app. For removal, quit the app and run `quarterdeck desktop uninstall` before `npm uninstall --global quarterdeck`. npm removal alone leaves the app behind. Projects, settings, and saved sessions are preserved; see the [desktop guide](docs/desktop.md#using-the-app) for ownership and migration details.

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

On supported macOS and Windows hosts this builds and installs the matching desktop app. Quit the installed app before rebuilding or replacement. See [development](DEVELOPMENT.md) for internal runtime and isolated test workflows.

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
