# Native Windows Validation

Quarterdeck’s reusable Test workflow splits the full Windows runtime test suite across parallel runners. Every test file belongs to one shard. Static source checks run once, and a separate Windows job builds the app, checks the packed npm artifact, and runs the renderer tests. Pull-request CI and publishing require all of these checks. The automated lane uses only isolated synthetic data and deterministic fake commands; the separate manual matrix is the final real-provider release gate.

## Clean validation

Run these commands from a fresh Windows checkout in a non-elevated shell with Git, Node.js 22.23.2, and npm 11.19.1. Do not run the focused smoke as well as this full sequence on the same unchanged tree; `npm run check` already includes its integration specs.

Desktop admission requires newly created metadata to be owned by the current user, as in a normal per-user install. The hosted full check matches Desktop CI by using Git Bash, whose [Windows runtime sets the process token's default owner to the current user](https://github.com/git-for-windows/msys2-runtime/blob/main/winsup/cygwin/uinfo.cc#L73-L85). This avoids Administrators-owned fixtures without changing system policy or relaxing admission.

```powershell
npm ci
npm ci --prefix web-ui
npm run build
npm run test:package
npm run check
npm run web:test
```

The packaged smoke requires `dist/cli.js`, so the build must precede it. Test state, project, fake agents, host launchers, and runtime ports are isolated; the smoke does not use installed real agents, open native applications, or attach to an existing Quarterdeck runtime.

For a narrower Windows-only diagnostic after building, run:

```powershell
npm run test:windows-smoke
```

That command fails immediately off Windows. It runs the packaged CLI smoke plus the focused native integration specs.

## Automated coverage

- clean root and web dependency installation, including the native `node-pty` dependency;
- production web/runtime/package build, `dist/cli.js` startup, HTTP fetch of the bundled application shell, and graceful packaged shutdown;
- Windows command discovery and `.cmd` Codex version/native-hook feature probes with case-aware environment handling, plus invalid project-local `git.exe`, `codex.exe`, and `code.exe` decoys proving launches use exact inherited-`PATH` targets;
- source CLI startup with isolated state/project data and a project/state path containing spaces;
- a real ConPTY task session with an exact multiline prompt, Windows CR input, provider-hook transition, forced same-size row-nudge redraw, control/IO disconnect, reconnect, authoritative viewport/geometry restore, and clean stop;
- a real `cmd.exe` shell session executing a persisted project shortcut;
- protected launch-scoped process records and DACLs, direct runtime/root parentage, and clean record retirement;
- ordinary runtime restart preserving a separately abandoned synthetic `codex.exe` tree and its ownership evidence, followed by an explicit fixture call to the exact registry cleanup helper, which discovers and reverifies creation identities before terminating that tree while an unregistered Claude/Codex/Pi-looking process remains alive; this helper check does not claim automatic startup cleanup;
- generated hook-command execution through `cmd.exe`, including working-directory and `PATH` `powershell.exe` decoys, a copied `node.exe` under a metacharacter-heavy path, and byte-for-byte argv/stdin/stdout checks for spaces, multiline values, carriage returns, `%NAME%`, `!`, `^`, `&`, `|`, and parentheses;
- task-worktree create/delete, task-local copies of an ignored directory and setup file selected through `.worktreeinclude`, and checkout of a tracked path longer than 260 characters;
- Git/files API fidelity for tracked and untracked leading-space names plus a case-only rename on the native case-insensitive filesystem;
- Open in VS Code through an isolated `code.cmd` host-launch stub, without opening a real application;
- graceful source, development-wrapper, and packaged-CLI shutdown through the parent stdin control pipe; and
- private Windows DACLs on the managed-process registry/record, runtime descriptor/token, journal directory/segments/manifest, and an exported bundle under a configured state home and custom output path. Inspected roots must be protected, and effective file ACLs may grant access only to the current user and LocalSystem.

## Manual physical Ctrl+V acceptance

Run only on an explicitly chosen disposable, interactive Windows VM or test desktop, as a non-admin, with clipboard history, sync and VM/RDP clipboard sharing disabled. Do not run on a daily-use workstation or in CI. This replaces the disposable desktop's clipboard with synthetic text; no clipboard operations are automated by Agent Lab.

1. Build a fresh [inspection-enabled local candidate](desktop-release.md#local-unsigned-candidate) from the source under test. In an interactive PowerShell console on that desktop, launch the isolated probe with the **literal name of the chosen disposable computer**, not an expression that selects the current machine:

   ```powershell
   npm run agent:desktop -- windows-native-paste --app 'C:\path\to\Quarterdeck-win32-x64' --disposable-desktop 'QD-TEST-VM'
   ```

   The runner uses the private Agent Lab installation and synthetic project, opens a visible manual shell and waits up to three minutes for its receipt. No provider is started. Do not substitute a development instance, an installed app, or a public artifact.
2. In a separate PowerShell console on that same desktop, load the exact three synthetic lines with Windows CRLF separators and **no final newline** (ASCII-only command for Windows PowerShell compatibility):

   ```powershell
   $lines = @(('Quarterdeck caf' + [char]0xE9), ([string][char]0x6F22 + [char]0x5B57 + ' ' + [char]::ConvertFromUtf32(0x1F680)), 'last synthetic line')
   Set-Clipboard -Value ($lines -join "`r`n")
   ```

3. Click the Agent Lab terminal and **type** `node native-paste-probe.mjs`, then press Enter to start the child. Wait for `READY`. With no selection, physically press **Ctrl+V once** and release it. Do not use Playwright typing/`insertText`, a synthetic DOM paste event, an app menu or a context menu. Do not press Enter yet.
4. Wait for `PASTE ONLY: exact frame, zero submits`. The raw child requires exactly one `ESC [ 200 ~` frame with the UTF-8 text (xterm normalizes the two CRLF separators to CR), followed by `ESC [ 201 ~` and a 1.5-second quiet interval without any extra bytes. Only after that checkpoint, physically press **Enter once**. The child requires one additional `0d` byte and another quiet interval before passing. Early Enter, literal Ctrl+V, unframed/altered text, duplicate frames and extra Enter fail. Missing input times out. This tests the native shortcut through the packaged renderer and manual-shell ConPTY, not provider submission behavior.
5. Require a passing runner exit. Keep `native-paste-receipt.json` (exact frame and final input hex, zero prior submits and one separate submit), `native-paste-bundle-manifest.json`, and `desktop-manifest.json` from the printed evidence directory. Record Windows version/architecture and that the physical steps were performed. Check confirmed graceful Quit with no fallback and no remaining owned PIDs. On failure or interruption use Ctrl+C in the runner console and retain its evidence; do not kill by executable name or delete unconfirmed live state. Revert/dispose of the test desktop after the run.

## Manual real-provider acceptance

Use a normal non-administrator Windows account, synthetic repositories, and a dedicated disposable `QUARTERDECK_STATE_HOME`. Do not attach automation to an active Quarterdeck instance or run crash/recovery checks against ordinary user state. Coding agents need explicit authorization for each real-provider/account lane; deterministic fake coverage does not grant it. For each installed supported provider—Claude Code, Codex, and the exact pinned Pi release—verify:

1. Availability/version probing, a new task, prompt delivery, ordinary completion, a question or approval response, explicit stop, exact resume, explicit restart, and runtime restart recovery.
2. Task-terminal resize, repeated same-size redraw, panel detach/reattach, browser refresh, and control/IO reconnect preserve a usable provider TUI and the final requested dimensions.
3. Deliberately terminating a Quarterdeck owner blocks ordinary startup while its prior process custody is unconfirmed. Inspect with `quarterdeck recover`, stop remaining agents and background commands, then run `quarterdeck recover --confirm-stopped` and reopen. Confirmation must refuse live saved process evidence and leave unrelated provider-looking processes untouched.
4. Open in the installed IDE and open-folder actions reach the exact selected path; closing the parent console or wrapper allows diagnostics and session state to finalize before exit.
5. A diagnostic bundle exported beneath both the default and a custom state/output root cannot be read by a second ordinary local account.

Record the exact commit and provider versions with the result. This lane does not remove the README's experimental label by itself: both the required CI evidence and this manual matrix must pass, as tracked in [`windows-compatibility-todo.md`](./windows-compatibility-todo.md).
