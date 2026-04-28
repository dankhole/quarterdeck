# Architecture Overview

Quarterdeck is a local Node runtime plus a React app for running many coding-agent tasks across one or more git projects.

There are two big ideas to hold in your head:

1. The browser is mostly a control surface. It renders state, sends commands, reacts to live updates, and owns durable board writes.
2. The local runtime is the source of truth for project registration, worktrees, sessions, git operations, and streaming state.

All agents (Claude Code, Codex, etc.) run as PTY-backed CLI processes.

If you remember nothing else, remember this:

- agents are process-oriented
- the backend coordinates them through project-scoped APIs and one runtime state stream

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
| trpc/app-router.ts, trpc/project-procedures.ts, server/runtime-state-hub.ts      |
| server/project-registry.ts                                                      |
+-------------------------------+--------------------------------------------------+
                                |
                                v
+-------------------------------+--+
| PTY Runtime                      |
| src/terminal/                    |
|                                  |
| session-manager.ts               |
| pty-session.ts                   |
| session-lifecycle.ts             |
| session-transition-controller.ts |
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
    +--> runtime-api.ts        -> terminal/session-manager.ts
    |
    +--> project-procedures.ts -> project-api-* / workdir / git helpers


Live runtime state
    |
    +--> terminal session summaries
    |
    +--> project metadata updates
    |
    +--> lightweight task deltas
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
project provider, board, detail view, badges, and terminal panels
```

## The Mental Model

Quarterdeck is easiest to understand if you separate it into three layers of responsibility.

The browser layer is the presentation and orchestration layer. It renders the board, detail view, settings, git panels, and terminal surfaces. It also owns short-lived UI state such as panel visibility, form drafts, and optimistic message rendering. For durable board layout, it is the writer: browser saves send board truth through `project.saveState` with optimistic revision checks.

The runtime layer is the control layer. It decides what session to start, where it should run, what worktree or project it belongs to, what command should be used, what git metadata should be refreshed, and what state should be streamed back to the browser.

The execution layer is the actual agent implementation: a CLI process attached to a PTY for every task agent or shell session.

That split explains a lot of the architecture:

- the browser should not be the source of truth for session lifecycle
- the runtime should not rewrite board state behind an attached browser
- the runtime should coordinate work, not render UI

## Runtime Modes

Quarterdeck currently supports two runtime modes.

| Runtime mode | Used for | Scope | Backing implementation | Why it exists |
| --- | --- | --- | --- | --- |
| CLI-backed task terminal | Claude Code, Codex, and similar agents | task-scoped | PTY-backed process runtime | these agents are command-driven CLIs and fit the terminal model well |
| Project shell terminal | the home/detail shell panels | project-scoped | PTY-backed shell process | this is for manual commands in the repo, not task execution |

## Core Concepts

These terms come up everywhere in the codebase.

| Concept | Meaning | Why it matters |
| --- | --- | --- |
| Project | an indexed git repository that Quarterdeck has opened | most browser and runtime state is scoped to a project id |
| Task card | a board item with a prompt, base ref, and review settings | a task is the unit of work the board cares about |
| Worktree | a per-task git worktree | most task agents run inside one |
| Task session | the live runtime attached to a task card | this is a PTY process |
| Shell session | a project-scoped manual terminal | shell sessions reuse terminal plumbing but have different lifecycle rules from task agents |
| Runtime summary | the small state object the board uses to know whether a session is idle, running, awaiting review, interrupted, or failed | this is the bridge between long-running agent work and the UI |

## Who Owns What

One of the biggest cleanup themes was making ownership clearer. The system is much easier to work on if every concern has one obvious owner.

| Concern | Primary owner | Notes |
| --- | --- | --- |
| durable board state | browser through `project.saveState` | the public save contract is board-only and uses `expectedRevision` |
| runtime session truth | terminal runtime | task/session summaries come from the server-owned terminal store |
| project registration and project state files | Quarterdeck runtime | state is stored under the runtime state home, outside repos |
| worktree lifecycle | Quarterdeck | task worktrees are a Quarterdeck concept |
| process lifecycle | Quarterdeck | the terminal runtime owns process start, resize, output, and stop |

## Backend Architecture

The backend has a few important subsystems, each with a different job.

### TRPC layer

`app-router.ts` defines the typed tRPC contract between the browser and the runtime. Procedures are split into runtime, project, projects, and hooks routers.

`runtime-api.ts` is the coordinator behind that contract. It should be the front door for runtime procedures, but not the place where deep session logic accumulates. A good rule of thumb is that `runtime-api.ts` should route and validate, then hand off to the terminal runtime, workdir helpers, project state, config helpers, or git helpers.

Project-specific git, worktree, state, and file operations live behind `project-procedures.ts` and the `project-api-*` modules. Multi-project operations such as add/remove/reorder live behind `projects-api.ts`.

### Project registry

`server/project-registry.ts` is the runtime's project directory. It tracks indexed projects, the active project, runtime config for the active project, and the per-project `TerminalSessionManager` instances. It also builds project snapshots by loading persisted board state, overlaying live terminal summaries, and pruning session summaries to the board/runtime view that is appropriate for broadcasting.

### Terminal runtime

The `src/terminal/` area owns everything process-oriented:

- choosing what binary to run
- launching PTY sessions
- resizing and streaming terminal output
- translating process lifecycle into Quarterdeck runtime summaries
- handling project shell terminals
- reconciling stale/dead/processless sessions

This is the path for all agents: Claude Code, Codex, and any other command-driven agent.

`session-manager.ts` is the public terminal-service facade, but much of the behavior is split into focused modules:

- `session-lifecycle.ts` for task/shell spawn, exit handling, stale recovery, and hydration
- `session-transition-controller.ts` for state-machine side effects and summary fanout
- `session-input-pipeline.ts` and `session-output-pipeline.ts` for PTY IO paths
- `session-reconciliation.ts` and `session-reconciliation-sweep.ts` for periodic cleanup
- `terminal-state-mirror.ts` and `ws-server.ts` for terminal restore and socket transport

### Workdir and config

`src/workdir/` owns worktree creation, lookup, cleanup, git helpers, workdir searches, and turn checkpoints.

`src/config/runtime-config.ts` owns Quarterdeck preferences such as selected agents, shortcuts, notification settings, and prompt templates. Global config lives at the runtime state home; project config lives under the project's state directory.

### State streaming

`runtime-state-hub.ts` is the central fanout point for live updates. It listens to terminal summaries, project metadata, project state changes, debug logs, and lightweight task events, then broadcasts websocket messages that keep the browser in sync. It delegates batching to `runtime-state-message-batcher.ts` and git metadata policy to the project metadata monitor modules.

This is important because Quarterdeck is not designed around browser polling. The runtime is long-lived and streams state outward.

## Frontend Architecture

The frontend is also easier to navigate if you think in responsibilities instead of folders.

`App.tsx` is the composition root for the application shell. It wires the provider tree and high-level surfaces, but it should not become a second runtime orchestrator.

Providers in `web-ui/src/providers/` own broad UI state domains. `ProjectProvider` owns project navigation, stream state, hydration, and project sync. `ProjectRuntimeProvider` owns project-scoped runtime config and onboarding/access gates. Board, dialog, git, terminal, and interaction providers layer on top of that project foundation.

Hooks in `web-ui/src/hooks/` are where most domain logic lives. Hooks are organized by domain subdirectory: `app`, `board`, `debug`, `git`, `notifications`, `project`, `search`, `settings`, and `terminal`. If you are looking for "how does this behavior actually work?", the answer is usually in a hook or its pure companion domain module, not a component.

Components in `web-ui/src/components/` are mostly rendering and composition. Good frontend changes often mean moving runtime-aware logic into hooks and leaving the component to render a view model.

`web-ui/src/runtime/` holds client-side query helpers, stream transport/reducer code, project persistence, board cache, and runtime config glue. Raw project tRPC client creation should stay concentrated in these runtime helpers rather than spread through arbitrary components.

`web-ui/src/terminal/` owns the browser terminal implementation: pooled task terminal slots, dedicated shell terminals, socket/restore handling, xterm viewport plumbing, and DOM diagnostics.

## Main Flows

### Starting a task session

When the user starts a task, the browser asks the runtime to start a task session. The runtime resolves the task cwd, chooses the right command, and starts a PTY-backed process inside the task worktree. As the process runs, the terminal runtime emits summary updates. The runtime state hub streams those summaries back to the browser so the board and detail view stay live.

Raw PTY output does not travel through the runtime state hub. It streams through the terminal WebSocket path and browser terminal slot/restore layer, while the runtime state hub carries the product-shaped summaries and metadata that the rest of the UI needs.

### Saving board state

When the user changes the board, the browser persists through `project.saveState` with the current `expectedRevision`. The public save payload contains board data only. On the server, the project API reads authoritative session summaries from the terminal manager, prunes them for persistence, and writes the combined state through the low-level project-state writer. If the revision has moved, the save fails with a conflict and the browser refetches authoritative state.

Server code that needs to notify the UI about a task-scoped board change should prefer a lightweight runtime stream message, such as `task_title_updated`, and let the browser apply and persist that board change through the normal save path.

### Applying authoritative project state

Authoritative project snapshots enter the browser through `applyAuthoritativeProjectState(...)` in `web-ui/src/hooks/project/project-sync.ts`. That function reconciles session truth, projects runtime state onto the `in_progress`/`review` columns, decides whether to hydrate from server state or keep a cached board, and tells the persistence layer whether the next save should be skipped.

## Configuration and Persistence

Different state lives in different places on purpose.

| State | Where it lives | Why |
| --- | --- | --- |
| selected agent, global prompt shortcuts, Quarterdeck prompt templates | global runtime config | these are cross-project Quarterdeck preferences |
| project shortcuts, default base ref, pinned branches | project config under the project state directory | these are project-scoped preferences |
| board columns and cards | project `board.json`, written by the browser save path | the board is durable product state |
| task runtime summaries | terminal runtime memory plus project `sessions.json` | runtime session truth is server-owned |
| git metadata | streamed project metadata | it is refreshed by runtime policy instead of browser polling |

### State directory layout

Persistent runtime state lives under `~/.quarterdeck/` in the user's home directory by default. Tests and isolated runs can override that root with `QUARTERDECK_STATE_HOME`. Current project config also lives under this state home; repo-local `.quarterdeck/config.json` is a legacy location that is migrated into the state directory.

```
~/.quarterdeck/
├── config.json                          # global runtime config
├── worktrees/                           # task worktree checkouts
│   └── <task-id>/
│       └── <repo-name>/                 # isolated git worktree for the task
├── trashed-task-patches/                # saved patches from deleted tasks
└── projects/                            # per-project persistent state
    ├── index.json                       # maps project ids to repo paths
    └── <project-id>/
        ├── board.json                   # columns, cards, prompts, settings
        ├── config.json                  # project shortcuts and defaults
        ├── pinned-branches.json         # optional pinned branch order
        ├── sessions.json                # session summaries (PIDs, state, timestamps)
        └── meta.json                    # revision counter and last-updated timestamp
