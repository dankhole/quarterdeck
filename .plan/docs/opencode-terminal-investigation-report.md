# OpenCode Terminal Investigation Report

Date: March 11, 2026

Purpose: capture the full investigation that finally explained why `opencode` would not render in Kanban's bottom terminal, after several days of debugging across `xterm`, `node-pty`, websocket transport, and frontend bundling.

## Executive summary

The final root cause was not `node-pty`, not the raw websocket bridge, and not OpenCode itself.

The blocking failure was in the production frontend bundle:

- OpenCode probes terminal modes during startup
- that hit xterm's DECRQM `requestMode` path
- our production build emitted broken xterm code in that path
- the browser threw `ReferenceError: n is not defined`
- xterm stopped parsing the startup stream, so OpenCode never painted its TUI

The fix that made OpenCode render reliably was:

- disable frontend minification in [web-ui/vite.config.ts](/Users/saoud/Repositories/kanban/web-ui/vite.config.ts:11)

This investigation also uncovered a real startup race around `OSC 11` background color probing. That was a legitimate issue and worth fixing, but it was not the last blocker. The last blocker was the broken production xterm bundle.

## Original symptom

User report:

- recent xterm and `node-pty` work improved the terminal generally
- `opencode` stopped working in the bottom terminal
- sometimes raw escape output was visible, such as `OSC 11` related output
- later, after partial fixes, typing `opencode` appeared to do nothing and the TUI never showed up

Observed behaviors during debugging:

- raw `OSC 11` replies sometimes leaked visibly
- after suppressing those leaks, `opencode` could still remain blank
- regular shell commands like `echo hi` worked fine in the same terminal

## Reference set used during investigation

Main Kanban files inspected:

- [web-ui/src/terminal/use-terminal-session.ts](/Users/saoud/Repositories/kanban/web-ui/src/terminal/use-terminal-session.ts)
- [web-ui/src/terminal/terminal-options.ts](/Users/saoud/Repositories/kanban/web-ui/src/terminal/terminal-options.ts)
- [src/terminal/ws-server.ts](/Users/saoud/Repositories/kanban/src/terminal/ws-server.ts)
- [src/terminal/session-manager.ts](/Users/saoud/Repositories/kanban/src/terminal/session-manager.ts)
- [src/terminal/pty-session.ts](/Users/saoud/Repositories/kanban/src/terminal/pty-session.ts)
- [src/core/api-contract.ts](/Users/saoud/Repositories/kanban/src/core/api-contract.ts)

Reference projects inspected:

- `/Users/saoud/Repositories/xterm-references/web-terminal-poc`
- `/Users/saoud/Repositories/xterm-references/vscode`
- `/Users/saoud/Repositories/xterm-references/xterm.js`

Most useful reference files:

- `/Users/saoud/Repositories/xterm-references/web-terminal-poc/public/index.html`
- `/Users/saoud/Repositories/xterm-references/web-terminal-poc/server.mjs`
- `/Users/saoud/Repositories/xterm-references/web-terminal-poc/README.md`
- `/Users/saoud/Repositories/xterm-references/vscode/src/vs/workbench/contrib/terminal/browser/xterm/xtermTerminal.ts`
- `/Users/saoud/Repositories/xterm-references/xterm.js/src/common/InputHandler.ts`

## Investigation timeline

### 1. First hypothesis: PTY transport or `node-pty` corruption

This was the initial suspicion because the recent work touched terminal transport, batching, xterm wiring, and `node-pty`.

What we checked:

- server websocket output path
- server websocket input path
- PTY output history replay
- resize plumbing
- environment variables sent to the shell and agents

What we found:

- PTY output was being forwarded as raw buffers
- user input was being forwarded back as raw bytes or UTF-8 strings as expected
- nothing obvious in the transport path was converting escape bytes into visible `^[` text by itself

Conclusion:

- the transport layer did not look like the primary failure

### 2. Confirm OpenCode's startup expectations directly in a raw PTY

A dedicated `node-pty` harness was used to spawn `opencode` directly outside the web app.

What OpenCode emitted first:

```text
ESC ] 11 ; ? BEL
```

This means OpenCode starts by querying the terminal background color via `OSC 11` and waits for a reply.

Key finding:

