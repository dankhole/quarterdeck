# Whole-repository review

Baseline: `fb9a34fbc41fb8464dd5133db066120c24eb866c`. Created 2026-09-26. This is a review of the current application, not a branch diff. The starting worktree was clean.

The map covers all **1217 tracked files** in **29 review modules**. These are review boundaries, not a proposal to reorganize the repository. The [exact file inventory](./module-inventory.json) assigns every baseline file to one primary module. Cross-module callers, callees and tests must still be traced. Root tests are inventoried under M28 but are evidence for every relevant module; colocated tests travel with their feature.

## Review process

1. Use **the available agent concurrency** for independent module reviews, assigning modules in numeric order as slots become available. This run started with three reviewers plus the coordinator and resumed with 11 total agent slots after the user raised the limit. Reviewers used extra-high reasoning for lifecycle, concurrency, persistence and security scopes, and high reasoning for more isolated modules. Each reviewer owned one report, read relevant repository conventions, and coordinated cross-module candidates. The coordinator verified coverage and consequential findings before marking a module reviewed; additional independent auditors checked P1 findings and final overlaps.
2. Inspect production entry points, state ownership, callers/callees and relevant tests. Cover bugs and failure paths, maintainability/code smells, architectural choices, concurrency/resource cleanup and performance. Evaluate optimization against a simpler implementation and the actual contract.
3. Report actionable findings with stable IDs (`M01-F01`), severity, category, narrow file/line anchors, concrete trigger and impact, evidence, the smallest practical remedy and validation needed. Do not impose a findings quota. Separate uncertain candidates and already-tracked work from new findings.
4. Write one report per module in this directory. State exactly which files/paths were examined, checks executed and unresolved gaps. Source inspection is not a passing runtime test; performance hypotheses need measurement before being called measured regressions.
5. The coordinating agent checks consequential findings against the code, deduplicates cross-module issues and updates this queue. A completed pass means the documented scope was reviewed, not that the module is certified bug-free.
6. If a module is too large to cover responsibly, split it into explicit submodules with disjoint primary file ownership before declaring it reviewed. List any unexamined paths as gaps rather than implying coverage.
7. Keep this run read-only for application code. Do not fix findings, create external tickets, commit, push, start the user's runtime or use real providers. Reports and this review tracker are the authorized output. Focused synthetic checks are allowed; any Agent Lab work must follow the repo-owned skill and stop its run.

Severity: P1 = substantial correctness/data-loss/security/availability defect; P2 = actionable normal-priority defect or material design/performance issue; P3 = concrete lower-impact maintainability cleanup. Reserve P0 for demonstrated immediate critical impact. Category and severity are independent.

## Current run

**29 of 29 modules reviewed**, with **142 supported findings** (6 P1, 122 P2, 14 P3). All module passes are complete; see final coverage and validation notes below.

The full-review objective is complete. Start with the [independent P1 audit](./priority-findings-audit.md) for the six highest-priority findings and the [completion audit](./completion-audit.md) for coverage, validation and limitations. Application fixes are outside this review run.

For implementation planning, the [consolidation map](./consolidation.md) groups 33 findings into 16 bounded tasks and leaves 109 standalone: 125 proposed work items. The 142 original findings and their regression checks remain intact.

## Validation environment

During the resumed full review, locked root (292 packages) and web (360 packages) dependencies were installed into this worktree with lifecycle scripts disabled. No dependencies are shared with the main checkout, and lockfiles are unchanged. Focused repository tests are now available where native dependencies permit; each report records what actually ran. Node is 22.22.2 and npm is 11.19.0 (the web manifest requests npm >=11.19.1, producing an install warning). M01–M03 retain their initial dependency-free validation evidence; M03 additionally records 14 focused tests after the main merge.

Install logs and transient review harnesses are under the ignored `.quarterdeck/review-validation/` directory. Evidence needed for findings belongs in the reports; temporary harnesses and passing suite output are not substitutes for the documented scope.

## Module inventory and progress

Source lines are an approximate sizing aid (code files excluding `.test.*` and root/browser test suites), not a coverage claim. Documentation/history, assets and lockfiles are inventoried but require contract/configuration review rather than line-by-line code review. Historical docs are consulted only where current sources leave a question unanswered.

