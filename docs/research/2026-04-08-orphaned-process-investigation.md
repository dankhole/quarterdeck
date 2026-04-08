# Orphaned Process Investigation

**Date**: 2026-04-08
**Status**: Initial investigation

## Incident

Four zombie processes from `.cline/worktrees/` were found still running days after their parent tasks ended:

| PID | Process | Running since | Notes |
|-----|---------|---------------|-------|
| 5606 | Runtime server (`.cline/worktrees/330dd/`) | Sunday 9PM | Spiked to 181% CPU on SIGTERM, required SIGKILL |
| 68871 | Runtime server (`.cline/worktrees/324e7/`) | Sunday 9PM | Spiked to 86% CPU on SIGTERM, required SIGKILL |
| 44578 | `hooks ingest --event to_in_progress` (`.cline/worktrees/12e78/`) | Sunday 9PM | Survived SIGTERM |
| 51878 | `hooks ingest --event to_in_progress` (`.cline/worktrees/330dd/`) | Sunday 6PM | Survived SIGTERM |

All were spawned by Cline (VS Code extension) in its own worktrees running the old `kanban` codebase. The processes were orphaned when Cline's tasks ended without signaling shutdown.

## Observed problems

### 1. Runtime servers don't exit when their parent dies

The runtime server has a graceful shutdown system (`src/core/graceful-shutdown.ts`) that listens for SIGINT, SIGTERM, SIGHUP, and SIGQUIT. But if the parent process (Cline, a terminal, etc.) simply disappears without sending a signal, the server has no way to know it should exit.

**Relevant code**: `src/core/graceful-shutdown.ts` handles signals but there's no heartbeat, no stdin EOF detection, and no parent-process liveness check.

### 2. SIGTERM caused CPU spike instead of clean exit

Both runtime servers spiked to high CPU on receiving SIGTERM instead of shutting down cleanly. This suggests the shutdown handler (`src/server/shutdown-coordinator.ts`) may enter a hot loop or block on I/O that no longer exists (e.g., writing to a workspace state file in a deleted worktree, or iterating over stale session state).

**Relevant code**: `shutdownRuntimeServer()` in `shutdown-coordinator.ts` loads workspace state, moves tasks to trash, deletes worktrees, and closes the HTTP server — any of these could hang if the filesystem state is stale.

### 3. Hook ingest processes survived SIGTERM

The `hooks ingest` command (`src/commands/hooks.ts`) makes an HTTP request to the runtime server. If the server is already gone, the request should fail and the process should exit. The fact that these survived SIGTERM suggests they may be stuck in a retry loop or the signal handler isn't wired up for the hooks subcommand.

**Relevant code**: `src/commands/hooks.ts` has signal forwarding logic (lines 723-744) but this is for forwarding signals to child processes, not for handling its own shutdown.

## Areas to investigate

### Parent liveness detection
- **Stdin EOF**: If quarterdeck is launched as a child process, stdin closing is a reliable signal the parent is gone. Could add a stdin watcher that triggers shutdown.
- **IPC channel**: The processes were launched with `--require shutdown-ipc-hook.cjs`, suggesting there's already an IPC-based shutdown mechanism. Investigate why it didn't fire — did Cline close the IPC channel? Did the hook fail silently?
- **Process group**: Check if quarterdeck should be using process groups so that when the parent dies, all children get signaled.

### Shutdown handler robustness
- Why does SIGTERM cause a CPU spike? Add timeouts to each phase of shutdown (state persistence, worktree cleanup, server close).
- Consider a hard deadline: if shutdown hasn't completed within N seconds, force exit.
- The `onSecondSignal` handler in `cli.ts` (line 539) does force exit — but only on a *second* signal. If the first signal's handler hangs, the process is stuck until someone sends another signal.

### Hook process lifecycle
- `hooks ingest` should have a timeout on its HTTP request to the runtime. If the runtime is gone, fail fast.
- Consider whether hook processes need their own signal handling beyond what they inherit.

### Stale worktree detection
- When shutdown-coordinator tries to clean up worktrees that no longer exist (because the parent worktree was deleted), does it hang or error gracefully?
