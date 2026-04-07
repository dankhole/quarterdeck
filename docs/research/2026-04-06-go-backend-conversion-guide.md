# Research: Go Backend Conversion Guide

**Date**: 2026-04-06
**Branch**: HEAD (detached)

## Research Question

Document everything in the Quarterdeck Node.js/TypeScript backend needed to rewrite it in Go: all API routes, PTY/terminal management, state persistence, hook/event system, CLI commands, WebSocket protocols, git worktree management, configuration, dependencies, and agent adapters.

## Summary

The Quarterdeck backend is a Node.js server (~15k lines of TypeScript across 50+ files in `src/`) that orchestrates AI coding agents via PTY processes in isolated git worktrees. It exposes 34 tRPC procedures over HTTP, 3 raw WebSocket endpoints for real-time state streaming and terminal I/O, and a CLI with subcommands for hooks and task management. State is persisted as JSON files under `~/.quarterdeck/` with file-system locks for concurrency control. The system is architecturally well-suited for Go: it's primarily process orchestration, file I/O, and WebSocket streaming with a pure-function state machine at its core.

This document is organized as a reference for building the Go equivalent module-by-module.

---

## 1. HTTP Server & API Layer

### Server Setup

**File:** `src/server/runtime-server.ts`

- Node.js `http.createServer()` on configurable host/port (default `127.0.0.1:3484`)
- tRPC served via `@trpc/server/adapters/standalone` at `/api/trpc/*`
- Static web UI assets served for all non-`/api/` paths (SPA fallback to `index.html`)
- Three WebSocket upgrade paths handled on the `upgrade` event:
  - `/api/runtime/ws` -- runtime state stream
  - `/api/terminal/io` -- binary PTY I/O
  - `/api/terminal/control` -- JSON terminal control messages

**Go equivalent:** `net/http` with a mux (stdlib `http.ServeMux` or `chi`). WebSocket upgrades via `gorilla/websocket` or `nhooyr.io/websocket`. Static file serving via `http.FileServer`.

### tRPC Context

Each HTTP request carries context (`src/trpc/app-router.ts:122-231`):
- `requestedWorkspaceId` -- from `x-quarterdeck-workspace-id` header or `workspaceId` query param
- `workspaceScope` -- resolved `{ workspaceId, workspacePath }` or null
- Four API surface objects: `runtimeApi`, `workspaceApi`, `projectsApi`, `hooksApi`

**Go equivalent:** Middleware that extracts workspace ID from header/query, resolves scope, injects into `context.Context`.

### Middleware

One middleware: `workspaceProcedure` -- enforces workspace scope is present. Returns 400 if missing, 404 if workspace not found.

### All API Routes (34 procedures)

#### Runtime Router (9 procedures)

| Procedure | Method | Workspace Required | Description |
|-----------|--------|-------------------|-------------|
| `runtime.getConfig` | GET | No | Load runtime config (agent selection, shortcuts, prompt templates) |
| `runtime.saveConfig` | POST | No | Save config fields (all optional) |
| `runtime.startTaskSession` | POST | Yes | Create worktree + spawn agent PTY |
| `runtime.stopTaskSession` | POST | Yes | Kill agent PTY session |
| `runtime.sendTaskSessionInput` | POST | Yes | Write text to agent PTY stdin |
| `runtime.startShellSession` | POST | Yes | Spawn interactive shell PTY |
| `runtime.runCommand` | POST | Yes | Run command synchronously, return stdout/stderr/exitCode |
| `runtime.resetAllState` | POST | No | Debug: delete all `~/.quarterdeck` state |
| `runtime.openFile` | POST | No | Open file in system editor |

**Key request/response shapes:**

`startTaskSession` input:
```
{ taskId, prompt, images?: [{id, data, mimeType, name?}], startInPlanMode?, mode?: "act"|"plan",
  resumeFromTrash?, baseRef, useWorktree?, cols?, rows? }
```

`startTaskSession` output:
```
{ ok, summary: TaskSessionSummary | null, error? }
```

`getConfig` output:
```
{ selectedAgentId, selectedShortcutLabel, agentAutonomousModeEnabled, debugModeEnabled?,
  effectiveCommand, globalConfigPath, projectConfigPath, readyForReviewNotificationsEnabled,
  detectedCommands: string[], agents: AgentDefinition[], shortcuts: ProjectShortcut[],
  commitPromptTemplate, openPrPromptTemplate, commitPromptTemplateDefault, openPrPromptTemplateDefault }
```

