# M28 supporting audit — integration, state and API tests

Baseline: `fb9a34fbc41fb8464dd5133db066120c24eb866c`. Scope is the 91 files assigned to `integration_state_api` in [M28-coverage.json](M28-coverage.json), totaling 26,560 source lines. This report supports [M28.md](M28.md); its candidate identifier is local to this audit and is not a second consolidated finding.

## M28-I01 — P2 · Native Windows smoke requires the removed implicit ignored-path mirror

**Trigger and impact.** Run the native Windows smoke test after the explicit `.worktreeinclude` copy change. Its repository fixture ignores `.windows-smoke-cache/` and `.windows-smoke.env` but never creates `.worktreeinclude`. The test then calls `lstatSync` on the missing worktree cache and requires a symbolic link. The smoke therefore fails after worktree creation, before its later task-agent PTY, hook, host-launch and orphan-process checks. Adding an include file alone is insufficient: current production creates ordinary copies, so the symbolic-link assertion would still fail. The Windows job invokes this suite directly in focused mode and includes it in the ordinary check lane.

**Narrow evidence.** [windows-native-smoke.integration.test.ts](../../test/integration/windows-native-smoke.integration.test.ts), lines 571–580, constructs the ignored source paths without an include file; lines 788–794 require the mirrored directory/link. No `.worktreeinclude` reference exists anywhere in that file. [task-worktree-setup.ts](../../src/workdir/task-worktree-setup.ts), line 143, invokes the copy owner. [task-worktree-symlinks.ts](../../src/workdir/task-worktree-symlinks.ts), lines 233–235, returns when the include file is absent; lines 263–268 preserve/create regular files rather than directory mirrors. [.github/workflows/test.yml](../../.github/workflows/test.yml), lines 105–111, selects the native suite. The suite is platform-gated, so non-Windows root-test success cannot validate these assertions.

**Validation performed.** A disposable real Git repository and detached worktree reproduced the exact fixture boundary without starting Quarterdeck or a provider. With the smoke's ignored directory/file but no include file, calling `copyIncludedIgnoredPathsIntoWorktree` produced `{"withoutInclude":{"cache":false,"file":false}}`. Adding explicit include entries and calling the same production function produced `{"withInclude":{"cacheIsDirectory":true,"cacheIsSymlink":false}}`. The probe used `node --import tsx --input-type=module` from stdin, the existing synthetic Git helper, filesystem sentinels and a `finally` cleanup; it left no source or fixture artifact. This establishes the platform-independent contract mismatch; native Windows execution was not performed.

**Smallest remedy and regression check.** Add explicit include entries to the smoke fixture, require an ordinary copied directory/file, mutate one copy and assert its source sentinel remains unchanged. Keep any legacy junction-removal test in a fixture that explicitly creates that legacy junction. Run the repaired native smoke on Windows, verifying execution proceeds through its later PTY, hook and cleanup assertions. The focused [worktree-include.integration.test.ts](../../test/integration/worktree-include.integration.test.ts) already correctly covers absent includes, ordinary copies and explicit legacy links.

**Overlap.** M10 inspected the production copy/no-follow implementation and reported no separate defect there. This is a stale required acceptance fixture, independent of M10's archive data-preservation findings and the separate Agent Lab PowerShell shim mismatch in M28.

## Shared infrastructure handoffs

The disposable-home review identified inherited `QUARTERDECK_STATE_HOME`/backup-root ownership as a shared-helper concern and handed it to M28's infrastructure owner. A separate nonwriting probe set a disposable custom state root, entered `withTemporaryHome`, and observed `{"homeIsDisposable":true,"stateStillInherited":true}` from path resolution. It restored the environment and removed the sentinel. The owned [runtime-config-helpers.ts](../../test/runtime/config/runtime-config-helpers.ts), lines 6–43, likewise changes HOME/USERPROFILE/PATH without pinning the explicit state-root override; [startup-session-prune.integration.test.ts](../../test/integration/startup-session-prune.integration.test.ts), lines 43–75, has an inline HOME-only variant. These are consumers/variants of the consolidated isolation finding, not separate candidates here.

The child-start cleanup gap was also handed off: numerous owned integrations await `startQuarterdeckServer` before entering their cleanup `try/finally`. The shared helper must own a spawned child even when readiness fails before it returns a stop handle. The consolidated report owns that finding; this audit did not launch a server to reproduce it.

## Coverage deductions and existing finding overlap

