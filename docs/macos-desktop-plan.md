# macOS Desktop App Plan

Status: core local implementation and the npm launch simplification are committed and reviewed, 2026-10-07; acceptance remains in progress. The shared desktop/browser architecture, ARM packaging, native layout, and fake-provider process-loss checks are implemented and reviewed. npm can select browser mode or install and launch an optional matching app; isolated local import, reuse, and native project handoff passed. Real Codex validation exposed a folder-trust compatibility defect; the correction passes packaged startup, held permission, and exact resume with fresh native hooks after a guarded no-tools turn. Local main is incorporated in the feature branch. Signing, Intel/oldest-macOS execution, signed updates, actual cross-platform CI, remaining OS interaction and performance checks, other real-provider coverage, and sustained daily use remain acceptance gates. The [architecture guide](./desktop.md) records implemented boundaries; the [validation ledger](./desktop-validation.md) distinguishes executed checks from release gates.

Deliver a dependable, polished macOS application that opens from Finder or the Dock, runs existing Quarterdeck workflows, and installs and updates without requiring Node or npm for Quarterdeck itself. Keep the npm CLI and browser experience supported on macOS, Linux, and Windows, with the existing platform support qualifications, including experimental Windows support.

The recommended architecture is an Electron shell around the shared React UI and a separate bundled Node runtime. Browser and desktop clients use the same domain services, board state, agent adapters, and HTTP/WebSocket contracts. This plan defines delivery milestones and acceptance gates; the primary checkout's `docs/qDeck.yaml` remains the execution tracker.

## Delivery scope

The first release includes:

- Signed, notarized installation for Apple Silicon and Intel Macs, initially as separate downloads. Supporting both architectures is the planning assumption pending the user's preference.
- Finder and Dock launch, a single application window, native menus, reliable shortcuts, window restoration, native project selection, clipboard behavior, notifications, and diagnostic export.
- Existing projects, tasks, worktrees, settings, Files/Git views, and supported agent workflows, using the existing state directory.
- Clear setup for Git and installed agent CLIs, including actionable missing-command and unsupported-version errors. Provider authentication remains provider-owned.
- Defined behavior for window close, Quit, renderer failure, runtime failure, sleep/wake, and upgrades.
- Downloaded updates with explicit restart, safe session shutdown, and retained user data.
- Additive desktop validation while retaining the browser and npm release gates.

Windows and Linux desktop installers, multiple desktop windows, login-item launch, an independent background daemon, agent installation, cloud sync, and VS Code extension/editor parity are outside this release. The application retains Quarterdeck's current design system and core layout.

## Product behavior

| Situation | Required behavior |
| --- | --- |
| First launch | Show a startup surface immediately, then existing onboarding or the saved project. Missing Git or agents produce setup guidance rather than a blank window. |
| Later launch | Restore window geometry and the user's view where valid. Reconcile projects and task state from the runtime before enabling actions. |
| Close button or Cmd+W | Hide the main window and keep the application and task agents alive. Dock activation restores it. Preserve unsaved editor state while hidden. |
| Second application launch | Focus the existing application and route any project-open intent to it. Do not create another runtime or duplicate agent session. |
| Cmd+Q | Check unsaved edits and live sessions, including idle or input-waiting PTYs. Explain interruption when applicable. Shut down only a runtime owned by this application; a CLI-owned runtime continues. |
| Open in Browser | Open the selected project's browser view against the same runtime and saved data. Browser mode does not require a desktop installation. |
| Renderer crash or reload | Keep the runtime alive. Recover the view through authoritative hydration. Warn before intentional reload when edits would be lost; retain bounded local recovery drafts for editor crashes. |
| Runtime failure | Show a distinct runtime error with diagnostics and an explicit recovery action. Do not repeatedly restart agents in a hidden retry loop. |
| Application process failure | The owned helper detects parent-channel loss and performs bounded shutdown. Next launch uses existing exact-session recovery; continuous execution through a main-process crash is not promised. |
| Sleep and wake | Reconnect and check the actual runtime/session state. Elapsed time does not imply an agent transition. |
| Update available | Show download status and Later / Restart to Update. Never restart automatically over live sessions or unsaved work. |

Manual Home and Detail shell panels retain their documented lifetime: closing their panel stops their shell. Hiding the application window does not count as closing a shell panel. This distinction needs an integration test.

## Shared architecture