#### Workspace Router (20 procedures, all require workspace scope)

| Procedure | Method | Description |
|-----------|--------|-------------|
| `workspace.getGitSummary` | GET | Git sync summary (branch, ahead/behind, changed files). Optional task scope. |
| `workspace.runGitSyncAction` | POST | Git fetch/pull/push on workspace |
| `workspace.checkoutGitBranch` | POST | Switch to a git branch |
| `workspace.discardGitChanges` | POST | `git restore` + `git clean` |
| `workspace.getChanges` | GET | File diffs for a task (working_copy or last_turn mode) |
| `workspace.ensureWorktree` | POST | Create git worktree for task if missing |
| `workspace.deleteWorktree` | POST | Delete task's git worktree (saves patch first) |
| `workspace.getTaskContext` | GET | Workspace info for a task (path, branch, HEAD, detached state) |
| `workspace.searchFiles` | GET | Fuzzy file search in workspace |
| `workspace.listFiles` | GET | List all files in task's worktree |
| `workspace.getFileContent` | GET | Read single file from worktree |
| `workspace.getState` | GET | Full workspace state snapshot (board + sessions + git + revision) |
| `workspace.notifyStateUpdated` | POST | Trigger WebSocket broadcast of current state |
| `workspace.saveState` | POST | Save board + sessions with optimistic concurrency |
| `workspace.getWorkspaceChanges` | GET | File changes for home workspace (not task-scoped) |
| `workspace.getGitLog` | GET | Commit history with optional ref filter, pagination |
| `workspace.getGitRefs` | GET | List git branches/remotes with ahead/behind |
| `workspace.getCommitDiff` | GET | File-level diff for a specific commit |
| `workspace.regenerateTaskTitle` | POST | LLM-generated title from prompt + response |
| `workspace.updateTaskTitle` | POST | Manually set task title (1-200 chars) |

**Optimistic concurrency on saveState:**
- Input includes optional `expectedRevision`
- If mismatch with stored revision, returns HTTP 409 CONFLICT with `currentRevision`
- On success, revision increments by 1

#### Projects Router (4 procedures, no workspace required)

| Procedure | Method | Description |
|-----------|--------|-------------|
| `projects.list` | GET | All registered projects with task counts |
| `projects.add` | POST | Register project by path, optionally `git init` |
| `projects.remove` | POST | Remove project (stops sessions, deletes worktrees, cleans state) |
| `projects.pickDirectory` | POST | Open native OS folder picker |

#### Hooks Router (1 procedure)

| Procedure | Method | Description |
|-----------|--------|-------------|
| `hooks.ingest` | POST | Ingest agent hook event (to_review, to_in_progress, activity) |

Input: `{ taskId, workspaceId, event: "to_review"|"to_in_progress"|"activity", metadata?: { activityText?, toolName?, toolInputSummary?, finalMessage?, hookEventName?, notificationType?, source? } }`

---

## 2. WebSocket Protocols

### 2.1 Runtime State Stream (`/api/runtime/ws`)

**Connection:** `ws://host:port/api/runtime/ws?workspaceId=<id>`
**Direction:** Server -> Client only (client sends nothing)

**Message types** (JSON, discriminated on `type` field):

| Type | Payload | When Sent |
|------|---------|-----------|
| `snapshot` | `{ currentProjectId, projects[], workspaceState, workspaceMetadata }` | On connection (first message) |
| `workspace_state_updated` | `{ workspaceId, workspaceState }` | Board/session state changes |
| `task_sessions_updated` | `{ workspaceId, summaries[] }` | Batched every 150ms from PTY activity |
| `projects_updated` | `{ currentProjectId, projects[] }` | Project list changes |
| `workspace_metadata_updated` | `{ workspaceId, workspaceMetadata }` | Periodic git metadata refresh |
| `task_ready_for_review` | `{ workspaceId, taskId, triggeredAt }` | Agent signals completion |
| `error` | `{ message }` | Error conditions |

