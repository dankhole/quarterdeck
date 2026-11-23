# Agent Functional Testing

Quarterdeck's Agent Lab runs a packaged macOS or Windows app through the repo-owned Playwright Electron driver. Windows stay hidden and unfocused by default. Temporary state, Electron storage, synthetic projects, fake provider launchers, process tracking and cleanup are isolated from the user's app. This is internal headless testing, not a standalone browser product.

The lab is data/process isolation, not a hardened security sandbox. Use synthetic fixtures only and never attach automation to the user's active Quarterdeck instance. Use [testing strategy](testing.md) to select the smallest scenario; coding agents follow the repo-owned `quarterdeck-functional-testing` skill.

## Build and run

Use a freshly built inspection-enabled local package, not a stale installed app or a public production-fused artifact. Follow [local packaging](desktop-release.md#local-unsigned-candidate) for the current build procedure. Keep root, web and desktop dependency directories local to the worktree.

```bash
npm run --silent agent:desktop -- smoke --app <absolute-packaged-app-path> --json
```

On macOS the path points to `Quarterdeck.app`; on Windows it points to the packaged `Quarterdeck-win32-x64` or ARM64 directory. The harness imports the candidate into its disposable installation rather than overwriting the user's app or Start menu. It records exact build/artifact identity and always attempts shutdown.

Native execution requires application, local-socket and process-inspection permission. A restricted macOS runner can fail during OS application registration and display a system crash alert even for hidden windows. The driver checks process inspection before launch; this does not establish every required OS permission. Do not retry a denied native launch blindly or weaken global OS security settings.

The default fake-provider smoke deliberately crashes a renderer to check recovery and may display a system alert. Hidden windows do not suppress crash reporting. Explain this before running it. Select a narrow non-crash scenario when recovery is not the claim.

The former interactive standalone browser lab (`start`, named browser actions and `restart-runtime`), its wrapper and browser E2E commands are retired. The retained packaged lab is a scenario runner, not a drop-in interactive CLI replacement. Use its scenario modules to extend functional coverage. Source runtime fixtures remain available internally for focused integration tests; they do not create public browser bootstrap URLs or bypass desktop authentication.

## Scenario selection

Use `npm run agent:desktop -- smoke --help` for the exact current combinations. Windows supports the hidden fake-provider scenarios below except `--npm-launch`, `--performance`, and `--main-loss`, which use macOS-specific fixtures or process probes. The default Windows run includes typed same-instance launch handoff. Important boundaries:

| Scenario | Claim |
| --- | --- |
| Default fake-provider smoke | Packaged startup, task PTY/hooks, card/board/project lifecycle indicators, permissions and interruption, board, diagnostics, Files draft recovery, and graceful shutdown. On Windows, the task Restart action verifies exact provider resume. On macOS, the runtime restart verifies exact resume across runtime generations. |
| `--no-agent` | Startup/renderer subset only; not task PTY or provider compatibility |
| `--npm-launch --no-agent` | Synthetic npm/app identity, project handoff and alternate-owner refusal |
| `--manual-shells --no-agent` | Home/Detail shell process survives Hide and viewer detach, explicit Terminate retires it, reopening creates a fresh shell. On macOS it also checks native Close, which enters Quit on Windows. |
| `--compare-window --no-agent` | Independent read-only comparison surface without taking editable/native-command authority |
| `--notifications` | Hidden fake-task tone intent, Settings volume and muted events through the simulation ledger; not actual audible sound or OS banners |
| `--native-experience --no-agent` | Keyboard and enlarged-text behavior. On macOS, add `--show-window` for native focus, close, and reopen checks. |
| `--performance` | Desktop-only idle process CPU/RSS, task navigation and available terminal acknowledgements; excludes competing scenarios, reloads and crashes |
| `--main-loss` | Fake-provider recovery after exact isolated main-process loss; no real-provider account access |
| `--session-recovery --no-agent` | Blocked unclean startup, cancellation, explicit acknowledgement and ordinary startup retry |

Add `--show-window` only when visibility/focus is part of the claim; it can take focus. Do not infer physical Dock, taskbar, folder-picker, display, accessibility, sleep/wake or notification experience from hidden/simulated runs. Performance observations remain bounded samples, not proof of sustained use.

The lab-only mock keychain avoids modifying the user's macOS Keychain. Ordinary app launches retain native encryption. Never reset Keychain, strip quarantine, disable Gatekeeper, or relax production Electron fuses to make a test pass.

## Providers

The default `fake` provider is deterministic, offline and suitable for CI. Reusable fixture/provider modules remain under `scripts/agent-lab/`; the terminal protocol is in the skill's `references/protocol.md`. Real provider availability does not authorize using it.

Use `--provider real-codex` or `--provider real-claude` only with explicit user/account authorization and only when the unresolved question depends on actual TUI behavior, hook schemas/order, exact resume, or launcher interpretation. First pass the fresh candidate through the fake scenario. Keep the real prompt tiny, synthetic and behind normal approval controls; never run real modes in CI. Interactive Claude has no hard budget ceiling, so its inexpensive model default is not an enforced spending limit.

Real scenarios hold a permission request without approving it, check the requested synthetic write did not occur, and use the board restart action to verify the exact provider session, fresh PTY and current launch hook. This proves an unapproved boundary, not an explicit Deny. Do not send guessed numeric choices or broaden the prompt to force progress. Real modes reject `--no-agent` and remove staged sign-in profiles even when other evidence is retained.

Real provider launchers isolate provider-owned history/configuration and suppress unmanaged integrations. They reuse only the scoped authenticated identity required by the selected lane; OS-backed credentials and organization policy remain real host boundaries. Never include credential values in artifacts or diagnostics. Inspect `scripts/agent-lab/provider-policy.ts`, `real-codex.ts`, `real-claude.ts` and `desktop-provider.ts` for the exact enforced policy rather than assuming old browser-lab command flags still exist.

Codex can defer its resume hook until the next turn. Its packaged scenario uses bounded, agent-reviewed screenshots before sending a fixed cancellation/no-tools follow-up. Inspect each actual PNG and write only the exact requested accept/refuse observation; an observation is not provider approval or new user authorization. A visible composer during “Resuming session…” is not readiness. Exact session identity and fresh native work evidence remain required; typed input alone never proves Running.

## Evidence and cleanup

Keep the returned `desktop-manifest.json`, artifact identity, checkpoints, diagnostic bundles and cleanup result. The runner's typed simulated host effects establish intent and outcome without launching a real IDE, opening user folders, playing sound or showing OS notifications. Never replace those assertions with claims about native presentation.

Normal acceptance requires confirmed graceful Quit, no remaining owned processes and no fallback termination. If closure is unconfirmed, preserve the fixture and exact identity evidence; do not delete state or kill processes by executable name. `--keep-temp` retains synthetic evidence, not authorization to leave processes running. Check cleanup even when the scenario fails.

Renderer-crash recovery reobserves the original captured document through an observation-only CDP client, bound to exact process/profile/WebContents/document identity. The original Electron application remains the Quit owner. A fresh unrelated browser or product window is not proof of recovering that document.

The smoke uses the Settings button’s test ID to detect the mounted toolbar. Modal dialogs can hide that toolbar from accessibility queries without unmounting it. Settings opens with a normal click and an assertion that the Settings dialog appeared. Only startup onboarding is dismissed automatically; verify and close recovered-draft review explicitly.

On Windows, native lab evidence covers actual installation locks, Chromium/crashpad job membership, ConPTY, replacement, shortcut replacement and uninstall under a private profile. An app manifest with `status: "stopped"` confirms the end of the application run. The runner may still be verifying or replacing the installation. Check `windows-installation-phase.json` for progress and `windows-installation-lifecycle.json` for the completed lifecycle receipt. It does not prove a real user's Start menu, SmartScreen, minimum Windows release or another architecture.

The Windows lifecycle checks wait for xterm to acknowledge the task's synthetic output on the paired terminal sockets. This includes the historical redraw through its current prompt. The macOS checks use an inline OSC 52 receipt, which ConPTY did not deliver in the Windows lab. Both lanes check the Files clipboard action separately through the simulated host ledger.

Public installation, N-to-N+1 updating, actual OS approval, native architecture/minimum-OS coverage, provider compatibility and sustained daily use remain separate [desktop acceptance gates](desktop-validation.md). Report exact candidate scope and limitations; passing source tests or an old package is not current native acceptance.