```

Project state is keyed by a generated project id stored in `projects/index.json`, with a reverse mapping from repository path to project id. When you run Quarterdeck against `/Users/you/projects/myapp`, the project is indexed by its canonical git root path, and its state lands in `~/.quarterdeck/projects/<project-id>/`. Moving or recloning a repo changes the path identity unless the project index/state is migrated.

## Design Rules

These are the architectural rules that are most important to preserve.

- one concern should have one clear source of truth
- keep `runtime-api.ts` as a coordinator, not a god file
- keep project-specific behavior behind project APIs, registry, and providers instead of ad hoc globals
- treat the browser as a client of streamed runtime state, not the source of truth for long-running sessions
- treat the browser as the writer for durable board changes when it is connected
- when adding new agent behavior, prefer capability-oriented reasoning over agent-specific branching

## Common Change Guide

When you are making a change, this table is often more useful than a file list.

| If you are changing... | Think about this first | Common mistake to avoid |
| --- | --- | --- |
| task startup for any agent | the PTY runtime and agent launch path | accidentally adding agent-specific special cases |
| live board updates | the runtime state hub and browser stream consumers | falling back to polling or duplicating summary logic |
| board persistence | browser `project.saveState`, revision conflicts, and session overlay | writing board state directly from server code |
| session lifecycle or transient session UI | terminal manager, transition controller, and reconciliation sweep | using terminal output timestamps as work-state truth |
| git metadata indicators | project metadata monitor and workdir git helpers | adding browser polling or unbounded git probes |

## What A New Engineer Should Expect

A new engineer opening this repo will probably notice a few things quickly:

- the backend is long-lived and stateful, not a thin stateless API server
- the browser is closer to a local control client than a traditional web app
- the task system, review system, and runtime system are tightly connected
- all agents use the same PTY-backed execution path
- project state and worktrees live outside the target repository by default
- the architecture favors clean ownership over compatibility glue

If you approach the code with those assumptions, the rest of the system starts to make sense much faster.