**Go implementation notes:**
- One goroutine per client writing JSON messages
- Session summaries need 150ms batching (collect into map, flush on timer)
- Clients scoped to workspace ID; broadcast only to relevant clients

### 2.2 Terminal I/O (`/api/terminal/io`)

**Connection:** `ws://host:port/api/terminal/io?workspaceId=<id>&taskId=<id>&clientId=<id>`

- **Server -> Client:** Raw binary PTY output chunks (not JSON)
- **Client -> Server:** Raw binary input forwarded to PTY stdin
- **Batching:** 4ms interval for output; immediate send for chunks <= 256 bytes if idle >= 5ms
- **Backpressure:** Two-level -- WebSocket buffer (16KB high / 4KB low water mark) + application-level acknowledgment (100KB unacked high / 5KB low)
- **Multi-viewer:** One PTY fans output to N browser tabs, each with independent backpressure state. PTY is paused (fd read suspended) only when ANY viewer is backpressured, resumed when ALL have caught up.

### 2.3 Terminal Control (`/api/terminal/control`)

**Connection:** `ws://host:port/api/terminal/control?workspaceId=<id>&taskId=<id>&clientId=<id>`

**Client -> Server:**
| Message | Fields | Effect |
|---------|--------|--------|
| `resize` | `{ cols, rows, pixelWidth?, pixelHeight? }` | Resize PTY |
| `stop` | `{}` | Stop task session |
| `output_ack` | `{ bytes }` | Acknowledge received output (flow control) |
| `restore_complete` | `{}` | Client applied restore snapshot, flush pending output |

**Server -> Client:**
| Message | Fields | When |
|---------|--------|------|
| `state` | `{ summary }` | Session state changed |
| `exit` | `{ code }` | PTY process exited |
| `restore` | `{ snapshot, cols?, rows? }` | On connect, serialized terminal state for reconnection |
| `error` | `{ message }` | Error |

---

## 3. PTY / Terminal Management

### 3.1 PTY Session Spawning

**File:** `src/terminal/pty-session.ts`

- Uses `node-pty` with `encoding: null` (raw `Buffer` I/O)
- Default `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=quarterdeck`
- Default terminal size: 120x40 if not specified
- Process group kill on terminate: `process.kill(-pid, "SIGTERM")`

**Go equivalent:** `github.com/creack/pty` for PTY allocation. `os/exec.Cmd` for process spawning. `syscall.Kill(-pid, syscall.SIGTERM)` for process group termination.

### 3.2 Session State Machine

**File:** `src/terminal/session-state-machine.ts`

States: `idle`, `running`, `awaiting_review`, `failed`, `interrupted`

**Transition table:**

| Current | Event | Next | Review Reason |
|---------|-------|------|---------------|
| `running` | `hook.to_review` | `awaiting_review` | `"hook"` |
| `awaiting_review` (reason: attention/hook/error) | `hook.to_in_progress` | `running` | null |
| `awaiting_review` (reason: attention/hook/error) | `agent.prompt-ready` | `running` | null |
| `running` | `interrupt.recovery` | `awaiting_review` | `"attention"` |
| any | `process.exit` (code=0) | `awaiting_review` | `"exit"` |
| any | `process.exit` (code!=0) | `awaiting_review` | `"error"` |
| any | `process.exit` (interrupted) | `interrupted` | `"interrupted"` |

Guard: `canReturnToRunning` only allows resume from review reasons `"attention"`, `"hook"`, or `"error"` -- NOT from `"exit"` or `"interrupted"`.

**Go equivalent:** Pure function `func reduceTransition(state, event) -> (newState, reviewReason)`. This is the simplest part to port.

### 3.3 Session Manager

**File:** `src/terminal/session-manager.ts`

- Tracks sessions in `Map<taskId, SessionEntry>`
- Each `SessionEntry` holds: summary, active process state, terminal state mirror, listeners, restart config
- **Auto-restart:** On process exit, re-spawns if not suppressed and under rate limit (max 3 per 5 seconds)
- **Stale process watchdog:** 30-second interval polls `isProcessAlive(pid)`, forcibly transitions dead sessions
- **Interrupt recovery:** Ctrl+C/Escape during `running` triggers 5-second timer -> `awaiting_review` with reason `"attention"`
- **Listener system:** `attach(taskId, listener)` returns detach function. Listeners have `onOutput`, `onState`, `onExit` callbacks.
- **Global summary listener:** `onSummary(cb)` fires on every session state change across all tasks

