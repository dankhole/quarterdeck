# Agent CWD Mismatch Detection

Detect when a running agent's actual working directory diverges from the card's configured worktree path.

## Problem

When kanban spawns an agent, it sets the PTY's `cwd` to the resolved worktree path (or workspace root if `useWorktree` is false). The session summary records this as `workspacePath`. But if the agent `cd`s elsewhere during execution, kanban has no idea — the stored path is a snapshot from spawn time, never re-checked.

## Current state

- PID is already tracked in `RuntimeTaskSessionSummary` (`session-manager.ts`)
- `workspacePath` (the expected CWD) is already stored in the session summary
- No mechanism exists to read the agent's actual CWD at runtime

## Approach

### CWD lookup by platform

| Platform | Method | Notes |
|----------|--------|-------|
| Linux | `readlink /proc/<pid>/cwd` | Trivial, no dependencies |
| macOS | `lsof -d cwd -Fn -p <pid>` | Spawns a subprocess, output needs parsing |

Windows is not a supported platform for kanban (Unix PTYs, git worktrees, node-pty all assume Unix). Not worth investing in `NtQueryInformationProcess` unless that changes.

A future optimization on macOS would be a native N-API binding to `proc_pidinfo` from `libproc.h` (fast, no subprocess). There's precedent for native code since kanban already depends on node-pty. Overkill for now.

### Implementation outline

1. **Utility function** (`src/terminal/process-cwd.ts` or similar)
   - Input: PID
   - Output: absolute path string or null (process gone, permission denied, etc.)
   - Platform switch: `readlink` on Linux, `lsof` on macOS

2. **Exposure to the UI** — two options:
   - **Periodic poll**: Session manager checks every N seconds, adds a `cwdMismatch` boolean to the session summary, broadcast via WebSocket
   - **On-demand tRPC query**: UI calls an endpoint when rendering a card, compares result to `workspacePath`

   Periodic poll is simpler for the UI but adds background work. On-demand is lighter but requires the UI to manage timing.

3. **UI indicator** on the board card — an orange badge similar to the existing "No WT" tag, e.g. "CWD mismatch" with a tooltip showing the actual vs expected paths.

### Rough size estimate

- Utility function: ~20 lines
- tRPC endpoint or poll integration: ~30-50 lines
- UI badge: ~10 lines (copy the "No WT" pattern in `board-card.tsx`)

Small feature overall. The existing session summary -> WebSocket -> UI pipeline handles the plumbing.