These are specific limits of the inspected test claims, not new copies of already reported production defects:

| Existing finding | What the owned tests establish; missing discriminator |
| --- | --- |
| [M01-F03/F04/F05](M01.md) | Config tests persist ordinary updates and normalized shortcuts. The concurrent-config case uses one-process `Promise.all`, with `selectedAgentId: "claude"` already selected by the fixture; it does not establish cross-process saves of two independently changed values. The probe timeout test observes a fake child kill and manually completes its callback, which cannot establish a deadline for a real SIGTERM-resistant child. |
| [M02-F01/F02](M02.md) | Runtime API stop assertions cover `waitForExit` with `undefined` launch identity. Middleware tests cover host/origin allowlists, not raw IPv6 runtime-origin construction. |
| [M03-F02/F04/F05/F06](M03.md) | Board and transaction tests exercise receipts, session snapshots, revision conflicts and crash recovery. They do not gate a board/title snapshot behind a newer session persistence, repeatedly reread a corrupted operation journal, or restore project configuration from a backup. Lifecycle admission tests are stronger than a schema-only check but do not cover every omitted-source move path. |
| [M04-F01/F02/F03/F04/F05](M04.md) | Shutdown/server tests establish successful cleanup sequencing, and startup fixtures establish recovery outcomes. They do not establish cleanup after every failed bind/pre-scan/index write, overlapping selected-project config loads, malformed upgrade decoding, or manager disposal while asynchronous hydration is pending. |
| [M05-F01/F02/F03](M05.md) | Lifecycle integration has substantial real durable-state coverage, including failed starts, stop timeouts, replay and delete recovery. The timeout fixture has no task dependency edge to preserve; recovery fixtures do not model a completed compensating Trash move whose journal update was lost; native Restart replay is not established by create/start replay. |
| [M10-F01/F02/F03](M10.md) | Worktree integration checks normal dirty archive/restore and invalid patch application. It does not establish preservation after archive capture/write failure, clean detached commits through Trash, or two projects using the same task ID. |
| [M11-F01/F03/F04/F06/F07/F08/F10/F11](M11.md) | Real Git fixtures provide useful operation coverage. Literal-path coverage is strongest for selected commits, not every single-file mutator; rebase fixtures start from a clean operation and use the default backend; stash API mocks preserve list positions; deletion-side reads do not resolve a deleted side; content assertions often match snippets; stash preview fixtures are tracked-file cases; UTF-8 history filenames do not cover tabs/newlines/quoted paths. |
| [M13-F01/F02](M13.md) | API tests verify task-resource serialization for task launch/delete and scoped delegation, but shell-start tests do not interleave detail-shell preparation with real Trash cleanup. The largely fixed mock scope does not establish unknown-project rejection for configuration. |
| [M14-F01/F02/F03/F04](M14.md) | Metadata tests gate task refreshes, prove shared-source batching and independent-project refreshes. These do not establish same-project home refresh generations, in-flight disposal publication, rejected Git administrative backlinks, or a background project's different configured default ref. |
| [M16-F01/F02/F03/F04](M16.md) | Conversation integration uses synthetic accepted records; summary tests gate generation after setup; scheduler tests deduplicate a task. They do not establish current native version admission, early asynchronous single-flight admission, global multi-event generation capacity, or helper-model default-warning privacy. Hook log privacy tests cover a different producer. |

Several weaker assertions are retained as cleanup notes rather than counted findings. [conversation-read-service.integration.test.ts](../../test/integration/conversation-read-service.integration.test.ts), lines 58–65, creates `unrelatedRuntimeOwners` that is never passed to the service; comparing its clone proves nothing about those owners, although the real store and provider-file immutability checks remain useful. [project-metadata-monitor.test.ts](../../test/runtime/server/project-metadata-monitor.test.ts), lines 63–70, creates each Review task twice, once ordinary and once unstarted with the same ID, so this helper cannot represent an unstarted-only task; production `collectTrackedTasks` filters the duplicate unstarted copy. Prefer one card per ID with an explicit `unstarted` fixture field. The setup-descendant case checks successful return and parent log text, without directly proving the descendant PID is gone. No independent production failure was established from these observations.

The hook API helper intentionally stops at a mock manager boundary: it invokes the real reducer and returns a merged summary but does not persist that patch to a real summary store. Its routing assertions should not be cited as end-to-end state/persistence evidence. The separate permission-guard tests do use the real manager/summary store with a fake PTY, and hook transition tests explicitly gate acknowledgement on persistence; those are materially stronger, distinct checks.