### 3.4 Server-Side Terminal Emulation

**File:** `src/terminal/terminal-state-mirror.ts`

- Uses `@xterm/headless` + `@xterm/addon-serialize` (10,000 line scrollback)
- Mirrors all PTY output server-side for session restore on reconnect
- `getSnapshot()` serializes full terminal state (screen + scrollback) as a string

**Go equivalent:** `github.com/ActiveState/vt10x` or `github.com/hinshun/vt10x` for VT100 parsing. Custom serialization for restore snapshots. This is the hardest component to replicate with full xterm compatibility.

### 3.5 Terminal Protocol Filter

**File:** `src/terminal/terminal-protocol-filter.ts`

- Intercepts OSC 10/11 color queries from TUI apps, synthesizes dark-theme responses
- Handles incomplete escape sequences split across PTY output chunks
- Disabled once a live browser terminal connects

### 3.6 Agent Adapters

**File:** `src/terminal/agent-session-adapters.ts`

Strategy pattern: each agent has a `prepare(input) -> PreparedAgentLaunch` function returning modified args, env, cleanup callbacks, and optional output transition detectors.

**Claude adapter:**
- Sets `FORCE_HYPERLINK=1`
- Autonomous: `--dangerously-skip-permissions`
- Plan mode: `--allow-dangerously-skip-permissions --permission-mode plan`
- Resume: `--continue`
- Writes Claude `settings.json` with hook definitions for `Stop`, `SubagentStop`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `UserPromptSubmit`
- All hooks call `quarterdeck hooks ingest --event <event>`
- Sets `QUARTERDECK_HOOK_TASK_ID`, `QUARTERDECK_HOOK_WORKSPACE_ID` env vars

**Codex adapter:**
- Autonomous: `--dangerously-bypass-approvals-and-sandbox`
- Resume: `resume --last`
- Wraps binary with `quarterdeck hooks codex-wrapper` for hook event detection
- Plan mode: deferred input via bracketed paste `/plan <prompt>`
- Output transition detector: watches for `> ` prompt pattern

**Gemini adapter:**
- Autonomous: `--yolo`
- Resume: `--resume latest`
- Plan mode: `--approval-mode=plan`
- Hooks via `settings.json` with `BeforeTool`, `AfterTool`, `AfterAgent`, `BeforeAgent`, `Notification`
- Prompt: `-i <prompt>`

**OpenCode adapter:**
- Resume: `--continue`
- Plan mode: `OPENCODE_EXPERIMENTAL_PLAN_MODE=true` + `--agent plan`
- Hooks via JavaScript plugin file (`quarterdeck.js`)
- Prompt: `--prompt <prompt>`

**Workspace trust auto-confirm:**
- Claude: detects "trust this folder" prompt, auto-sends `\r` after 100ms (only within Quarterdeck worktrees dir)
- Codex: detects "do you trust the contents" prompt, always auto-confirms

---

## 4. State Persistence

### 4.1 Directory Layout

```
~/.quarterdeck/                               # QUARTERDECK_STATE_HOME override
+-- config.json                          # Global config
+-- worktrees/                           # Git worktrees for agent tasks
|   +-- <taskId>/
|       +-- <repoFolderName>/            # Actual git worktree
+-- trashed-task-patches/                # Saved patches from deleted worktrees
|   +-- <taskId>.<commitSHA>.patch
+-- workspaces/
    +-- index.json                       # Master index: repoPath <-> workspaceId
    +-- .workspaces.lock                 # Root-level lock
    +-- <workspaceId>/
    |   +-- board.json                   # Board columns + cards + dependencies
    |   +-- sessions.json                # Task session summaries
    |   +-- meta.json                    # { revision, updatedAt }
    +-- <workspaceId>.lock               # Per-workspace lock
```

### 4.2 Board Schema (`board.json`)