- replying to that `OSC 11` probe was enough to unblock OpenCode and make it continue its startup sequence in the raw PTY harness

After replying, OpenCode emitted a much richer stream including:

- alternate screen enter
- mouse mode setup
- mode queries
- color palette queries
- full 24-bit color paint output

Conclusion:

- OpenCode is terminal-probe heavy
- `OSC 11` support matters immediately at startup
- the app did need to answer that probe coherently

### 3. Real issue found on the server side: startup probe race

A real race existed in Kanban's terminal session flow.

What was happening:

- OpenCode could emit the initial `OSC 11;?` probe before the browser terminal was fully attached
- PTY output history stored the raw probe before the frontend was listening
- OpenCode then waited for a reply that never came

Fixes added in the session manager during the investigation:

- detect and filter `OSC 11;?` from PTY output
- immediately synthesize an `OSC 11` background reply back into the PTY input stream
- apply the same filtering and reply behavior during output history replay on attach

Relevant file:

- [src/terminal/session-manager.ts](/Users/saoud/Repositories/kanban/src/terminal/session-manager.ts)

Conclusion:

- this was a real issue
- it explained some earlier blank-terminal cases and the raw escape leaks
- it was necessary, but it still did not fully fix the problem in the bottom terminal

### 4. Verified the bottom terminal still failed even after `OSC 11` handling

At this point:

- regular shell commands worked in the bottom terminal
- `opencode` still showed a blank screen after startup

A Playwright-based browser repro was used against the live app.

Results:

- `echo hi` rendered correctly
- typing `opencode` left the terminal visually blank
- the websocket path was still receiving large binary frames after `opencode` started

This was a major turning point.

Conclusion:

- the PTY was alive
- the websocket bridge was delivering output
- the remaining failure had to be in the browser-side xterm layer or its bundle

### 5. Reference projects pointed at the browser terminal layer

The `web-terminal-poc` reference was especially useful because it explicitly argued against relying on `AttachAddon` for native-feeling terminals.

Key notes from the reference:

- custom websocket integration instead of `AttachAddon`
- `terminal.write(data, callback)` used for backpressure and parsed-write acknowledgment
- explicit `onBinary` handling for mouse and raw terminal data
- output batching and flow control treated as first-class concerns

This gave a good direction, but it still was not the exact root cause.

Important lesson from the references:

- our suspicion should stay focused on the browser terminal stack, not the PTY

### 6. Critical live-browser clue: actual xterm runtime exception

A Playwright run against the served app captured browser-side errors while launching `opencode`.

This revealed the first hard browser exception:

```text
ReferenceError: n is not defined
    at gZ.requestMode (.../assets/index-B5AYENPi.js:215:103689)
```

That was the smoking gun.

Meaning:

- xterm was not merely failing to render
- xterm was crashing while parsing OpenCode's mode query traffic
- the specific crash happened inside xterm's `requestMode` implementation

This fit OpenCode's behavior perfectly because OpenCode uses DECRQM mode queries during startup.

### 7. Confirmed xterm source itself was fine

The xterm source in `node_modules` and the xterm reference repo was inspected.

Relevant source:

- `/Users/saoud/Repositories/xterm-references/xterm.js/src/common/InputHandler.ts`
- `requestMode(params, ansi)`

That source was correct and did not reference an undefined variable.

The same logic in `web-ui/node_modules/@xterm/xterm/lib/xterm.mjs` was also inspected and was still valid.

Conclusion:

- xterm's shipped source was not broken
- the breakage had to be happening during production bundling/minification

### 8. Inspected the broken production bundle

The generated production bundle in `web-ui/dist/assets` was searched directly.

The emitted `requestMode` implementation contained this pattern:

```js
requestMode(e,r){(S=>(S[S.NOT_RECOGNIZED=0]="NOT_RECOGNIZED",S[S.SET=1]="SET",S[S.RESET=2]="RESET",S[S.PERMANENTLY_SET=3]="PERMANENTLY_SET",S[S.PERMANENTLY_RESET=4]="PERMANENTLY_RESET"))(void 0||(n={}));
```

That expression attempts to evaluate `n` even though `n` is not defined in that scope.

This directly explains the runtime exception:

```text
ReferenceError: n is not defined
```

Conclusion:

