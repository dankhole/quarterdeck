# How the Terminal System Works (Plain English)

**Date**: 2026-04-13
**See also**: `terminal-architecture.md` for the full technical reference with file paths and line numbers.

---

## What are we even doing?

Quarterdeck runs AI agents (like Claude Code) and shows their output in a browser. The agents are command-line programs — they think they're running in a regular terminal, like Terminal.app or iTerm. Our job is to make the browser look and behave like that terminal.

This is harder than it sounds.

---

## The big picture

```
Claude Code thinks          Quarterdeck captures        Your browser pretends
it's in a normal     →      everything it writes   →    to be that terminal
terminal                    and forwards it
```

There are a lot of steps in between. Here they are, in order.

---

## Step 1: The fake terminal

**What's a PTY?**

PTY stands for "pseudo-terminal." It's a fake terminal that the operating system provides. When you open Terminal.app, your shell (zsh/bash) is connected to a PTY. The shell writes text to the PTY, and Terminal.app reads from the other end and draws it on screen.

We do the same thing, but instead of Terminal.app reading the output, our Node.js server reads it.

```
Claude Code  ──writes──►  PTY (fake terminal)  ──reads──►  Our server
```

Claude Code has no idea it's not in a real terminal. It sends the same text, colors, cursor movements, and screen redraws it would send to Terminal.app. This is important — we don't control what Claude Code sends. We just have to deal with whatever bytes come out.

**File**: `src/terminal/pty-session.ts`

---

## Step 2: Filtering out noise

Before anyone sees the output, we run it through a filter.

Some programs ask the terminal "what color are you?" by sending special byte sequences. Before a browser tab is connected, nobody can answer that question. So the filter intercepts these questions, sends back a hardcoded answer ("dark background, light text"), and strips the question from the output so downstream code never sees it.

Think of it as a secretary who answers routine mail before it reaches your desk.

**File**: `src/terminal/terminal-protocol-filter.ts`

---

## Step 3: Two copies of the truth

Here's where it gets interesting. After filtering, the output goes to **two places at once**:

### Copy 1: The server-side mirror

The server runs its own invisible terminal — no screen, no pixels, just a data model of what the terminal looks like. Every byte Claude Code writes gets fed into this invisible terminal. It processes all the cursor movements, colors, and screen clears, and maintains a model of "what the screen looks like right now."

Why? Because when you open a new browser tab, or your connection drops and reconnects, we need to send you "here's what the terminal looks like right now." The mirror is always ready with that answer. Without it, you'd see a blank screen until Claude Code happened to write something new.

**File**: `src/terminal/terminal-state-mirror.ts`

### Copy 2: The WebSocket to your browser

The same bytes also get sent over a network connection (WebSocket) to your browser, where your browser's copy of the terminal processes them and draws pixels.

**The problem**: The server mirror and your browser are two separate terminals processing the same data independently. They should agree on what the screen looks like, but there's no mechanism to check. If they disagree for any reason, things get weird.

---

## Step 4: The network connection

The server and browser communicate over two WebSocket connections per terminal:

**The data channel**: Raw bytes. Server sends terminal output, browser sends your keystrokes. This is the fast path — binary data, no overhead.

**The control channel**: JSON messages for everything else — "here's a snapshot to restore from," "the terminal is now 120 columns wide," "I've processed 4,096 bytes" (for flow control), "the session exited."

Why two? Mixing binary terminal data with JSON control messages in one channel would require framing and parsing overhead on every chunk. Separating them keeps the hot path (terminal output) as fast as possible.

**File**: `src/terminal/ws-server.ts`

### Flow control

Claude Code can produce output much faster than a browser can render it. If we just firehose bytes at the browser, the WebSocket buffer fills up and things break.

So we have a backpressure system: the browser sends "I processed N bytes" acknowledgments. If unacknowledged bytes pile up past a threshold, the server tells the operating system to pause the PTY. This literally stops the kernel from giving us more data from Claude Code, which eventually makes Claude Code itself slow down (it blocks on write).

---

## Step 5: The restore dance

When your browser first connects to a running agent (or reconnects after a drop), it needs to see what the terminal looks like right now, not a blank screen. This is the restore protocol:

1. **Server sends a snapshot** — the mirror serializes its entire state (what's on screen plus up to 10,000 lines of scroll history) and sends it on the control channel.
2. **Browser wipes its terminal** — calls `terminal.reset()`, which destroys everything: scrollback, cursor position, colors, all of it.
3. **Browser writes the snapshot** — the serialized state is written to the browser's terminal, which processes it and reconstructs the screen.
4. **Browser says "done"** — sends `restore_complete` to the server.
5. **Server flushes buffered output** — any bytes that Claude Code produced while the browser was applying the snapshot were held in a buffer. Now they're sent.

This is the most fragile part of the system. The hard wipe in step 2 causes a visible flash. If the snapshot is wrong or incomplete, the terminal looks broken until the next restore.

---

## Step 6: The browser terminal

Your browser runs its own copy of xterm.js — the same terminal emulator library, but with a real renderer attached (WebGL or canvas 2D).

### How it draws text

xterm.js doesn't draw text like a web page does. Instead of using the browser's text engine (which produces crisp, sub-pixel-antialiased text), it rasterizes glyphs (letter shapes) into a **texture atlas** — a big image containing every character it needs. Then it composites those pre-rendered characters onto a canvas.

This is fast (GPU-accelerated with WebGL), but the text looks slightly different from native browser text. That's why the agent's chat looks "chunkier" than, say, a `<div>` with the same font.

The texture atlas is **cached**. Once a glyph is rasterized, it's reused. This is great for performance, but it means the cache can go stale — if you move to a different monitor (different pixel density), the cached glyphs are now the wrong resolution, and text looks blurry.

### The persistence trick

When you switch between tasks, the terminal doesn't get destroyed and recreated. That would be expensive and lose state. Instead, the terminal's DOM element (the `<div>` containing the canvas) gets physically moved between containers.

Think of it like moving a TV from one room to another. The TV stays on, keeps showing the same picture — you just unplug it from one wall mount and plug it into another.

This is done with a "parking root" — a hidden div offscreen (`left: -10000px`). When a terminal isn't visible, its element lives there. When you select a task, the element is moved into the visible panel.

**The catch**: Moving a canvas element in the DOM can break the renderer. The cached glyph textures become stale, the canvas dimensions may be wrong for the new container. That's why we need the canvas repair sequence after every move.

### Canvas repair

After every DOM move, three things must happen:

1. **Fake a resize** — Tell the terminal it's one column narrower, then immediately resize back. This tricks the layout system into recalculating everything, because it ignores "resize to the same size" as a no-op.
2. **Clear the texture atlas** — Throw away all cached glyph images so they get re-rasterized at the right resolution for the current monitor.
3. **Repaint everything** — Redraw every visible row using the fresh textures.

**If any of these three steps is missing, the terminal looks broken.** This has been the #1 source of visual bugs. The "Reset terminal rendering" button was literally not doing anything until today because it was missing steps 2 and 3.

**File**: `web-ui/src/terminal/persistent-terminal-manager.ts`

---

## Step 7: React glues it together

A React hook (`usePersistentTerminalSession`) connects the React component lifecycle to the persistent terminal. When you select a task, the hook calls `mount()` to move the terminal into view. When you select a different task, it calls `unmount()` to park it. The terminal itself is never destroyed by React — the hook just moves it around.

**File**: `web-ui/src/terminal/use-persistent-terminal-session.ts`

---

## Why visual bugs happen

Most terminal visual bugs come from one of these root causes:

### 1. The canvas repair didn't run (or ran incompletely)

Something moved the terminal's canvas in the DOM, but the three repair steps didn't all execute. Text looks blurry, dimensions are wrong, or the content is stale. This is the most common cause.

### 2. The restore snapshot doesn't match reality

The server mirror and client terminal disagreed about what the screen looks like. A restore sent the server's version, which was different from what the client was showing. This can cause content to jump, duplicate, or disappear.

### 3. Scrollback filled up with duplicate content

Claude Code is a full-screen TUI app. It constantly redraws its entire screen. Each redraw sends "clear the screen and write this instead." If those clears push the old content into scrollback instead of discarding it, you get thousands of copies of the same conversation in your scroll history. We suppress this with a setting (`scrollOnEraseInDisplay: false`), but some types of screen transitions still leak through.

### 4. Monitor/DPR change without texture rebuild

You moved the browser window to a different monitor (e.g., Retina laptop to an external display). The terminal got resized for the new dimensions, but the cached glyph textures are still rendered at the old pixel density. Text looks blurry until something triggers a texture atlas clear.

### 5. WebSocket dropped without recovery

One or both network connections broke. There's no automatic reconnection — the terminal just shows an error. The terminal's local state keeps diverging from the server's state with no way to sync back.

---

## Glossary

| Term | What it means |
|------|---------------|
| **PTY** | Pseudo-terminal. A fake terminal provided by the OS. Programs think they're talking to Terminal.app; really they're talking to our server. |
| **xterm.js** | JavaScript terminal emulator library. Runs in the browser. Interprets the same escape sequences that Terminal.app does. |
| **Headless xterm** | Same library but without a renderer. Processes bytes and maintains a data model, but draws nothing. Used on the server for the mirror. |
| **WebGL renderer** | xterm.js's GPU-accelerated text renderer. Fast but text looks slightly different from native browser text. |
| **Canvas 2D renderer** | xterm.js's fallback renderer using the browser's 2D drawing API. Slower but crisper text. |
| **Texture atlas** | A cached image containing pre-rasterized letter shapes. Fast to composite but goes stale when pixel density changes. |
| **DPR** | Device Pixel Ratio. How many physical pixels per CSS pixel. Retina displays are 2x, external monitors are often 1x. Text rendered at the wrong DPR looks blurry. |
| **ED2** | "Erase In Display" — a terminal escape sequence meaning "clear the whole screen." Claude Code sends this constantly to redraw its TUI. |
| **Alternate screen buffer** | A separate screen buffer that full-screen TUI apps use. When Claude Code starts, it switches to the alternate buffer. When it exits, it switches back and the original content reappears. Like a layer in Photoshop. |
| **Scrollback** | The lines above the visible terminal viewport that you can scroll up to see. Like scrolling up in Terminal.app to see old output. |
| **Parking root** | A hidden offscreen div where terminal elements live when they're not visible. The "backstage" area. |
| **Restore** | The process of sending a snapshot of the server's terminal state to the browser, wiping the browser's state, and writing the snapshot. Like force-refreshing the terminal. |
| **Backpressure** | Flow control that slows down the data source (the agent) when the consumer (the browser) can't keep up. Like a dam on a river. |