```json
{
  "columns": [
    {
      "id": "backlog|in_progress|review|trash",
      "title": "Backlog|In Progress|Review|Trash",
      "cards": [
        {
          "id": "<5-char-hex>",
          "title": "<string|null>",
          "prompt": "<string>",
          "startInPlanMode": false,
          "autoReviewEnabled": false,
          "autoReviewMode": "commit|pr|move_to_trash",
          "images": [{ "id": "<string>", "data": "<base64>", "mimeType": "<string>", "name": "<string>" }],
          "baseRef": "<git-ref>",
          "useWorktree": true,
          "createdAt": 1712400000000,
          "updatedAt": 1712400000000
        }
      ]
    }
  ],
  "dependencies": [
    { "id": "<uuid>", "fromTaskId": "<id>", "toTaskId": "<id>", "createdAt": 1712400000000 }
  ]
}
```

### 4.3 Sessions Schema (`sessions.json`)

```json
{
  "<taskId>": {
    "taskId": "<string>",
    "state": "idle|running|awaiting_review|failed|interrupted",
    "mode": "act|plan|null",
    "agentId": "claude|codex|gemini|opencode|null",
    "workspacePath": "<string|null>",
    "pid": 12345,
    "startedAt": 1712400000000,
    "updatedAt": 1712400000000,
    "lastOutputAt": 1712400000000,
    "reviewReason": "attention|exit|error|interrupted|hook|null",
    "exitCode": 0,
    "lastHookAt": 1712400000000,
    "latestHookActivity": {
      "activityText": "<string|null>",
      "toolName": "<string|null>",
      "toolInputSummary": "<string|null>",
      "finalMessage": "<string|null>",
      "hookEventName": "<string|null>",
      "notificationType": "<string|null>",
      "source": "<string|null>"
    },
    "warningMessage": "<string|null>",
    "latestTurnCheckpoint": { "turn": 1, "ref": "<git-ref>", "commit": "<sha>", "createdAt": 1712400000000 },
    "previousTurnCheckpoint": null
  }
}
```

### 4.4 Meta Schema (`meta.json`)

```json
{ "revision": 42, "updatedAt": 1712400000000 }
```

### 4.5 Workspace Index (`index.json`)

```json
{
  "version": 1,
  "entries": {
    "<workspaceId>": { "workspaceId": "<id>", "repoPath": "/absolute/path" }
  },
  "repoPathToId": {
    "/absolute/path": "<workspaceId>"
  }
}
```

Workspace IDs: lowercase folder name, NFKD-normalized, non-alphanumeric -> hyphens, collision suffix (4-char random).

### 4.6 File Locking

Uses `proper-lockfile` (lockfile-based advisory locks):
- Stale threshold: 10 seconds
- Retry: 200 attempts, 25-50ms backoff
- Deadlock prevention: locks sorted by path before acquisition
- Atomic writes: temp file + rename

**Go equivalent:** `github.com/gofrs/flock` for file locks. Atomic writes via `os.CreateTemp` + `os.Rename`.

### 4.7 Optimistic Concurrency

- `meta.json` holds integer `revision` counter
- `saveState` accepts optional `expectedRevision`
- Mismatch -> 409 CONFLICT with `currentRevision`
- Success -> revision++

---

## 5. Hook / Event System

### 5.1 Events

Three events (`src/core/api-contract.ts:851`):

| Event | Guard | Effect |
|-------|-------|--------|
| `to_review` | `state === "running"` | -> `awaiting_review` (reason: `"hook"`), capture turn checkpoint, broadcast `task_ready_for_review` |
| `to_in_progress` | `state === "awaiting_review"` AND reason in `[attention, hook, error]` | -> `running` |
| `activity` | none | Update `latestHookActivity` metadata only, no state transition |

### 5.2 Transport

Agents call `quarterdeck hooks ingest --event <event>` (or `quarterdeck hooks notify` for best-effort). The CLI:
1. Reads `QUARTERDECK_HOOK_TASK_ID` and `QUARTERDECK_HOOK_WORKSPACE_ID` from env
2. Creates tRPC HTTP client to `http://127.0.0.1:3484/api/trpc`
3. Calls `hooks.ingest` mutation with 3-second timeout

### 5.3 Agent-Specific Hook Integrations

**Claude:** Native hook system. Writes `settings.json` with hooks for Stop, SubagentStop, PreToolUse, PostToolUse, etc. Hooks receive JSON on stdin.

**Codex:** `codex-wrapper` subcommand wraps the real binary. Session log watcher polls JSONL file every 200ms, maps Codex events to Quarterdeck events.

