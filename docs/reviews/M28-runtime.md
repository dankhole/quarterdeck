# M28 runtime contract test review

Baseline: `fb9a34fbc41fb8464dd5133db066120c24eb866c`.

This supporting review covers all **110 primary files / 33,460 lines** assigned to `runtime_contracts` in [M28-coverage.json](./M28-coverage.json). **101 files received a full read; nine large suites received a case/assertion/helper audit with selected complete scenario bodies.** This is source inspection, not a claim that every test was executed or that all 33,460 lines were read consecutively. The per-file ledger below records the distinction. Findings use supporting-report IDs; consolidation belongs to M28.

The review used the review-code-smells skill, repository instructions, review resume/index, `docs/testing.md`, `test/README.md`, and the functional-testing skill's isolation/validation contract. No Agent Lab, browser, runtime/dev/dogfood instance, or real provider was launched. Production source was followed where necessary to assess the test seams, especially terminal reconciliation/summary normalization, hook ordering/outbox replay, execution ownership, host simulation, conversation compatibility, and filesystem operations. Existing M06–M09, M12, M15 and M16 reports supplied deduplication and prior production evidence, not substitutes for this test inspection.

## Distinct candidates

### M28-R01 — P3 · Host-simulation tests leave their temporary directories behind

- **Anchor:** `test/runtime/runtime-host-simulation.test.ts:11–25`; callers at lines 30, 88 and 102.
- **Trigger:** Run the host-simulation unit suite, including through a root/fast suite. `createSimulationFixture()` calls real `mkdtemp`, writes `simulation.json`, and returns paths without a cleanup function. The file has no `afterEach`, `rm`, or `finally` cleanup for these roots.
- **Impact:** Every run leaves three synthetic fixture roots; successful ledger-writing scenarios also leave `host-events.json`. Repeated local/CI test runs accumulate files outside the repository. This is a fixture lifecycle defect, not evidence of leaked production data.
- **Evidence:** Full read of the 186-line test and its host-simulation/ledger boundary. Ran `npm run test -- test/runtime/runtime-host-simulation.test.ts` with `TMPDIR` set to a unique worktree-local review directory: **one file, six tests passed**. Inspection after the process exited found retained fixture configuration and event-ledger files. The absence of cleanup is independent of test success.
- **Remedy:** Use the shared temporary-directory helper and register cleanup immediately in a suite-level cleanup collection, or wrap each fixture use in `try/finally`. Register the root before writes that can throw.
- **Validation after repair:** Run the same suite under an isolated `TMPDIR` and verify no `quarterdeck-host-simulation-test-*` roots remain after both successful tests and an injected assertion/setup failure.
- **Overlap:** Distinct from the parent M28 review's Agent Lab environment/state-home concerns; this file independently owns uncollected unit-test fixtures. No matching M01–M16 finding was identified.

### M28-R02 — P3 · The reconciliation error-isolation case never produces an error

- **Anchor:** `test/runtime/terminal/session-manager-reconciliation.test.ts:796–819`; production boundary `src/terminal/session-reconciliation-sweep.ts:34–65`.
- **Trigger:** Regress/remove the per-entry exception isolation in `reconcileSessionStates`. The case titled “error in one entry does not prevent checking others (39)” still exercises two ordinary successful entries.
- **Impact:** A named regression guard gives false confidence that one failing entry cannot prevent subsequent tasks from being reconciled. It does not cover the error path it advertises.
- **Evidence:** Read the entire case, fixture helpers, neighboring correction/notification cases, and complete production sweep. Both tasks use the same live mocked PTY and `setupStalePermissionReview`; all listeners are nonthrowing `vi.fn()` callbacks. Assertions require both stale activities to be cleared. No throw, rejected operation, or failing mock reaches the production `catch`. This is a static, concrete coverage defect; the current production catch exists and no production failure is claimed here.
- **Remedy:** Make the first entry fail at a seam actually inside the sweep's try block, such as a one-shot `store.getSummary` failure for its task ID. Verify the failure was exercised, the second entry was repaired, and the first failure was logged. Keep the present two-successful-entry scenario under an accurate title if useful.
- **Validation after repair:** Demonstrate that the revised test fails when the per-entry catch is removed or moved outside the loop, then passes against current production behavior. No production mutation was made during this review.
- **Overlap:** Related lifecycle domain to M06, but none of M06-F01–F06 is this test's unexercised exception-isolation contract. Do not present this as a new reconciliation production bug.

