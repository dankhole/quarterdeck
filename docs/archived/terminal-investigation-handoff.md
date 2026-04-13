> **ARCHIVED** — Superseded by `docs/terminal-visual-bugs.md`, `docs/terminal-scrollback-and-history.md`, `docs/terminal-unfocused-task-strategy.md`

# Terminal Investigation Handoff

**Date**: 2026-04-13
**Context**: Architectural investigation into why the terminal system keeps producing visual bugs. Not a bug fix — the goal is understanding the system well enough to stop chasing symptoms.

## The problem

The terminal has had 11+ commits in 2 days, each fixing one symptom and creating another. The current symptoms — off-by-1 TUI positioning, stuck status bar artifacts, dimension mismatches after task switch — are just the latest round. The pattern suggests systemic issues, not isolated bugs.

## What was done in this session

### 1. Full architecture documentation

Wrote two docs covering the entire terminal pipeline from PTY to pixels:
- `docs/terminal-architecture.md` — technical reference with file paths, line numbers, data flow diagrams, and 9 known architectural tensions
- `docs/terminal-architecture-explained.md` — plain-English walkthrough assuming no terminal knowledge

### 2. Identified architectural tensions

The docs catalog 9 known issues. The ones most likely driving the visual bugs:

**Two independent terminal emulators with no sync verification.** Server mirror and client terminal process the same bytes independently with different settings. No mechanism to detect or correct drift.

**Every restore is a hard wipe.** `terminal.reset()` destroys all client state, then writes a snapshot that may have been serialized at different dimensions or in a different buffer state.

**Canvas repair is fragile and underdocumented.** Three specific xterm.js API calls must run together after every DOM move. Missing any one is a silent no-op. This was the #1 bug source — fixed in this session by extracting `repairRendererCanvas()` with a detailed doc comment explaining why each step is needed.

**DPR changes don't trigger texture atlas clear.** `listenForDprChange` calls `requestResize()` but not `repairRendererCanvas()`. Monitor switches get right dimensions but stale glyph textures.

**requestResize() marks epoch satisfied before confirming send.** If the control socket isn't open, the resize is silently dropped but future calls with the same dimensions are deduped. The PTY stays at stale dimensions.

### 3. Specific root cause for the off-by-1 bug

Documented in `docs/terminal-dimension-mismatch-investigation.md`. Two contributing factors:
1. SIGWINCH removal (d72fedc5) means Claude doesn't redraw on task switch when PTY dimensions haven't changed
2. requestResize epoch bug means resizes can be silently dropped

### 4. Code changes (committed on this branch)

- `33294afe` — Fixed `resetRenderer()` (was a no-op), extracted `repairRendererCanvas()`, added debug logging
- `59ef1f81` — Architecture docs
- `3eb4a191` — Dimension mismatch investigation doc

### 5. Key insight: scrollback is mostly pointless for agent terminals

Claude Code runs in the alternate screen buffer and handles its own scrolling. Our scrollback (10,000 lines on the server mirror) accumulates noise from alternate screen transitions, not useful conversation history. The restore snapshot sends all this noise over the wire on every reconnect. Reducing agent terminal scrollback to the minimum (100 lines) would eliminate most of the "duped convo" artifacts without any UX impact.

## What to do next

The investigation revealed that the terminal system's problems are structural, not surface-level. The architectural docs now make it possible to reason about the system as a whole rather than chasing individual symptoms.

Specific things to address, roughly in priority order:

1. **Fix the requestResize epoch bug** — concrete, well-understood, causes persistent dimension mismatches
2. **Fix DPR change to trigger canvas repair** — `listenForDprChange` needs to call `repairRendererCanvas()`, not just `requestResize()`
3. **Reduce agent terminal scrollback** — change from 10,000 to 100 lines for agent sessions on both server and client; keeps scroll events working but eliminates noise
4. **Consider whether the two-terminal architecture is worth keeping** — the server mirror exists for restore snapshots, but a raw byte ring buffer would be simpler, have zero drift, and eliminate the entire serialization layer

## Repo docs index

| Doc | What it covers |
|-----|---------------|
| `docs/terminal-architecture.md` | Full technical reference — every layer with file:line refs |
| `docs/terminal-architecture-explained.md` | Same system, plain English, no jargon |
| `docs/terminal-dimension-mismatch-investigation.md` | Root cause + fix plan for off-by-1 bug |
| `docs/terminal-scrollback-investigation.md` | Scrollback duplication root causes |
| `docs/terminal-rendering-investigation.md` | WebGL vs canvas 2D text quality |