**Gemini:** `gemini-hook` subcommand reads JSON from stdin, maps Gemini events (AfterAgent -> to_review, BeforeAgent -> to_in_progress), spawns detached notification process.

**OpenCode:** JavaScript plugin file implements full OpenCode plugin contract, calls `quarterdeck hooks ingest`.

### 5.4 Metadata Enrichment

`normalizeHookMetadata()` extracts structured fields from raw hook payloads:
- `source` -- inferred from payload structure
- `hookEventName` -- original hook name
- `toolName`, `activityText`, `finalMessage`, `notificationType`

---

## 6. CLI Commands

### 6.1 Main Command (`quarterdeck`)

- Starts HTTP server, opens browser
- Options: `--host`, `--port <number|auto>`, `--no-open`, `--skip-shutdown-cleanup`
- Auto-port retry on EADDRINUSE when `--port auto`
- Detects existing running server and opens browser to it

### 6.2 Task Command (`quarterdeck task`)

| Subcommand | Description |
|------------|-------------|
| `task list` | List tasks (JSON). Options: `--project-path`, `--column` |
| `task create` | Create task in backlog. Required: `--prompt`. Options: `--base-ref`, `--start-in-plan-mode`, `--auto-review-enabled`, `--auto-review-mode` |
| `task update` | Update task fields. Required: `--task-id` |
| `task start` | Start task session. Required: `--task-id` |
| `task trash` | Move to trash. Options: `--task-id` or `--column` for bulk |
| `task delete` | Permanently remove task(s) |
| `task link` | Create dependency between two tasks |
| `task unlink` | Remove dependency link |

All commands return JSON. Some operate on state files directly, others call tRPC.

### 6.3 Hooks Command (`quarterdeck hooks`)

| Subcommand | Description |
|------------|-------------|
| `hooks ingest` | Ingest hook event (fails on error) |
| `hooks notify` | Best-effort hook notification (never throws) |
| `hooks codex-wrapper` | Wraps Codex binary with session log watcher |
| `hooks gemini-hook` | Reads Gemini hook JSON from stdin |

---

## 7. Git Worktree Management

### 7.1 Worktree Creation

**File:** `src/workspace/task-worktree.ts`

Path: `~/.quarterdeck/worktrees/<taskId>/<repoFolderName>/`

Flow:
1. Resolve `baseRef` to commit SHA via `git rev-parse --verify <ref>^{commit}`
2. Check for saved patch from prior deletion
3. Acquire per-repo lock (`quarterdeck-task-worktree-setup.lock` in git common dir)
4. `git worktree add --detach <path> <baseCommit>` (always detached HEAD, no branch)
5. Initialize submodules if `.gitmodules` exists
6. Symlink gitignored paths (e.g., `node_modules/`) from main repo
7. Apply saved patch if one exists (`git apply --binary --whitespace=nowarn`)

### 7.2 Worktree Deletion

1. Capture uncommitted work: `git diff --binary HEAD` + untracked file diffs
2. Save patch to `~/.quarterdeck/trashed-task-patches/<taskId>.<commit>.patch`
3. `git worktree remove --force <path>` (fallback: `git worktree prune` + `rm -rf`)
4. Prune empty parent dirs

### 7.3 Turn Checkpoints

**File:** `src/workspace/turn-checkpoints.ts`

Creates git commits capturing full working tree state (including uncommitted changes) without modifying HEAD or index:
1. Uses temporary `GIT_INDEX_FILE`
2. `git read-tree HEAD` -> `git add -A` -> `git write-tree` -> `git commit-tree`
3. Stored as `refs/quarterdeck/checkpoints/<base64url(taskId)>/turn/<N>`

### 7.4 Git Operations Summary

All git commands go through a `runGit` helper that:
- Sets `core.quotepath=false`
- Uses 10MB max buffer
- Strips git env vars (`GIT_DIR`, `GIT_WORK_TREE`, etc.) to prevent parent context leakage
- Returns structured `{ ok, stdout, stderr, exitCode }`

**Go equivalent:** `os/exec.Command("git", args...)` with custom `Cmd.Env` stripping git vars. Parse stdout directly.