### M28-R03 — P3 · WebSocket quiet assertions ignore messages already in the queue

- **Anchor:** `test/runtime/terminal/ws-server.test.ts:183–195`; uses at lines 393, 417 and 453.
- **Trigger:** An unexpected output/control message arrives before `expectNoQueuedMessage()` installs its listener. The shared socket callback has already buffered it in `queuedSocket.queue`.
- **Impact:** The helper waits for future `message` events and resolves successfully without inspecting the existing queue. Restore buffering, restore-gap suppression, and replacement-control ownership checks can pass while unwanted messages are already present. This is a test false negative, independent of whether current production emits such a message.
- **Evidence:** Full read of all 568 lines, including queue producers, positive consumers, bridge teardown, fake terminal manager, and all three negative assertions. A fileless Node check extracted the real helper from the test, removed TypeScript syntax with `node:module`'s `stripTypeScriptTypes`, and called it with a real `EventEmitter` plus one queued Buffer. Actual result: `{"result":"resolved","queuedMessages":1}`. No event was emitted after listener registration.
- **Remedy:** Assert the queue is empty before waiting and when the quiet interval ends, while retaining rejection on future arrivals. If only particular frame kinds must be absent, check those kinds explicitly rather than ignoring the queue.
- **Validation after repair:** Cover both prequeued and subsequently arriving unexpected messages; both must fail the helper. Re-run the three restore/control scenarios.
- **Overlap:** [M07](./M07.md) already owns restore duplication (F03) and unbounded unacknowledged restore buffering (F04). This finding concerns the test helper's separate ability to conceal a queued message and does not re-report either production defect.

## Contract coverage and previously reported gaps

The tests contain useful real boundary checks: temporary on-disk ownership records and journal writes; actual Git repositories for many workdir operations; real HTTP/WebSocket transports for terminal bridge tests; real xterm state mirrors; generated Pi extension execution against controlled callbacks; and deferred promises/fake clocks for launch and interaction races. These were evaluated as specific assertions, not inferred from pass totals.

Provider and process doubles impose narrower guarantees. Adapter tests prove argument/environment construction and preparation behavior, not compatibility with a running provider. PTY manager tests largely use mocked PTYs and manually delivered callbacks. WebSocket tests use a fake terminal manager whose restore snapshot does not model the real mirror's advancing output boundary. The ownership-service harness does use the real `InMemorySessionSummaryStore`; it must not be dismissed as a wholesale fake-state harness.

