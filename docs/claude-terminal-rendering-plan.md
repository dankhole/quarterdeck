# Claude terminal rendering

Current contract: fullscreen is the only supported Claude renderer. This document retains the rationale and launch/geometry constraints; current lifecycle rules live in [session lifecycle](./conventions/session-lifecycle.md).

## Decision

Use Claude Code's fullscreen renderer as the durable fix for redraw noise and scrollback presentation. Do not try to infer and remove redraw frames from the raw PTY byte stream.

Quarterdeck always launches Claude in fullscreen. The classic renderer and its Settings toggle have been removed; existing classic sessions must be restarted to adopt the supported renderer.

## Why the classic renderer cannot provide both clean redraws and native scrollback

Claude's classic terminal UI repeatedly clears and redraws the visible screen. Quarterdeck currently enables xterm's `scrollOnEraseInDisplay` behavior in both the browser viewport and the server-side headless mirror. That preserves lines erased by Claude so mouse-wheel history remains available, but it also promotes transient redraw frames into scrollback and produces duplicated or reflowed conversation fragments.

Turning `scrollOnEraseInDisplay` off removes those transient frames, but it also removes the native history users expect. A PTY filter is not a safe middle ground: redraw sequences can cross output chunks, depend on terminal width and cursor state, and contain real content that never receives a later replacement frame. The server mirror and browser would also have to make exactly the same filtering decisions for restoration to stay deterministic.

## Why fullscreen is the better ownership boundary

Claude's fullscreen renderer uses the terminal alternate screen and owns a virtualized conversation transcript. The input stays pinned at the bottom, only visible messages are rendered, and navigation happens inside Claude instead of relying on xterm's erase-generated history. This removes the need for Quarterdeck to reinterpret Claude's control sequences.

Quarterdeck's existing restore model is compatible with that boundary: the server mirror serializes the normal and alternate buffers plus active terminal modes, while the browser applies the serialized snapshot before replaying buffered live output. The pre-restore forced resize should remain so Claude renders the alternate viewport at the attached browser geometry before the snapshot is requested.

The separate `--ax-screen-reader` mode is not the primary presentation fix. It deliberately flattens decorations and animation for assistive technology; it requires the classic renderer and is not supported in Quarterdeck. Such launches fail with a clear configuration error rather than silently changing renderers.

## Launch and geometry contract

1. Every Claude launch receives `CLAUDE_CODE_NO_FLICKER=1` and `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=0`, overriding inherited classic preferences. `CLAUDE_CODE_SCROLL_SPEED` defaults to `3` while preserving explicit user values. Codex, Pi, and shell environments remain unchanged.
2. `--ax-screen-reader` or an enabled `CLAUDE_AX_SCREEN_READER` is rejected before spawning because Claude requires the classic renderer for that mode. `CLAUDE_CODE_ACCESSIBILITY` is only a screen-magnifier cursor aid and remains supported.
3. All terminals use their actual viewport rows. There is no renderer-mode state, detached row multiplier, or attach/detach-triggered geometry change. Explicit browser resize and pre-restore forced redraw remain.
4. The retired `claudeFullscreenEnabled` config field is ignored on load and omitted on the next save. No persisted session-state migration is needed. Do not switch managed Claude sessions to `/tui default`; Quarterdeck supports fullscreen only.
5. Terminal snapshots, normal/alternate-buffer serialization, restore ordering, and shared xterm scrollback options remain necessary for restore and other terminal surfaces. They are not classic-mode policy.

## Validation boundaries

- New, resumed, restarted, pooled, parked, and reattached Claude sessions restore to the bottom without duplicated frames or a premature loading-overlay reveal.
- Trackpad and mouse-wheel scrolling, Page Up/Down, Ctrl+Home/End, and Claude's transcript search work through xterm mouse reporting.
- Text selection, copy/paste, links, and permission prompts work in both short and tall terminals.
- Resizing while output is active, switching task terminals, detaching and reattaching, and restoring while the alternate screen is active do not lose visible output.
- Codex, Pi, home shell, and detail shell terminal behavior remains unchanged.
- Linux/macOS are dogfooded separately; Windows ConPTY keeps its existing same-size-resize caveat until native validation is available.

## Historical evidence

The [archived rollout receipts](./history/claude-terminal-rendering-evidence.md) record the isolated synthetic and authorized real-provider macOS runs that informed this choice, including the retired classic-mode experiments. They are candidate-specific historical evidence, not current cross-platform acceptance.

## Upstream references

- [Claude Code fullscreen mode](https://code.claude.com/docs/en/fullscreen)
- [Claude Code terminal configuration](https://code.claude.com/docs/en/terminal-config)
- [Claude Code environment variables](https://code.claude.com/docs/en/env-vars)
- [`CLAUDE_CODE_NO_FLICKER` introduced in Claude Code 2.1.89 on 2026-04-01](https://github.com/anthropics/claude-code/releases/tag/v2.1.89)
- [`/tui` and the persistent `tui` setting introduced in 2.1.110 on 2026-04-15](https://github.com/anthropics/claude-code/releases/tag/v2.1.110)
- [Screen-reader mode introduced in 2.1.208 on 2026-07-14](https://github.com/anthropics/claude-code/releases/tag/v2.1.208)
