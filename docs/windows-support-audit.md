# Windows Support Audit

Last audited: 2026-04-29.

Quarterdeck's Windows support remains experimental. The codebase has explicit Windows handling in the highest-risk runtime paths, but Windows is not currently part of CI and this pass was a code audit plus simulated Windows unit coverage, not a native Windows smoke run.

## Audit Coverage

This pass checked the runtime and developer-facing app surface end to end: install/build scripts, CLI startup/shutdown, agent discovery and launch, PTY/session lifecycle, task/worktree filesystem operations, git command execution, state persistence, browser/runtime APIs, web UI path/open-command helpers, terminal rendering, test fixtures, and GitHub Actions coverage.

## Current Assessment

- **Install/build:** Root and web package lockfiles include Windows-native optional packages from the toolchain, and package scripts keep build file operations in Node scripts. `node-pty` remains the main native dependency to verify on real Windows hosts.
- **Path handling:** Runtime path code mostly uses `node:path`, Git path output is kept as forward-slash repository paths for UI/file-tree use, and browser display utilities normalize Windows separators. This pass fixed worktree-home containment so `~/.quarterdeck/worktrees/...` detection normalizes separators and drive-letter casing.
- **Shell and process launch:** Interactive shell startup uses `COMSPEC` on Windows and falls back to PowerShell. Project shortcuts run through Node's platform shell. Task PTY launch wraps ambiguous Windows `.cmd`/`.bat` shims through `cmd.exe`; this pass extended the same wrapping to agent availability/version probes and made `dev:full` launch `npm.cmd`.
- **PTY behavior:** Task and shell terminals use `node-pty`. Windows launch avoids Unix process-group termination, but ConPTY behavior still needs native validation for resize, reconnect, task restore, and shutdown. Forced same-size resize currently sends `SIGWINCH`, which is useful on Unix and effectively best-effort on Windows.
- **Process cleanup:** Startup/shutdown orphan cleanup now has a Windows path instead of returning no work. It queries `Win32_Process` for parentless or pid-reused-parent agent processes, recognizes direct agent executables plus hosted `node.exe`/`cmd.exe` shim command lines for known agent commands, and terminates matching trees through the Windows task-kill path. This is still best-effort; a future managed PID registry would make cleanup more narrowly scoped to Quarterdeck-launched agents.
- **Git/worktree operations:** Git commands are invoked as argv arrays through `execFile`, which avoids shell quoting for normal git operations. Worktree ignored-path mirroring uses directory junctions on Windows to avoid requiring admin privileges or Developer Mode for directories; file symlinks are best-effort and skipped on failure.
- **Symlink strategy:** Directory junctions should cover common dependency mirrors such as `node_modules`. Mutable build-output exclusions already avoid known `.NET` paths. The broader ignored-path allowlist follow-up remains active and also matters for Windows because junction mirroring can cross worktree isolation boundaries.
- **Terminal rendering:** Browser rendering is xterm-based and should be platform-independent. The unverified portion is server-side ConPTY lifecycle behavior under real Windows agent CLIs.
- **File watching:** The runtime does not rely on a platform-specific file watcher for project metadata; it uses polling and git probes. Vite/Playwright dev tooling brings its own watcher behavior.
- **Scripts:** Build/dev scripts are Node-based. `dogfood` already selects `npm.cmd`; this pass aligned `dev:full` and guarded dev/e2e SIGHUP forwarding on Windows. Some integration helpers still use Unix shell stubs and skip Windows scenarios.
- **Tests/CI:** Unit tests cover Windows command discovery, shell selection, directory picker fallback, PTY launch wrapping, process termination, open-target commands, and the worktree containment fix. CI currently runs Ubuntu and macOS only; `windows-latest` is commented out in `.github/workflows/test.yml`.
- **Docs:** README now points to this audit and still marks Windows support experimental until native CI or manual smoke coverage proves the main flows.

## Fixes From This Pass

- Agent availability probes now launch Windows command shims through `ComSpec` using the same `cmd.exe /d /s /c` escaping path as PTY task launch.
- Worktree-home detection now normalizes separators and casing before rejecting or ignoring Quarterdeck-managed worktrees as user projects.
- `npm run dev:full` now uses `npm.cmd` on Windows for the web UI child process.
- Dev/e2e wrapper scripts no longer register or forward `SIGHUP` on Windows.
- Orphaned agent cleanup no longer short-circuits on Windows; it discovers parentless Windows agent processes, including known agent CLIs hosted by `node.exe` or `cmd.exe` shims, and uses process-tree termination for cleanup.

## Tracked Follow-Ups

- Add a `windows-latest` CI lane and stabilize the currently skipped Windows test scenarios, especially fake agent command/version probes and launch/open integration smoke coverage.
- Run a native Windows smoke pass covering install/build, `quarterdeck` launch, Codex/Claude/Pi detection, task PTY start/stop, shell terminals, task worktree create/delete, ignored-path junction mirroring, Open in IDE, project shortcuts, and shutdown cleanup.
- Harden Windows shell-string generation for hook, statusline, and Open-in-IDE commands so `cmd.exe` metacharacters in paths and arguments are escaped through one shared helper instead of ad hoc double quoting.
- Validate ConPTY resize/reconnect/task-restore behavior and decide whether Windows needs a resize-nudge fallback where Unix uses `SIGWINCH`.
- Replace best-effort orphan cleanup with a scoped managed PID registry if native smoke testing shows Windows agent wrappers leave descendants that cannot be identified safely from known executable names or hosted command lines.