| Existing owner | Test evidence and boundary still missing at this baseline |
| --- | --- |
| [M06-F01/F02](./M06.md) | Shutdown tests gate preparation and hook registration, while the reported post-spawn ownership-registration race remains a different boundary. Shell tests cover ordinary start/resize/stop but do not establish pending ownership for concurrent starts. |
| [M06-F03/F05](./M06.md) | Ordering/initial-start tests inspect hook and preparation gates; they do not establish that rejected/reused starts preserve every active-launch policy or that all pre-handoff hooks retain their full meaning. |
| [M06-F04](./M06.md) | Auto-restart tests cover crash budgets and Codex reconnect outcomes. Those assertions do not cover viewer-reconnect admission for failed Claude/Pi exact resume. |
| [M06-F06](./M06.md), [M08-F03](./M08.md) | Hook-order and interaction tests cover many correlated stale/delayed events; the existing ambiguity and parallel-tool completion counterexamples remain separate missing combinations. |
| [M07-F01/F05](./M07.md) | Orphan-cleanup tests positively expect name/parent-based Unix termination; managed-process tests use serial process/ownership snapshots rather than the publication/discovery race. These expectations cannot independently validate safe ownership. |
| [M07-F02/F03/F04](./M07.md) | Bridge tests include malformed JSON, restore acknowledgements, finite buffering and disconnects. They do not exercise the reported syntactically valid malformed control frames, real-mirror duplicate snapshot boundary, or indefinitely missing acknowledgement. R03 further weakens their quiet checks. |
| [M07-F06/F07](./M07.md) | Protocol-filter tests cover valid complete/split escapes. Mirror tests validate mirror behavior separately from inspection callbacks; neither establishes the reported incomplete-escape resource bound or live-byte reentrancy ordering. |
| [M08-F01](./M08.md) | Outbox tests assert a content-stripped persisted metadata shape that omits `transcriptPath`. Direct ingest/navigation tests do not pass through that serialization/replay boundary. |
| [M08-F02](./M08.md) | Codex trust tests accept recognizable transcript text as a prompt signal; passing pure detector/manager tests does not establish authorized prompt provenance. |
| [M09-F01/F02/F03](./M09.md) | Structured owner tests mock SDK initialization/process behavior and check mapped options. They do not establish the reported still-live replacement PID ownership or preserve the missing enablement/settings-file argument distinctions. |
| [M09-F04/F06](./M09.md) | Durable ownership and interaction tests exercise substantial failure and duplicate handling. Existing crash-receipt recovery and reverse-order answered-request counterexamples remain uncovered combinations. |
| [M09-F05](./M09.md) | `session-state-machine.test.ts:875–917` asserts a reducer patch returning Running without applying the real store normalization. Ownership-service tests use the real store, but the examined structured callback scenario exercises an unresolved wait, not that answered transition through normalization. |
| [M12-F01](./M12.md) | Lock-cleanup tests age lock files and stub locking; their successful cleanup assertions do not prove that an old live Git lock is safe to remove. |
| [M12-F02/F03](./M12.md) | Mutation/save tests cover traversal and static symlink escape. The validated-file-open suite has an explicit post-open parent-swap check, but this read-side test does not cover mutation-side aliases or parent replacement. |
| [M12-F04/F05/F06](./M12.md) | Workdir searches cover ordinary matching, bounds and leading spaces. These do not establish error-vs-empty outcomes, newline-containing names, or staged-delete/recreated-file visibility. |
| [M15-F01–F04](./M15.md) | Diagnostic tests validate limits, redaction, ordinary append failures, bundle privacy and identity handling. The existing admission, raw stderr, partial append retry and stale refresh counterexamples remain separate integration/failure paths. |
| [M16-F01](./M16.md) | Conversation fixtures exercise declared legacy/paginated histories and bounded reconstruction, but compatibility is not coupled to the native Codex launch policy. The synthetic service fixture defaults to `0.142.5`. |
| [M16-F02/F03/F04](./M16.md) | Generator/helper tests cover fallback order, local limiter accounting and diagnostic sink metadata. Those checks do not prove scheduler-wide admission across distinct title events or content-free default warning-console output on rejected model responses. |

These rows explain why substantial focused tests can coexist with the earlier findings. They are not additional M28 findings or claims that these are the only missing scenarios. No bare pass count was treated as evidence that a boundary is adequately tested.

## Exact inspection ledger

`Full` means the entire file was read, including imports/doubles, setup/cleanup, scenario bodies and assertions. `Audit` means scenario and assertion scans, complete fixture/helper/setup inspection, and selected complete bodies were reviewed; not every intervening construction line was read. Paths below are relative to `test/runtime/`. The nine audits have additional range notes after the table.

