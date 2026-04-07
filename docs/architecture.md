# Architecture Overview

Quarterdeck is a local Node runtime plus a React app for running many coding-agent tasks in parallel.

There are two big ideas to hold in your head:

1. The browser is mostly a control surface. It renders state, sends commands, and reacts to live updates.
2. The local runtime is the source of truth for projects, worktrees, sessions, git operations, and streaming state.

All agents (Claude Code, Codex, Gemini, OpenCode, Droid, etc.) run as PTY-backed CLI processes.

If you remember nothing else, remember this:

- agents are process-oriented
- the backend coordinates them through one runtime API and one state stream

## System Diagram

```text
+----------------------------------------------------------------------------------+
| Browser UI                                                                       |
| web-ui/src                                                                       |
|                                                                                  |
| App.tsx, hooks/, components/, runtime/, terminal/                               |
+---------------------------------------+------------------------------------------+
                                        |
                                        | TRPC requests and websocket updates
                                        v
+----------------------------------------------------------------------------------+
| Local Runtime                                                                    |
| src/                                                                             |
|                                                                                  |
| trpc/app-router.ts, trpc/runtime-api.ts, server/runtime-state-hub.ts             |
+-------------------------------+--------------------------------------------------+
                                |
                                v
+-------------------------------+--+
| PTY Runtime                      |
| src/terminal/                    |
|                                  |
| agent-registry.ts                |
| session-manager.ts               |
| pty-session.ts                   |
+-------------------------------+--+
                                |
                                v
+-------------------------------+--+
| Worktrees and shell processes    |
| per-task cwd, CLI agents, shell  |
+----------------------------------+
```

## Request and Stream Diagram

```text
User action in UI
    |
    v
component
    |
    v
hook or runtime query helper
    |
    v
TRPC client
    |
    v
app-router.ts
    |
    v
runtime-api.ts
    |
    +--> terminal/session-manager.ts


Live runtime output
    |
    +--> terminal session summaries
    |
    v
runtime-state-hub.ts
    |
    v
websocket stream
    |
    v
browser runtime state hooks
    |
    v
board, detail view, sidebar, and terminal panels
```

## The Mental Model

Quarterdeck is easiest to understand if you separate it into three layers of responsibility.

The browser layer is the presentation and orchestration layer. It renders the board, detail view, settings, and terminal surfaces. It also owns short-lived UI state such as panel visibility, form drafts, and optimistic message rendering.

The runtime layer is the control layer. It decides what session to start, where it should run, what worktree or workspace it belongs to, what command should be used, and what state should be streamed back to the browser.

The execution layer is the actual agent implementation — a CLI process attached to a PTY for every agent in the catalog.

That split explains a lot of the architecture:

- the browser should not be the source of truth for session lifecycle
- the runtime should coordinate work, not render UI

## Runtime Modes

Quarterdeck currently supports two runtime modes.

| Runtime mode | Used for | Scope | Backing implementation | Why it exists |
| --- | --- | --- | --- | --- |
| CLI-backed task terminal | Claude Code, Codex, Gemini, OpenCode, Droid, and similar agents | task-scoped | PTY-backed process runtime | these agents are command-driven CLIs and fit the terminal model well |
| Workspace shell terminal | the bottom shell panel | workspace-scoped | PTY-backed shell process | this is for manual commands in the repo, not task execution |

## Core Concepts

These terms come up everywhere in the codebase.

| Concept | Meaning | Why it matters |
| --- | --- | --- |
| Workspace | an indexed git repository that Quarterdeck has opened | most browser and runtime state is scoped to a workspace |
| Task card | a board item with a prompt, base ref, and review settings | a task is the unit of work the board cares about |
| Worktree | a per-task git worktree | most task agents run inside one |
| Task session | the live runtime attached to a task card | this is a PTY process |
| Home agent session | a synthetic, project-scoped session used by the sidebar agent surface | this lets the sidebar reuse existing runtime primitives without creating a real task card |
| Runtime summary | the small state object the board uses to know whether a session is idle, running, awaiting review, interrupted, or failed | this is the bridge between long-running agent work and the UI |

## Who Owns What

One of the biggest cleanup themes was making ownership clearer. The system is much easier to work on if every concern has one obvious owner.

| Concern | Primary owner | Notes |
| --- | --- | --- |
| board state, workspace state, review state | Quarterdeck | this is product state |
| worktree lifecycle | Quarterdeck | task worktrees are a Quarterdeck concept |
| process lifecycle | Quarterdeck | the terminal runtime owns process start, resize, output, and stop |

## Backend Architecture

The backend has a few important subsystems, each with a different job.

### TRPC layer

`app-router.ts` defines the typed contract between the browser and the runtime.

`runtime-api.ts` is the coordinator behind that contract. It should be the front door for runtime procedures, but not the place where deep session logic accumulates. A good rule of thumb is that `runtime-api.ts` should route and validate, then hand off to the terminal runtime, workspace logic, config helpers, or git helpers.

### Terminal runtime

The `src/terminal/` area owns everything process-oriented:

- choosing what binary to run
- launching PTY sessions
- resizing and streaming terminal output
- translating process lifecycle into Quarterdeck runtime summaries
- handling the workspace shell terminal

This is the path for all agents: Claude Code, Codex, Gemini, OpenCode, Droid, and any other command-driven agent.

### Workspace and config