## Exact inspection depth

All 91 primary files were inspected beyond names/counts. **F** means the full file body was read, including arrangements, assertions, mocks, helper/setup code and cleanup. **S** means every test scenario, complete assertion expression, function-declared helper, setup/teardown hook and mock declaration/behavior was read through an AST-assisted source extract, followed by targeted original-body reads where an arrangement, race, cleanup or production boundary mattered. S does **not** claim every inline fixture literal or every test-body statement was read verbatim. There are 33 F files and 58 S files. This distinction prevents the inventory from implying a full-body review of all 26,560 lines.

Large S-file targeted reads included stream setup/seed/notification/metadata cleanup, worktree archive/restore contents, native Windows fixture/launch/check/cleanup, config concurrency arrangements, metadata board construction/refresh orchestration, hook routing/persistence arrangement, and API launch/resource-order boundaries. All 1,627 lines of lifecycle integration were read in full across bounded chunks. Complete assertion/mock review of the remaining suites was used to compare claimed invariants against the existing production findings above. No line/branch-coverage measurement, mutation run or runtime pass count is claimed.

| Primary file | Depth | Inspected responsibility |
| --- | --- | --- |
| `test/integration/clear-trash.integration.test.ts` | F | Trash clearing, returned state and worktree removal; disposable-home ownership. |
| `test/integration/cli-parent-disconnect.integration.test.ts` | F | Parent-disconnect child ownership, termination waiting and fixture cleanup. |
| `test/integration/codex-model-catalog.integration.test.ts` | F | Synthetic Codex catalog executable/protocol and cache behavior. |
| `test/integration/codex-task-title-monitor.integration.test.ts` | F | Persisted Codex titles, manual provenance and monitor cleanup. |
| `test/integration/codex-thread-names.integration.test.ts` | F | Thread-index append/update parsing using disposable provider data. |
| `test/integration/conversation-read-service.integration.test.ts` | F | Real read service, synthetic history, session/source immutability and source-hint persistence. |
| `test/integration/graceful-shutdown-signals.integration.test.ts` | F | Signal delivery, graceful-exit assertions and process cleanup. |
| `test/integration/legacy-backlog-lifecycle.integration.test.ts` | F | Legacy backlog migration, start and trash lifecycle with persisted state. |
| `test/integration/native-input-authorization.integration.test.ts` | F | Native hook identity and authorized input behavior against real summary ownership. |
| `test/integration/project-board-command-service.integration.test.ts` | F | Command admission, receipts/replay, revision conflicts, title effects and authoritative sessions. |
| `test/integration/project-discovery.integration.test.ts` | F | Project registration/discovery across child runtime and temporary directories. |
| `test/integration/project-management.integration.test.ts` | F | Project add/select/remove HTTP behavior and spawned-server cleanup. |
| `test/integration/project-state-transaction.integration.test.ts` | F | Crash fixture and transaction consistency between durable board and session files. |
| `test/integration/project-state.integration.test.ts` | F | Normalization, persistence, malformed durable fixtures, identity and conflict handling. |
| `test/integration/project-task-lifecycle-service.integration.test.ts` | F | Durable lifecycle replay, setup, compensation, recovery, stop timeout and delete receipts. |
| `test/integration/runtime-conversation-session-resolver.integration.test.ts` | F | Conversation resolver's project/task session ownership. |
| `test/integration/runtime-session-persistence.integration.test.ts` | F | Real persistence boundary, snapshot deduplication and persisted summaries. |
| `test/integration/server-restart.integration.test.ts` | F | Two-server restart sequencing, persisted Review sessions and worktree identity preservation. |
| `test/integration/shutdown-coordinator.integration.test.ts` | F | Shutdown order, sessions, worktrees, state and coordinator callbacks. |
| `test/integration/startup-session-prune.integration.test.ts` | F | Startup stale-session pruning and manual HOME restoration. |
| `test/integration/state-backup-transaction.integration.test.ts` | F | Backup snapshot transaction consistency and temporary artifact cleanup. |
| `test/integration/state-streaming.integration.test.ts` | S | Project stream isolation, notifications, input/state transitions and metadata delivery. |
| `test/integration/task-command-exit.integration.test.ts` | F | Linux-only CLI launch/browser stub behavior, child exit and server teardown. |
| `test/integration/task-worktree-identity.integration.test.ts` | F | Broken/reused Git administrative registration, sentinel file and replacement-index preservation. |
| `test/integration/task-worktree-setup.integration.test.ts` | F | Include-before-script order, retry policy, setup/removal serialization, timeout/log bounds. |
| `test/integration/task-worktree.integration.test.ts` | S | Real Git worktree creation/reuse/archive/restore; successful and failed restore contents. |
| `test/integration/windows-native-smoke.integration.test.ts` | S | Native Windows launch, state-root, Git, PTY, hook and orphan cleanup monolithic smoke. |
| `test/integration/worktree-include.integration.test.ts` | F | Explicit include/no-include, Git-ignore semantics, partial copy, concurrency and no-follow behavior. |
| `test/runtime/config/agent-registry.test.ts` | S | Availability/version/feature policy, cache refresh and timeout/launch mock contracts. |
| `test/runtime/config/agent-selection.test.ts` | S | Selection priority and fake installed-agent environment. |
| `test/runtime/config/audible-notifications.test.ts` | S | Notification configuration persistence and normalization. |
| `test/runtime/config/config-persistence.test.ts` | S | Global/project config persistence and same-process concurrent update arrangement. |
| `test/runtime/config/pinned-branches.test.ts` | S | Pinned-branch configuration and persisted normalization. |
| `test/runtime/config/prompt-shortcuts.test.ts` | S | Shortcut selection, labels, normalization and persistence. |
| `test/runtime/config/prompt-templates.test.ts` | S | Default/custom prompt-template behavior. |
| `test/runtime/config/runtime-config-helpers.ts` | F | HOME/PATH restoration, cache reset and POSIX/Windows fake-command generation. |
| `test/runtime/core/build-identity.test.ts` | S | Build identity inputs/output. |
| `test/runtime/core/command-discovery.test.ts` | S | PATH discovery and executable resolution with platform cases. |
| `test/runtime/core/git-process-env.test.ts` | S | Git environment inheritance/optional-lock behavior. |
| `test/runtime/core/keyed-operation-coordinator.test.ts` | S | Keyed serialization, independent keys and failure release. |
| `test/runtime/core/process-environment.test.ts` | S | Process environment sanitization contract. |
| `test/runtime/core/runtime-board-projection.test.ts` | S | Board projection from authoritative session states. |
| `test/runtime/core/task-indicators.test.ts` | S | Indicator precedence for native work, interactions, review and stalled state. |
| `test/runtime/core/task-resource-operation-coordinator.test.ts` | S | Task resource coordination keys, serialization and failure release. |
| `test/runtime/core/windows-cmd-launch.test.ts` | S | Windows argument quoting, command shim and PowerShell launch policy. |
| `test/runtime/git-behind-base.test.ts` | S | Real Git ahead/behind divergence fixtures. |
| `test/runtime/git-checkout.test.ts` | S | Real checkout success/refusal and branch state. |
| `test/runtime/git-commit.test.ts` | S | Selected-file commits, isolated index behavior, errors and literal-path case. |
| `test/runtime/git-conflict-integration.test.ts` | S | Real merge/rebase conflict fixtures and continuation/abort behavior. |
| `test/runtime/git-conflict.test.ts` | S | Conflict-side reads, marker extraction and resolution behavior. |
| `test/runtime/git-history.test.ts` | S | Real history/ref/diff parsing with fixture commits. |
| `test/runtime/git-stash.test.ts` | S | Real stash push/pop/apply/drop/list/preview and conflict scenarios. |
| `test/runtime/git-sync-no-optional-locks.test.ts` | S | Optional-lock preservation across Git status/sync calls. |
| `test/runtime/git-utils.test.ts` | S | Git refs, path validation, content reads and command error contracts. |
| `test/runtime/server/automatic-task-title-scheduler.test.ts` | S | Title event admission, same-task deduplication and stale task protection. |
| `test/runtime/server/codex-task-title-monitor.test.ts` | S | Codex native-title lookup, source identity and manual-title protection. |
| `test/runtime/server/middleware.test.ts` | S | Origin/host middleware acceptance and rejection. |
| `test/runtime/server/project-metadata-loaders.test.ts` | S | Metadata loads, caching inputs and task/home Git summaries. |
| `test/runtime/server/project-metadata-monitor.test.ts` | S | Polling focus/visibility, shared-source batching, refresh races and callbacks. |
| `test/runtime/server/project-metadata-visibility.test.ts` | S | Visibility aggregation across clients. |
| `test/runtime/server/project-orphan-maintenance.test.ts` | S | Orphan maintenance admission and current-task protection. |
| `test/runtime/server/project-registry-startup-recovery.integration.test.ts` | S | Startup recovery integration through registry and synthetic session manager. |
| `test/runtime/server/project-registry-startup-resume.test.ts` | S | Startup resume admission and scheduled recovery callbacks. |
| `test/runtime/server/project-state-diagnostics.test.ts` | S | Content-safe state diagnostics projection. |
| `test/runtime/server/runtime-server.test.ts` | S | Runtime server close and owned callback cleanup. |
| `test/runtime/server/runtime-session-persistence.test.ts` | S | Persistence controller snapshots, queueing and failures. |
| `test/runtime/server/runtime-state-client-registry.test.ts` | S | State-stream client registration/removal and per-project subscriptions. |
| `test/runtime/server/runtime-state-hub.test.ts` | S | State hub snapshots, publication, scoped notifications and client delivery. |
| `test/runtime/server/runtime-state-message-batcher.test.ts` | S | State message batching/coalescing and flush/close behavior. |
| `test/runtime/server/startup-session-recovery.test.ts` | S | Startup recovery retries, tokens, readiness and failure classifications. |
| `test/runtime/server/task-title-service.test.ts` | S | Manual title generation, task identity and source-stability publication. |
| `test/runtime/state/state-backup-execution-ownership.test.ts` | S | Backup execution ownership/serialization across owners. |
| `test/runtime/trpc/display-summary-polish.test.ts` | S | Display-summary scheduling, single-flight behavior and stale-source guards. |
| `test/runtime/trpc/hooks-api/_helpers.ts` | F | Hook mock manager, real reducer dispatch and fabricated summary return boundaries. |
| `test/runtime/trpc/hooks-api/agent-session-id.test.ts` | S | Provider session-id capture and mismatched ownership. |
| `test/runtime/trpc/hooks-api/checkpoints.test.ts` | S | Turn-checkpoint capture/delete dispatch. |
| `test/runtime/trpc/hooks-api/log-privacy.test.ts` | S | Hook payload redaction and log-level behavior. |
| `test/runtime/trpc/hooks-api/permission-guard.test.ts` | S | Real manager/reducer with fake PTY: permission correlation and foreground work evidence. |
| `test/runtime/trpc/hooks-api/summaries.test.ts` | S | Conversation/display summary dispatch and subagent exclusion. |
| `test/runtime/trpc/hooks-api/transitions.test.ts` | S | Hook acknowledgement/persistence barrier, order admission and launch handoff. |
| `test/runtime/trpc/open-project.test.ts` | F | Typed host target and capability rejection mapping. |
| `test/runtime/trpc/project-api-changes.test.ts` | S | File mutation metadata refresh and checkpoint-based diff selection. |
| `test/runtime/trpc/project-api-conflict.test.ts` | S | Conflict API delegation, errors and metadata publication. |
| `test/runtime/trpc/project-api-git-mutations.test.ts` | S | Git mutation shared-checkout guards, resource serialization and refresh effects. |
| `test/runtime/trpc/project-api-stash.test.ts` | S | Stash API delegation, scopes, errors and metadata refresh. |
| `test/runtime/trpc/project-api-state.test.ts` | F | Board-command delegation and manual-title effect publication. |
| `test/runtime/trpc/project-procedures.test.ts` | F | Procedure exposure and title-service routing. |
| `test/runtime/trpc/projects-api-directory-picker.test.ts` | F | Typed directory-picker cancellation and unavailable capability. |
| `test/runtime/trpc/runtime-api.test.ts` | S | Launch preparation/restore/start/stop/shell/host/cached catalog dependencies. |
| `test/runtime/trpc/runtime-mutation-effects.test.ts` | F | Mutation effect deduplication and scoped Git/title/log-level delivery. |
| `test/runtime/trpc/send-task-session-input.test.ts` | F | Transport bytes, platform Enter and explicit submit intent. |

## Validation and limits

Only the two disposable nonruntime probes described above were executed: ignored-file copy behavior and state-root path resolution. No test suite, Agent Lab, browser, Quarterdeck runtime/dev/dogfood instance, real provider or native Windows process was started. Existing M01–M16 results were used as cross-module evidence, not rerun or treated as new pass counts. The supporting report is the only file owned/written by this audit. Relative links and the 91-row ledger were checked against the filesystem and assigned inventory; temporary probes used stdin and removed their synthetic directories.