- the production bundle was corrupting xterm's `requestMode` helper
- the corruption occurred during frontend build/minification
- OpenCode reliably triggered that broken code path because it queries terminal modes like `2026`

## Root cause

The root cause was a frontend production build incompatibility between our build pipeline and the xterm version we ship.

More specifically:

- Kanban was using `@xterm/xterm@6.0.0`
- the production build minified the xterm bundle in a way that corrupted the `requestMode` helper
- OpenCode's startup queries exercised that exact code path
- xterm threw a runtime exception and stopped parsing the TUI startup stream

Evidence that supports this conclusion:

- raw PTY harness worked once `OSC 11` was answered
- websocket frames continued arriving in the browser during failure
- browser stack trace pointed into minified xterm `requestMode`
- `node_modules` xterm source was correct
- generated production bundle was incorrect
- rebuilding without minification removed the browser error and OpenCode rendered successfully

## Why earlier fixes helped but were not sufficient

### `OSC 11` filtering and reply synthesis

This fixed a real startup issue.

Without it:

- OpenCode could block waiting for a background-color reply
- history replay could preserve the unanswered probe
- raw escape output could become visible in the UI

But even after that was fixed, the browser-side xterm parser still crashed on DECRQM mode queries. That is why the terminal could still look blank.

### Richer terminal options and compatibility shims

The work to add richer terminal settings was still useful:

- `windowOptions`
- Unicode 11
- pixel-aware resize
- `TERM_PROGRAM=kanban`

These changes made the terminal environment more coherent and more native-feeling, but they did not address the production bundle crash.

One speculative piece from the investigation was later removed:

- a frontend addon that fabricated replies for OSC special color queries `13` through `19`

That addon was useful as an experiment, but it was not part of the actual OpenCode fix and risked advertising terminal behavior we had not fully validated. The current code keeps the richer terminal options and Unicode support, but no longer injects those speculative OSC replies.

### `AttachAddon` suspicion

The reference POC was right that `AttachAddon` is not ideal for a top-tier native-feeling terminal. It is still a good follow-up area.

However, the blocking issue here was more fundamental:

- even a perfect transport layer would not fix a parser crash in the minified xterm bundle

## Final fix

The fix that made OpenCode work in the shipped app was:

- disable frontend minification in [web-ui/vite.config.ts](/Users/saoud/Repositories/kanban/web-ui/vite.config.ts:11)

Current config:

```ts
build: {
  // esbuild minification corrupts xterm's DECRQM requestMode helper in the
  // production bundle, which breaks full-screen TUIs like OpenCode at runtime.
  minify: false,
},
```

Why this works:

- it prevents the broken transformation of xterm's `requestMode` helper
- the production bundle preserves the valid xterm logic
- OpenCode's mode queries no longer crash the parser
- the TUI startup stream is fully processed and rendered

## Post-fix cleanup

After OpenCode was rendering again, the terminal stack was cleaned up to keep only the parts that proved their value.

What stayed:

- production `minify: false` in [web-ui/vite.config.ts](/Users/saoud/Repositories/kanban/web-ui/vite.config.ts:14)
- pixel-aware resize through websocket control messages and `node-pty`
- centralized xterm options in [web-ui/src/terminal/terminal-options.ts](/Users/saoud/Repositories/kanban/web-ui/src/terminal/terminal-options.ts)
- `Unicode11Addon`
- `TERM_PROGRAM=kanban`

What changed after the initial fix:

- the backend `OSC 11` workaround was narrowed so it only covers startup and history replay
- once a live terminal listener attaches, the backend stops filtering live PTY output for `OSC 11`
- the speculative frontend OSC special-color compatibility addon was removed

Why the `OSC 11` workaround still exists:

- OpenCode can send its background-color query before the browser terminal is attached
- that startup race was real and reproducible
- solving it in early PTY output and replay avoids the blank-terminal wait state without permanently rewriting live terminal traffic

## Rows and cols vs pixel dimensions

The resize work now carries both:

- `rows` and `cols`
- `pixelWidth` and `pixelHeight`

This is intentional.

`rows` and `cols` are still the core PTY size because terminal layout is fundamentally cell-based:

- wrapping
- cursor movement
- scrolling regions
- alternate screen behavior
- fullscreen TUI layout

Pixel dimensions are extra geometry metadata, not a replacement for the character grid. They help with richer terminal reporting and better feature parity, but the PTY still needs `rows` and `cols` as the primary resize contract.

