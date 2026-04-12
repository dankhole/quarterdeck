# Windows Compatibility

Investigation date: 2026-04-09

## Overall Assessment

The codebase has extensive Windows-aware code already in place (`windows-cmd-launch.ts`, command discovery with PATHEXT, case-insensitive path comparison, PowerShell directory picker, etc.). Runtime code paths have been fixed to handle Windows correctly. Dev tooling (CI, build scripts, test fixtures) still needs work.

---

## Done — Runtime Fixes (2026-04-09)

All runtime code paths that would crash or silently fail on Windows have been fixed:

| Fix | File | What Changed |
|-----|------|-------------|
| `/dev/null` in git diff | `task-worktree.ts:213` | Platform-conditional `NUL` on win32 |
| `isProcessAlive` liveness check | `session-reconciliation.ts:16-28` | Distinguishes EPERM (alive) from ESRCH (dead) — correctness fix on all platforms |
| Signal registration | `graceful-shutdown.ts:197-209` | Skips SIGHUP/SIGQUIT on win32 (unsupported signals) |
| Symlink junction fallback | `task-worktree.ts:33,43-47` | Uses `"junction"` type for directories on win32 — no admin/Developer Mode required |
| chmod guard | `locked-file-system.ts:129,139` | Skips chmod on win32 (no-op anyway, but now explicit) |
| Lock ordering | `locked-file-system.ts:100-107` | Case-insensitive sort on win32 to prevent deadlocks on case-insensitive FS |
| Display path | `task-worktree-path.ts:1-12` | Uses `homedir()` join on win32 instead of `~` tilde convention |

---

## Remaining — Dev Tooling & Infrastructure

These items affect developers building/testing Quarterdeck on Windows, not end-users running it.

### 1. CI: Windows testing is disabled

**`.github/workflows/test.yml:22-23`**

Windows is commented out of the CI matrix:

```yaml
# - os: windows-latest
#   node-version: 22
```

Until this runs, the runtime fixes above are validated by code review only, not runtime proof. **Enabling this is the single highest-leverage remaining change.**

### 2. node-pty native compilation

**`package.json:98`** — `node-pty@1.2.0-beta.11`

node-pty is a native C++ addon. It supports Windows via ConPTY, but requires Windows build tools (Visual Studio C++ Build Tools workload) before `npm ci` succeeds. This needs to be documented for Windows developers.

### 3. Husky pre-commit hook

**`.husky/pre-commit`**

Pure `#!/bin/sh` script with Unix shell syntax. Git for Windows runs hooks through its bundled shell, so this is usually fine in practice. Worth validating, but likely a non-issue.

### 4. Build script chmod

**`package.json` build script**

`shx chmod +x dist/cli.js` is a no-op on Windows. The CLI shebang (`#!/usr/bin/env node`) doesn't work natively on Windows. npm's `bin` field auto-generates `.cmd` shims on `npm install -g`, so this only matters for manual invocation outside npm.

### 5. Optional dependencies missing Windows binaries

**`package.json:85-91`**

Only Linux Biome/Rolldown binaries listed. Missing `@biomejs/cli-win32-x64` and `@rolldown/binding-win32-x64-msvc`. Biome falls back to WASM/JS (slower but functional).

### 6. Test fixtures use Unix paths

Multiple test files hardcode `/tmp/`, `/Users/`, `/usr/local/bin/`. Key files:
- `test/utilities/runtime-config-factory.ts:6-7`
- Various integration tests

These need `os.tmpdir()`, `os.homedir()`, or a shared test helper.

---

## Non-Issues (Investigated, No Action Needed)

| Area | Why It's Fine |
|------|--------------|
| `TERM` env var defaults to `xterm-256color` | Works with Windows Terminal + ConPTY; legacy conhost is rare |
| `SHELL` env var not set on Windows | `shell.ts` correctly checks `win32` first and uses `COMSPEC`/`powershell.exe` |
| `SIGTERM` on Windows | Can be caught in Node.js; partial support is sufficient for shutdown |
| File symlinks need Developer Mode | Error is caught, returns "skipped" — acceptable for rare file symlinks in ignored paths |

---

## What Was Already Working

The codebase had substantial Windows groundwork before any fixes:

| Area | Key File |
|------|----------|
| Shell resolution (cmd/powershell) | `src/core/shell.ts` |
| CMD.exe argument escaping | `src/core/windows-cmd-launch.ts` |
| PATHEXT-aware binary discovery | `src/terminal/command-discovery.ts` |
| Case-insensitive path comparison | `src/config/runtime-config.ts:347-350` |
| Windows directory picker (PowerShell) | `src/server/directory-picker.ts:135-159` |
| PTY spawn with cmd wrapping | `src/terminal/pty-session.ts:90-92` |
| Process tree kill via tree-kill | `src/server/process-termination.ts:20-32` |
| Path separator normalization (`/` and `\`) | `src/workspace/task-worktree-path.ts:17-20` |
| Windows file blacklist (Thumbs.db, Desktop.ini) | `src/workspace/task-worktree.ts:23-31` |
| TCP networking (no Unix domain sockets) | `src/server/runtime-server.ts` |
| Hook command launching with Windows wrapping | `src/commands/hooks.ts:661` |
| Claude workspace trust (case-insensitive) | `src/terminal/claude-workspace-trust.ts:68-71` |
| Shell argument quoting per platform | `src/core/shell.ts:29-37` |
| Windows env var case-insensitive lookup | `src/core/windows-cmd-launch.ts:9-27` |
