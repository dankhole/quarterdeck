### npx kanban (Research Preview)

A replacement for your IDE better suited for running many agents in parallel and reviewing diffs. Each task card gets its own terminal and worktree all handled for you automatically. Enable auto-commit and link cards together to create dependency chains of tasks to complete large amounts of work autonomously. Open a card to view the agent's work and see a diff of all its changes for you to comment on or commit. Run `npx kanban` (or `npm i -g kanban`) in your project to use it with your installed CLI agent.

<p align="center">
  <img src="https://github.com/user-attachments/assets/bd06a620-c66a-4903-84a7-759682d0f139" width="100%" />
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

Kanban makes it easy to go from idea -> commit or PR, and work on many tasks in parallel without running into merge conflicts. This is accomplished with worktrees and agent-assisted merging.

Start by creating a task, or opening the bottom terminal (cmd + j) to start your agent and ask it to create tasks for you. You can even create a task to create tasks (agents are automatically loaded with a `kanban` skill that shows them how to use the kanban CLI to add/edit/start tasks for you).

Hit the play button to start a task, this provisions an ephemeral worktree just for that task and uses clever tricks like symlinking gitignored files so you don't have to worry about worktree initialization or management yourself.

Your configured CLI agent then gets started on the task in a terminal emulator. Kanban uses hooks to retrieve the latest message or tool call from the agent as it works, so you can stay in the loop watching hundreds of agents work at the same time. Use an agent's TUI in a terminal emulator by clicking on a card. You can also see a diff of all the changes, or changes between each message you send with kanban's own checkpointing system. 

When the task is completed, you can hit the Commit or Open PR buttons which send a dynamic prompt to the agent to help it convert the worktree to a commit for your base ref or a PR branch. Once finished, move the task to trash to clean up the agent terminal and the worktree files. You can always resume a trashed task since kanban keeps track of the resume ID.

Keep track of all the work being done on your repo by clicking the branch name in the navbar to view its git information, with commit history, and list of branches to easily switch. Inspired by Git Tower, this git visualizer includes all the core git features you need to manage and push changes as your agents make them. It also comes with a visualizer for your git branches and commit history, so you can keep track of the work your agents do.

### Advanced Usage

You can choose to skip review process and automatically commit or open a PR as soon as the agent is done working.

You can also command click in a card to create a link to another task card. This creates a 'dependency' where as soon as one of those cards is completed and moved to trash, it auto-starts the linked task. 

Auto commit/PR + linking allows you to complete large projects end to end in a way that parallelizes for efficiency. You can even ask your agent to break a large project down into tasks and link them in a way that parallelizes. It’s a pretty magical experience using the kanban MCP to ask Cline to decompose a big task into subtasks that auto-commit - he’ll cleverly do it in a way that parallelizes efficiently and links tasks together for end to end autonomy.


### Worktree Parallelization

Every task gets its own worktree. As soon as the task is started, the worktree is created, and your project's gitignore is used to create symbolic links to things like node_modules that take quite long and would waste too much hard drive if we directly copied. Symlinks allow us to reference the original files in the new location, and are ideal for when you need a file to be in your project that you don't plan on modifying.

### Create tasks to create tasks

A `kanban` skill is automatically added to your CLI agent, so that it knows how to use the kanban CLI right away. This allows it to create, edit, start, and link tasks on your kanban board for you. It’s a pretty magical experience asking the agent to decompose a big task into subtasks that auto-commit - he’ll cleverly do it in a way that parallelizes efficiently and links tasks together for end to end autonomy.

### Auto-commit + Linking

With the models getting better, most work will become less course correcting and more reviewing and committing. Auto-commit or PR allows the agent to autonomously complete the work so that all you have to do is watch. This becomes especially powerful when you link tasks together, so that one task auto-completing automatically kicks off a dependent task or tasks, and those tasks kick off their own dependency and so on. 

### Script Shortcuts

To easily test and debug your app, create a Script Shortcut in settings. Use a command like `npm run dev` so that all you have to do is hit a play button in the navbar, instead of remembering commands or asking your agent to do it.

### Add comments to diffs

Once the agent's completed working, view the changes in a unified or full screen split diff view. Click on lines to leave comments and send them to your agent. 

### Git History

Keep track of the work your agent is doing by having a full git GUI for you to manage branches and commit history. Fetch, pull, push, keep track of remote changes, switch branches, everything you'd need in managing git with a UI to make it all make sense.


## License

[Apache 2.0 (c) 2026 Cline Bot Inc.](./LICENSE)
