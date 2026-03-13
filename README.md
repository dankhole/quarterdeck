# kanban (Research Preview)

<p align="center">
  <img src="https://github.com/user-attachments/assets/deabc452-a340-4210-b42f-f8696be04ee9" width="100%" />
</p>

<div align="center">
<table>
<tbody>
<td align="center">
<a href="https://www.npmjs.com/package/kanban" target="_blank">NPM</a>
</td>
<td align="center">
<a href="https://github.com/cline/kanban" target="_blank">GitHub</a>
</td>
<td align="center">
<a href="https://github.com/cline/kanban/issues" target="_blank">Issues</a>
</td>
<td align="center">
<a href="https://github.com/cline/kanban/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop" target="_blank">Feature Requests</a>
</td>
<td align="center">
<a href="https://discord.gg/cline" target="_blank">Discord</a>
</td>
<td align="center">
<a href="https://x.com/cline" target="_blank">@cline</a>
</td>
</tbody>
</table>
</div>

A Human-in-the-Loop Agent Swarm Orchestration layer that gives more autonomy to your CLI agents with task dependency linking and automatic commits and pull requests. Each task runs in its own branchless worktree with .gitignore'd files like node_modules symlinked so your filesystem and git don't get polluted, letting you run hundreds of tasks in parallel on any computer. It also comes with a visualizer for your git branches and commit history, so you can keep track of the work your agents do.

```
npx kanban
```

## Getting Started

1. Install an agent like Claude Code, Codex, Gemini, OpenCode, Cline
2. Run `kanban` (install with `npm i -g kanban`) in your repo to launch a web GUI
3. Create tasks, link dependencies, hit the play button, and watch agents work in parallel. You can also ask your agent to manage tasks through Kanban's built-in skill and task CLI.
4. When they finish, you review diffs, leave comments, and commit or make a PR.

## Agent Skill Setup

Kanban writes a `kanban` skill file on every launch so your agent can add, update, link, and start tasks using `kanban task` commands.

Generated skill paths:

- `~/.agents/skills/kanban/SKILL.md`
- `~/.claude/skills/kanban/SKILL.md` (written when Claude is installed)

The file is regenerated each launch so new Kanban releases can update the instructions automatically.

The skill includes:

- command reference for `kanban task list|create|update|link|unlink|start`
- parameter guidance for each command
- dependency and auto-review workflow notes
- ephemeral worktree handling (`.kanban/worktrees`) so commands target the main workspace

## License

[Apache 2.0 (c) 2026 Cline Bot Inc.](./LICENSE)