Key git commands used (30+): worktree add/remove/prune, rev-parse, diff (name-status, numstat, binary), log, for-each-ref, status, fetch/pull/push, switch, restore/clean, ls-files, show, read-tree, write-tree, commit-tree, update-ref, submodule update, apply, init.

---

## 8. Board Mutations

**File:** `src/core/task-board-mutations.ts`

All mutations are pure functions operating on the board data structure:

| Mutation | Description |
|----------|-------------|
| `addTaskToColumn` | Create card, generate 5-char ID, prepend to column |
| `moveTaskToColumn` | Move card between columns, reorient dependencies |
| `updateTask` | Update card fields in place |
| `addTaskDependency` | Link two tasks (at least one must be in backlog) |
| `removeTaskDependency` | Remove link by ID |
| `trashTaskAndGetReadyLinkedTaskIds` | Trash + identify now-ready linked backlog tasks |
| `deleteTasksFromBoard` | Permanent removal + cleanup orphaned dependencies |

**Dependency rules:**
- At least one task must be in backlog, neither in trash
- `fromTaskId` = the waiter (backlog task), `toTaskId` = the dependency
- When a review task is trashed, linked backlog tasks become "ready" for auto-start

---

## 9. System Prompt Injection

**File:** `src/prompts/append-system-prompt.ts`

Only injected for the "home agent" sidebar panel (task ID pattern `__home_agent__:*`). Not injected into task agents in worktrees.

Prompt content:
- Declares the agent as a "board management helper, NOT a coding agent"
- **CRITICAL: NEVER edit/create/delete files**
- Full CLI reference for all `quarterdeck task` subcommands
- GitHub `gh` CLI guidance
- Agent-specific Linear MCP setup instructions

---

## 10. Configuration

**File:** `src/config/runtime-config.ts`

Two tiers:

**Global config** (`~/.quarterdeck/config.json`):
```json
{
  "selectedAgentId": "claude",
  "selectedShortcutLabel": null,
  "agentAutonomousModeEnabled": false,
  "readyForReviewNotificationsEnabled": true,
  "commitPromptTemplate": "...",
  "openPrPromptTemplate": "..."
}
```

**Project config** (`<repo>/.quarterdeck/config.json`):
```json
{ "shortcuts": [{ "label": "...", "command": "...", "icon": "..." }] }
```

Auto-detection on first run: scans PATH for installed agents, selects best (claude > codex).

---

## 11. External Dependencies & Go Equivalents

| Node.js Dependency | Purpose | Go Equivalent |
|-------------------|---------|---------------|
| `node-pty` | PTY allocation and process spawning | `github.com/creack/pty` |
| `@trpc/server` + `@trpc/client` | Type-safe RPC over HTTP | Custom HTTP handlers or `connect-go` |
| `ws` | WebSocket server | `gorilla/websocket` or `nhooyr.io/websocket` |
| `@xterm/headless` + `@xterm/addon-serialize` | Server-side terminal emulation + snapshots | `github.com/hinshun/vt10x` (partial; may need custom) |
| `zod` | Runtime schema validation | Struct tags + `go-playground/validator` |
| `commander` | CLI framework | `cobra` or `urfave/cli` |
| `proper-lockfile` | File-system advisory locks | `github.com/gofrs/flock` |
| `tree-kill` | Kill process tree | `syscall.Kill(-pid, sig)` (process groups) |
| `open` | Open URL in browser | `github.com/pkg/browser` or `exec.Command("open", url)` |
| `ora` | Terminal spinner | `github.com/briandowns/spinner` |
| `@modelcontextprotocol/sdk` | MCP server | Custom or `github.com/anthropics/mcp-go` |

---

## 12. Graceful Shutdown

**File:** `src/core/graceful-shutdown.ts`

- Handles SIGINT, SIGTERM, SIGHUP, SIGQUIT
- First signal: graceful shutdown with 10-second timeout
- Suppresses duplicate SIGINT within 750ms (npm/npx wrapper detection)
- Second different signal: force exit
- Exit codes: SIGHUP=129, SIGINT=130, SIGQUIT=131, SIGTERM=143

**Go equivalent:** `signal.Notify` + `context.WithTimeout`. Process group cleanup via `syscall.Kill(-pid, syscall.SIGTERM)` for each active PTY.

---

## Architecture & Patterns

### Key Design Decisions