| Boundary | Owner and responsibilities |
| --- | --- |
| Shared React application | Existing `web-ui/`: board, tasks, Files/Git, terminals, settings, onboarding, command enablement, and authoritative state application. No Electron imports. |
| Shared runtime | Existing `src/`: persistence, project registration, Git/worktrees, PTYs, provider hooks, lifecycle transitions, and diagnostics. |
| Shared startup service | New `src/server/runtime-bootstrap.ts`: extract startup/shutdown composition from the CLI without moving CLI argument parsing or terminal presentation into it. |
| Runtime admission | New focused ownership/discovery service and typed management contract: choose one runtime owner before any startup mutation and authenticate attachment. |
| Desktop main process | New `desktop/` package: window lifecycle, menu assembly, runtime supervision, protocol proxy, native presentation, update coordination, and application errors. Keep these in separate modules. |
| Desktop preload | A small, typed, versioned bridge for approved desktop commands and capabilities. Never expose raw Electron IPC, arbitrary process launch, or filesystem access. |
| Host integrations | Preserve `IRuntimeHostIntegrations`. For an app-owned helper, forward allowed native effects over its private parent channel. A CLI owner retains its existing host implementation. |

The existing [architecture](./architecture.md), [runtime state rules](./conventions/runtime-state.md), [session lifecycle](./conventions/session-lifecycle.md), and [frontend ownership rules](./conventions/frontend-hooks.md) remain authoritative. Desktop adapters must not become additional board or session writers.

### Runtime ownership and coexistence

Adopt one writable runtime per canonical state directory for the new launchers. Acquire a lifetime ownership lease before cleanup, migration, backup creation, project registration, or recovery. The existing CLI currently attempts occupied-port attachment after substantial startup work; that ordering must change before desktop distribution.

Publish a private, atomic owner descriptor containing instance identity, readiness, endpoint, package version, browser protocol version, and a separate management protocol version. Establish a bounded authenticated handshake before attachment. Port occupancy or a successful public tRPC request is not proof of ownership. Keep management credentials separate from diagnostic credentials and out of logs, URLs, renderer state, and command arguments.

If an owner supports the browser protocol, desktop bridge, and transport capability versions, complete an authenticated handshake, attach, and send typed project-open intent. Attachment does not transfer shutdown authority. If an owner is starting or stopping, wait within a bounded startup policy and show useful progress. An incompatible or unverifiable live owner produces upgrade/restart guidance; never kill it or start a second writer on an automatic port.

Use immutable, atomically published ownership claims, with exact PID and process-creation identity. A live or unverifiable owner remains authoritative regardless of heartbeat age, sleep, or suspension. An immutable successor claim may follow only a proven-dead or explicitly released generation; never delete a contested claim or compact the reachable chain online. This admission requires a local filesystem supporting hard links; network-shared state homes are unsupported. Generic startup cleanup must never delete ownership records. Normal Quit retains ownership through process quiescence, persistence, and server closure. Reject new mutations and drain admitted operations before the final snapshots. Shutdown returns a typed bounded outcome and a separate completion promise: a deadline or caught persistence/process failure is incomplete, never permission to exit, release ownership, or install an update. If the lease is lost, immediately fence durable writes, stop only owned processes, and close without ordinary shutdown persistence; a replacement owner may already be active. Retain existing durable command and execution fences as defense against stale processes.

Offline mutators such as backup creation and restore acquire the same admission in maintenance mode and refuse a live owner. Read-only diagnostics and launch-authenticated hook/outbox delivery remain independent.

This deliberately changes the documented same-state multi-runtime behavior. Independent lab and dogfood runtimes continue through distinct `QUARTERDECK_STATE_HOME` directories. `--port auto` selects transport after ownership admission; it no longer bypasses ownership for the same home. Update the dogfood launcher and documentation to make isolation explicit.

Ship and validate admission support in the npm CLI before the desktop release. Old binaries cannot be made to honor the new lease: detect known legacy active instances and refuse unsafe coexistence, document the minimum compatible CLI, and require users to stop or upgrade older runtimes. A lease is not a guarantee against an old binary launched afterward.

### Runtime process and hook execution

Bundle a real Node executable with runtime JavaScript, web assets, and production dependencies. PTYs run in that helper, not Electron main. Keep the helper and its dependencies outside the Electron ASAR where native loading and child execution require real files.

