> **ARCHIVED** — Superseded by `docs/terminal-visual-bugs.md`

# Terminal Rendering Investigation

**Date**: 2026-04-11
**Status**: WebGL toggle landed and active. HTML chat view experiment removed (see "Revisit HTML chat view concept" in todo.md).
**Branch**: `feat/terminal-hybrid-rendering` (working branch), landed on local `main`

## Problem Statement

The agent terminal chat text (rendered by xterm.js) looks noticeably worse than the Claude Code status bar at the bottom of the terminal. The status bar is rendered as native HTML text by the browser's text engine and appears crisp. The agent chat above it is rendered on a WebGL canvas by xterm.js and appears heavier/chunkier — especially on low-DPR external monitors.

This is a longstanding issue. The root cause is that xterm.js's WebGL renderer rasterizes glyphs into a texture atlas on an opaque canvas, which produces heavier strokes than the browser's native subpixel antialiasing pipeline (Core Text on macOS). No amount of font weight tuning can close this gap because the rendering pipelines are fundamentally different.

## Prior Art (before this investigation)

The codebase already had extensive history fighting this problem:

| Commit | What was tried | Outcome |
|--------|---------------|---------|
| `3508cc19` | Font weight 400 → 300 (Light) | Too thin |
| `df2cd2d0` | NL (no ligatures) font variant | Marginal improvement, not worth losing ligatures |
| `29042bed` | Font weight 300 → 350, re-enable ligatures | Better but still chunky vs native |
| `0a595037` | Configurable font weight setting | Landed (currently defaults to 325) |
| `8e652fb7` | Dispose/recreate WebGL addon for DPR changes | Fixed DPR-specific issue, not the general rendering gap |
| `b89edddb` | matchMedia DPR listener for monitor switching | Fixed monitor-switching blur |
| `98279309` | Wait for font readiness before terminal.open() | Fixed measurement issues |
| `c60f31cd` | Reverted configurable font family/size, kept Nerd Font | Simplified config surface |

Commit `df2cd2d0` explicitly acknowledged: *"the chunky appearance is an inherent limitation of canvas/WebGL text rendering vs native subpixel antialiasing"*.

## What We Built

### Option 1: WebGL Renderer Toggle

**Commit**: `623ec763` (on main)
**Config**: `terminalWebGLRenderer` (boolean, default `true`)
**Location**: Settings > Terminal > "Use WebGL renderer"

Lets users switch between xterm.js's WebGL renderer and its built-in canvas 2D renderer. The canvas 2D renderer uses the browser's `fillText()` API which renders text through a different pipeline than the WebGL texture atlas. Hypothesis: canvas 2D might produce crisper text because it's closer to native text rendering.

**Implementation**:
- Module-level `currentTerminalWebGLRenderer` flag in `persistent-terminal-manager.ts`
- `attachWebglAddon()` checks the flag and skips loading when disabled
- `setWebGLRenderer()` method on `PersistentTerminal` for live toggle (disposes/recreates addon)
- Exported `setTerminalWebGLRenderer()` applies to all live terminals
- `useEffect` in `App.tsx` applies on config change

**Status**: Landed, untested by user. Needs A/B comparison.

### Option 2: HTML Chat View (Experimental) — REMOVED

**Config**: `terminalChatViewEnabled` — removed from codebase
**Location**: Was in Settings > Terminal > "Experimental: HTML chat view"

This experiment was removed because the implementation was incomplete and noisy — it stripped ANSI formatting and read from xterm's buffer, but output was unreliable for full-screen TUIs like Claude Code. See "Revisit HTML chat view concept" in todo.md for the concept revisit note. The history below is preserved for context.

**Status**: Removed. Went through two iterations before removal.

#### Iteration 1: Streaming ANSI Accumulator (FAILED)

**Approach**: Subscribe to `PersistentTerminal.onOutputText`, feed raw terminal chunks into a streaming parser that:
1. Filters cursor-save/restore blocks (intended to strip status bar redraws)
2. Strips all remaining ANSI escape sequences
3. Collapses carriage-return line overwrites
4. Accumulates clean text lines
5. Renders in a scrollable `<pre>`-like `<div>` with the terminal's monospace font

**Files created**:
- `web-ui/src/terminal/chat-output-accumulator.ts` — the streaming parser
- `web-ui/src/hooks/use-chat-output.ts` — React hook bridging terminal output to state
- `web-ui/src/components/chat-output-view.tsx` — HTML text renderer with auto-scroll

**Why it failed**: Claude Code is a **full-screen TUI**, not a line-by-line CLI. It uses cursor positioning (`CSI H` sequences) for *all* output — not just the status bar. The cursor-save/restore filter was eating almost everything because the entire interface is drawn through positioned writes. After stripping, only one random line of text remained. The fundamental assumption (that chat content flows linearly and only the status bar uses cursor positioning) was wrong.

