# Native Windows Validation

Quarterdeck's reusable test workflow contains a non-optional `Windows native` job. Pull-request CI and publishing both call that workflow, so a Windows failure fails the caller rather than being treated as an allowed experiment. The automated lane uses only isolated synthetic data and deterministic fake commands; the separate manual matrix is the final real-provider release gate.

## Clean validation

Run these commands from a fresh Windows checkout with Git, Node.js 22.22.2, and npm 11.19.0. Do not run the focused smoke as well as this full sequence on the same unchanged tree; `npm run check` already includes its integration specs.

```powershell
npm ci
npm ci --prefix web-ui
npm run build
npm run test:package
npm run check
npm run web:test
```

The packaged smoke requires `dist/cli.js`, so the build must precede it. Test state, project, fake agents, host launchers, and runtime ports are isolated; the smoke does not use installed real agents, open native applications, or attach to an existing Quarterdeck runtime.

For a faster Windows-only diagnostic after building, run:

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
- protected launch-scoped process records and DACLs, direct runtime/root parentage, clean record retirement, and startup cleanup of an exact abandoned `codex.exe` tree while an unregistered Claude/Codex/Pi-looking process remains alive;
- generated hook/status-line execution through `cmd.exe`, including working-directory and `PATH` `powershell.exe` decoys, a copied `node.exe` under a metacharacter-heavy path, and byte-for-byte argv/stdin/stdout checks for spaces, multiline values, carriage returns, `%NAME%`, `!`, `^`, `&`, `|`, and parentheses;
- task-worktree create/delete, a readable ignored-directory junction, a readable ignored setup file through symlink or task-local copy fallback, and checkout of a tracked path longer than 260 characters;
- Git/files API fidelity for tracked and untracked leading-space names plus a case-only rename on the native case-insensitive filesystem;
- Open in VS Code through an isolated `code.cmd` host-launch stub, without opening a real application;
- graceful source, development-wrapper, and packaged-CLI shutdown through the parent stdin control pipe; and
- private Windows DACLs on the managed-process registry/record, runtime descriptor/token, journal directory/segments/manifest, and an exported bundle under a configured state home and custom output path. Inspected roots must be protected, and effective file ACLs may grant access only to the current user and LocalSystem.

## Manual real-provider acceptance

Use a normal non-administrator Windows account and synthetic repositories. Do not attach automation to an active Quarterdeck instance. For each installed supported provider—Claude Code, Codex, and the exact pinned Pi release—verify:

1. Availability/version probing, a new task, prompt delivery, ordinary completion, a question or approval response, explicit stop, exact resume, explicit restart, and runtime restart recovery.
2. Task-terminal resize, repeated same-size redraw, panel detach/reattach, browser refresh, and control/IO reconnect preserve a usable provider TUI and the final requested dimensions.
3. A deliberately terminated Quarterdeck owner leaves its registered provider tree recoverable by the next startup without touching an unrelated provider-looking process.
4. Open in the installed IDE and open-folder actions reach the exact selected path; closing the parent console or wrapper allows diagnostics and session state to finalize before exit.
5. A diagnostic bundle exported beneath both the default and a custom state/output root cannot be read by a second ordinary local account.

Record the exact commit and provider versions with the result. This lane does not remove the README's experimental label by itself: both the required CI evidence and this manual matrix must pass, as tracked in [`windows-compatibility-todo.md`](./windows-compatibility-todo.md).
