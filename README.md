> **Fork notice:** This project is a derivative work of [kanban-org/kanban](https://github.com/kanban-org/kanban), originally created by Cline Bot Inc. and licensed under the Apache License 2.0. Significant modifications have been made. See [LICENSE](LICENSE) for terms.

## Quarterdeck

<p align="center">
  <img src="https://github.com/user-attachments/assets/2aa3dcc7-94e3-4076-bcfe-6d0272007cfe" width="100%" />
</p>

A terminal replacement with light IDE features — run many agents in parallel, review diffs, and manage your full dev workflow without swapping between apps. Each task card gets its own terminal and worktree, all handled for you automatically. Enable auto-commit and link cards together to create dependency chains that complete large amounts of work autonomously.

Supports **Claude Code**, **Codex CLI**, and **Pi** out of the box — Quarterdeck detects whichever is installed and launches it for you.

> [!NOTE]
> Quarterdeck is under active development. Found a bug or have an idea? Open a [GitHub Issue](https://github.com/dankhole/quarterdeck/issues).
>
> **Windows support** is experimental — basic functionality should work but is largely untested. If you try it on Windows, bug reports are very welcome.

<div align="left">
<table>
<tbody>
<td align="center">
<a href="https://github.com/dankhole/quarterdeck" target="_blank">GitHub</a>
</td>
<td align="center">
<a href="https://github.com/dankhole/quarterdeck/issues" target="_blank">Issues</a>
</td>
<td align="center">
<a href="https://github.com/dankhole/quarterdeck/discussions/categories/ideas" target="_blank">Feature Requests</a>
</td>
</tbody>
</table>
</div>

## Contributor docs

If you're working on Quarterdeck itself instead of just using it:

- [`DEVELOPMENT.md`](./DEVELOPMENT.md) has the local-dev workflow, command cheatsheet, repo map, and CI notes.
- [`docs/README.md`](./docs/README.md) is the human-facing index for architecture, refactor docs, and implementation history.
- [`AGENTS.md`](./AGENTS.md) is the canonical repo-owned agent-instructions file used for shared Claude/Codex guidance.

### 1. Install quarterdeck

For the best terminal experience, install a [Nerd Font](https://www.nerdfonts.com/) (we recommend **JetBrainsMono Nerd Font**). Nerd Fonts include the glyphs that CLI agents use for status icons and UI elements. Without one installed, the terminal falls back to SF Mono / Menlo.

```bash
git clone https://github.com/dankhole/quarterdeck.git
cd quarterdeck
npm run install:all
npm run link
```
This builds the project and creates a global `quarterdeck` CLI command. Then open any git repo and run:
```bash
cd /path/to/your/project
quarterdeck
```
Quarterdeck will detect your installed CLI agent, launch a local server, and open it in your browser. No account or setup required.

### 2. Manage projects and create tasks
Add multiple projects to Quarterdeck and switch between them from the sidebar — each project has its own board, task cards, and configuration. Create a task card manually, or open the sidebar chat and ask your agent to break work down into tasks for you. Quarterdeck injects board-management instructions into that session so you can simply ask it to add tasks, link tasks, or start work on your board.

### 3. Start tasks
Hit the play button on a card. Quarterdeck creates an ephemeral worktree just for that task so agents work in parallel without merge conflicts. Under the hood, it also symlinks gitignored files like `node_modules` so you don’t have to worry about slow `npm install`s for each copy of your project.

> [!NOTE]
> [Symlinks (symbolic links)](https://en.wikipedia.org/wiki/Symbolic_link) are special "shortcuts" pointing to another file or directory, allowing access to the target from a new location without duplicating data. They work great in this case since you typically don’t modify gitignored files in day-to-day work. If your workflow regularly modifies them, you can disable worktree symlinks in settings.

As agents work, Quarterdeck uses hooks to display the latest message or tool call on each card, so you can monitor all your agents at a glance without opening each one.

### 4. Link and automate
<kbd>⌘</kbd> + click a card to link it to another task. When a card is completed and moved to trash, linked tasks auto-start. Combine with auto-commit for fully autonomous dependency chains: one task completes → commits → kicks off the next → repeat. It’s a pretty magical experience asking your agent to decompose a big task into subtasks that auto-commit - it’ll cleverly do it in a way that parallelizes for maximum efficiency and links tasks together for end-to-end autonomy.

### 5. Review changes
Click a card to view the agent's TUI and a diff of all the changes in that worktree. Quarterdeck includes its own checkpointing system so you can also see a diff from the last messages you've sent. Click on lines to leave comments and send them back to the agent. Switch to the file browser to explore the full worktree, browse other branches, or inspect individual files.

To easily test and debug your app, create a Script Shortcut in settings. Use a command like `npm run dev` so that all you have to do is hit a play button in the navbar instead of remembering commands or asking your agent to do it. Settings also let you configure audible notifications, terminal rendering, git polling intervals, worktree behavior, and more.

### 6. Ship it
When the work looks good, hit **Commit** or **Open PR**. Quarterdeck sends a dynamic prompt to the agent to convert the worktree into a commit on your base ref or a new PR branch, and work through any merge conflicts intelligently. Or skip review by enabling auto-commit / auto-PR and the agent ships as soon as it's done. Move the card to trash to clean up the worktree (you can always resume later since Quarterdeck tracks the resume ID).

### 7. Keep track with the git view
Open the git view to see uncommitted changes, a diff of what changed since your last message (Last Turn), or compare any two branches side by side with the Compare tab. The integrated file tree lets you navigate diffs by file. Works in both task worktree and home repo contexts.

---

[Apache 2.0 © 2026 Cline Bot Inc.](./LICENSE)