Replace accidental dependence on the GUI's executable identity with an explicit headless invocation contract. Existing hook construction derives from `process.execPath` and `process.argv` in [`quarterdeck-command.ts`](../src/core/quarterdeck-command.ts). Claude, Codex, and Pi hooks/statuslines must invoke the bundled helper with the exact launch-scoped state directory and endpoint. Hook subcommands must not open a window, acquire the runtime-owner lease, or execute full runtime startup.

Keep the runtime helper's native dependency tree separate from Electron's. Build `node-pty` for the bundled Node version and architecture; Electron-native modules, if introduced, have their own ABI requirements. Validate installed bundle paths containing spaces and non-ASCII characters. [Electron native module guidance](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)

### Stable desktop origin and browser transport

Use a stable `app://quarterdeck` desktop origin in a persistent Electron session. A narrow main-process protocol handler proxies the verified owner's existing web assets and permitted relative HTTP routes. This preserves matching owner-served UI assets and keeps desktop local storage stable when the runtime port changes. Partition desktop storage by canonical state home, with isolated partitions for tests.

Introduce one shared runtime-environment adapter for WebSocket endpoints. The two existing socket URL builders in `runtime-state-stream-transport.ts` and `terminal-socket-utils.ts` currently derive the host from `window.location`; the browser implementation retains that behavior. Desktop receives only the selected endpoint and non-secret capabilities. The main process adds credentials only to requests from the approved desktop contents to the exact pinned runtime endpoint.

Register the privileged scheme before Electron readiness and install its handler on the window's actual session partition. Use one composed owner for each webRequest interception stage; Electron retains only the last listener. The protocol handler must preserve HTTP method/body/status, cancellation, content types, and streaming, reject arbitrary hosts and redirects, and invalidate requests when the selected runtime generation changes. Reverify the owner and reload the renderer before using a replacement generation; never silently redirect a live page to another owner. Do not disable web security or CSP to make this work. The first technical gate must prove relative fetch, storage, and all three WebSocket endpoints: `/api/runtime/ws`, `/api/terminal/io`, and `/api/terminal/control`. [Electron protocol API](https://www.electronjs.org/docs/latest/api/protocol), [Electron request interception](https://www.electronjs.org/docs/latest/api/web-request)

Browser mode continues to use ordinary HTTP/WebSockets and requires no preload bridge. Desktop UI preferences are local to the app; durable projects and global preferences remain in the shared runtime state. Automatically importing another browser's profile is not required.

### Desktop security and capabilities

Enable context isolation and renderer sandboxing; disable Node integration. Validate IPC sender, frame, payload, and current runtime generation. Keep normal web links in the default browser, deny unrequested navigation/popups and device permissions, and preserve existing terminal-link confirmation. Use a restrictive CSP and narrow protocol/request allowlists. No arbitrary URL may become a privileged application view. [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)

Separate runtime discovery, authenticated management, and client API authorization. Define per-run client admission for HTTP and all three WebSocket upgrades, including explicit allowed origins and CSRF protection; CORS and protocol-version checks are not authentication. Browser launch must remain convenient through a short-lived, one-use bootstrap capability exchanged for an HttpOnly session cookie, with the capability removed from history and excluded from diagnostics. Desktop credentials remain main-process-owned and generation-scoped. Browser expiry must produce explicit reopen guidance instead of infinite reconnect attempts; a protocol snapshot cannot recover a request rejected before authentication. Provider hook and diagnostic authentication retain distinct scopes.

Apply this through shared launch/admission services so the app can attach safely to a new CLI owner. Cover startup, expiry, refresh, invalid credentials, replay, and cross-origin attempts. Keep desktop attachment limited to loopback. Existing explicit CLI network binding requires a documented compatible admission path; this release does not add remote desktop attachment.