## Validation performed

### Backend and unit-level validation

Before the final bundle fix, the following validations were already passing:

- `npm test`
- `npm run typecheck`
- `npm --prefix web-ui test`
- `npm run web:typecheck`

These covered:

- probe handling in the session manager
- pixel-aware resize plumbing
- terminal options behavior

### End-to-end production validation

After disabling minification and rebuilding:

- `npm run web:build`
- `npm run web:typecheck`

Then a Playwright repro against the served app at `http://127.0.0.1:3484/kanban` confirmed:

- no browser `pageerror`
- `opencode` rendered in the bottom terminal
- terminal rows contained actual OpenCode TUI content

Representative post-fix result:

- `rowCount: 18`
- visible TUI text including the OpenCode interface and status content
- no `ReferenceError` in the browser

### Validation after cleanup

After narrowing the backend `OSC 11` handling and removing the speculative frontend OSC addon, the following still held:

- session-manager tests passed
- web terminal options tests passed
- backend and frontend typechecks passed
- a browser repro still showed `opencode` rendering correctly in the bottom terminal with no page errors

## Things this investigation ruled out

These were plausible but ultimately not the final root cause:

- `node-pty` byte corruption
- websocket transport dropping startup frames
- simple missing `OSC 11` support as the only issue
- WebGL renderer alone being the problem
- OpenCode itself being incompatible with xterm in general

Each of those either tested cleanly or explained only part of the failure.

## Why the reference projects still mattered

The references were extremely useful, even though the final bug was bundle corruption.

### `web-terminal-poc`

Useful for:

- focusing attention on the browser terminal layer
- reinforcing that `AttachAddon` is limited for native-feeling terminals
- highlighting `terminal.write(data, callback)` and `onBinary`
- clarifying buffering and flow control expectations

### VS Code reference

Useful for:

- terminal option shape
- `windowOptions`
- richer VT configuration
- general confirmation that the terminal product needs a capability layer above raw xterm

### xterm.js source

Most critical for the final diagnosis because it proved:

- the source implementation of `requestMode` was valid
- the corruption happened after source, inside the production bundle

## Follow-up recommendations

### 1. Keep the no-minify fix unless and until a safer alternative is proven

This is the highest confidence production-safe fix right now.

### 2. Consider testing alternative minification strategies later

Possible future work:

- try `terser` instead of the current default minification path
- try excluding xterm from aggressive minification if Vite allows a targeted workaround
- upgrade xterm and retest once a known-good combination is identified

### 3. Continue improving terminal parity, but treat it as separate from this bug

Good future work still includes:

- moving away from `AttachAddon` toward a custom websocket integration
- adding explicit flow control
- keeping `onBinary` handling first-class
- improving shell integration and terminal capability tracking

Those are still worthwhile, but they are separate from the production bundle crash that blocked OpenCode.

One thing this investigation specifically does not justify is speculative terminal emulation. If a capability reply is not grounded in observed need and validated behavior, it is safer not to fake it.

## Practical takeaway for future debugging

If a terminal-only app works in a raw PTY and websocket frames are visibly arriving in the browser, do not stop at transport.

Check for browser-side parser failures immediately:

- capture `pageerror`
- inspect generated bundle code, not just source
- compare `node_modules` implementation to emitted production output
- test the exact served production app, not only unit tests or isolated PTY harnesses

That step broke the investigation open.

## Final conclusion

There were two real issues in play:

1. OpenCode needed coherent `OSC 11` startup handling, including during history replay
2. the production xterm bundle was crashing in `requestMode` because minification corrupted the emitted code

Issue 1 explained the early weirdness.
Issue 2 was the last blocker.

The current state of the code reflects that conclusion:

- the startup-only `OSC 11` workaround remains because it solved a real attach race
- speculative frontend OSC compatibility emulation was removed
- `rows` and `cols` remain the primary terminal size, with pixel dimensions added as supplementary geometry

The reason this was so painful to find is that the stack looked healthy in every lower layer:

- PTY output was fine
- websocket transport was fine
- xterm source was fine
- only the shipped browser bundle was broken

That is why this felt invisible for so long, and why the decisive breakthrough came from capturing the browser exception and inspecting the generated bundle directly.