| ID | Module | Files | Source lines | Status | Responsibilities |
| --- | --- | ---: | ---: | --- | --- |
| M01 | [CLI, configuration and agent discovery](./M01.md) | 14 | 3,751 | Reviewed | CLI commands, settings persistence, model catalog, availability and launch configuration. |
| M02 | [Shared contracts and platform primitives](./M02.md) | 42 | 4,527 | Reviewed | API schemas, validation, process/path helpers and shared coordination primitives. |
| M03 | [Durable board state and command authority](./M03.md) | 17 | 4,987 | Reviewed | Board persistence, revisions, receipts, mutations, backup and execution ownership records. |
| M04 | [Runtime bootstrap and project registry](./M04.md) | 9 | 3,200 | Reviewed | Runtime assembly, project registration, startup recovery, shutdown and session persistence. |
| M05 | [Managed task lifecycle orchestration](./M05.md) | 4 | 2,134 | Reviewed | Task start/stop/trash workflows, resource ownership and orchestration across state, worktrees and sessions. |
| M06 | [Terminal session lifecycle and reconciliation](./M06.md) | 16 | 6,162 | Reviewed | Session manager, state machine, transitions, reconciliation, interruption and recovery. |
| M07 | [PTY, terminal transport and output](./M07.md) | 17 | 3,106 | Reviewed | PTY process ownership, terminal mirror, WebSocket restore, fanout, backpressure and I/O pipelines. |
| M08 | [Provider adapters, native hooks and trust](./M08.md) | 19 | 4,964 | Reviewed | Claude/Codex/Pi launch adapters, hook delivery/order, approvals, trust and provider-specific lifecycle interpretation. |
| M09 | [Structured execution and provider handoff](./M09.md) | 12 | 5,259 | Reviewed | Exclusive structured owners, interaction authorization, provider clients and handoff/shutdown. |
| M10 | [Task worktree lifecycle](./M10.md) | 10 | 1,425 | Reviewed | Worktree creation, identity, setup, patching, removal, symlinks and setup locking. |
| M11 | [Git operations and checkpoints](./M11.md) | 11 | 3,603 | Reviewed | History, staging/commit, branch/sync/conflict/stash operations and turn checkpoints. |
| M12 | [Filesystem access, editing and search](./M12.md) | 13 | 1,676 | Reviewed | Path containment, locked/validated file access, file editing/mutation and bounded search. |
| M13 | [RPC, request security and host integrations](./M13.md) | 34 | 5,595 | Reviewed | tRPC wiring, mutation effects, API entry points, authentication/middleware and host capabilities. |
| M14 | [Project metadata and runtime state streaming](./M14.md) | 18 | 3,756 | Reviewed | Metadata collection/cache/polling, projections, subscriptions and stream batching. |
| M15 | [Diagnostics end to end](./M15.md) | 41 | 6,687 | Reviewed | Recorder/journal/bundles, diagnostics CLI/HTTP and browser collection/panel. |
| M16 | [Conversation reconstruction and generated text](./M16.md) | 40 | 4,768 | Reviewed | Provider transcript reading, conversation contracts, titles, summaries and commit-message generation. |
| M17 | [Browser runtime state and synchronization](./M17.md) | 52 | 4,500 | Reviewed | Runtime transport/store, authoritative hydration, project sync/cache and scoped providers. |
| M18 | [Application shell, navigation and layout](./M18.md) | 79 | 7,069 | Reviewed | App composition, project navigation, onboarding, dialogs, hotkeys and resizable surfaces. |
| M19 | [Board domain and interactions](./M19.md) | 70 | 7,298 | Reviewed | Board rendering, drag/dependencies, task actions, optimistic state and board hooks. |
| M20 | [Task creation, editing and detail surfaces](./M20.md) | 45 | 4,736 | Reviewed | Task prompt/options/images, editor state, create dialogs and task-detail composition. |
| M21 | [Browser terminal ownership and panels](./M21.md) | 65 | 6,923 | Reviewed | Terminal pooling/attachment, restore/resize/input, shell lifecycle and terminal panels. |
| M22 | [Git UI and workflows](./M22.md) | 67 | 9,699 | Reviewed | Git navigation, branch actions, history, commits, conflicts and stash UI. |
| M23 | [Diff loading and rendering](./M23.md) | 24 | 3,612 | Reviewed | Diff data/query/prefetch, split/unified renderers, parsing and highlighting. |
| M24 | [Files editor, file tree and search UI](./M24.md) | 27 | 4,023 | Reviewed | Editor workspace/cache, file content/tree, Files surface and search overlays. |
| M25 | [Settings, shortcuts and notifications](./M25.md) | 35 | 2,909 | Reviewed | Settings form/control wiring, prompt shortcuts, audio and review-ready notifications. |
| M26 | [Shared browser UI, utilities and assets](./M26.md) | 80 | 2,946 | Reviewed | UI primitives, browser utilities/storage, styles/assets, PWA and error capture. |
| M27 | [Build, dependency, release and developer tooling](./M27.md) | 44 | 1,801 | Reviewed | Packaging/build scripts, CI/release workflows, manifests/lockfiles and development commands. |
| M28 | [Test infrastructure and Agent Lab](./M28.md) | 263 | 6,216 | Reviewed | Root test coverage/fixtures, browser smoke infrastructure, isolated lab and fake-provider fidelity. |
| M29 | [Documentation and architecture consistency](./M29.md) | 49 | 0 | Reviewed | Active documentation, instruction routing and cross-module contract/backlog consistency; history is reference only. |

## Report and handoff contract

Each module report contains: baseline; scope and ownership; findings; uncertain candidates; existing-backlog overlap; validation/evidence; coverage limitations. Findings should link to repository files using relative paths and give line numbers in prose. Include an explicit “no supported findings” statement when appropriate.

For a later pass, check the baseline against the current revision and worktree, then read the relevant completed reports. If code changed, record affected modules as needing re-review; do not silently apply old findings to new code. Add new tracked files to the inventory with an explicit owner. Keep review-generated artifacts outside the baseline inventory.

## Consolidated findings

Findings below were checked against the source by the coordinating agent. Validation strength and outstanding executable checks are recorded in the linked reports. These are findings, not applied fixes.

