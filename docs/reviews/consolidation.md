# Finding consolidation

Baseline: `fb9a34fbc41fb8464dd5133db066120c24eb866c`. Reassessed 2026-09-26 using the completed reports and four parallel reviewers.

**Recommendation: combine 33 findings into 16 bounded implementation tasks.** Leave the other **109 findings separate**, giving **125 proposed work items** instead of treating all 142 findings as separate tasks. This is a conservative grouping, not a claim that 125 is the minimum possible number of changes.

Keep all **142 finding IDs and their evidence**, including the six P1 findings. This pass found no additional exact duplicate to delete from the active index. The groups below share an implementation owner, one end-to-end behavior, or the test repair needed to verify that behavior; their failures still require separate regression checks. One group can ship in several small changes, and an urgent fix should not wait for adjacent work.

Each group inherits its highest member priority. All findings absent from the groups remain standalone under the [original index](./README.md#consolidated-findings). No application changes or external tickets were made.

---

## Recommended combined tasks

### C01 — Complete and recover Trash compensation

**Findings:** [M05-F01](./M05.md#m05-f01--p2--correctnesscompensation-failed-trash-permanently-removes-task-dependencies), [M05-F02](./M05.md#m05-f02--p2--correctnessrecovery-recovery-archives-a-task-after-its-trash-move-was-already-compensated). **Priority:** P2. **Owner:** ProjectTaskLifecycleService and its operation journal.

Preserve the dependency/workspace metadata destroyed by Trash, restore it through guarded compensation, and recognize a committed compensation before replaying forward effects.

**Complete when:** A stop failure restores still-valid dependencies and workspace identity; a crash after compensation cannot stop/archive the Review task on recovery; retrying Trash starts each linked child once.

### C02 — Own provisional task and shell launches

**Findings:** [M06-F01](./M06.md#m06-f01--p2--correctnessconcurrency-task-launch-can-publish-an-unstopped-process-after-shutdown), [M06-F02](./M06.md#m06-f02--p2--resource-lifecycleconcurrency-shell-starts-lack-pending-ownership-and-can-orphan-a-concurrent-pty). **Priority:** P2. **Owner:** Session lifecycle and lifecycle controller.

Track pending shell starts, admit/coalesce them per terminal, and fence task/shell publication after process-ownership registration. Include exact provisional-process cleanup in shutdown quiescence.

**Complete when:** Concurrent shell starts retain at most one process; shutdown during registration leaves no live provisional PTY or post-shutdown running summary, and pending activity is accounted for.

### C03 — Correlate native tool events by identity

**Findings:** [M06-F06](./M06.md#m06-f06--p2--correctnessevent-ordering-delayed-claude-tools-make-ambiguous-permission-ownership-depend-on-arrival-order), [M08-F03](./M08.md#m08-f03--p2--correctnessordering-a-parallel-tool-completion-suppresses-the-awaited-tools-completion). **Priority:** P2. **Owner:** Hook event ordering and the native session reducer.

Keep exact tool-use completions separate from same-name tools, and invalidate inferred permission ownership when delayed predecessors make it ambiguous.

**Complete when:** For no-ID waits, both predecessor orders and receipt replay remain unresolved until explicit matching resolution. For an ID-bearing wait on A, only A's completion resolves it regardless of B's arrival; real duplicates remain rejected.

### C04 — Make the terminal restore handoff exact and bounded

**Findings:** [M07-F03](./M07.md#m07-f03--p2--correctnessrestore-ordering-initial-restore-replays-bytes-already-present-in-its-snapshot), [M07-F04](./M07.md#m07-f04--p2--resource-lifecyclebackpressure-a-missing-restore-acknowledgement-retains-unlimited-output), [M28-F07](./M28.md#m28-f07--p3--websocket-test-helper-quiet-assertion-ignores-messages-already-queued). **Priority:** P2. **Owner:** Terminal restore coordinator and its WebSocket tests.

Establish the snapshot/output boundary, replay only later bytes, and bound pending output/time for an unacknowledged restore. Repair the quiet-test helper so it detects prequeued messages.

**Complete when:** Applying the snapshot plus post-boundary output reproduces the mirror state without duplicated or lost output. Missing acknowledgements, a control socket that never connects, and a closed control socket cannot leave retained output unbounded or obstruct a healthy sibling. Quiet assertions fail on both prequeued and newly arriving messages.

### C05 — Preserve Claude launch options during structured handoff

**Findings:** [M09-F02](./M09.md#m09-f02--p2--permission-preservation-enablement-only-claude-arguments-activate-bypass-during-handoff), [M09-F03](./M09.md#m09-f03--p2--configuration-preservation-accepted-claude-settings-files-are-silently-omitted-from-the-sdk-launch). **Priority:** P2. **Owner:** Claude structured-owner argument-to-SDK translation.

Represent bypass enablement separately from active permission mode, and carry configured settings through the SDK handoff without confusing them with generated hook settings.

**Complete when:** Captured SDK options preserve enablement/plan/bypass distinctions. A synthetic custom settings file's configured behavior and permission rules survive handoff/restart, while generated hook settings are not duplicated. Option-shape assertions alone do not establish effective settings behavior.

### C06 — Project structured interactions from the pending set

**Findings:** [M09-F05](./M09.md#m09-f05--p2--state-projection-resolved-structured-interactions-cannot-restore-running-through-the-real-store), [M09-F06](./M09.md#m09-f06--p2--interaction-identity-reverse-order-codex-answers-leave-an-already-answered-wait-active). **Priority:** P2. **Owner:** Structured owners, interaction reducer and normalized summary boundary.

Reconcile keyed pending callbacks with the single displayed interaction after every pending-set change, including requests, resolution, failure/cancellation and turn completion. Define provider-resolved retirement consistently with summary normalization while preserving native response-pending semantics.

**Complete when:** Tests through the normalized store cover one provider-resolved callback for both Claude and Codex, show an actually pending identity after either concurrent answer order, clear attention when no structured callback remains, and restore Running only with accepted provider resumption evidence.

### C07 — Preserve a restorable checkout before Trash removes it

**Findings:** [M10-F01](./M10.md#m10-f01--p1--data-preservation-trash-deletes-task-files-after-restore-patch-capture-fails), [M10-F02](./M10.md#m10-f02--p1--data-preservation-clean-detached-task-commits-disappear-from-trash-restore). **Priority:** P1. **Owner:** Worktree archive/capture/restore contract.

Protect the archived HEAD with an owned Git ref and durably publish any dirty patch before authorizing worktree removal; retain the existing archive and checkout if capture fails. Keep that ref for the archive's restorable lifetime, retiring it only after successful archive consumption or permanent purge. A stored SHA alone does not protect detached commits from pruning.

**Complete when:** Capture failure preserves files and the previous archive; both clean detached commits and dirty changes restore correctly, including after the base branch advances and unreachable objects are pruned in a disposable Git fixture. Repeated archive/restore cycles preserve commit ownership. The immediate fail-closed fix can ship before the broader archive representation change.

### C08 — Identify and own Git conflict operations

**Findings:** [M11-F03](./M11.md#m11-f03--p2--operation-ownership-failed-new-rebase-requests-abort-an-existing-operation), [M11-F07](./M11.md#m11-f07--p2--compatibility-apply-backend-rebases-cannot-be-detected-or-aborted). **Priority:** P2. **Owner:** git-conflict operation detection and action handling.

Detect both rebase backends for explicit Continue/Abort. Reject a new start when an operation already exists, coordinate mutations per checkout, and automatically abort only an operation proven to have been created by that request. Explicit Continue/Abort must still address a pre-existing paused operation.

**Complete when:** A rejected second request cannot abort the first operation or discard its resolution; merge/apply-backend rebases are detected and continued/aborted correctly, including linked worktrees.

### C09 — Authorize the actual Files mutation target

**Findings:** [M12-F02](./M12.md#m12-f02--p2--correctnesspath-policy-aliases-bypass-protected-directory-mutation-checks), [M12-F03](./M12.md#m12-f03--p2--correctnesscontainment-parent-replacement-redirects-a-checked-mutation-outside-the-worktree). **Priority:** P2. **Owner:** Files read-only policy and locked mutation/atomic-save boundary.

Apply protected-directory policy to canonical targets and carry approved parent identity through a containment-preserving commit after lock acquisition. A pre-lock check, or a second pathname check followed by another unchecked commit window, is insufficient.

**Complete when:** In-root aliases cannot edit protected metadata, and parent replacement cannot redirect save/create/rename/delete outside the worktree; legitimate aliases still work and cleanup remains correct.

### C10 — Preserve search failure from server to screen

**Findings:** [M12-F04](./M12.md#m12-f04--p2--correctnesssearch-errors-failed-text-searches-are-reported-as-successful-empty-results), [M24-F05](./M24.md#m24-f05--p2--search-errors-transport-failures-are-displayed-as-no-matches). **Priority:** P2. **Owner:** Text-search API plus Text Search/File Finder hooks and overlays.

Reserve empty success for a real no-match result, propagate typed backend failures, and show retryable failures for rejected browser requests.

**Complete when:** Invalid regex, timeout and output overflow cannot appear as zero matches; both overlays distinguish rejected requests from successful empty results. Bounded collection must not silently drop matches.

### C11 — Fence metadata publication by freshness and lifetime

**Findings:** [M14-F01](./M14.md#m14-f01--p2--correctnessconcurrency-an-older-full-refresh-overwrites-newer-home-git-metadata), [M14-F02](./M14.md#m14-f02--p2--resource-ownership-disposed-metadata-controllers-still-publish-after-replacement). **Priority:** P2. **Owner:** Project metadata refresher/controller.

Order overlapping home probes under one freshness owner and reject every publication/follow-up from a disposed controller generation.

**Complete when:** An older full probe cannot overwrite newer home metadata; a disposed controller cannot publish, persist inferred state or schedule follow-up work after replacement.

### C12 — Make board recovery own its queue and project

**Findings:** [M17-F01](./M17.md#m17-f01--p2--save-queue-an-edit-accepted-during-conflict-recovery-is-left-unsent), [M17-F02](./M17.md#m17-f02--p2--project-ownership-late-recovery-from-project-a-disables-project-b-edits). **Priority:** P2. **Owner:** use-project-sync conflict recovery.

Make recovery an explicit project/generation-scoped queue state and settle every edit admitted while recovery is pending.

**Complete when:** Every accepted edit reaches a saved or reported-failed terminal state without another user action, and covered flush waiters settle. A-to-B and A-to-B-to-A switches cannot let obsolete recovery clear the active project's revision or disable edits.

### C13 — Order config reads and saves within the active project

**Findings:** [M17-F03](./M17.md#m17-f03--p2--config-ownership-a-late-save-response-replaces-a-different-projects-config), [M17-F04](./M17.md#m17-f04--p2--readwrite-ordering-an-older-config-read-overwrites-a-successful-save-response). **Priority:** P2. **Owner:** use-runtime-config and query publication.

Fence mutation completion by project/save identity and establish a read-versus-write barrier against older queries.

**Complete when:** A late A save cannot replace B's config or saving state, and a pre-save read/error cannot replace an acknowledged newer value; close/reopen and overlapping saves retain correct ownership.

### C14 — Fence Files reloads and settle saves by tab identity

**Findings:** [M24-F01](./M24.md#m24-f01--p2--editor-correctness-a-late-reload-discards-edits-made-after-it-began), [M24-F02](./M24.md#m24-f02--p2--cache-lifecycle-a-save-finishing-after-files-unmounts-leaves-the-tab-stuck-saving). **Priority:** P2. **Owner:** Files editor workspace hook, tab revisions and scoped cache.

Tie forced reload permission to the tab revision at request time, and settle in-flight save state in the cache independently of a mounted React updater.

**Complete when:** Typing during reload survives; newer reloads supersede older ones; save success/failure after unmount clears saving state while preserving later edits and replacement-tab identity.

### C15 — Preserve dirty settings drafts across refresh

**Findings:** [M25-F01](./M25.md#m25-f01--p2--draft-ownership-a-changed-config-response-erases-unsaved-settings), [M25-F02](./M25.md#m25-f02--p2--draft-ownership-a-prompt-shortcut-refresh-discards-in-progress-edits). **Priority:** P2. **Owner:** Settings form and prompt-shortcut editor hydration.

Separate a new dialog/project opening from a config refresh, preserving dirty local edits when fresh or equivalent server values arrive.

**Complete when:** Both settings surfaces retain edited values across refresh; close/reopen and project switches deliberately initialize the correct baseline. Pending-save mutation controls remain the separate M25-F03 task.

### C16 — Elect one dogfood cleanup owner per state home

**Findings:** [M27-F03](./M27.md#m27-f03--p2--shutdown-ownership-dogfood-instances-with-separate-state-homes-share-one-cleanup-lock), [M27-F04](./M27.md#m27-f04--p2--concurrency-an-incomplete-dogfood-lock-can-elect-two-cleanup-owners). **Priority:** P2. **Owner:** Dogfood cleanup-lock protocol.

Scope lock identity to the canonical state home and publish/fence a complete ownership record so partial initialization cannot elect another owner.

**Complete when:** Independent state homes each retain cleanup responsibility; concurrent same-home acquisition yields one owner; stale-record recovery cannot unlink a replacement owner's lock.

## Similar findings that should stay separate

- **Server and browser config:** [M01-F03](./M01.md#m01-f03--p2--correctnessconcurrency-global-settings-saves-can-overwrite-unrelated-completed-updates), [M04-F03](./M04.md#m04-f03--p2--correctnessconcurrency-overlapping-selection-installs-another-projects-launch-configuration), [M13-F02](./M13.md#m13-f02--p2--scope-validation-unknown-project-configuration-requests-fall-back-to-activeglobal-configuration), [M14-F04](./M14.md#m14-f04--p2--project-scoping-background-base-ref-inference-uses-the-globally-selected-projects-configuration) concern persistence, registry selection, missing-scope validation and a background lookup respectively. C13 only covers browser response publication. C15 only covers local dirty drafts. Fixing one layer does not establish the others.
- **Other shell races:** [M13-F01](./M13.md#m13-f01--p2--resource-ownership-detail-shell-starts-can-run-inside-a-worktree-that-trash-is-deleting) needs task/worktree admission during Trash; [M21-F01](./M21.md#m21-f01--p2--lifecycleconcurrency-closing-a-shell-panel-does-not-cancel-its-pending-start) needs browser Close to retire a pending panel start. C02 fixes provisional PTY ownership at the server. These remain distinct work items.
- **Confirmation dialogs:** [M22-F05](./M22.md#m22-f05--p2--dialog-lifecycle-a-second-cherry-pick-confirmation-cannot-be-cancelled) has a cherry-pick guard that never resets; [M26-F01](./M26.md#m26-f01--p2--modal-lifecycle-stacked-confirmation-guards-make-the-next-escape-close-fail) has redundant Trash caller guards and double cancel delivery. They need different changes even if handled in one small UI batch.
- **Generated-text concurrency:** [M16-F02](./M16.md#m16-f02--p2--correctnessconcurrency-summary-polishing-claims-its-single-flight-slot-after-asynchronous-setup) must claim one task's polish operation before asynchronous setup; [M16-F03](./M16.md#m16-f03--p2--resource-usageconcurrency-separate-title-events-bypass-the-three-request-limit) needs a runtime-wide capacity limit across title events. A shared “generation concurrency” title would conceal two independent owners.
- **Diff requests and search identity:** [M23-F01](./M23.md#m23-f01--p2--fetch-failure-a-failed-priority-diff-becomes-a-cached-empty-file) caches fetch failure as success; [M23-F02](./M23.md#m23-f02--p2--selection-ownership-a-pending-file-response-replaces-a-newer-cached-selection) publishes a stale selection from a different hook. [M24-F03](./M24.md#m24-f03--p2--search-intent-edited-queries-can-navigate-or-publish-old-results) lets old search results navigate/publish under a new query. These are independent of C10's failure-versus-empty contract.
- **High-priority safety fixes:** [M11-F01](./M11.md#m11-f01--p1--data-preservation-single-file-operations-interpret-filenames-as-git-pathspecs) concerns Git pathspec interpretation, independent of C09's filesystem target authorization. [M28-F01](./M28.md#m28-f01--p1--test-isolation-inherited-state-home-can-overwrite-the-user-project-index) must isolate inherited state-home overrides and remains a standalone P1; child cleanup, Windows fixtures and ordinary temp-directory cleanup do not close it.

## Optional small batches

These can share a pull request for convenience, but are **not counted as further consolidation**:

- [M25-F04](./M25.md#m25-f04--p2--validation-settings-reports-success-after-discarding-an-empty-script-shortcut) plus [M25-F08](./M25.md#m25-f08--p3--maintainability-shortcut-label-suffix-logic-is-duplicated): while validating Settings shortcut rows, reuse the already-tested naming helper in the same section. Removing the duplicate helper alone does not fix silently discarded rows.
- [M15-F02](./M15.md#m15-f02--p2--privacyerror-handling-journal-failures-print-private-paths-to-stderr) plus [M16-F04](./M16.md#m16-f04--p2--privacylogging-rejected-model-responses-are-printed-to-the-default-warning-console): remove content from the named default-warning producers, with independent filesystem-path and model-response sentinel checks. They do not share one logging implementation or error classifier.
- M29's documentation corrections can be edited together, but lifecycle semantics, release references and an obsolete backlog gate require separate source checks.

## Existing work and validation

The [repo backlog](../todo.md) was checked. Its Files cache item covers deleted project/task/worktree scopes, whereas C14 addresses pending reload/save ownership and view unmount. Its shell-persistence item is a product decision independent of the launch races. Existing Files/diff profiling and Windows acceptance work should retain their stated scope; these groups do not turn unmeasured performance candidates into new defects. External issue trackers were not searched, so these are proposed scopes, not assertions that new tickets are missing.

No runtime or test suite was rerun for this planning pass. Existing evidence and cross-module call paths were reused. Mapping validation checks that every grouped ID is active, belongs to only one group and retains its priority; the remaining IDs default to individual work. The [completion audit](./completion-audit.md) remains the coverage record for the original review.