1. **No database** -- all state is JSON files with file locks. This simplifies deployment (single binary) but requires careful lock ordering.

2. **Pure-function state machine** -- session transitions are a side-effect-free reducer. Easy to port and test.

3. **Strategy pattern for agents** -- each agent adapter is a prepare function returning modified launch config. New agents added by implementing the interface.

4. **Detached HEAD worktrees** -- avoids branch lock conflicts. Agents work on commits, not branches.

5. **Patch save/restore** -- uncommitted work survives worktree delete/recreate cycles.

6. **Multi-viewer fan-out** -- one PTY to N browser tabs with per-viewer backpressure.

7. **Dual WebSocket channels** -- binary I/O separated from JSON control for efficiency.

8. **Environment variable stripping** -- prevents parent git context from leaking into child processes.

### Go Architecture Recommendations

**Package layout suggestion:**
```
cmd/quarterdeck/          # CLI entry point (cobra)
internal/
  api/               # HTTP handlers + WebSocket endpoints
  board/             # Board data structures + mutations
  config/            # Configuration persistence
  git/               # Git command execution + worktree management
  hook/              # Hook event processing
  prompt/            # System prompt generation
  session/           # Session state machine + manager
  state/             # Workspace state persistence + locking
  terminal/          # PTY management, protocol filter, adapters
  ws/                # WebSocket server, fan-out, backpressure
pkg/
  api/               # Public API types (shared with potential client libraries)
```

**Concurrency model:**
- One goroutine per PTY session reading output
- One goroutine per WebSocket client writing messages
- Channel-based fan-out from PTY to viewers
- `sync.Mutex` for session map and state mutations
- File locks for persistent state

## Code References

- `src/core/api-contract.ts` -- All 867 lines define every data type in the system
- `src/trpc/app-router.ts:248-520` -- All 34 tRPC procedures
- `src/server/runtime-server.ts:132-233` -- HTTP + WebSocket server setup
- `src/terminal/session-state-machine.ts:1-92` -- Complete state machine (pure function)
- `src/terminal/session-manager.ts:228-1172` -- Session lifecycle management
- `src/terminal/pty-session.ts:86-104` -- PTY spawn
- `src/terminal/ws-server.ts:42-525` -- WebSocket terminal streaming + backpressure
- `src/terminal/terminal-state-mirror.ts:1-68` -- Server-side xterm
- `src/terminal/agent-session-adapters.ts:482-1055` -- All 4 agent adapters
- `src/state/workspace-state.ts:160-752` -- State persistence + concurrency
- `src/workspace/task-worktree.ts:430-600` -- Worktree lifecycle
- `src/workspace/turn-checkpoints.ts:32-92` -- Turn checkpoint system
- `src/workspace/get-workspace-changes.ts:366-498` -- Diff computation
- `src/workspace/git-sync.ts:249-385` -- Git sync operations
- `src/core/task-board-mutations.ts:161-637` -- Board mutation logic
- `src/commands/hooks.ts:317-747` -- Hook CLI + metadata enrichment
- `src/core/graceful-shutdown.ts:48-206` -- Signal handling

## Open Questions

1. **Server-side terminal emulation fidelity** -- xterm.js headless provides full xterm compatibility for restore snapshots. No Go library matches this. Options: (a) embed a headless xterm.js via wasm/cgo, (b) use a simpler VT parser and accept reduced restore fidelity, (c) write a custom xterm-compatible serializer.

2. **tRPC replacement** -- tRPC provides type-safe contracts shared between server and client. Options: (a) OpenAPI spec + code generation, (b) Connect/gRPC with protobuf, (c) plain HTTP with manually maintained TypeScript types for the frontend.

3. **Frontend type sharing** -- Currently the frontend imports types directly from `api-contract.ts`. A Go backend would need a way to keep frontend types in sync (code generation from OpenAPI/protobuf, or a shared schema file).

4. **Agent adapter complexity** -- Claude and OpenCode adapters write config files and hook scripts. These are tightly coupled to each agent's CLI interface and change frequently. Consider keeping adapter logic in a scripting layer or generating config files from Go templates.

5. **npm distribution** -- Currently distributed via `npx quarterdeck`. A Go binary would need a different distribution mechanism (homebrew, go install, GitHub releases, or a thin npm wrapper that downloads the binary).
