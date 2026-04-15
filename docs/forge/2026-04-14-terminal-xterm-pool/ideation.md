---
project: terminal-xterm-pool
date: 2026-04-14
status: ideation
---

# Ideation: Terminal xterm Pool

## Goal

Replace the per-task `PersistentTerminal` architecture with a fixed pool of 4 xterm+WebGL slots that swap between tasks, capping GPU resource usage at 4 slots worth (briefly 5 during proactive rotation) regardless of how many tasks are opened.

## Behavioral Change Statement

> **BEFORE**: Each task opened creates its own `PersistentTerminal` (xterm + WebGL + sockets). 8 tasks = 8 WebGL contexts, hitting browser limits. IO suspend/resume manages which sockets are active.
> **AFTER**: 4 fixed `TerminalSlot` instances exist for the browser tab's lifetime (briefly 5 during proactive rotation). Slots connect/disconnect from tasks on demand. PREVIOUS keeps IO open for instant switch-back. Mouseover preloads into FREE slots.
> **SCOPE**: Task terminal rendering only. Home shell and task dev shells are excluded (dedicated instances, not pooled).

## Functional Verification Steps

1. **Task switch**: Click task A, then task B -> A's slot becomes PREVIOUS (IO stays open), B gets a slot and renders. Currently: creates a new PersistentTerminal.
2. **Switch-back**: Click task A again -> instant (no restore round-trip, buffer is current from PREVIOUS). Currently: fast-path visibility toggle but may need restore.
3. **Mouseover preload**: Hover over task C -> FREE slot connects, starts restore. Click -> instant mount. Mouse away without clicking -> disconnect after 3s timeout.
4. **5+ tasks**: Open tasks A-E -> only 4 slots exist. Eviction follows priority: PRELOADING first, then READY. ACTIVE/PREVIOUS never evicted.
5. **Project switch**: Switch projects -> all slots disconnect + reset to FREE, no xterm disposal.
6. **Slot rotation**: After 3 minutes, oldest FREE slot is replaced with a fresh instance (new xterm+WebGL). Non-FREE slots skip rotation.
7. **Regression -- home shell**: Home shell terminal still works independently, not affected by pool.
8. **Regression -- dev shells**: Task dev shells still work independently, not affected by pool.

## Scope

- **IN**: TerminalSlot class, TerminalPool manager, consumer wiring, deletion of PersistentTerminal/registry/IO-suspend code
- **OUT**: Home shell, dev shells, server-side ws-server.ts, scrollback configuration

## Key Requirements

- Fixed 4 slots, 10K scrollback matching server mirror
- clientId stays per-slot (identifies browser viewer, not task)
- PREVIOUS keeps IO open; FREE has no sockets
- Mouseover warmup no-ops for ACTIVE/PREVIOUS tasks
- Eviction: PRELOADING -> READY -> never ACTIVE/PREVIOUS
- Proactive 3-minute rotation of oldest FREE slot

## Constraints

- Server's ws-server.ts already handles new IO/control socket connections per (connectionKey, clientId) pair -- no server changes needed
- Existing mount/unmount visibility toggle logic carries over to TerminalSlot

## Open Questions for Research

- Exact socket setup/teardown sequences in PersistentTerminal to extract into connectToTask/disconnectFromTask
- All consumer call sites that reference the registry or PersistentTerminal
- Current IO suspend/resume code paths to delete

## Design Reference

Full design document: `docs/terminal-xterm-pool-strategy.md`
