---
project: terminal-xterm-pool
date: 2026-04-14
status: research
---

# Research: Terminal xterm Pool

## Codebase Research Summary

### Files to Modify

- `web-ui/src/terminal/persistent-terminal-manager.ts` — 1123-line `PersistentTerminal` class. Extract into `TerminalSlot`: xterm creation (L149-212), font waiting (L214-243), WebGL attach (L245-260), mount/unmount/visibility (L751-856), resize logic (L377-421), DPR handling (L423-447), canvas repair (L940-975), socket management (connectIo L449-511, connectControl L573-669, suspendIo L513-526). Key difference: taskId/workspaceId move out of constructor into connectToTask/disconnectFromTask.

- `web-ui/src/terminal/terminal-registry.ts` — 150-line module. Simple `Map<string, PersistentTerminal>` keyed by `workspaceId:taskId`. Replaced by `terminal-pool.ts`. Exports: ensurePersistentTerminal, disposePersistentTerminal, disposeAllPersistentTerminalsForWorkspace, warmupPersistentTerminal, cancelWarmupPersistentTerminal, writeToTerminalBuffer, isTerminalSessionRunning, resetAllTerminalRenderers, restoreAllTerminals, setTerminalFontWeight, setTerminalWebGLRenderer, dumpTerminalDebugInfo.

- `web-ui/src/terminal/use-persistent-terminal-session.ts` — 199-line hook. Calls ensurePersistentTerminal (L105) and disposePersistentTerminal (L73, L86). Must switch to pool's acquireForTask. Registers terminal controller per taskId (L166).

- `web-ui/src/App.tsx` — Warmup handlers at L236-247. Must switch to pool.warmup/cancelWarmup.

- `web-ui/src/hooks/use-project-switch-cleanup.ts` — L39: disposeAllPersistentTerminalsForWorkspace. Must change to pool.releaseAll().

- `web-ui/src/hooks/use-terminal-config-sync.ts` — Imports setTerminalFontWeight, setTerminalWebGLRenderer from registry.

- `web-ui/src/components/settings/display-sections.tsx` — L283: resetAllTerminalRenderers(), L301: restoreAllTerminals().

- `web-ui/src/components/debug-log-panel.tsx` — L18/L194: dumpTerminalDebugInfo().

- `web-ui/src/hooks/use-terminal-panels.ts` — L23: isTerminalSessionRunning, writeToTerminalBuffer from registry. Used for home/dev shells.

### Context Files (read-only)

- `web-ui/src/terminal/terminal-socket-utils.ts` — generateTerminalClientId(), getTerminalWebSocketUrl(). Used unchanged by TerminalSlot.
- `web-ui/src/terminal/terminal-geometry-registry.ts` — reportTerminalGeometry(taskId), clearTerminalGeometry(taskId). Slot must track current taskId.
- `web-ui/src/terminal/terminal-controller-registry.ts` — Per-taskId registration stays in the hook.
- `web-ui/src/terminal/terminal-options.ts` — createQuarterdeckTerminalOptions(), TERMINAL_FONT_SIZE, TERMINAL_PRIMARY_FONT.
- `web-ui/src/state/card-actions-context.tsx` — Passes onTerminalWarmup/onTerminalCancelWarmup through context. No changes needed.
- `web-ui/src/components/board-card.tsx` — Fires warmup/cancelWarmup on mouseenter/mouseleave. No changes.
- `src/terminal/ws-server.ts` — Server creates per-(connectionKey, clientId) viewer state. Handles reconnection automatically.

### Server-Side Viewer State Model

When connectToTask opens new sockets:
1. **IO socket** (ws-server.ts:432-472): Server gets (connectionKey=workspaceId:taskId, clientId). Creates/replaces viewer state's ioSocket. If previous IO socket exists for same clientId on a different task, that's a different connectionKey — server creates new viewer state.
2. **Control socket** (ws-server.ts:474-564): Server resets restoreComplete=false, clears pendingOutputChunks, sends restore snapshot immediately.

### Constraints Discovered

1. **Subscriber re-wiring**: When slot swaps tasks, existing subscribers receive callbacks for the new task. Hook must resubscribe or slot must clear subscribers on disconnect.
2. **Terminal geometry registry**: Reports geometry keyed by taskId. Slot must track current taskId and clearTerminalGeometry on disconnect.
3. **Terminal controller registry**: Independent of pool — hook owns this registration per taskId.
4. **writeToTerminalBuffer / isTerminalSessionRunning**: Used by use-terminal-panels.ts for home/dev shell auto-restart. Pool must expose equivalents.
5. **No server changes needed**: Confirmed by reading ws-server.ts L424-564.
