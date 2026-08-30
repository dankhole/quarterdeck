# Claude terminal rendering plan

Status: complete; fullscreen is the default with a visible classic-renderer escape hatch.

## Decision

Use Claude Code's fullscreen renderer as the durable fix for redraw noise and scrollback presentation. Do not try to infer and remove redraw frames from the raw PTY byte stream.

Quarterdeck exposes fullscreen rendering as the default Claude setting after deterministic and real-provider dogfood. Turning the setting off remains an explicit classic-renderer escape hatch for new or restarted sessions.

## Why the classic renderer cannot provide both clean redraws and native scrollback

Claude's classic terminal UI repeatedly clears and redraws the visible screen. Quarterdeck currently enables xterm's `scrollOnEraseInDisplay` behavior in both the browser viewport and the server-side headless mirror. That preserves lines erased by Claude so mouse-wheel history remains available, but it also promotes transient redraw frames into scrollback and produces duplicated or reflowed conversation fragments.

Turning `scrollOnEraseInDisplay` off removes those transient frames, but it also removes the native history users expect. A PTY filter is not a safe middle ground: redraw sequences can cross output chunks, depend on terminal width and cursor state, and contain real content that never receives a later replacement frame. The server mirror and browser would also have to make exactly the same filtering decisions for restoration to stay deterministic.

## Why fullscreen is the better ownership boundary

Claude's fullscreen renderer uses the terminal alternate screen and owns a virtualized conversation transcript. The input stays pinned at the bottom, only visible messages are rendered, and navigation happens inside Claude instead of relying on xterm's erase-generated history. This removes the need for Quarterdeck to reinterpret Claude's control sequences.

Quarterdeck's existing restore model is compatible with that boundary: the server mirror serializes the normal and alternate buffers plus active terminal modes, while the browser applies the serialized snapshot before replaying buffered live output. The pre-restore forced resize should remain so Claude renders the alternate viewport at the attached browser geometry before the snapshot is requested.

The separate `--ax-screen-reader` mode is not the primary presentation fix. It deliberately flattens decorations and animation for assistive technology; it is useful as an accessibility option or diagnostic fallback, but does not preserve the intended Claude TUI appearance.

## Implemented experiment boundary

1. The global `claudeFullscreenEnabled` setting defaults on and is exposed under Harnesses. It applies to new or restarted sessions; Quarterdeck's Claude minimum already exceeds the renderer environment variables' minimum versions.
2. Enabled Claude launches receive `CLAUDE_CODE_NO_FLICKER=1` and default `CLAUDE_CODE_SCROLL_SPEED` to `3` unless the user already set it; disabled launches receive `CLAUDE_CODE_NO_FLICKER=0` plus `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`. The explicit false works across the full 2.1.89+ preview range, while the newer force-classic variable also overrides a saved `/tui` preference. Codex, Pi, and shell sessions receive no renderer environment override. The status-line setting remains independent.
3. The selected launch mode is carried through the task-session request, active process record, startup resume, and automatic restart. The documented `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` escape hatch and Claude's actual screen-reader mode take precedence over the setting and select the matching classic row policy. The separate `CLAUDE_CODE_ACCESSIBILITY` screen-magnifier cursor aid does not change renderer mode. The state is runtime-only and requires no persisted session migration.
4. Fullscreen sessions always use real reported rows, including while detached. Classic Claude alone retains the detached 3x row multiplier for native scrollback history.
5. Browser and server terminal options remain aligned, and both renderer modes retain Claude's pre-restore forced resize. `scrollOnEraseInDisplay` is unchanged until dogfood establishes whether fullscreen normal-buffer output needs different treatment.
6. `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` remains an upstream environment-level escape hatch, and Quarterdeck logs when it overrides the enabled setting. The visible Quarterdeck switch retains the same classic renderer choice.

## Dogfood and rollout gates