**File deleted**: `chat-output-accumulator.ts` (dead code after iteration 2)

#### Iteration 2: xterm Buffer Snapshot (CURRENT)

**Commit**: `044d3e1f` (on main)

**Approach**: Instead of parsing the raw stream, read from xterm.js's already-processed terminal buffer. xterm does all the hard work of interpreting escape sequences, cursor positioning, screen redraws, etc. We just read the rendered result.

**Implementation**:
- Added `readBufferLines()` method on `PersistentTerminal`:
  ```typescript
  readBufferLines(): string[] {
      const buffer = this.terminal.buffer.active;
      const totalLines = buffer.length;
      const result: string[] = [];
      for (let i = 0; i < totalLines; i++) {
          const line = buffer.getLine(i);
          result.push(line ? line.translateToString(true) : "");
      }
      return result;
  }
  ```
- `useChatOutput` hook subscribes to `onOutputText` events but only uses them as a trigger to re-snapshot the buffer (throttled at 100ms)
- Initial snapshot taken on mount so existing buffer content appears immediately
- `ChatOutputView` renders lines joined with `\n` in a scrollable div using the terminal's monospace font family, with auto-scroll (40px threshold from bottom)

**Status**: Landed on local main, **needs testing**. Unknown whether it produces usable output.

### Architecture: How the Chat View Is Wired

The chat view is driven by a **global settings toggle**, not a per-panel toggle. This is because the main agent terminal (`card-detail-view.tsx:431`) renders `AgentTerminalPanel` with `showSessionToolbar={false}` and no `onClose` — which means the layout renders no toolbar at all. A per-panel toggle was initially built but only appeared on shell terminals (which have the minimal header with close button), not on agent sessions where it's actually useful.

**Data flow**:
```
Settings > terminalChatViewEnabled
  → App.tsx reads from runtimeProjectConfig
  → passes chatViewEnabled prop to CardDetailView
  → CardDetailView passes to AgentTerminalPanel (main agent terminal only)
  → AgentTerminalPanel:
      - Always runs usePersistentTerminalSession (xterm stays alive)
      - Runs useChatOutput when chatViewEnabled is true
      - When chatViewEnabled: shows ChatOutputView, hides terminal at height:0
      - When disabled: shows terminal at height:100%, no ChatOutputView
```

The xterm.js terminal always receives data regardless of the setting — switching back to the normal terminal (by disabling the setting) preserves full scroll-back.

## Open Questions

1. **Does the buffer snapshot approach actually produce readable output?** The buffer includes the full screen state — visible rows plus scrollback. For Claude Code, this includes the status bar rows at the bottom. Need to see if the output is clean enough to be useful.

2. **Performance of full buffer reads**: `readBufferLines()` iterates all lines in the buffer (up to 10,000 scrollback). At 100ms throttle during active output, this could be expensive. May need to optimize (diff against previous snapshot, only read new lines, or reduce scrollback for the snapshot).

3. **Does disabling WebGL (option 1) actually look better?** Canvas 2D's `fillText()` might or might not produce noticeably crisper text. Need visual comparison.

4. **Status bar in buffer output**: The buffer snapshot will include the Claude Code status bar text in the last few rows. May want to trim those, but detecting them is tricky without the cursor-save/restore approach.

5. **Long-term direction**: If the HTML chat view works well, the natural evolution is to parse the buffer content into structured blocks (tool use, markdown, code, etc.) and render them with proper formatting. The buffer gives us clean text to work with — much better starting point than raw ANSI.

## Files Touched

| File | Purpose |
|------|---------|
| `src/config/global-config-fields.ts` | `terminalWebGLRenderer` + `terminalChatViewEnabled` config fields |
| `src/core/api-contract.ts` | Zod schemas for both fields |
| `web-ui/src/terminal/persistent-terminal-manager.ts` | `setWebGLRenderer()`, `readBufferLines()`, `setTerminalWebGLRenderer()` |
| `web-ui/src/App.tsx` | Live-apply effects for WebGL toggle, `chatViewEnabled` prop to CardDetailView |
| `web-ui/src/components/card-detail-view.tsx` | Passes `chatViewEnabled` to AgentTerminalPanel |
| `web-ui/src/components/detail-panels/agent-terminal-panel.tsx` | `chatViewEnabled` prop drives HTML vs terminal rendering |
| `web-ui/src/components/chat-output-view.tsx` | Scrollable HTML text renderer |
| `web-ui/src/hooks/use-chat-output.ts` | Buffer snapshot hook (throttled at 100ms) |
| `web-ui/src/components/runtime-settings-dialog.tsx` | Both settings toggles in Terminal section |
| `web-ui/src/runtime/use-runtime-config.ts` | Save type signatures |
| `web-ui/src/test-utils/runtime-config-factory.ts` | Test factory |
| `test/runtime/config/runtime-config.test.ts` | Test expectations |