| Primary file | Depth | Scenarios / fidelity / cleanup examined |
| --- | --- | --- |
| api-validation.test.ts | Full | Schema rejection/normalization, query coercion and malformed API inputs; pure tests. |
| branch-base-ref.test.ts | Full | Branch/ref derivation and fallback; pure cases. |
| browser.test.ts | Full | Browser launch decisions and opener/process doubles. |
| clear-trash.test.ts | Full | Trash selection and task identity mutation contract. |
| codex-hooks.test.ts | Full | Hook configuration generation, managed merge/cleanup and provider event contract. |
| commands/hooks.test.ts | Full | Command registration and hook flags. |
| commands/statusline.test.ts | Full | Statusline command contract and fallback behavior. |
| conversation/bounded-jsonl-tail.test.ts | Full | Real bounded file reads, Unicode/partial lines and fixture cleanup. |
| conversation/conversation-read-service.test.ts | Audit | Provider fixtures, fork/rollback/compaction, identity, bounded tail/response and privacy; real files with cleanup registry. |
| conversation/provider-source-locator.test.ts | Full | Source identity, traversal/symlink containment, discovery limits and temporary roots. |
| diagnostics/bounded-value.test.ts | Full | Redaction, field/size bounds and bounded value shapes. |
| diagnostics/commands.test.ts | Full | CLI registration/options and command contract. |
| diagnostics/http.test.ts | Full | Authorization/routing, bounded transport replies and mock HTTP seams. |
| diagnostics/journal-recorder.test.ts | Full | Recording, flush/read, bounds and failure fixtures; M15 failure-path limits retained. |
| diagnostics/private-path.test.ts | Full | Private path validation and real fixture permissions/cleanup. |
| diagnostics/runtime-diagnostics.test.ts | Full | Capture/admission/privacy and runtime snapshot dependencies. |
| diagnostics/runtime-instance.test.ts | Full | Runtime metadata identity/lifecycle and fixture ownership. |
| diagnostics/snapshot-bundle.test.ts | Full | Snapshot budgets, privacy/schema, journal evidence and bundle filesystem cleanup. |
| directory-picker.test.ts | Full | Platform-specific command outputs, cancellation/failure and command doubles. |
| execution/claude-structured-owner.test.ts | Full | SDK start/interaction/interrupt/stop, mapped options and mocked process ownership. |
| execution/codex-app-server-client.test.ts | Full | Protocol request/reply/error/shutdown and transport lifecycle doubles. |
| execution/codex-model-catalog-cache.test.ts | Full | Cache freshness/single-flight/failure behavior with controlled loaders. |
| execution/codex-model-catalog.test.ts | Full | Model metadata transformation and catalog selection. |
| execution/native-input-authorization.test.ts | Full | Native input ownership epochs, denial and serialized authorization races. |
| execution/native-terminal-input.test.ts | Full | Native writer intent/result and unsupported/stale owner handling. |
| execution/project-execution-ownership-store.test.ts | Full | Real durable ownership records, epochs and malformed/missing records; cleanup. |
| execution/structured-owner-registry.test.ts | Full | Owner registration/identity/removal and lifecycle reuse. |
| execution/structured-shutdown-preparation.test.ts | Full | Structured shutdown preparation policy. |
| execution/task-execution-ownership-service.test.ts | Full | Handoff/restart/recovery and interaction races; real summary store, durable fixtures and stub owners. |
| execution/task-interaction-service.test.ts | Full | Input command authorization, receipts, duplication and unsupported owner behavior. |
| get-workdir-changes.test.ts | Full | Real Git refs/diffs, content revision, selected paths, whitespace and bounded binary/symlink excerpts; finally cleanup. |
| graceful-shutdown.test.ts | Full | Duplicate-signal timing, force exit/deadlines, programmatic shutdown and Windows signals; fake process/clock cleanup. |
| hook-metadata.test.ts | Full | Identity forwarding, native completion bounds, pending/background work and activity labels. |
| hook-transition-outbox.test.ts | Full | Real persistence/replay/order/TTL, metadata stripping, acknowledgements and state-home restoration. |
| hooks-source-inference.test.ts | Full | Unix/Windows provider inference, precedence and transcript metadata. |
| lock-cleanup.test.ts | Full | Stale/fresh lock paths and ownership assumptions; mocked locking versus real paths. |
| locked-file-system.test.ts | Full | Lock acquisition/failures/atomic writes and cleanup; proper-lockfile doubled. |
| mutate-workdir-entry.test.ts | Full | File/directory rename/delete, protected paths, containment and temporary roots. |
| open-project.test.ts | Full | IDE resolution/arguments, platform command construction and host-effect doubles. |
| output-utils.test.ts | Full | Formatting/escaping/normalization edge cases. |
| path-comparison.test.ts | Full | Platform normalization and path identity. |
| process-termination.test.ts | Full | POSIX groups, invalid PID and Windows tree-before-root/fallback; restored spies. |
| project-board-command.test.ts | Full | Reducer idempotence, title provenance, dependencies/reorder/stale preconditions and schemas. |
| project-path.test.ts | Full | Project path normalization/resolution. |
| project-state-index-windows.test.ts | Full | Windows identity/index behavior. |
| project-state-meta.test.ts | Full | Persisted metadata normalization and defaults. |
| project-state-utils.test.ts | Full | Project state shape/utility boundaries. |
| quarterdeck-command.test.ts | Full | Entrypoint/launcher command construction. |
| runtime-endpoint.test.ts | Full | Endpoint parsing/selection and invalid inputs. |
| runtime-host-integrations.test.ts | Full | Capabilities/typed outcomes and fail-closed host dispatch with stub openers. |
| runtime-host-simulation.test.ts | Full | Scoped ledger/privacy/persistence/reset, real temp fixtures; R01. |
| runtime-logger.test.ts | Full | Logging sink/filter/privacy behavior and logger reset. |
| save-workdir-file.test.ts | Full | Save conflicts, containment/symlinks, file identity and cleanup. |
| search-workdir-files.test.ts | Full | Real Git/filesystem search, filtering, bounds and ignored paths. |
| search-workdir-text.test.ts | Full | Search results/context/limits and file fixture cleanup. |
| shell.test.ts | Full | Platform shell selection and process/environment behavior. |
| shortcut-utils.test.ts | Full | Shortcut parsing/substitution and malformed inputs. |
| shutdown-coordinator-timeout.test.ts | Full | Phase bounds, failures, pending stops and deadline cleanup. |
| state-backup-lifecycle-operations.test.ts | Full | Backup lifecycle-operation payload and restoration contract. |
| task-board-mutations.test.ts | Full | Task/dependency/card reducer invariants and idempotence. |
| task-id.test.ts | Full | Task ID validation/normalization. |
| task-repository-info.test.ts | Full | Repository metadata and Git command failure/selection seams. |
| task-worktree.test.ts | Audit | Worktree identity/branch/copy/submodule/removal/lock cases; mocked Git/filesystem harness and cleanup. |
| terminal/agent-session-adapters.test.ts | Full | Claude/Codex/Pi arguments, resume/trust/environment/preparation; fake homes and restored environment. |
| terminal/claude-renderer-policy.test.ts | Full | Renderer policy decision table. |
| terminal/claude-workspace-trust.test.ts | Full | Trust prompt detection/config persistence and temporary paths. |
| terminal/codex-approval-prompt.test.ts | Full | Prompt parsing and approval scope/content cases. |
| terminal/codex-turn-interruption.test.ts | Full | Turn interruption evidence and identity/staleness. |
| terminal/codex-workspace-trust.test.ts | Full | Trust phrase/prompt detection; M08-F02 provenance gap. |
| terminal/hook-event-order.test.ts | Full | Native identities, occurrence order/replay, waits/completions and ambiguous correlation. |
| terminal/hook-runtime-context.test.ts | Full | Hook launch context identity/environment. |
| terminal/is-permission-activity.test.ts | Full | Permission activity classifier positives/negatives. |
| terminal/managed-process-ownership.test.ts | Full | Ownership records, process discovery and identity; serial snapshot limitation. |
| terminal/orphan-cleanup.test.ts | Full | Platform process selection/signals; M07-F01 unsafe ownership expectation. |
| terminal/pi-lifecycle-extension.test.ts | Full | Generated extension callbacks/native hooks, helper captures and temporary module cleanup. |
| terminal/pty-runtime-health.test.ts | Full | Native PTY health/probe outcomes and controlled binding behavior. |
| terminal/pty-session.test.ts | Full | Native spawn/write/resize/exit/termination/error paths; mocked bindings/filesystem and environment restore. |
| terminal/session-auto-restart.test.ts | Full | Restart classification/budget/backoff pure policy. |
| terminal/session-interaction-state-machine.test.ts | Audit | Wait ownership, response/cancel/input timing, stale/subagent events; direct patch merge helper. |
| terminal/session-launch-readiness.test.ts | Full | Readiness/preparation policy and failure outcomes. |
| terminal/session-manager-auto-restart.test.ts | Audit | Crash budgets, restart snapshots, preparation failures and reconnect behavior with fake PTYs. |
| terminal/session-manager-initial-start.test.ts | Full | Fresh startup, pending launch and failure/retry state with controlled preparation. |
| terminal/session-manager-interrupt-recovery.test.ts | Audit | Ctrl+C/Escape/ANSI/paste, hook confirmation and dead/live PID recovery; fake timers. |
| terminal/session-manager-ordering.test.ts | Audit | Hook/prepare/registration ordering, stale launches, coalescing, replay and output state; deferred gates. |
| terminal/session-manager-reconciliation.test.ts | Audit | Dead/missing path/processless recovery, timer/notification/output invariants; R02 full case. |
| terminal/session-manager-recovered-hook.test.ts | Full | Recovered native hooks, fencing and replay-state restoration. |
| terminal/session-manager-shell.test.ts | Full | Shell start/attach/resize/exit and fake PTY lifecycle. |
| terminal/session-manager-shutdown.test.ts | Full | Shutdown gates/pending starts/exit cleanup and idempotent process stop. |
| terminal/session-manager-workspace-trust.test.ts | Full | Trust prompt handling/timeouts/resume and input dispatch fences. |
| terminal/session-manager.test.ts | Audit | Attach/detach/viewport/summaries/checkpoints/metadata and pending input; real store with some private-entry fixtures. |
| terminal/session-reconciliation.test.ts | Full | Pure reconciliation checks/priority for dead, missing-path and processless states. |
| terminal/session-startup-recovery-policy.test.ts | Full | Recovery admission, exact resume and deterministic/transient failure policy. |
| terminal/session-state-machine.test.ts | Audit | Native/structured transitions, exit/review/interrupt and recovery; raw patch versus store boundary. |
| terminal/session-summary-store.test.ts | Full | Real summary normalization/identity/emission and state consistency. |
| terminal/session-transition-controller.test.ts | Full | Board/lifecycle consequences, updates and transition failure seams. |
| terminal/terminal-protocol-filter.test.ts | Full | Complete/split terminal controls, printable output and suppression. |
| terminal/terminal-state-mirror.test.ts | Full | Real xterm snapshots/resize/output/clear; disposed mirrors. |
| terminal/worktree-context.test.ts | Full | Worktree launch context and path/root derivation. |
| terminal/ws-server.test.ts | Full | Real HTTP/WS bridge, restore/IO/ACK/client replacement and teardown; fake manager; R03. |
| title-generator.test.ts | Full | Provider fallback, prompt/context bounds, normalization and limiter reset; mocked network/providers. |
| title-thread-context.test.ts | Full | Recent steering/proposal pairing, transcript bounds, duplicate completion and empty fallback. |
| title/codex-client.test.ts | Full | Isolated args/stdin, unavailable/failure, timeout termination, late callback and metadata privacy; fake child process. |
| title/commit-message-generator.test.ts | Full | Serial provider fallback, identical bounded context, selected files and untracked excerpts. |
| title/generation-response.test.ts | Full | Prefix/quote/noise removal, refusal/question and empty response rejection. |
| title/llm-client.test.ts | Full | Rate window/concurrency, environment URL/model config, failure/timeout diagnostics; fake fetch and restore. |
| title/summary-generator.test.ts | Full | Provider fallback, echo filtering, length/input bounds and empty results. |
| title/task-generation-context.test.ts | Full | Final-message recency and deduplication. |
| update-notification.test.ts | Full | Interactive gating, daily notifier configuration and suppressed failures. |
| validated-file-open.test.ts | Full | Real handles, canonical containment and parent replacement after open; platform skip and finally cleanup. |
| workdir-path-policy.test.ts | Full | Windows devices/streams/aliases/traversal and POSIX whitespace. |