- New, resumed, restarted, pooled, parked, and reattached Claude sessions restore to the bottom without duplicated frames or a premature loading-overlay reveal.
- Trackpad and mouse-wheel scrolling, Page Up/Down, Ctrl+Home/End, and Claude's transcript search work through xterm mouse reporting.
- Text selection, copy/paste, links, permission prompts, and the optional Quarterdeck status line work in both short and tall terminals.
- Resizing while output is active, switching task terminals, detaching until the row policy changes, and restoring while the alternate screen is active do not lose visible output.
- Codex, Pi, home shell, and detail shell terminal behavior remains unchanged.
- Linux/macOS are dogfooded separately; Windows ConPTY keeps its existing same-size-resize caveat until native validation is available.

## Rollout evidence

The default-on decision followed two isolated macOS Agent Lab passes on 2026-08-29. Deterministic run `claude-fullscreen-gates-20260829T145825Z-7ff1b6` covered fresh launch, working/crash automatic restart, cold runtime replacement, Trash/restore, pooled Files/Terminal detach and reattach, resize, and alternate-buffer restoration. Its first pass exposed that fake Claude did not honor the production fullscreen environment on replacement; the fake now enters the alternate screen on every qualifying launch, locking that recovery contract into the deterministic lane.

Authorized run `real-claude-fullscreen-fixed-20260829T151540Z-b36b4c` used one Haiku 4.5 turn through the configured Amazon Bedrock gateway. The actual Claude TUI remained in the alternate buffer across short/tall resize, virtualized mouse scrolling, pooled detach/reattach, graceful runtime replacement, and Trash/restore. Text selection produced a simulated clipboard write, the rendered URL exposed xterm's pointer link layer, and startup/restore logs contained only exact-resume `SessionStart` hooks with no replayed `UserPromptSubmit`. Snapshot `real-haiku-fullscreen-gates` completed without warnings; the final visual artifact is `browser/fullscreen-after-trash-restore.png` under that run.

The real run also hardened the unattended lane before the turn was spent: explicit gateway variables must cross the disposable supervisor boundary, and the isolated Claude profile must seed the non-secret completed-onboarding marker. Focused tests now cover both. The cross-platform row/launch policies remain automated; native Windows validation retains the documented ConPTY caveat and the classic switch is the immediate fallback.

A broader authorized pass in `claude-real-tui-audit-20260829T184012Z-9f4455` verified Claude Code 2.1.224 with three small Haiku 4.5 turns. Fullscreen mode covered the actual permission chooser, safe-command auto-approval, long output, links, Page Up/Down, narrow and tall resize, Files/Terminal detach and reattach, hard browser reload, and exact runtime resume without a replayed prompt or lost alternate buffer. Restarting the same session into classic mode rendered both resumed and fresh output cleanly at rest. Claude's detailed transcript was navigable with Shift+PageUp, but bare Page Up entered an empty provider-owned view until End returned to the bottom. Because xterm had no local scrollback at that point, the remaining behavior belongs to Claude's opt-in classic UI rather than a Quarterdeck redraw frame that can be removed safely. The final checkpoint completed without warnings and the lab stopped cleanly.

## Upstream references

- [Claude Code fullscreen mode](https://code.claude.com/docs/en/fullscreen)
- [Claude Code terminal configuration](https://code.claude.com/docs/en/terminal-config)
- [Claude Code environment variables](https://code.claude.com/docs/en/env-vars)
- [`CLAUDE_CODE_NO_FLICKER` introduced in Claude Code 2.1.89 on 2026-04-01](https://github.com/anthropics/claude-code/releases/tag/v2.1.89)
- [`/tui` and the persistent `tui` setting introduced in 2.1.110 on 2026-04-15](https://github.com/anthropics/claude-code/releases/tag/v2.1.110)
- [Screen-reader mode introduced in 2.1.208 on 2026-07-14](https://github.com/anthropics/claude-code/releases/tag/v2.1.208)
