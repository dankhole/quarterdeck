# Orphaned Process Investigation — 2026-04-07

## Summary

During routine use, we discovered orphaned processes from both the old Cline/kanban setup and the current quarterdeck runtime, revealing real process lifecycle bugs.

## Orphaned processes found and killed

### Cline/kanban zombie processes (killed with SIGKILL)

These were spawned by the Cline VS Code extension running the old kanban project in its own worktrees. They survived since Sunday and required `kill -9` — regular `kill` (SIGTERM) caused them to spike CPU without dying.

| PID | Type | Running since | Command | Why orphaned |
|-----|------|--------------|---------|--------------|
| 5606 | Kanban runtime server | Sunday 9PM | `node .cline/worktrees/330dd/kanban/src/cli.ts --no-open` | Cline spawned it in a worktree; Cline exited but server had no parent to signal shutdown |
| 68871 | Kanban runtime server | Sunday 9PM | `node .cline/worktrees/324e7/kanban/src/cli.ts --no-open` | Same — second Cline-managed worktree, same orphan pattern |
| 44578 | Hook ingest | Sunday 9PM | `node .cline/worktrees/12e78/kanban/dist/cli.js hooks ingest --event to_in_progress --source claude` | Hook fired by an agent; target runtime already gone, hung waiting |
| 51878 | Hook ingest | Sunday 6PM | `node .cline/worktrees/330dd/kanban/dist/cli.js hooks ingest --event to_in_progress --source claude` | Same — hook ingest from a different task, orphaned |

### Quarterdeck duplicate/orphaned processes (killed with SIGTERM)

| PID | Type | Running since | Command | Why orphaned |
|-----|------|--------------|---------|--------------|
| 73739 | Task agent | 5:39PM | `claude --settings ... are all kafka consumers split across all deploye` | Duplicate — same query as PID 43100, two processes for one task |
| 43100 | Task agent | 5:34PM | `claude --settings ... are all kafka consumers split across all deploye` | Duplicate of above |
| 30056 | Sidebar agent | 5:28PM | `claude --settings ... --append-system-prompt # Quarterdeck Sidebar` | Stale sidebar — should have been killed when 81341 replaced it |
| 81341 | Sidebar agent | 3:46PM | `claude --settings ... --append-system-prompt # Quarterdeck Sidebar` | Older sidebar session, also not cleaned up |

### Potentially stale terminal processes (still running, not killed)

| PID | Type | Running since | Notes |
|-----|------|--------------|-------|
| 26871 | Manual `claude` | Saturday 11PM | User only has 2 terminals open but 3 bare `claude` processes exist |
| 29258 | Manual `claude` | Monday 1PM | Same — one of these two is likely orphaned |

## Root cause analysis

### The SIGTERM-only problem

The fundamental issue across the codebase: **quarterdeck only sends SIGTERM, never escalates to SIGKILL.**

Zero uses of SIGKILL in the entire `src/` directory.

Key code paths:

1. **`terminatePtyProcess`** (`src/terminal/pty-session.ts:53-63`) — sends `pty.kill()` + `process.kill(-pid, "SIGTERM")` to the process group. No follow-up. If the process traps SIGTERM (Claude Code does this during API calls), it stays alive.

2. **`stopTaskSessionAndWaitForExit`** (`src/terminal/session-manager.ts:1013-1025`) — waits 5 seconds for the process to exit after SIGTERM, then silently returns without escalating. The caller proceeds as if the process died.

3. **Graceful shutdown** (`src/cli.ts:514`) — 10-second hard timeout. Calls `markInterruptedAndStopAll()` which sends SIGTERM to all processes, then `process.exit`. Any process still alive is orphaned.

### Sidebar session leak

**`use-home-agent-session.ts:285-293`** — the React unmount cleanup effect only clears in-memory refs, never calls `stopHomeAgentSession`. When the sidebar component unmounts (page nav, tab close, React re-render), the server-side agent process is orphaned. There's also no server-side detection of browser client disconnect.

### Duplicate task sessions

**`startTaskSession`** (`session-manager.ts:328-329`) — if a session entry is already in an active state, it returns early. Combined with the SIGTERM timeout issue, if a previous stop didn't actually kill the process, re-starting the same task silently returns the stale summary instead of force-replacing it. This may explain the duplicate kafka query processes.

### Stale process watchdog limitations

**`recoverStaleProcesses`** (`session-manager.ts:1151-1184`) — checks `isProcessAlive(pid)` every 30 seconds, but only checks the direct PTY child PID. Grandchild processes (e.g., the actual agent behind a wrapper) can survive undetected.

## Recommended fix

Add a SIGTERM -> wait -> SIGKILL escalation pattern:

```
1. Send SIGTERM to process group
2. Wait N seconds (e.g., 3-5s)
3. Check if process is still alive
4. If yes, send SIGKILL to process group
5. Verify death
```

Apply this pattern in:
- `terminatePtyProcess`
- `stopTaskSessionAndWaitForExit`
- Graceful shutdown handler
- Home agent session cleanup (server-side)

Additionally:
- Add `stopHomeAgentSession` call to the React unmount cleanup
- Add server-side detection of browser disconnect to clean up sidebar sessions
- Consider process tree killing for wrapper/grandchild scenarios