Additional audit depth, beyond case/assertion scans across each listed suite:

- `conversation/conversation-read-service.test.ts`: complete fixture/helper setup at 1–138 and tail/budget/privacy scenarios at 1019–1218; selected provider reconstruction/fork/rollback/compaction bodies earlier in the file. Not every long JSON fixture body was read in full.
- `task-worktree.test.ts`: full 1–497, including mocked Git/filesystem locking helpers; case/assertion audit of 498–876.
- `terminal/session-interaction-state-machine.test.ts`: full helper/initial scenarios at 1–190; subsequent event/correlation assertions and selected event bodies.
- `terminal/session-manager-auto-restart.test.ts`: full fixture 1–82 and final scenarios 797–1049; preceding case/assertion audit.
- `terminal/session-manager-interrupt-recovery.test.ts`: full 1–100 fixture; case/assertion audit and selected recovery/input bodies through 713.
- `terminal/session-manager-ordering.test.ts`: full 1–170, setup/teardown at 323–337, and 850–1215; case/assertion audit and selected gates across all 2188 lines.
- `terminal/session-manager-reconciliation.test.ts`: full 1–190 helpers and 770–839, including R02; case/assertion audit and selected reconciliation scenarios through 1111.
- `terminal/session-manager.test.ts`: full 1–175, 529–667 and 778–910; case/assertion audit across remaining attach/resize/summary scenarios.
- `terminal/session-state-machine.test.ts`: full 1–100 and structured interaction cases at 875–967; case/assertion audit and selected transition payloads in between.

## Validation and retained artifacts

Only one existing test suite was executed for this supporting review: `npm run test -- test/runtime/runtime-host-simulation.test.ts` (**6/6 passed**, Vitest 5, Node 22.22.2). It ran with `TMPDIR` under `.quarterdeck/review-validation/m28-host-simulation.jVHSVW`; the entire uniquely owned directory, including Node compile-cache files and leaked test fixtures, was then removed. A subsequent existence check returned false. The WebSocket helper probe ran entirely in memory and created no file. R02 is validated by the concrete setup/production control-flow inspection, with mutation testing proposed as repair validation rather than claimed as performed.

No broad rerun, production source edit, persistent probe test, Git checkout/commit/push, or outside-worktree write was performed. The only retained artifact owned by this review is this report. Existing root/focused pass evidence in earlier modules remains historical evidence; it is not attributed to this run.