Follow the [browser/runtime compatibility policy](../DEVELOPMENT.md#browserruntime-compatibility) when changing admission or API contracts. Declare a protocol bump wherever old clients cannot safely continue. Desktop management/bridge versions are separate from browser protocol, package semver, and build identity.

## Daily use integration

### Environment and onboarding

Resolve the launch environment once before starting an owned runtime. Preserve a usable terminal-provided environment; for Finder/Dock launches, use a bounded login-shell environment acquisition outside agent discovery and launch hot paths. Capture through a private structured channel, cancel a hung shell, and fall back to explicit setup guidance. Do not spawn interactive shell discovery for each task.

Provide executable-path or PATH configuration and a refresh action for installations that shell discovery cannot resolve. Use typed launch configuration; add global fields only through the existing config checklist and Settings mapping. Never log or persist the complete inherited environment, inspect provider credentials, or overwrite the user's shell files. Attached clients use the owner's environment and explain when a runtime restart is needed to refresh it.

The bundle removes Quarterdeck's Node installation requirement. Git, agent CLIs, optional language servers, and any dependencies those tools need remain user-installed. Availability is not evidence of authentication. Reuse the existing onboarding and provider compatibility checks, including Pi's exact-version gate.

### Native interface

Start with the standard macOS title bar and traffic lights. Restore usable window bounds, clamp them after display changes, and support fullscreen, zoom, and minimum size. Preserve the current dark theme and layout.

Add Application, File, Edit, View, Window, and Help menus. Include About, Add Project, Settings (`Cmd+,`), Open in Browser, Check for Updates, Diagnostics/export, minimize, fullscreen, Hide, and Quit. Route product commands through shared handlers and enablement rules. Preserve existing application shortcuts and terminal key policy; native `Cmd+M` minimizes. Each accelerator must produce exactly one action with inputs, dialogs, or the terminal focused.

Use a parented native folder picker for an owned runtime, with correct cancellation and focus restoration. Preserve typed outcomes for Finder/IDE/path actions. Support clipboard text and image paths through the existing bounded terminal-input contracts. Cover keyboard navigation, VoiceOver semantics for core flows, visible focus, and enlarged text without clipped primary actions.

### Notifications and diagnostics

Native notifications and the Dock badge are part of this release. One desktop notification owner consumes authoritative permission/review/failure projections across projects, using a shared pure policy rather than interpreting terminal output. It remains active when the window is hidden and does not require a healthy renderer. Deduplicate by stable event/session identity across replay and reconnect, respecting existing preferences and foreground suppression.

Notification clicks carry only project/task identity, restore the window, revalidate that the target still exists, and navigate through existing UI owners. Deleted targets fall back to the project or board. Prevent duplicate desktop/browser audio when both clients are open through explicit notification presentation ownership; losing a presentation owner must not affect task lifecycle. Denied notifications leave in-app indicators usable.

Add bounded desktop startup, process-generation, updater, and shutdown evidence to the existing diagnostic schema and bundle. Reuse the one recorder/export contract, including a bounded path for failures before runtime readiness. Do not create a second general log system or record environment values, prompts, terminal content, or full launch arguments. Follow [diagnostics guidance](./diagnostics.md).

## Packaging and updates

Create a private `desktop/` Electron Forge package with its own dependency tree and commands. Keep root npm installation, `npm run build`, CLI artifacts, and browser use independent of Electron tooling. Desktop packaging consumes the existing paired runtime/browser build from `scripts/build-all.mjs`; do not independently rebuild the two halves with different identities.

Pin validated Electron and bundled Node versions. Electron 44.5.1 and bundled Node 22.22.2 set the current application minimum to macOS 13. Test the oldest supported and current macOS releases; cross-building does not satisfy execution coverage. Produce native `arm64` and `x64` DMGs plus ZIP update payloads. A universal app can follow after both architectures are proven. Direct distribution is the initial channel. [Forge DMG packaging](https://www.electronforge.io/config/makers/dmg)

Sign the app and all nested executable code with Developer ID, use hardened runtime with narrowly required entitlements, notarize, and staple. Finalize the stapled app before creating its update ZIP. Sign, notarize, staple, and verify the final install DMG as well. Test downloaded/quarantined installation and offline first launch with Gatekeeper enabled. Signing credentials belong in protected CI with temporary keychain handling, never the repository. [Forge macOS signing](https://www.electronforge.io/guides/code-signing/code-signing-macos), [Apple Developer ID distribution](https://developer.apple.com/developer-id/)

Use Electron's macOS updater with architecture-specific signed ZIPs. Prefer `update.electronjs.org` if the repository remains public and its release-asset contract is verified; a private distribution would require an explicit alternative feed. Provide Check for Updates, download/error state, Later, and Restart to Update. Complete user-approved quiescence and await successful owned-helper shutdown before invoking `quitAndInstall()`. Busy or dirty sessions and failed shutdown leave the update pending. Electron may apply an already-downloaded update at the next application start: “Later” means continue working until the next safe quit/relaunch, not a promise to require another installation approval. All quit paths must use the same safe shutdown gate. Normal Quit and updater-specific quit events share the idempotent shutdown path; `before-quit-for-update` is not the cancellation gate. [Electron updater API](https://www.electronjs.org/docs/latest/api/auto-updater), [Electron update service](https://github.com/electron/update.electronjs.org)

Use one product semver and immutable source tag for the app, bundled runtime, npm package, and notes. Keep the existing npm OIDC flow. Build and verify all expected artifacts, upload desktop assets/checksums to a draft GitHub Release, publish npm, then expose the complete stable Release. Retries must recognize an already-published npm version and finish missing release steps; publication across registries is not atomic. Keep previews out of the stable update feed.

Record source SHA, product version, Electron/Node versions, architecture, build identity, and checksums in an artifact manifest. Runtime and browser identity must match within each artifact; separately built architectures may legitimately have different build UUIDs.

Extend [RELEASE_WORKFLOW.md](../RELEASE_WORKFLOW.md) with signing, both architecture gates, draft finalization, update tests, and post-download verification. Verify N-to-N+1 update with a controlled test feed before enabling production updates. Preserve data and backward-compatible state changes where possible; if a release adds an irreversible migration, document backup/recovery and do not promise automatic downgrade.

## Implementation sequence

Estimates are engineering planning ranges for one developer familiar with this repository, not delivery commitments. Allow roughly 20–30 working days, or four to six weeks including overlap and daily-use hardening. The earlier two-to-three-week estimate remains plausible for a usable local app; signed dual-architecture distribution, safe coexistence, and tested updates add work.

| Milestone | Work and boundary | Completion gate | Estimate |
| --- | --- | --- | --- |
| 1. Prove the packaged architecture | Add isolated desktop package, bundled Node/runtime/native dependencies, startup surface, stable-origin proxy, and shared socket environment adapter. Select versions, minimum macOS, and bundle identity. | Actual packaged app on each architecture renders shared UI and runs a fake PTY without system Node; storage survives a port change; HTTP and all three socket endpoints work without disabling security. | 3–4 days |
| 2. Establish shared runtime ownership | Extract bootstrap, add early lifetime admission and authenticated management/client bootstrap, make project-open attachment typed, isolate dogfood state, and adapt helper hook invocation. | Simultaneous CLI/app launch creates one writer; unrelated or legacy listeners are not adopted; different homes remain isolated; browser launch and hooks work. Publish the prerequisite CLI before desktop rollout. | 4–6 days |
| 3. Make lifecycle dependable | Implement close/hide, second launch, quit/update quiescence, dirty-editor protection, crash recovery, parent-loss cleanup, sleep/wake, environment capture, and diagnostics. | No duplicated/orphaned owned agents; attached CLI survives app quit; interrupted state and exact resume are correct; failure surfaces are actionable. | 4–5 days |
| 4. Finish macOS daily use | Menus/command routing, window state, native picker/clipboard, onboarding refresh, notifications/badge, browser action, diagnostic export, keyboard and accessibility polish. | Native acceptance matrix passes with window hidden, terminal focused, multiple projects, changed monitors, and denied notification permissions. | 3–5 days |
| 5. Ship installation and updates | Signing/notarization, DMG/ZIP artifacts, protected release CI, update UI/shutdown, complete draft-release finalization, documentation. | Clean downloaded install and signed N-to-N+1 update pass on both architectures; failed update leaves current app/data usable; npm/browser releases remain valid. | 3–5 days |
| 6. Validate sustained use | Run the additive desktop harness, final shared/browser gates, targeted real-provider acceptance when authorized, and a five-working-day dogfood period. Fix release-blocking findings. | All release criteria below pass on the final candidate; evidence identifies version, architecture, and exact artifact. | 3–5 engineering days, with dogfood elapsed time overlapping late work |

Milestones 1 and 2 are the architectural gates. Before admission is implemented, the prototype must use synthetic projects and an explicit temporary runtime state home as well as isolated Electron `userData`; package isolation alone is insufficient. Do not defer helper/hook packaging, stable-origin behavior, or ownership correctness until visual polish. CI/signing setup can proceed alongside lifecycle implementation; native polish can proceed once command and host contracts are stable. Shared runtime/transport changes require one coordinated owner even when other work is delegated.

## Validation and release criteria

Follow [the testing strategy](./testing.md). Add a desktop surface to the existing isolated Agent Lab with an explicit Electron launcher/driver, temporary Electron `userData`, synthetic projects, fake provider, app/main/renderer/helper process tracking, and guaranteed stop/cleanup. The current `agent:browser` wrapper drives Chromium and does not already automate Electron. Extend the repo-owned skill and harness documentation when that capability is implemented.

Use focused tests for ownership races, lifecycle policy, menu routing, protocol/IPC authorization, notifications, and geometry. Use process/filesystem integration for startup/shutdown/recovery and actual packaged-app smoke for bundled Node/native dependencies. Simulated native effects prove routing; real macOS checks must prove actual dialogs, permissions, and Finder/Dock behavior.

| Gate | Required evidence |
| --- | --- |
| Shared product behavior | Synthetic add-project, create/start task, authoritative Running hook, input wait, review, Files/Git, reconnect, and diagnostics work in both desktop and browser. Simultaneous desktop/browser viewing and resizing preserve terminal identity and existing geometry ownership. Durable command/lifecycle authority remains unchanged. |
| Ownership and compatibility | Concurrent launch, same-home/different-port, separate homes, stale descriptors, lease loss, PID reuse, unrelated listener, compatible/incompatible CLI, and minimum-version upgrade guidance. |
| Authentication and transport | Valid and invalid HTTP admission and each of the three socket endpoints, single-use browser bootstrap, expired credentials, cross-origin attempts, generation changes, stable storage across ports, streaming/cancellation/reconnect, and blocked navigation. |
| Desktop lifecycle | Hide/reopen, second launch, dirty editor, renderer/main/helper crash, pending startup/quit, input-waiting and idle PTYs, shutdown failure, attached-owner quit, and sleep/wake. No unexpected relaunch or leaked descendants. |
| Native experience | Finder/Dock environment, path overrides, picker cancel/focus, clipboard text/images, Edit/menu shortcuts, notification permission/click/replay, hidden-window delivery, audio deduplication, display removal, fullscreen, VoiceOver, and zoom. |
| Provider compatibility | Fake-provider lifecycle coverage remains deterministic. Before declaring provider compatibility, run narrow, explicitly authorized real Claude/Codex/Pi checks for packaged hook invocation, approvals, stop, and exact recovery at supported versions. Record unsupported or untested combinations. |
| Distribution | Signed/notarized downloaded DMG and updater ZIP on both architectures; no system Node needed for Quarterdeck; Gatekeeper enabled and offline first launch; signed N-to-N+1 update, offline/corrupt feed, deferred install, and preserved data. |
| Browser regression | Existing Linux/macOS/Windows build, root checks, web tests, and npm package/platform smoke retain their current scope. Desktop dependencies are absent from the npm runtime artifact. Desktop changes do not imply a promotion of experimental Windows/provider support. |
| Sustained use | Five working days on the release candidate with real projects under user control: close/open cycles, multiple agents/projects, overnight sleep, reconnects, and an update. No unresolved data-loss, duplicate-agent, shutdown, or installation blocker. |

Screenshots support visual claims only. Use unified diagnostics and process/session evidence for lifecycle claims. Performance acceptance compares the same fixtures against browser mode: responsive terminal/input and navigation, bounded startup failure, no idle busy loop, and no continuing process/memory growth over repeated window and task cycles. Record the baseline and measured results rather than inventing unmeasured thresholds.

Maintain a release evidence ledger distinguishing passed, pending access, and pending elapsed-time checks, with exact source/artifact identities. Missing Developer ID credentials, native Intel/oldest-OS execution, signed update evidence, or five days of use remains a release gate; unit tests and cross-builds cannot replace it.

Final checks apply to the final reconciled tree and actual distributables. Do not run an umbrella gate and its constituent commands redundantly. Always stop isolated runs; never attach automation to the user's active instance. Real-provider usage and real-account distribution actions require their applicable authorization when execution begins.

## Prerequisites and maintenance

Before the signed-release milestone, confirm Apple Developer membership, Developer ID identity and custody, Team ID, notarization access, protected CI, final bundle identifier, release hosting, and test access to both Mac architectures and the supported macOS range. These are unverified prerequisites, not assumptions that credentials already exist.

Maintain one documented Electron/Chromium/Node update policy, repeat native packaging tests when versions change, and keep browser compatibility checks independent from desktop shell versions. User documentation must explain installation, close versus quit, external agent setup, updates, Open in Browser, and diagnostics. Update the relevant current architecture/convention documents as each behavior lands; this plan must not silently replace their as-built contracts.

Full plan acceptance still requires all release gates, the normal changelog/release hygiene, and reconciliation of the primary Chit backlog. Core local implementation is complete; remaining acceptance is tracked in the validation ledger. An implemented workflow does not prove signing or distribution succeeded.
