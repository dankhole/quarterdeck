# Claude terminal rendering plan

Status: investigated; recommended direction is staged dogfooding, not yet implemented.

## Decision

Use Claude Code's fullscreen renderer as the durable fix for redraw noise and scrollback presentation. Do not try to infer and remove redraw frames from the raw PTY byte stream.

Quarterdeck should first expose fullscreen rendering as an opt-in Claude setting. Once mouse input, selection, restore, and pooled-terminal behavior are stable in dogfood, it can become the default with an explicit classic-renderer escape hatch.

## Why the classic renderer cannot provide both clean redraws and native scrollback

Claude's classic terminal UI repeatedly clears and redraws the visible screen. Quarterdeck currently enables xterm's `scrollOnEraseInDisplay` behavior in both the browser viewport and the server-side headless mirror. That preserves lines erased by Claude so mouse-wheel history remains available, but it also promotes transient redraw frames into scrollback and produces duplicated or reflowed conversation fragments.

Turning `scrollOnEraseInDisplay` off removes those transient frames, but it also removes the native history users expect. A PTY filter is not a safe middle ground: redraw sequences can cross output chunks, depend on terminal width and cursor state, and contain real content that never receives a later replacement frame. The server mirror and browser would also have to make exactly the same filtering decisions for restoration to stay deterministic.

## Why fullscreen is the better ownership boundary

Claude's fullscreen renderer uses the terminal alternate screen and owns a virtualized conversation transcript. The input stays pinned at the bottom, only visible messages are rendered, and navigation happens inside Claude instead of relying on xterm's erase-generated history. This removes the need for Quarterdeck to reinterpret Claude's control sequences.

Quarterdeck's existing restore model is compatible with that boundary: the server mirror serializes the normal and alternate buffers plus active terminal modes, while the browser applies the serialized snapshot before replaying buffered live output. The pre-restore forced resize should remain so Claude renders the alternate viewport at the attached browser geometry before the snapshot is requested.

The separate `--ax-screen-reader` mode is not the primary presentation fix. It deliberately flattens decorations and animation for assistive technology; it is useful as an accessibility option or diagnostic fallback, but does not preserve the intended Claude TUI appearance.

## Proposed implementation

1. Add a global `claudeFullscreenEnabled` setting using the existing config/settings-form pattern. Start it disabled while the upstream feature remains a research preview.
2. When enabled, add `CLAUDE_CODE_NO_FLICKER=1` to Claude's launch environment. Keep the status-line setting independent so either renderer can run with or without Quarterdeck's injected status line.
3. Carry the selected renderer mode into the active terminal-session record. Fullscreen sessions should always use the real reported row count; disable Claude's detached 3x row multiplier for them because virtualized history belongs to Claude and extra hidden rows only create unnecessary resize/redraw work.
4. Keep the current browser/server terminal options aligned. Do not special-case `scrollOnEraseInDisplay` until fullscreen dogfood proves whether any normal-buffer output still needs it.
5. After dogfood, consider enabling fullscreen by default. Preserve a visible classic-renderer toggle and support the upstream `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` escape hatch for regressions.

## Validation gates

- New, resumed, restarted, pooled, parked, and reattached Claude sessions restore to the bottom without duplicated frames or a premature loading-overlay reveal.
- Trackpad and mouse-wheel scrolling, Page Up/Down, Ctrl+Home/End, and Claude's transcript search work through xterm mouse reporting.
- Text selection, copy/paste, links, permission prompts, and the optional Quarterdeck status line work in both short and tall terminals.
- Resizing while output is active, switching task terminals, detaching until the row policy changes, and restoring while the alternate screen is active do not lose visible output.
- Codex, Pi, home shell, and detail shell terminal behavior remains unchanged.
- Linux/macOS are dogfooded separately; Windows ConPTY keeps its existing same-size-resize caveat until native validation is available.

## Upstream references

- [Claude Code fullscreen mode](https://code.claude.com/docs/en/fullscreen)
- [Claude Code terminal configuration](https://code.claude.com/docs/en/terminal-config)
- [Claude Code environment variables](https://code.claude.com/docs/en/env-vars)
- [`CLAUDE_CODE_NO_FLICKER` introduced in Claude Code 2.1.89 on 2026-04-01](https://github.com/anthropics/claude-code/releases/tag/v2.1.89)
- [`/tui` and the persistent `tui` setting introduced in 2.1.110 on 2026-04-15](https://github.com/anthropics/claude-code/releases/tag/v2.1.110)
- [Screen-reader mode introduced in 2.1.208 on 2026-07-14](https://github.com/anthropics/claude-code/releases/tag/v2.1.208)