`src/workspace/` owns worktree creation, lookup, cleanup, and turn checkpoints.

`src/config/runtime-config.ts` owns Quarterdeck preferences such as selected agents, shortcuts, and prompt templates.

### State streaming

`runtime-state-hub.ts` is the central fanout point for live updates. It listens to terminal summaries, workspace metadata, and workspace state changes, then broadcasts websocket messages that keep the browser in sync.

This is important because Quarterdeck is not designed around browser polling. The runtime is long-lived and streams state outward.

## Frontend Architecture

The frontend is also easier to navigate if you think in responsibilities instead of folders.

`App.tsx` is the composition root. It wires together the major hooks, determines which high-level surfaces are visible, and hands state down into the board, detail view, dialogs, and terminal areas. It should not become a second runtime orchestrator.

Hooks in `web-ui/src/hooks/` are where most domain logic lives. This includes project navigation, workspace synchronization, task-session actions, review behavior, and the home sidebar agent lifecycle. If you are looking for "how does this behavior actually work?", the answer is usually in a hook, not a component.

Components in `web-ui/src/components/` are mostly rendering and composition. Good frontend changes often mean moving runtime-aware logic into hooks and leaving the component to render a view model.

`web-ui/src/runtime/` holds client-side query helpers and persistence glue. One of the guardrails we now enforce is that raw workspace TRPC client creation should stay concentrated in the runtime query helpers rather than spread through arbitrary components.

## The Home Sidebar Agent Surface

The home sidebar agent surface is one of the less obvious parts of the architecture.

It looks like a task panel, but it is not backed by a real task card and it does not create a task worktree. Instead, the system creates a synthetic home agent session id and runs a project-scoped session behind that identity.

That design is a deliberate compromise.

It lets the sidebar reuse the same runtime primitives that already exist for task-scoped terminal panels, but without pretending the sidebar is a normal task with a prompt card and a worktree-backed lifecycle.

The current behavior is:

- the sidebar renders a terminal panel for the selected agent
- the home session is keyed to the current workspace and relevant agent descriptor
- switching between Projects and Agent in the sidebar should not restart the session
- switching to a different project or materially different agent configuration should rotate the session

## Main Flows

### Starting a task session

When the user starts a task, the browser asks the runtime to start a task session. The runtime resolves the task cwd, chooses the right command, and starts a PTY-backed process inside the task worktree. As the process runs, the terminal runtime emits summary updates and terminal output. The runtime state hub then streams those updates back to the browser so the board and detail view stay live.

## Configuration and Persistence

Different state lives in different places on purpose.

| State | Where it lives | Why |
| --- | --- | --- |
| selected agent, shortcuts, Quarterdeck prompt templates | Quarterdeck runtime config | these are Quarterdeck preferences |
| per-project UI or workflow state | workspace state or project config | this is workspace-scoped product state |
| task runtime summaries | Quarterdeck runtime memory and state stream | the board needs a lightweight product-shaped summary of current work |

### State directory layout

All persistent state lives under `~/.quarterdeck/` in the user's home directory, not inside the project repository. The in-repo `.quarterdeck/` directory only holds project-level config (shortcuts, hooks).

```
~/.quarterdeck/
├── config.json                          # global runtime config
├── hooks/                               # global hook scripts
├── worktrees/                           # task worktree checkouts
│   └── <task-id>/
│       └── <repo-name>/                 # isolated git worktree for the task
├── trashed-task-patches/                # saved patches from deleted tasks
└── workspaces/                          # per-workspace persistent state
    ├── index.json                       # maps workspace slugs to paths
    └── <workspace-slug>/
        ├── board.json                   # columns, cards, prompts, settings
        ├── sessions.json                # session history (PIDs, state, timestamps)
        └── meta.json                    # revision counter and last-updated timestamp
```

Workspace state is keyed by a slug derived from the project path. When you run Quarterdeck against `/Users/you/projects/myapp`, the state lands in `~/.quarterdeck/workspaces/myapp/`. This means state does not transfer automatically if you clone a repo to a new path or rename the project directory — you would need to copy the workspace folder manually.

## Design Rules

These are the architectural rules that are most important to preserve.

- one concern should have one clear source of truth
- keep `runtime-api.ts` as a coordinator, not a god file
- prefer sharing runtime-aware hooks between detail view and sidebar instead of letting the two diverge
- treat the browser as a client of streamed runtime state, not the source of truth for long-running sessions
- when adding new agent behavior, prefer capability-oriented reasoning over agent-specific branching

## Common Change Guide

When you are making a change, this table is often more useful than a file list.

| If you are changing... | Think about this first | Common mistake to avoid |
| --- | --- | --- |
| task startup for any agent | the PTY runtime and agent launch path | accidentally adding agent-specific special cases |
| live board updates | the runtime state hub and browser stream consumers | falling back to polling or duplicating summary logic |
| home sidebar agent behavior | the synthetic home session lifecycle | treating the sidebar like a normal task with a real worktree |

## What A New Engineer Should Expect

A new engineer opening this repo will probably notice a few things quickly:

- the backend is long-lived and stateful, not a thin stateless API server
- the browser is closer to a local control client than a traditional web app
- the task system, review system, and runtime system are tightly connected
- all agents use the same PTY-backed execution path
- the architecture favors clean ownership over compatibility glue

If you approach the code with those assumptions, the rest of the system starts to make sense much faster.