| Finding | Priority | Summary | Report |
| --- | --- | --- | --- |
| M01-F01 | P1 | Squash prompt can land an old tree on a concurrently advanced target and silently discard the target’s new file changes. | [M01](./M01.md#m01-f01--p1--correctnessconcurrency-squash-landing-can-silently-discard-a-concurrent-target-change) |
| M01-F02 | P2 | `--no-update-notifier` is classified as a command invocation and exits the runtime after startup. | [M01](./M01.md#m01-f02--p2--correctnesscli-disabling-update-notices-also-exits-the-runtime) |
| M01-F03 | P2 | Concurrent global settings saves merge against stale snapshots and lose unrelated updates. | [M01](./M01.md#m01-f03--p2--correctnessconcurrency-global-settings-saves-can-overwrite-unrelated-completed-updates) |
| M01-F04 | P2 | Malformed persisted hidden-shortcut settings bypass normalization and prevent config loading. | [M01](./M01.md#m01-f04--p2--correctnessconfiguration-malformed-hidden-shortcut-settings-prevent-configuration-loading) |
| M01-F05 | P2 | Agent availability probes can remain pending after timeout when the child ignores SIGTERM. | [M01](./M01.md#m01-f05--p2--availabilityresource-lifecycle-the-probe-timeout-does-not-bound-a-sigterm-ignoring-probe) |
| M02-F01 | P2 | Stop RPC normalization discards a supplied session-instance ID, bypassing requested stale-session protection. | [M02](./M02.md#m02-f01--p2--correctnessconcurrency-stop-request-normalization-removes-the-requested-process-identity) |
| M02-F02 | P2 | IPv6 hosts produce invalid HTTP/WS origins and break stream upgrades. | [M02](./M02.md#m02-f02--p2--correctnessavailability-ipv6-hosts-produce-invalid-runtime-origins) |
| M02-F03 | P3 | Port parsing silently truncates malformed numeric inputs instead of rejecting them. | [M02](./M02.md#m02-f03--p3--correctnessinput-validation-port-parsing-silently-accepts-malformed-integers) |
| M03-F02 | P2 | Delayed board/title work can overwrite a newer acknowledged session snapshot with an older capture. | [M03](./M03.md#m03-f02--p2--correctnessconcurrency-older-board-work-can-overwrite-a-newer-persisted-session-snapshot) |
| M03-F04 | P2 | Corruption handling removes the lifecycle journal, allowing later reads to mistake lost history for an empty journal. | [M03](./M03.md#m03-f04--p2--correctnessrecovery-corrupt-lifecycle-journal-handling-forgets-the-durable-operation-history) |
| M03-F05 | P2 | Generic board moves can bypass managed restore admission by omitting the optional source column; merged main closes the start variant. | [M03](./M03.md#m03-f05--p2--architecturecorrectness-omitting-a-moves-source-bypasses-lifecycle-command-admission) |
| M03-F06 | P2 | Backups omit per-project configuration; change detection also misses project-config and pinned-branch-only edits. | [M03](./M03.md#m03-f06--p2--correctnessbackup-coverage-project-configuration-is-absent-from-backups) |
| M04-F01 | P2 | Failed startup leaves the previous bootstrap alive during port retry | [M04](./M04.md#m04-f01--p2--resource-lifecycleconcurrency-failed-startup-leaves-the-previous-bootstrap-alive-during-port-retry) |
| M04-F02 | P2 | Cleanup errors or a hung pre-scan bypass server close | [M04](./M04.md#m04-f02--p2--correctnessshutdown-cleanup-errors-or-a-hung-pre-scan-bypass-server-close) |
| M04-F03 | P2 | Overlapping selection installs another project's launch configuration | [M04](./M04.md#m04-f03--p2--correctnessconcurrency-overlapping-selection-installs-another-projects-launch-configuration) |
| M04-F04 | P2 | Malformed upgrade paths throw outside the request boundary | [M04](./M04.md#m04-f04--p2--availabilityinput-handling-malformed-upgrade-paths-throw-outside-the-request-boundary) |
| M04-F05 | P2 | Project disposal does not retire pending or existing manager reconciliation | [M04](./M04.md#m04-f05--p2--resource-lifecycleconcurrency-project-disposal-does-not-retire-pending-or-existing-manager-reconciliation) |
| M05-F01 | P2 | Failed Trash permanently removes task dependencies | [M05](./M05.md#m05-f01--p2--correctnesscompensation-failed-trash-permanently-removes-task-dependencies) |
| M05-F02 | P2 | Recovery archives a task after its Trash move was already compensated | [M05](./M05.md#m05-f02--p2--correctnessrecovery-recovery-archives-a-task-after-its-trash-move-was-already-compensated) |
| M05-F03 | P2 | Retrying a successful native Restart repeats the process effects | [M05](./M05.md#m05-f03--p2--correctnessidempotency-retrying-a-successful-native-restart-repeats-the-process-effects) |
| M06-F01 | P2 | Task launch can publish an unstopped process after shutdown | [M06](./M06.md#m06-f01--p2--correctnessconcurrency-task-launch-can-publish-an-unstopped-process-after-shutdown) |
| M06-F02 | P2 | Shell starts lack pending ownership and can orphan a concurrent PTY | [M06](./M06.md#m06-f02--p2--resource-lifecycleconcurrency-shell-starts-lack-pending-ownership-and-can-orphan-a-concurrent-pty) |
| M06-F03 | P2 | Pre-handoff hooks can be acknowledged before the launch can enforce their meaning | [M06](./M06.md#m06-f03--p2--correctnessidentity-pre-handoff-hooks-can-be-acknowledged-before-the-launch-can-enforce-their-meaning) |
| M06-F04 | P2 | Viewer reconnect bypasses terminal failure and restart admission | [M06](./M06.md#m06-f04--p2--correctnessrecovery-viewer-reconnect-bypasses-terminal-failure-and-restart-admission) |
| M06-F05 | P2 | Rejected starts replace the active launch's policy | [M06](./M06.md#m06-f05--p2--correctnessstate-ownership-rejected-starts-replace-the-active-launchs-policy) |
| M06-F06 | P2 | Delayed Claude tools make ambiguous permission ownership depend on arrival order | [M06](./M06.md#m06-f06--p2--correctnessevent-ordering-delayed-claude-tools-make-ambiguous-permission-ownership-depend-on-arrival-order) |
| M07-F01 | P1 | Unix orphan cleanup can terminate unrelated agents | [M07](./M07.md#m07-f01--p1--correctnessprocess-ownership-unix-orphan-cleanup-can-terminate-unrelated-agents) |
| M07-F02 | P2 | Malformed terminal frames terminate the runtime | [M07](./M07.md#m07-f02--p2--availabilitysocket-handling-malformed-terminal-frames-terminate-the-runtime) |
| M07-F03 | P2 | Initial restore replays bytes already present in its snapshot | [M07](./M07.md#m07-f03--p2--correctnessrestore-ordering-initial-restore-replays-bytes-already-present-in-its-snapshot) |
| M07-F04 | P2 | A missing restore acknowledgement retains unlimited output | [M07](./M07.md#m07-f04--p2--resource-lifecyclebackpressure-a-missing-restore-acknowledgement-retains-unlimited-output) |
| M07-F05 | P2 | Orphan discovery can delete an ownership record during publication | [M07](./M07.md#m07-f05--p2--correctnessconcurrency-orphan-discovery-can-delete-an-ownership-record-during-publication) |
| M07-F06 | P2 | Incomplete terminal escapes swallow and repeatedly copy subsequent output | [M07](./M07.md#m07-f06--p2--correctnessresource-bounds-incomplete-terminal-escapes-swallow-and-repeatedly-copy-subsequent-output) |
| M07-F07 | P2 | Inspection state changes reorder live terminal bytes | [M07](./M07.md#m07-f07--p2--correctnessoutput-ordering-inspection-state-changes-reorder-live-terminal-bytes) |
| M08-F01 | P2 | Outbox replay discards persistent Codex session navigation | [M08](./M08.md#m08-f01--p2--correctnessreplay-outbox-replay-discards-persistent-codex-session-navigation) |
| M08-F02 | P2 | Transcript text can trigger Codex trust confirmation | [M08](./M08.md#m08-f02--p2--input-authorization-transcript-text-can-trigger-codex-trust-confirmation) |
| M08-F03 | P2 | A parallel tool completion suppresses the awaited tool's completion | [M08](./M08.md#m08-f03--p2--correctnessordering-a-parallel-tool-completion-suppresses-the-awaited-tools-completion) |
| M08-F04 | P3 | A discharging Mac battery is shown as charging | [M08](./M08.md#m08-f04--p3--correctnessdisplay-a-discharging-mac-battery-is-shown-as-charging) |
| M09-F01 | P2 | Failed Claude initialization loses a still-live replacement PID | [M09](./M09.md#m09-f01--p2--process-ownership-failed-claude-initialization-loses-a-still-live-replacement-pid) |
| M09-F02 | P2 | Enablement-only Claude arguments activate bypass during handoff | [M09](./M09.md#m09-f02--p2--permission-preservation-enablement-only-claude-arguments-activate-bypass-during-handoff) |
| M09-F03 | P2 | Accepted Claude settings files are silently omitted from the SDK launch | [M09](./M09.md#m09-f03--p2--configuration-preservation-accepted-claude-settings-files-are-silently-omitted-from-the-sdk-launch) |
| M09-F04 | P2 | Crashed interaction receipts permanently block new commands | [M09](./M09.md#m09-f04--p2--recovery-crashed-interaction-receipts-permanently-block-new-commands) |
| M09-F05 | P2 | Resolved structured interactions cannot restore Running through the real store | [M09](./M09.md#m09-f05--p2--state-projection-resolved-structured-interactions-cannot-restore-running-through-the-real-store) |
| M09-F06 | P2 | Reverse-order Codex answers leave an already-answered wait active | [M09](./M09.md#m09-f06--p2--interaction-identity-reverse-order-codex-answers-leave-an-already-answered-wait-active) |
| M10-F01 | P1 | Trash deletes task files after restore-patch capture fails | [M10](./M10.md#m10-f01--p1--data-preservation-trash-deletes-task-files-after-restore-patch-capture-fails) |
| M10-F02 | P1 | Clean detached task commits disappear from Trash restore | [M10](./M10.md#m10-f02--p1--data-preservation-clean-detached-task-commits-disappear-from-trash-restore) |
| M10-F03 | P2 | Project-local task IDs address global worktrees and patches | [M10](./M10.md#m10-f03--p2--ownershipisolation-project-local-task-ids-address-global-worktrees-and-patches) |
| M11-F01 | P1 | Single-file operations interpret filenames as Git pathspecs | [M11](./M11.md#m11-f01--p1--data-preservation-single-file-operations-interpret-filenames-as-git-pathspecs) |
| M11-F02 | P2 | Git diff follows repository symlinks outside the project | [M11](./M11.md#m11-f02--p2--file-isolation-git-diff-follows-repository-symlinks-outside-the-project) |
| M11-F03 | P2 | Failed new rebase requests abort an existing operation | [M11](./M11.md#m11-f03--p2--operation-ownership-failed-new-rebase-requests-abort-an-existing-operation) |
| M11-F04 | P2 | Stash actions address a mutable list position | [M11](./M11.md#m11-f04--p2--identityconcurrency-stash-actions-address-a-mutable-list-position) |
| M11-F05 | P2 | Asynchronous completion reorders turns and crosses launches | [M11](./M11.md#m11-f05--p2--checkpoint-ownership-asynchronous-completion-reorders-turns-and-crosses-launches) |
| M11-F06 | P2 | Git blob reads strip meaningful whitespace | [M11](./M11.md#m11-f06--p2--content-fidelity-git-blob-reads-strip-meaningful-whitespace) |
| M11-F07 | P2 | Apply-backend rebases cannot be detected or aborted | [M11](./M11.md#m11-f07--p2--compatibility-apply-backend-rebases-cannot-be-detected-or-aborted) |
| M11-F08 | P2 | Choosing a deleted side cannot resolve a modify/delete conflict | [M11](./M11.md#m11-f08--p2--conflict-handling-choosing-a-deleted-side-cannot-resolve-a-modifydelete-conflict) |
| M11-F09 | P2 | A sync branch value becomes a Git push option | [M11](./M11.md#m11-f09--p2--argument-handling-a-sync-branch-value-becomes-a-git-push-option) |
| M11-F10 | P2 | Stash previews omit saved untracked files | [M11](./M11.md#m11-f10--p2--review-completeness-stash-previews-omit-saved-untracked-files) |
| M11-F11 | P2 | Quoted filenames lose their commit patch | [M11](./M11.md#m11-f11--p2--history-parsing-quoted-filenames-lose-their-commit-patch) |
| M11-F12 | P3 | Status probing duplicates existing shared parsers | [M11](./M11.md#m11-f12--p3--maintainability-status-probing-duplicates-existing-shared-parsers) |
| M12-F01 | P2 | Cleanup deletes locks held by live Git writers | [M12](./M12.md#m12-f01--p2--correctnesslock-ownership-cleanup-deletes-locks-held-by-live-git-writers) |
| M12-F02 | P2 | Aliases bypass protected-directory mutation checks | [M12](./M12.md#m12-f02--p2--correctnesspath-policy-aliases-bypass-protected-directory-mutation-checks) |
| M12-F03 | P2 | Parent replacement redirects a checked mutation outside the worktree | [M12](./M12.md#m12-f03--p2--correctnesscontainment-parent-replacement-redirects-a-checked-mutation-outside-the-worktree) |
| M12-F04 | P2 | Failed text searches are reported as successful empty results | [M12](./M12.md#m12-f04--p2--correctnesssearch-errors-failed-text-searches-are-reported-as-successful-empty-results) |
| M12-F05 | P3 | Newline-containing filenames are truncated despite NUL framing | [M12](./M12.md#m12-f05--p3--correctnesssearch-parsing-newline-containing-filenames-are-truncated-despite-nul-framing) |
| M12-F06 | P2 | Staged deletion hides a recreated working-tree file | [M12](./M12.md#m12-f06--p2--correctnessfile-search-staged-deletion-hides-a-recreated-working-tree-file) |
| M13-F01 | P2 | Detail-shell starts can run inside a worktree that Trash is deleting | [M13](./M13.md#m13-f01--p2--resource-ownership-detail-shell-starts-can-run-inside-a-worktree-that-trash-is-deleting) |
| M13-F02 | P2 | Unknown project configuration requests fall back to active/global configuration | [M13](./M13.md#m13-f02--p2--scope-validation-unknown-project-configuration-requests-fall-back-to-activeglobal-configuration) |
| M14-F01 | P2 | An older full refresh overwrites newer home Git metadata | [M14](./M14.md#m14-f01--p2--correctnessconcurrency-an-older-full-refresh-overwrites-newer-home-git-metadata) |
| M14-F02 | P2 | Disposed metadata controllers still publish after replacement | [M14](./M14.md#m14-f02--p2--resource-ownership-disposed-metadata-controllers-still-publish-after-replacement) |
| M14-F03 | P2 | Metadata trusts a Git registration rejected by launch and removal | [M14](./M14.md#m14-f03--p2--ownershipcorrectness-metadata-trusts-a-git-registration-rejected-by-launch-and-removal) |
| M14-F04 | P2 | Background base-ref inference uses the globally selected project's configuration | [M14](./M14.md#m14-f04--p2--project-scoping-background-base-ref-inference-uses-the-globally-selected-projects-configuration) |
| M15-F01 | P2 | Essential browser events are acknowledged and discarded | [M15](./M15.md#m15-f01--p2--correctnessadmission-essential-browser-events-are-acknowledged-and-discarded) |
| M15-F02 | P2 | Journal failures print private paths to stderr | [M15](./M15.md#m15-f02--p2--privacyerror-handling-journal-failures-print-private-paths-to-stderr) |
| M15-F03 | P2 | Retrying a partial append corrupts the replay boundary | [M15](./M15.md#m15-f03--p2--correctnesspersistence-retrying-a-partial-append-corrupts-the-replay-boundary) |
| M15-F04 | P2 | A stale refresh restores another runtime's diagnostics | [M15](./M15.md#m15-f04--p2--correctnessruntime-identity-a-stale-refresh-restores-another-runtimes-diagnostics) |
| M16-F01 | P2 | The history reader rejects every currently supported native Codex version | [M16](./M16.md#m16-f01--p2--correctnesscompatibility-the-history-reader-rejects-every-currently-supported-native-codex-version) |
| M16-F02 | P2 | Summary polishing claims its single-flight slot after asynchronous setup | [M16](./M16.md#m16-f02--p2--correctnessconcurrency-summary-polishing-claims-its-single-flight-slot-after-asynchronous-setup) |
| M16-F03 | P2 | Separate title events bypass the three-request limit | [M16](./M16.md#m16-f03--p2--resource-usageconcurrency-separate-title-events-bypass-the-three-request-limit) |
| M16-F04 | P2 | Rejected model responses are printed to the default warning console | [M16](./M16.md#m16-f04--p2--privacylogging-rejected-model-responses-are-printed-to-the-default-warning-console) |
| M17-F01 | P2 | An edit accepted during conflict recovery is left unsent | [M17](./M17.md#m17-f01--p2--save-queue-an-edit-accepted-during-conflict-recovery-is-left-unsent) |
| M17-F02 | P2 | Late recovery from project A disables project B edits | [M17](./M17.md#m17-f02--p2--project-ownership-late-recovery-from-project-a-disables-project-b-edits) |
| M17-F03 | P2 | A late save response replaces a different project's config | [M17](./M17.md#m17-f03--p2--config-ownership-a-late-save-response-replaces-a-different-projects-config) |
| M17-F04 | P2 | An older config read overwrites a successful save response | [M17](./M17.md#m17-f04--p2--readwrite-ordering-an-older-config-read-overwrites-a-successful-save-response) |
| M18-F01 | P2 | Task Open in IDE opens the project root | [M18](./M18.md#m18-f01--p2--scope-preservation-task-open-in-ide-opens-the-project-root) |
| M18-F02 | P2 | Failed project reorders never roll back | [M18](./M18.md#m18-f02--p2--optimistic-state-failed-project-reorders-never-roll-back) |
| M18-F03 | P3 | Layout persistence maintains state no production consumer reads | [M18](./M18.md#m18-f03--p3--maintainability-layout-persistence-maintains-state-no-production-consumer-reads) |
| M19-F01 | P2 | Same-column drops reorder the wrong stored indexes | [M19](./M19.md#m19-f01--p2--correctnessordering-same-column-drops-reorder-the-wrong-stored-indexes) |
| M19-F02 | P2 | A pending lifecycle command absorbs a different action | [M19](./M19.md#m19-f02--p2--correctnessintent-a-pending-lifecycle-command-absorbs-a-different-action) |
| M19-F03 | P2 | Resetting animations releases queued Trash work into the new project | [M19](./M19.md#m19-f03--p2--correctnessproject-ownership-resetting-animations-releases-queued-trash-work-into-the-new-project) |
| M19-F04 | P2 | A delayed shortcut submits a replacement project's terminal | [M19](./M19.md#m19-f04--p2--correctnessinput-ownership-a-delayed-shortcut-submits-a-replacement-projects-terminal) |
| M20-F01 | P2 | A create request that never persists loses its draft | [M20](./M20.md#m20-f01--p2--draft-ownership-a-create-request-that-never-persists-loses-its-draft) |
| M20-F02 | P2 | Concurrent image imports overwrite attachments | [M20](./M20.md#m20-f02--p2--async-state-concurrent-image-imports-overwrite-attachments) |
| M20-F03 | P2 | Selecting a file completion closes the inline editor first | [M20](./M20.md#m20-f03--p2--pointer-ownership-selecting-a-file-completion-closes-the-inline-editor-first) |
| M20-F04 | P2 | The inline Save shortcut starts the agent | [M20](./M20.md#m20-f04--p2--keyboard-contract-the-inline-save-shortcut-starts-the-agent) |
| M20-F05 | P2 | An old branch-name response overwrites a newer draft | [M20](./M20.md#m20-f05--p2--result-ownership-an-old-branch-name-response-overwrites-a-newer-draft) |
| M20-F06 | P2 | Split tasks silently ignore Create feature branch | [M20](./M20.md#m20-f06--p2--option-propagation-split-tasks-silently-ignore-create-feature-branch) |
| M21-F01 | P2 | Closing a shell panel does not cancel its pending start | [M21](./M21.md#m21-f01--p2--lifecycleconcurrency-closing-a-shell-panel-does-not-cancel-its-pending-start) |
| M21-F02 | P2 | Immediate pool reuse carries old output into the new task | [M21](./M21.md#m21-f02--p2--terminal-ownership-immediate-pool-reuse-carries-old-output-into-the-new-task) |
| M21-F03 | P2 | Dedicated shell updates erase an already restored prompt | [M21](./M21.md#m21-f03--p2--restore-ordering-dedicated-shell-updates-erase-an-already-restored-prompt) |
| M22-F01 | P2 | Stash & Pull retries a task operation in the home checkout | [M22](./M22.md#m22-f01--p2--scope-preservation-stash--pull-retries-a-task-operation-in-the-home-checkout) |
| M22-F02 | P2 | Resolved paths and previews survive into another conflict scope | [M22](./M22.md#m22-f02--p2--conflict-ownership-resolved-paths-and-previews-survive-into-another-conflict-scope) |
| M22-F03 | P2 | Deselecting every file still stashes all changes | [M22](./M22.md#m22-f03--p2--selection-semantics-deselecting-every-file-still-stashes-all-changes) |
| M22-F04 | P2 | Late commit work overwrites a newer message draft | [M22](./M22.md#m22-f04--p2--draft-ownership-late-commit-work-overwrites-a-newer-message-draft) |
| M22-F05 | P2 | A second cherry-pick confirmation cannot be cancelled | [M22](./M22.md#m22-f05--p2--dialog-lifecycle-a-second-cherry-pick-confirmation-cannot-be-cancelled) |
| M22-F06 | P2 | Metadata refresh leaves history pagination permanently busy | [M22](./M22.md#m22-f06--p2--request-lifecycle-metadata-refresh-leaves-history-pagination-permanently-busy) |
| M22-F07 | P3 | Task-agent Git orchestration has no production caller | [M22](./M22.md#m22-f07--p3--maintainability-task-agent-git-orchestration-has-no-production-caller) |
| M23-F01 | P2 | A failed priority diff becomes a cached empty file | [M23](./M23.md#m23-f01--p2--fetch-failure-a-failed-priority-diff-becomes-a-cached-empty-file) |
| M23-F02 | P2 | A pending file response replaces a newer cached selection | [M23](./M23.md#m23-f02--p2--selection-ownership-a-pending-file-response-replaces-a-newer-cached-selection) |
| M23-F03 | P2 | Review comments clear before terminal paste succeeds | [M23](./M23.md#m23-f03--p2--draft-preservation-review-comments-clear-before-terminal-paste-succeeds) |
| M23-F04 | P2 | Split context gutters show the new-file number on the old side | [M23](./M23.md#m23-f04--p2--line-coordinates-split-context-gutters-show-the-new-file-number-on-the-old-side) |
| M24-F01 | P2 | A late reload discards edits made after it began | [M24](./M24.md#m24-f01--p2--editor-correctness-a-late-reload-discards-edits-made-after-it-began) |
| M24-F02 | P2 | A save finishing after Files unmounts leaves the tab stuck saving | [M24](./M24.md#m24-f02--p2--cache-lifecycle-a-save-finishing-after-files-unmounts-leaves-the-tab-stuck-saving) |
| M24-F03 | P2 | Edited queries can navigate or publish old results | [M24](./M24.md#m24-f03--p2--search-intent-edited-queries-can-navigate-or-publish-old-results) |
| M24-F04 | P2 | A failed list refresh masks a committed file operation | [M24](./M24.md#m24-f04--p2--mutation-result-a-failed-list-refresh-masks-a-committed-file-operation) |
| M24-F05 | P2 | Transport failures are displayed as no matches | [M24](./M24.md#m24-f05--p2--search-errors-transport-failures-are-displayed-as-no-matches) |
| M24-F06 | P2 | Changing word wrap erases undo for unsaved edits | [M24](./M24.md#m24-f06--p2--editor-history-changing-word-wrap-erases-undo-for-unsaved-edits) |
| M24-F07 | P3 | Capture groups duplicate text in result snippets | [M24](./M24.md#m24-f07--p3--search-rendering-capture-groups-duplicate-text-in-result-snippets) |
| M25-F01 | P2 | A changed config response erases unsaved settings | [M25](./M25.md#m25-f01--p2--draft-ownership-a-changed-config-response-erases-unsaved-settings) |
| M25-F02 | P2 | A prompt shortcut refresh discards in-progress edits | [M25](./M25.md#m25-f02--p2--draft-ownership-a-prompt-shortcut-refresh-discards-in-progress-edits) |
| M25-F03 | P2 | Shortcut edits remain active after their save snapshot is submitted | [M25](./M25.md#m25-f03--p2--save-ownership-shortcut-edits-remain-active-after-their-save-snapshot-is-submitted) |
| M25-F04 | P2 | Settings reports success after discarding an empty script shortcut | [M25](./M25.md#m25-f04--p2--validation-settings-reports-success-after-discarding-an-empty-script-shortcut) |
| M25-F05 | P2 | Renaming a built-in prompt shortcut restores its old entry | [M25](./M25.md#m25-f05--p2--default-identity-renaming-a-built-in-prompt-shortcut-restores-its-old-entry) |
| M25-F06 | P2 | Inherited icon names produce an invalid React component | [M25](./M25.md#m25-f06--p2--input-validation-inherited-icon-names-produce-an-invalid-react-component) |
| M25-F07 | P2 | A queued sound plays after the tab becomes active | [M25](./M25.md#m25-f07--p2--visibility-policy-a-queued-sound-plays-after-the-tab-becomes-active) |
| M25-F08 | P3 | Shortcut label suffix logic is duplicated | [M25](./M25.md#m25-f08--p3--maintainability-shortcut-label-suffix-logic-is-duplicated) |
| M26-F01 | P2 | Stacked confirmation guards make the next Escape close fail | [M26](./M26.md#m26-f01--p2--modal-lifecycle-stacked-confirmation-guards-make-the-next-escape-close-fail) |
| M26-F02 | P2 | Blocked localStorage access escapes the fallback | [M26](./M26.md#m26-f02--p2--storage-availability-blocked-localstorage-access-escapes-the-fallback) |
| M26-F03 | P2 | Shared hover-only actions take invisible focus | [M26](./M26.md#m26-f03--p2--keyboard-visibility-shared-hover-only-actions-take-invisible-focus) |
| M26-F04 | P3 | Any user's home-shaped path is displayed as this user's home | [M26](./M26.md#m26-f04--p3--path-fidelity-any-users-home-shaped-path-is-displayed-as-this-users-home) |
| M27-F01 | P2 | Codex environment setup recreates dangerous shared dependency links | [M27](./M27.md#m27-f01--p2--dependency-isolation-codex-environment-setup-recreates-dangerous-shared-dependency-links) |
| M27-F02 | P2 | Pre-commit hook silently adds unstaged hunks | [M27](./M27.md#m27-f02--p2--git-staging-pre-commit-hook-silently-adds-unstaged-hunks) |
| M27-F03 | P2 | Dogfood instances with separate state homes share one cleanup lock | [M27](./M27.md#m27-f03--p2--shutdown-ownership-dogfood-instances-with-separate-state-homes-share-one-cleanup-lock) |
| M27-F04 | P2 | An incomplete dogfood lock can elect two cleanup owners | [M27](./M27.md#m27-f04--p2--concurrency-an-incomplete-dogfood-lock-can-elect-two-cleanup-owners) |
| M28-F01 | P1 | Inherited state home can overwrite the user project index | [M28](./M28.md#m28-f01--p1--test-isolation-inherited-state-home-can-overwrite-the-user-project-index) |
| M28-F02 | P2 | Fake Agent Lab PowerShell shim names an unset script variable | [M28](./M28.md#m28-f02--p2--windows-launcher-fake-agent-lab-powershell-shim-names-an-unset-script-variable) |
| M28-F03 | P2 | Startup timeout leaves the child server running | [M28](./M28.md#m28-f03--p2--integration-harness-startup-timeout-leaves-the-child-server-running) |
| M28-F04 | P2 | Fixture expects ignored-path junctions the worktree setup no longer creates | [M28](./M28.md#m28-f04--p2--windows-smoke-fixture-expects-ignored-path-junctions-the-worktree-setup-no-longer-creates) |
| M28-F05 | P3 | Host-simulation fixtures survive successful tests | [M28](./M28.md#m28-f05--p3--test-cleanup-host-simulation-fixtures-survive-successful-tests) |
| M28-F06 | P3 | Per-entry reconciliation error case never injects an error | [M28](./M28.md#m28-f06--p3--regression-test-per-entry-reconciliation-error-case-never-injects-an-error) |
| M28-F07 | P3 | “quiet” assertion ignores messages already queued | [M28](./M28.md#m28-f07--p3--websocket-test-helper-quiet-assertion-ignores-messages-already-queued) |
| M29-F01 | P2 | Developer guide assigns state transitions to Codex compaction | [M29](./M29.md#m29-f01--p2--lifecycle-documentation-developer-guide-assigns-state-transitions-to-codex-compaction) |
| M29-F02 | P3 | Packaged manual advertises an older version | [M29](./M29.md#m29-f02--p3--release-documentation-packaged-manual-advertises-an-older-version) |
| M29-F03 | P3 | Upstream idea is gated on a release that already happened | [M29](./M29.md#m29-f03--p3--backlog-documentation-upstream-idea-is-gated-on-a-release-that-already-happened) |

## Baseline reconciliation

At the user’s request, local `main` was merged into this worktree by fast-forward from `19ad5fbd` to `fb9a34fb` during review. The merge brought 133 changed files and 11 new files; all new files have an explicit module owner. M01–M04 were reconciled against their changed source and consequential contracts, and active reviewers resumed on the new baseline. M03’s transaction/migration delta passed 14 focused tests. The later modules reviewed the merged source directly. Earlier test evidence remains labeled by its original pass.

The merge resolved **M03-F01** (incomplete state commits) and **M03-F03** (inconsistent snapshots), and narrowed M03-F05 to the restore-admission bypass. The resolved findings are retained in [M03’s reconciliation](./M03.md#resolved-by-the-merged-local-main), excluded from the active finding count.

## Final coverage and validation

All 29 reports and the two M28 supporting audits are complete. The [completion audit](./completion-audit.md) records the exact 1,217-file ownership check, independent P1 review, deduplication, test-evidence limits and final artifact checks. The [resume handoff](./RESUME.md) now points to these completed results.

## Initial-batch validation and limits

- All 70 primary files in M01–M03 were inspected by their assigned reviewers; selected cross-module callers and test cases were traced. Read each report for its precise coverage.
- Dependency-free extracted-source checks exercised CLI classification, configuration normalization, probe timeout handling, endpoint parsing, stop-request field loss, persistence failure/interleaving, lifecycle classification/corruption, and synthetic backup/restore. Several use stubbed boundaries and are explicitly not repository integration tests.
- The coordinator independently checked consequential source paths, deduplicated overlap, and validated the inventory, new document links/anchors and whitespace. The baseline revision and application source remained unchanged.
- Root/web dependencies were absent during M01–M03. No Vitest, typecheck, browser, Agent Lab or real-provider lane ran for that batch. Later modules record their own focused checks. No application fixes, external tickets, commits or pushes were made. No measured performance claim is made.

For a later review or fix pass, reconcile the recorded baseline with the working tree first. Reuse existing finding IDs and revalidate their triggers against changed code. Fix selection is a separate step after review.
