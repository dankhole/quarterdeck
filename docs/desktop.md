# macOS desktop architecture and operation

Quarterdeck's macOS app packages the shared web UI and runtime in an Electron shell. The npm CLI and browser UI remain supported on macOS, Linux, and Windows; browser mode does not install Electron. Desktop distribution is a candidate until the [validation ledger](./desktop-validation.md) records the release gates. See the [release runbook](./desktop-release.md) for local builds and distribution.

Installation, launch identity, and update ownership are shared between the npm CLI and native app; Electron retains its own dependency tree and native ABI. This guide describes the current implementation. The [acceptance gates](./desktop-validation.md) distinguish implemented behavior from unperformed distribution and native-platform validation.

## Using the app

The default `npm install -g quarterdeck` installs the browser/CLI package, and plain `quarterdeck` opens browser mode. On supported local graphical Macs, `QUARTERDECK_INSTALL_MODE=desktop npm install -g quarterdeck` explicitly installs the matching signed app at `~/Applications/Quarterdeck.app`; launch it with `quarterdeck --desktop`, Finder, or the Dock. Installation may be skipped by npm lifecycle policy; `quarterdeck desktop status` explains the installed pair and `quarterdeck desktop install` explicitly installs or repairs it. Until matching signed assets are public, use the [local build/install flow](./desktop-release.md#local-unsigned-candidate).

`npm run link` builds one local runtime/UI/app pair, links this checkout, and passes the app to the same installer. `npm run link -- --browser` explicitly opts out of desktop installation. Published artifacts pair by version and immutable source SHA; local artifacts must also share the exact build ID. One per-user app belongs to one global npm package slot and its resolved package directory. Switching checkout or npm prefix requires explicit ownership replacement. Launch only validates and opens an installed pair; it never downloads or repairs it silently.

For an installed local pair, standalone builds and cleanup refuse to change the owning checkout's build output. Use `npm run link -- --desktop` to update that checkout and the app together, or use another worktree for build-only validation. Browser-only linking cannot overwrite the installed app's owning checkout or npm slot. The paired workflow verifies the new CLI/app identity and absence of pending installation work before reporting success. A failed paired build or installation still requires repair; the guard does not make rebuilding and app replacement atomic.

Installer metadata lives in the private `~/Library/Application Support/Quarterdeck/installation` directory, outside the signed bundle and canonical runtime state. The app location is fixed rather than a configurable per-project path. The installer stages and verifies a replacement before requesting exclusive installation admission. A running app or bundle-dependent helper blocks replacement with quit-and-retry guidance; no sessions are killed. The transaction journal and temporary backup support interrupted replacement recovery. A successful replacement removes its temporary backup. Old managed UUID copies are not a permanent version store, but unguarded legacy copies require explicit safe migration rather than speculative deletion. The fixed app location keeps new Dock shortcuts stable; replace a shortcut to an obsolete managed copy once after quitting that copy.

npm and the app cannot change atomically. Both CLI and Dock startup validate the owner, receipt, build identity, and transaction state before starting runtime work. A missing npm package, changed owner, interrupted transaction, or mismatched pair produces repair guidance. Browser mode remains available independently. `quarterdeck desktop uninstall` removes the owned app safely before `npm uninstall -g quarterdeck`; npm does not provide a reliable uninstall lifecycle hook. Neither command removes projects, sessions, or runtime state.

The launcher passes the canonical state home and current repository through a bounded native request. First and subsequent launches use authoritative project registration and SPA navigation, with unsaved-work guards. It does not reload the renderer to change projects or start a second CLI runtime. A protocol-aware running app rejects a request for a different installation and asks you to quit and retry. Quit a pre-launcher standalone candidate once before switching: those older apps cannot understand this request and may only focus their window. The CLI reports “launch requested”; it does not claim the app has finished starting.

Open Quarterdeck from Finder or the Dock, then choose **File → Add Project…** (`Cmd+O`) for a repository. Quarterdeck includes its own Node runtime; Git and the agent CLI you choose must already be installed and signed in. If an installed command is missing, open **Quarterdeck → Runtime Environment…**, add its executable folder if needed, and refresh the runtime. An app attached to a CLI runtime uses that CLI's environment; restart the owning CLI to change it.

| Action | What happens |
| --- | --- |
| Close the window or press `Cmd+W` | Hide the window while tasks continue. Click the Dock icon to return. |
| Quit with `Cmd+Q` | Review unsaved work and any live sessions before shutdown. A separately started CLI runtime stays running. |
| File → Open in Browser | Open the same runtime in the default browser. Browser and desktop share projects and tasks. |
| View → Reload Window | Reload the interface after checking unsaved work; the runtime stays alive. |
| File → Restart Runtime… | Recover from a runtime failure after resolving unsaved work. This action appears enabled when recovery is available. |
| Help → Export Diagnostics… | Choose a folder for a diagnostic bundle, including app evidence when the runtime is unavailable. |

If a window crash leaves recoverable file drafts, review **Recover unsaved files** and restore the matching draft in Files. Restoring does not save the original file; use **Save file** explicitly. Recovery protects the last acknowledged snapshot, so keep a separate copy of important unsaved work if recovery reports a storage problem. A file can save successfully while updating its recovery copy fails; the warning distinguishes those outcomes. Retry recovery to restore protection; export a separate copy while storage is unavailable.

An npm-owned app checks the public npm registry once after startup and on **Check for Updates**. Stable installs follow `latest`; prerelease installs follow `preview`. A newer version appears in the native menu and an **Update available · vX.Y.Z** button beside Settings. Startup failures stay quiet. An explicit check reports errors or that the installed version is current. Local linked builds show their checkout's `npm run link` guidance and skip public checks.

Update details show the installed and available versions, the owning prefix, and release notes. **Update Quarterdeck** prepares a visible Terminal handoff, then uses the normal draft/session quit safeguards. Installation proceeds only after clean shutdown and app exit. The one-shot runner uses external Node/npm, installs the exact checked version in the recorded prefix, and verifies the resulting CLI/app pair. It reports progress, failures, and retry guidance in Terminal; reopen the app after success. There is no Electron self-updater, recurring check, unattended installation, forced session termination, or automatic relaunch. See the [update and recovery contract](./desktop-release.md#npm-update-and-recovery-contract) for ownership and failure boundaries.

## Shared settings and preferences

Browser and desktop clients using the same canonical state home share global settings, project settings, project organization, boards, and session history. Persistent UI preferences also belong to that runtime: onboarding and tips, saved panel sizes, editor wrap/preview, Git comparison options, preferred application, and remembered task/prompt choices are stored in `ui-preferences.json`. Settings changes notify connected clients; reconnecting or returning to a window refreshes its settings.

On the first upgraded visit, valid preferences already present in that browser or desktop profile seed only missing shared values. Existing shared values and explicit resets win. If legacy profiles disagree, open the profile whose preferences you want first, then adjust any remaining choices normally. A fresh profile does not publish defaults during startup. Preference loading and save failures are visible rather than silently replacing shared values.

Window geometry, current navigation and selected files/tasks, unsaved drafts, browser permissions, authentication, and diagnostic records stay with their owning window or profile. Project-group collapse choices seed later visits without changing another open window's navigation. Native executable-folder overrides remain desktop launch configuration; an attached app uses the owning CLI's process environment. Sharing settings does not make independently launched processes inherit identical shell environments.

### Notification sounds

Desktop task notifications play Quarterdeck's short permission, review, and failure tones using the same tone definitions as browser mode. The desktop main process owns playback, so hiding or reloading the window does not disable sounds. Playback honors the shared sound enablement, volume, event toggles, and current-project/focus suppression settings. Native notification banners are silent; their macOS permission does not control Quarterdeck's tones. System output volume and mute still apply.

While desktop owns notification presentation, connected browsers suppress their task tones to avoid duplicates. Desktop cancels pending playback when that ownership is lost, the connection closes, the runtime changes, or the app quits. Settings sound previews remain explicit UI playback and do not depend on a new task event.

If previews work but task tones remain silent, check the event and focus suppression settings first. Playback failures appear as `notification_audio` events with a `failed` outcome in the desktop diagnostics journal; they contain the tone category, not task content or filesystem paths. Synthetic desktop tests record playback intent without using speakers or displaying native banners.

## Process and storage ownership

Electron main owns the window, native presentation, update guidance, and private IPC to a separate real Node helper. The helper owns PTYs, provider hooks, and existing runtime services. Its dependencies are built for bundled Node, separately from Electron's ABI. Runtime code, paired web assets, Node, and native modules live outside ASAR.

Installed app identity checks use the physical filesystem for both file metadata and content hashes. Electron's ordinary filesystem presents `app.asar` as a virtual directory, so using it for a regular-file check rejects valid packages even when CLI verification succeeds. Keep these checks on the shared physical filesystem boundary; do not toggle process-wide ASAR behavior or accept directories and symbolic links as required resource files.

CLI and desktop enter through `startAdmittedRuntime` and `runtime-bootstrap`. Admission precedes cleanup, recovery, project registration, backups, and writable runtime construction. One runtime owns each canonical `QUARTERDECK_STATE_HOME` (default `~/.quarterdeck`). Claims record stable machine identity, PID and process birth, generation, and process custody protocol. Immutable hard-linked successors elect a replacement only after proven death or explicit release. Sleep, stale timestamps, and unavailable process inspection never authorize takeover. State homes require a local filesystem supporting hard links.

Windows machine identity reads the exact registry `MachineGuid` through .NET's `Registry.GetValue` in the fixed system PowerShell executable. Keep this probe free of cmdlets: module discovery can exceed its five-second deadline in an isolated environment without the host's warmed module cache. Strict UUID validation and hashing remain mandatory; inheriting host module paths or lengthening the deadline is unnecessary.

Boot and process-birth probes require built-in cmdlets, so they explicitly import the Utility and, for process snapshots, CimCmdlets manifests from absolute paths under `$PSHOME\Modules`. Setting only a system module search path still permits slow discovery in a fresh isolated home. Keep these imports, existing query deadlines, and host/user module-path isolation together.

A second CLI or desktop helper authenticates the existing owner and checks its protocol/capabilities. Attachment does not transfer shutdown authority. Quitting an attached app revokes its credential and leaves the CLI runtime running. Stop or upgrade incompatible or unverifiable live owners. Older binaries cannot be forced to honor new admission; stop them before mixing versions.

Owned desktop helpers bind an ephemeral loopback port and publish the actual endpoint after listening. An attached helper uses its verified owner's endpoint; desktop attachment requires the owner to be bound to `127.0.0.1`. Ordinary CLI port options remain supported. A local CLI can attach to an owner bound to `0.0.0.0` or `::` through the corresponding loopback address, while authenticating the original published bind identity. A runtime bound only to a particular network interface must be stopped and relaunched on loopback or a wildcard before local launcher attachment; this does not add remote desktop attachment. Independent lab and dogfood instances use separate state homes.

## Renderer and browser admission

The window uses stable `app://quarterdeck` storage scoped to its canonical state home. Main proxies approved assets, runtime/project APIs, and browser diagnostic routes. Management and provider hook routes are excluded. Main injects a credential only for the selected generation and approved contents. Runtime state, terminal I/O, and terminal control sockets share one environment adapter.

The renderer has context isolation, sandboxing, and no Node integration. Its versioned preload exposes typed commands and responses. Sender, frame, generation, schema, endpoint, and navigation checks are mandatory. Never expose arbitrary executable arguments, raw IPC, or general filesystem access. Existing domain owners remain the only board/session writers.

Browsers exchange a short-lived, one-use launch URL for an HttpOnly, SameSite cookie; a redirect removes the capability. Generation-specific cookie names keep separate loopback instances independent. Expiry or runtime restart requires reopening from `quarterdeck` or the native app, with explicit guidance instead of endless reconnects. The trusted Vite server handles development admission through the same private management boundary. Provider hook and diagnostic credentials remain separate.

## Shutdown and recovery

Window close hides the app and retains task/editor state. Quit and runtime restart share draft protection, live-process decisions, producer drain, process shutdown, persistence, and server close. Idle and input-waiting processes count as live. Attached clients never stop the independent owner.

Desktop file recovery stores a bounded snapshot in the renderer's state-home partition using an explicitly strict IndexedDB transaction. Only transaction completion acknowledges a revision. A single writer retains edits arriving during a commit, and Save waits for the revision that removes the saved draft before reporting ordinary success. Loading, uncommitted revisions, and storage errors block the final Quit, reload, runtime-restart, or restart seal. A persistent storage failure can therefore keep these actions blocked until recovery succeeds; exporting protects the text but does not itself repair storage.

Recovery copies remain local to the persistent Electron profile and never enter diagnostics. They contain file text and original revision metadata and are not encrypted independently of the user's disk/profile protections. Limits are 32 drafts, 512 KiB per serialized draft and 2 MiB total, counting conservative UTF-16 bytes including original text and metadata. Previously recovered copies expire after 30 days; current unsaved text is never truncated or evicted to meet a quota.

Restoration checks project, task creation time, repository/worktree and file identity, and refuses a newer unsaved tab. Restored text bypasses autosave until explicit Save and retains the original content-hash conflict check. Export and discard remain available without saving the original file. Task/settings prompt contents are outside this recovery mechanism. An unreadable or invalid snapshot pauses new recovery writes; confirmed **Reset saved recovery** discards it only after current drafts fit and the replacement transaction commits.

An existing IndexedDB record, including an empty snapshot, is authoritative. When no record exists, valid legacy local-storage drafts are imported once and removed only after the new snapshot commits. Unreadable or invalid storage is preserved for explicit reset. The importer cannot identify a draft that an older build had already saved but failed to remove durably, so such a draft may require one review. This contract covers the last acknowledged recovery snapshot, not every keystroke or all hardware and power-loss failures; browser mode keeps its existing editor behavior.

Shutdown returns a bounded response and a separate completion promise. It fences ingress, drains admitted producers, permanently fences new process launches, and only then snapshots and stops owned processes. Final persistence retains the write lease until quiescence. Deadlines, persistence failures, and unconfirmed processes do not authorize ownership release or app replacement. Write and launch fences remain installed after release to reject late work. Lease loss fences subsequent work and closes without ordinary persistence. Parent-channel loss waits for completion; an incomplete final result exits unsuccessfully with the claim unreleased.

Immediately before a covered spawn, the owner synchronously publishes and syncs a custody marker. This covers PTYs, structured providers, title agents, setup scripts, Git, language servers, and executable availability probes. Fixed OS identity/ACL probes and intentionally independent native-open effects are excluded. Isolated factories have no production guard until explicitly installed.

Recovery inspects previous claims and saved process evidence before workspace mutation. Clean release or a supported generation that never launched covered processes can proceed. An unclean dirty generation blocks automatic recovery even when its original root PID disappeared. A verified different boot proves prior processes cannot remain. A blocked upgraded launch provides an observation anchor so legacy custody can be resolved after reboot. Corrupt evidence remains intact. Backup creation and restore use the same maintenance admission and recovery checks because copying state can replay committed transactions.

The startup error offers **Recover sessions…** as an alternative to rebooting. The confirmation asks the user to check and stop any remaining agents or detached background commands. The app then runs the bundled recovery command and retries ordinary startup. Cancelling leaves recovery blocked. Recovery refuses a live runtime, live saved process evidence, unreadable evidence, or an unavailable boot identity; it never signals a process using only a saved PID.

The CLI equivalent is `quarterdeck recover` to inspect, followed by `quarterdeck recover --confirm-stopped` after checking remaining commands. Both use exclusive maintenance ownership. Confirmation publishes a private, immutable acknowledgement bound to the exact maintenance claim, its validated predecessor history, host, state home, and current boot. It preserves the original claims, custody markers, board state, task work, and provider session identities. The acknowledgement records the user's decision about untracked descendants; it does not claim verified cleanup or fabricate a clean shutdown. A later unclean generation requires a new confirmation. Reboot remains an alternative when the user cannot account for remaining commands.

Confirmed shutdown covers tracked process trees/groups and validated provider behavior. Arbitrary user commands can daemonize outside those trees; this is not an OS containment sandbox. Never infer complete cleanup from an absent root PID or broaden a kill by executable name.

On macOS, a captured process whose parent changes is observed without further PID-based signals because BSD birth timestamps have coarse precision. If it subsequently disappears before the cleanup deadline, that captured target is confirmed stopped. A still-live target, an incomplete initial ownership snapshot, or newly observed descendants under an unverifiable parent continue to block clean release.

## Native boundaries

`IRuntimeHostIntegrations` remains the runtime boundary for project, path, URL, IDE, and folder-picker effects. App-owned helpers forward allowed effects over private IPC; attached CLI runtimes keep their host implementation. Native commands use shared UI handlers. Quit/reload protection includes unsaved settings, task drafts, and cached file drafts. Recovery exports use explicit save dialogs rather than unrestricted downloads.

The app resolves its launch environment once without starting a shell by default, including Finder/Dock launches. It supplements the inherited PATH with common executable folders and one selected nvm installation. **Runtime Environment** lets users add executable folders or explicitly enable interactive login-shell environment import for variables and executable paths defined in shell startup files such as `.zshrc`. Changing either setting requires the normal guarded environment refresh or the next app launch. Only bounded folder preferences and the import choice are persisted; environment values are never saved. Attached CLI runtimes retain their owner's environment and require restarting that CLI. See [desktop environment resolution](./desktop-environment.md) for precedence, supported layouts, and validation boundaries. Git and agent CLIs remain user-installed; the app does not change provider sign-ins or shell files. Quarterdeck itself uses bundled Node.

Published installation requires verified signature/team, hardened runtime, release fuses, and npm-owned release policy. Unsigned local candidates use the explicit local import path. The update menu never changes desktop bytes independently of npm. See the release runbook for publication and replacement evidence.

## Maintaining desktop and browser together

Implement product behavior in the shared UI and runtime first. Board state, task lifecycle, provider compatibility, Git, Files, and settings keep their existing owners; fixing them there benefits both launch modes. Put native presentation and application lifetime in `desktop/`, expose only typed capabilities through the existing bridge, and keep browser defaults usable without that bridge. Avoid separate desktop copies of product views or provider adapters.

Select checks by the changed boundary. Ordinary shared features use their focused runtime/UI tests; transport, attachment, persistence, and lifecycle changes also need the affected desktop and browser paths. Native shell or dependency changes need a fresh packaged candidate. Release artifacts remain separate: browser/npm installation must keep working without Electron, while desktop packaging must preserve its paired runtime/UI build and bundled native ABI. See [testing scope](./testing.md) for when each lane is required.

### Removing desktop support later

The shared installer lives in `src/desktop-install/`, its launcher in `src/desktop-launcher.ts`, and its CLI management command in `src/commands/desktop.ts`. The Electron shell, native dependency tree, and packaging live in `desktop/`. Removing desktop support includes deleting those areas and their CI/lab tooling, then removing the explicit CLI, native bridge, desktop transport, diagnostics, and draft-recovery integrations in shared code. It is a bounded cross-cutting change, not just deletion of one directory.

Keep shared runtime admission, process/write fences, graceful shutdown, backup safety, browser authentication, and provider compatibility fixes. They also protect browser mode and should not be reverted with the shell. No product view, board model, or agent adapter needs a replacement implementation when the desktop client is removed.

## Source map

| Boundary | Implementation |
| --- | --- |
| npm/CLI installation, receipt and transaction | `src/desktop-install/`, `src/commands/desktop.ts`, `src/launch-policy.ts`, `src/desktop-launcher.ts` |
| Local dependency/build/link orchestration | `scripts/dependency-workflow.mjs`, `scripts/desktop-local.mjs` |
| Native installation admission | `desktop/native/`, `src/desktop-install/admission.ts`, `desktop/src/installation-preflight.ts` |
| Shell composition and runtime selection | `desktop/src/main.ts`, `runtime-supervisor.ts`, `runtime-selection.ts`, `launch-config.ts` |
| Renderer admission and shared UI transport | `desktop/src/protocol-proxy.ts`, `renderer-admission.ts`, `preload*.ts`, `src/shared/desktop-*-contract.ts` |
| Environment setup | See the [environment owner map](./desktop-environment.md#ownership-and-validation). |
| Registry checks and explicit npm handoff | `src/desktop-update/`, `desktop/src/update-controller.ts`, `npm-update-runner.ts`, `npm-update-worker.ts` |
| Packaging and release identity | `desktop/forge.config.mjs`, `desktop/scripts/`, `.github/workflows/desktop-*.yml`, `.github/scripts/desktop-release-artifacts.mjs` |

## Dependency maintenance

The desktop maintainer owns Electron, bundled Node, Forge, signing/notarization tools, and native-module compatibility together. Review upstream releases and security advisories at least monthly and handle relevant security fixes promptly instead of waiting for feature releases. Keep exact versions and archive checksums in the desktop manifests; update its separate lockfile without importing Electron into the npm runtime dependencies.

For an upgrade, read upstream migration and security notes, rebuild each supported native architecture, verify helper Node/native ABI and paired runtime/browser identity, and repeat the affected protocol, clipboard, launch, shutdown, and packaged-provider checks. Changes to Electron, signing tools, entitlements, fuses, or update behavior also require signed-install and npm replacement evidence before promotion. Record the candidate and any unsupported host combinations in the validation ledger. Do not relax fuses or provider compatibility gates to make an upgrade pass.

## Isolated validation

Use the repo-owned functional-testing skill and `npm run agent:desktop` against an actual packaged app. The harness creates synthetic state, projects, storage, and tracked processes. Its lab-only `--use-mock-keychain` switch keeps Chromium cookie tests away from the user's macOS keychain; ordinary launches retain native encryption. Never modify or reset a user's keychain to make a test pass.

Routine desktop tests keep their window hidden and unfocused. `--show-window` explicitly enables checks that need visible native activation; it may take focus. A hidden run cannot prove window placement, close/activate, or notification presentation.

Record exact artifact/build identity and cleanup results. Source tests do not validate stale packages. Native ARM/Intel execution, oldest macOS, Gatekeeper installation, signed npm replacements, and elapsed daily use are separate ledger gates.
