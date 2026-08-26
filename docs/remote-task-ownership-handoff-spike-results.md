# Remote task ownership handoff spike results

Date: 2026-08-24

Integration status: the P2 recent-conversation reader is implemented and remains read-only. The Codex execution-owner coordinator and structured runner are implemented on `feature/remote-execution-ownership` and await reconciliation with the newer native interaction/ordering model; Claude structured ownership remains pending. Remote Companion transport, authentication, pairing, and mobile UI are not implemented.

## 1. Executive conclusion

Quarterdeck can hand an existing Claude Code session from its native TUI to an exclusive Agent SDK owner and back to the native TUI while preserving the exact provider session. The result for Claude Code is **supported with documented constraints**.

Quarterdeck can also hand an existing Codex session from its native TUI to an exclusive stdio app-server owner and back while preserving the exact thread and session-tree identity. Exact native handback worked after a normal structured turn, an explicit structured interrupt, and a killed structured owner. The result for Codex is **supported with documented constraints**.

The most important Codex finding is that the purpose-created native 0.149.1 thread reported `historyMode: "paginated"` from its first app-server read. Structured ownership did not cause that mode or convert the history. Both owners appended to the same provider-owned rollout JSONL, with the same filename/root and byte-stable earlier prefix. At spike completion, P2B's raw Codex parser accepted the observed record shape but would also expose one provider-injected instruction/environment record as a user message. The later P2 integration added the required narrow injected-context exclusion and paginated native/structured fixture family and removed the legacy-only assumption.

| Provider | Decision B | Exact native → structured → native proof | Durable-history conclusion |
| --- | --- | --- | --- |
| Claude Code | Supported with documented constraints | Succeeded, including handback after interrupt and structured-runner crash | Same session ID, root, filename, and append-only JSONL lineage; Agent SDK turns add provider-owned envelope variants and an interrupt sentinel that P2 must recognize |
| Codex | Supported with documented constraints | Succeeded, including fresh-process reconstruction, explicit interrupt, and native handback after structured-runner crash | Native started as paginated; both owners used one append-only rollout with unchanged envelope families and stable message IDs; crash left an incomplete provider turn reconstructed as interrupted |

The provider experiment itself was evidence-only. It added no production execution owner, structured provider runner, remote transport, authentication flow, mobile UI, or second transcript store.

Integration status: after the P2B implementation was merged into this branch, the authenticated history findings were applied to its existing read-only boundary. P2 now filters the Codex injected repository/environment record, gates supported Codex history modes and declared transcript versions, represents the exact Claude SDK interruption sentinel as a typed boundary, and carries redacted native/structured/native fixture families. Claude records do not embed a trustworthy CLI/SDK writer version, so P2 keeps the existing runtime minimum-version check and fixture-gates the accepted sentinel shape instead of inventing a per-transcript version test. This does not add execution ownership or change the Decision-B constraints below.

## 2. Branch, base, and environment

- Branch: `spike/remote-task-ownership-handoff`
- Local base: `feature/remote-access`
- Original spike base commit: `606191e532adf2794be7f534f4941a46443e8545`
- Latest local `feature/remote-access` commit merged for the P2 integration follow-up: `c602b2947f91367be251a3c1a980ec7c3c8799f3`
- OS: macOS 26.2, build 25C56, arm64
- Claude experiment harness: Node.js 26.5.0 and npm 11.17.0
- Codex follow-up harness: Node.js 22.22.2 and npm 11.19.0
- Native Claude Code: 2.1.224
- Claude Agent SDK: `@anthropic-ai/claude-agent-sdk` 0.3.241
- Claude Code bundled by that SDK package: 2.1.241, not executed for the round trip
- Structured Claude executable: explicitly pinned through `pathToClaudeCodeExecutable` to native Claude Code 2.1.224
- Codex CLI: 0.149.1
- Codex app-server schemas: standard and experimental JSON Schema plus experimental TypeScript generated from Codex CLI 0.149.1
- Read-only P2B impact baseline: local `feature/remote-conversation-reads` commit `6510f0bf`

The authoritative behavioral references were the official [Claude Agent SDK session guide](https://code.claude.com/docs/en/agent-sdk/sessions), [Claude Code session guide](https://code.claude.com/docs/en/sessions), [Claude SDK approvals and user-input guide](https://code.claude.com/docs/en/agent-sdk/user-input), [Claude SDK streaming-input guide](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), [Codex app-server guide](https://developers.openai.com/codex/app-server/), and [Codex configuration reference](https://developers.openai.com/codex/config-reference/). Installed types and generated schemas controlled where documentation and the installed version differed.

## 3. Credential isolation

### Claude Code

Classification: **inherited third-party-provider credential in process memory**.

The isolated Claude process reported an authenticated Amazon Bedrock configuration. Only the names of the required Bedrock selector, endpoint, region, and bearer/auth environment variables were allowlisted into child processes. Values were never printed, copied, exported to a file, or placed in an artifact. Claude ran with an isolated HOME, `CLAUDE_CONFIG_DIR`, XDG roots, synthetic repository, logs, and PID/control files.

### Codex

Classification: **OS-keychain credential scoped to a purpose-created Codex profile root**.

- A fresh browser ChatGPT login asked Codex 0.149.1 to store its credential through the supported macOS Keychain mode. No token value or credential file was read, copied, printed, or placed in an artifact.
- The authenticated process received the account HOME only for OS Keychain access. `CODEX_HOME`, all XDG roots, project, history, config, cache, temporary files, logs, schemas, PID records, and artifacts remained beneath one disposable root.
- No `auth.json` existed beneath the disposable root at any point.
- A scope matrix proved that this installed release's Keychain lookup is selected by the exact `CODEX_HOME`: changing XDG roots preserved login, while changing `CODEX_HOME` lost login. Production must therefore treat the server-owned Codex profile root as part of the provider configuration identity shared by both owners; there is no supported global-across-`CODEX_HOME` setting.
- The normal Codex native-app login and normal provider history were not changed or used. The isolated login was separate and its synthetic rollout was the only provider history read.

No real Claude or Codex task, project, or history was used.

## 4. Experiment matrix and outcomes

| Matrix item | Claude Code | Codex |
| --- | --- | --- |
| A. Native baseline | Passed: native TUI created one synthetic session and persisted one user/assistant exchange | Passed: native TUI created one exact thread, persisted one exchange, and stopped through its PTY before replacement |
| B. Native → structured | Passed: a new SDK process verified the exact init session ID before its turn and appended one completed high-level interaction | Passed: app-server read and resumed the exact stored thread before `turn/start`; the completed turn appended once to the same rollout |
| C. Structured → native | Passed: native `--resume <exact-id>` verified the same ID and demonstrated context from both earlier owners | Passed: `codex resume <exact-id> <synthetic-prompt>` demonstrated context from both prior owners and appended once |
| D. Structured process reconstruction | Passed: separate SDK processes reopened the same session; no global-latest lookup was used | Passed: fresh app-server processes reread/resumed the exact thread; `thread/turns/list` reconstructed nine unique turns after the failure matrix |
| D. Structured interrupt | Passed with a provider-specific boundary: `Query.interrupt()` caused the single-shot iterator to throw typed `error_result`; history recorded an interrupt sentinel and no completed assistant record for that attempt | Passed: exact `turn/interrupt(threadId, turnId)` completed as `interrupted`; raw history appended one `turn_aborted` boundary and no assistant message |
| D. Structured crash | Passed: a dedicated process group was killed immediately after exact identity verification; the killed attempt was omitted from durable history and native exact-session handback succeeded | Passed with ambiguity constraint: exact app-server group was killed after turn acceptance; raw history contained `task_started` but no prompt/assistant, restart classified that turn interrupted, and exact native handback succeeded |
| D. Active-owner rejection | Passed in a no-provider coordinator simulation: replacement start count remained zero while the owner was active or stop timed out | Same proposed shared coordinator behavior |
| D. Delayed callback fencing | Passed in simulation: an old instance/generation exit could not finalize or clear its replacement | Same proposed shared coordinator behavior |
| E. Configuration parity | Exact cwd, model, effort, session, MCP-empty state, plugin-empty state, and environment allowlist matched; tools, permission mode, and skills intentionally differed and expose required production constraints | Exact cwd/thread/session/model and explicit low-effort turn setting matched; same Codex profile/config/instruction source was used; resume reported effort as null, so production must reapply the frozen value |
| F. Structured identity | Live session, assistant-message, interaction-completion, question request, and question tool-use identities observed | Live turn completion, Plan-mode question, and command-approval requests carried thread/turn/item and interaction-specific IDs |

The harness made only bounded synthetic calls. Two setup attempts exited before starting Claude, one initial interrupt attempt completed before cancellation and served as a process-reconstruction control, and one initial crash attempt completed before an externally approved signal arrived. The final interrupt and crash cases used deterministic in-process timing. None of these attempts overlapped provider owners.

The Codex follow-up made nine synthetic turn attempts: three normal round-trip turns, one explicit interrupt, one default-mode question attempt, one declined approval attempt, one killed structured turn, one native crash-recovery turn, and one Plan-mode question attempt. Preflight/native-wrapper failures created no provider thread. No two provider writers overlapped.

## 5. Claude findings

The official SDK documentation says sessions persist prompts, tool calls, tool results, and responses to disk, and that an exact session can be resumed by passing its ID. The native session documentation separately says SDK sessions are excluded from the interactive picker and `--continue`, but remain resumable by exact `claude --resume <session-id>`. The experiment confirmed that cross-interface path.

Observed results:

- The native SessionStart hook supplied the exact session ID from the purpose-created isolated process.
- The Agent SDK `SystemMessage` init ID and completion result ID matched the stored ID.
- The SDK used the external 2.1.224 executable, avoiding a mixed native/structured CLI version during the proof.
- The native handback SessionStart hook returned the same ID before the third prompt was sent.
- The handback assistant response demonstrated prior context from both the native and structured turns.
- Native records present before handoff remained byte-prefix-stable and all hashed native/message IDs remained a subset after both later owners appended.
- Normal SDK ownership added `queue-operation`, `attachment`, `tool_use`, and `tool_result` records around the same ordinary user/assistant lineage. It did not create a second file or session.
- `AskUserQuestion` produced both a stable SDK control `requestId` and `toolUseID` in the installed SDK.
- The installed `CanUseTool` type supplies the same two identifiers for permission callbacks. A separate permission request was not triggered deterministically; production must fail closed for any callback that lacks the installed-version identifiers.
- Claude exposes message UUIDs and a completion/result UUID, but not a first-class turn ID equivalent to Codex's `turnId`. Quarterdeck must treat the structured operation ID plus provider message/completion UUIDs as correlation, not invent a provider turn ID.
- The explicit SDK interrupt surfaced as a typed iterator error, not a successful completion object. The durable log contained the SDK user prompt followed by a provider-generated user-side interrupt sentinel with the same prompt ID and no assistant record for that attempt.
- The forced crash occurred after init identity verification but before a durable prompt record appeared. Quarterdeck must never auto-replay such an ambiguous in-flight request.

### Claude decision constraints

Claude conversion is supportable only if production:

1. Pins and compatibility-gates the native CLI/Agent SDK tuple and verifies the external executable path.
2. Stops and waits for the exact native process before constructing the SDK owner, and performs the reverse ordering on handback.
3. Uses exact `resume`; never `continue` or another latest-session selector.
4. Freezes a server-derived configuration manifest and maps it explicitly into both native flags/settings and SDK options.
5. Rejects mid-turn handoff by default. An explicit interrupt path must call `Query.interrupt()`, wait for terminal/error resolution, reread durable history, and only then replace the owner.
6. Treats a structured crash with an in-flight turn as `turn_outcome_unknown`; it may reread and hand back, but must not automatically replay prompt content.
7. Requires stable request/tool-use identity for interactive callbacks and fails closed when the installed provider version cannot supply it.
8. Adds the P2 interrupt-boundary compatibility work described below before claiming complete remote recent-context fidelity.

## 6. Codex findings

The authenticated 0.149.1 experiment established the following:

- Native `codex` created one purpose-built thread in the synthetic repository. The purpose-created rollout was the only session file, and its exact ID came from that file's `session_meta`, never from a list/latest operation.
- The native PTY owner received its stop sequence and exited before app-server started. App-server used stdio JSONL only, completed `initialize`/`initialized`, called exact `thread/read`, then exact `thread/resume` without `history`, `path`, `thread/list`, or a latest selector.
- Both read and resume returned the expected `thread.id` and `thread.sessionId`, the expected cwd, `source: "cli"`, no fork parent, and one instruction source confined to the synthetic repository.
- `turn/start` ran with the same selected `gpt-5.6-sol` model, explicit `low` effort, read-only/no-network sandbox, and `never` approval policy for normal turns. Its completion notification repeated the exact returned turn ID.
- Native exact-ID handback demonstrated both earlier synthetic codewords without response text being retained. A fresh app-server process later reread/resumed the same identity, and `thread/turns/list` reconstructed nine unique turns: seven completed and two interrupted.
- The first native-created thread already reported `historyMode: "paginated"`; no structured turn caused a mode transition. This differs from the legacy-default assumption in earlier official/static evidence, so installed live behavior controls the compatibility conclusion.
- Native and structured turns appended to one unchanged rollout path. Every checkpoint retained the baseline byte prefix and all baseline native IDs. The top-level envelope family stayed `session_meta`, `event_msg`, `response_item`, `world_state`, and `turn_context`; structured ownership did not introduce a second history format.
- All 17 parser-shaped user/assistant `response_item` records had unique provider IDs and the expected `input_text`/`output_text` block shape. One of the nine user-role records was provider-injected repository-instruction/environment context, not a conversational user message; the P2B baseline inspected during the spike accepted it and needed the narrow exclusion described in section 11. The integration follow-up now supplies that exclusion.
- Exact interrupt produced terminal `status: "interrupted"`, one raw `turn_aborted` event, and no assistant message for that turn.
- Killing the exact app-server process group after `turn/start` acceptance left a raw `task_started` event but no durable prompt marker or assistant message. After restart, the provider reconstructed that dangling turn as interrupted. Native exact handback succeeded and retained earlier context. Quarterdeck must classify this window as `turn_outcome_unknown` and must not replay automatically.
- Default-mode prompting did not produce `requestUserInput`. Explicit Plan mode produced one live `item/tool/requestUserInput` request with connection request ID, thread ID, turn ID, item ID, and per-question ID, then completed on the same turn ID.
- A harmless write command under read-only/on-request policy produced one live `item/commandExecution/requestApproval` with connection request ID plus thread/turn/item scope. The harness declined it, `serverRequest/resolved` arrived, and no file was created. The regular shell approval correctly had no additional `approvalId`; the installed type reserves that field for subcommand callbacks.
- JSON-RPC request IDs were reused by separate app-server connections. They are connection-local routing IDs, not durable global identities; production must scope them by owner generation/connection plus provider thread/turn/item/question or approval identity.
- The persisted thread effort stayed `low`, but `thread/resume` reported `reasoningEffort: null` even when supplied the selected value. `turn/start` accepted the explicit value. Production must reapply the frozen effort and treat a null resume field as unavailable evidence, not as a default or mismatch.

Important identity distinction: handoff targets `thread.id`. `thread.sessionId` is the session-tree root and can differ after a fork. Quarterdeck must store and verify both, never invoke `thread/fork`, and reject a changed root unless a separately supported provider operation explains it.

### Codex decision constraints

Codex conversion is supportable only if production:

1. Pins and fixture-gates the native CLI/app-server/schema/history tuple, beginning with the authenticated 0.149.1 behavior rather than assuming the older legacy default.
2. Uses the same server-owned `CODEX_HOME`/profile identity for both owners; it must never copy a credential, use a browser-supplied root, or silently fall back to another profile.
3. Stops and waits for the exact native PTY before starting app-server, and stops the exact app-server process group before native handback.
4. Uses exact `thread.id` for `thread/read`, `thread/resume`, `turn/start`, and native `codex resume <id>`; no latest, list, history/path override, or fork fallback is permitted.
5. Freezes cwd, model, effort, instruction sources, hooks, tools, MCP, sandbox, approvals, environment allowlist, and Codex profile, then reapplies values the resume response does not report.
6. Rejects mid-turn handoff by default. An explicit interrupt path must call exact `turn/interrupt`, await terminal `turn/completed`, reread durable history, and only then replace the owner.
7. Treats a structured crash after turn acceptance as outcome-unknown even when restart later classifies it interrupted; it may hand back or reconstruct, but cannot replay automatically.
8. Scopes structured questions and approvals by owner generation/connection and full provider identity tuple; JSON-RPC request ID alone is insufficient.
9. Adds the P2 injected-context exclusion and paginated round-trip fixture/compatibility work in section 11 before declaring remote recent-context support complete.

## 7. Native → structured → native identity proof

### Claude Code

No raw provider session ID is recorded here. The isolated session's SHA-256 classification begins `b4c10ec4`; the same hash appeared in every normal owner init/result record.

| Checkpoint | JSONL records | Bytes | SHA-256 prefix | Evidence |
| --- | ---: | ---: | --- | --- |
| Native baseline | 10 | 3,992 | `771fc62f` | One distinct user prompt UUID/prompt ID and one terminal assistant UUID |
| After structured turn | 20 | 16,821 | `dae78dd1` | Same prefix/file; two cumulative high-level user prompts and two terminal assistant responses; structured question subrecords present |
| After native handback | 26 | 20,434 | `ae5e2786` | Same prefix/file; three cumulative high-level user prompts and three terminal assistant responses |
| End of failure matrix | 61 | 42,678 | `b892abf1` | Same session lineage after interrupt recovery, process reconstruction controls, crash omission, and native recovery |

The baseline ID set was a subset of the structured checkpoint; the structured ID set was a subset of the native-handback checkpoint. All normal high-level prompt UUIDs, prompt IDs, and terminal assistant UUIDs were unique. The labels used were `NATIVE_A`, `STRUCTURED_B`, `NATIVE_C`, `INTERRUPT_D`, `NATIVE_AFTER_INTERRUPT`, `CRASH_E`, and `NATIVE_AFTER_CRASH`; no prompt or response content is retained in this document.

### Codex

The real provider ID is omitted. Its SHA-256 classification begins `693822d9`; `thread.id` and `thread.sessionId` had that same classification at every checkpoint because this was an unforked root thread.

| Checkpoint | JSONL records | Bytes | SHA-256 prefix | Evidence |
| --- | ---: | ---: | --- | --- |
| Native baseline | 14 | 44,433 | `e473c267` | One provider rollout, native source, paginated mode, one user/assistant exchange |
| After structured turn | 25 | 57,225 | `b7309c68` | Same path/identity/prefix; structured marker and assistant appended exactly once |
| After native handback | 36 | 76,918 | `4520ebbf` | Same path/identity/prefix; native response contained both prior codewords |
| After exact interrupt | 42 | 79,680 | `60306384` | Same prefix; one user record plus `turn_aborted`, no assistant record |
| Immediately after structured crash | 79 | 114,038 | `2ae8d64e` | Same prefix; one dangling `task_started`, no crash prompt marker or assistant record |
| After native crash recovery | 90 | 122,684 | `59dba9f1` | Same exact native handback; response again contained both original codewords |
| End of interaction matrix | 106 | 160,150 | `f2edd499` | Same path/identity/prefix after live question and approval identity checks |

All nine snapshots retained every baseline provider ID. At the end, the rollout held 17 unique parser-shaped native message IDs: one provider-injected user-role context record, eight synthetic user prompts, and eight assistant records. The explicit interrupt had no assistant, while the approval turn emitted assistant records on both sides of its tool request; raw message counts therefore are not turn counts. The crash-incomplete prompt never became a durable user record. `thread/turns/list` reconstructed both the explicit interrupt and crash-incomplete turn as interrupted.

## 8. Single-writer and process-fencing evidence

- Every provider owner had an explicit wrapper PID/process group; native Claude also recorded its exact child PID.
- Each replacement began only after the former tool session reported exit or the exact PID/process group was confirmed absent.
- Native idle processes were stopped with exact `SIGTERM` after their Stop hook because the safety harness had disabled slash commands. Exit status 143 was observed before replacement.
- Normal SDK processes exited 0 after their completed result.
- Interrupted SDK ownership ended non-zero through the typed SDK error path; the exact owner PID was absent before native recovery.
- Crash simulation placed only the structured runner and its descendants in a dedicated process group, verified the exact session at init, targeted that group with `SIGKILL`, and confirmed the group no longer existed before native recovery.
- Codex native owners ran in dedicated PTYs. Normal and recovery stops sent interrupt then EOF through that owner interface, observed exit without `SIGTERM`/`SIGKILL`, and started no replacement until the exact wrapper/process group was gone.
- Each Codex app-server process wrote a launch-specific PID/process-group record, verified exact thread and session-tree hashes before any turn, closed after terminal completion, and was absent before native handback. The crash case targeted only that recorded group.
- The Codex crash attempt left no live provider process. A harness-only unused notification timer was stopped separately after the provider group was already confirmed gone; it held no provider authority.
- No concurrency was tested by running two writers. The pure coordinator simulation rejected handoff while the current owner was active and on stop timeout, so replacement start count remained zero.
- The simulation started one replacement only after successful stop, replayed the same operation ID without another start, ignored a delayed exit from the former instance/generation, and preserved the replacement as authoritative.

The spike therefore proves a viable stop-and-wait/fence mechanism. It does not justify optimistic or overlapping owner startup.

## 9. Configuration parity

| Category | Claude result | Codex result | Production rule |
| --- | --- | --- | --- |
| cwd/worktree | Equivalent, observed by hash and SDK init | Equivalent: exact synthetic cwd returned by read/resume and used by every turn | Derive server-side from the task worktree; reject missing/divergent worktree |
| Exact provider identity | Equivalent, observed | Equivalent: exact thread and session-tree identities live-tested in both directions | Store provider resume target; verify init/read response before authority changes |
| Model | Equivalent in the experiment | Equivalent: catalog default `gpt-5.6-sol` frozen in native/resume/turn | Freeze explicit model/deployment selection; treat provider fallback as degraded |
| Reasoning/effort | Equivalent in the experiment | Explicit `low` used by native and turns; persisted value stayed low, while resume reported null | Reapply frozen effort; null/unknown response is unavailable evidence, not a default |
| System/repository instructions | Same synthetic repository; full real-project parity not exercised | Same synthetic `AGENTS.md`; resume reported one instruction source inside the project | Build one server-derived manifest; verify reported instruction sources/fingerprint |
| Hooks | Native hook plus minimal SDK hook, intentionally not identical | Empty isolated hook config in both modes | Declare one active hook configuration per owner; fence callbacks by generation |
| Tools | Native restricted to `Read`; SDK exposed its default tool set | Same built-in installation/profile; normal turns prohibited tools; interaction turns exercised question/command request | Explicit allowlist; reject a mapping that broadens capability |
| Tool permissions | Native `dontAsk`; SDK reported default/manual alias and callback policy | Normal `never`; one `on-request` command approval was declined and resolved | Map explicit policy and fail closed on unknown/experimental combinations |
| MCP | Empty in both Claude modes | Empty isolated config in both modes; no MCP request/startup event | Freeze server-derived config; required server failure blocks ownership |
| Skills/plugins | Native skills disabled; SDK reported skills and no plugins | Same isolated `CODEX_HOME`; provider-installed system skills present; apps disabled; no skill/plugin use triggered | Compatibility manifest must mark equivalent, intentionally disabled, or unsupported |
| Sandbox | Not independently exercised | Read-only/no-network used for structured turns; native launched read-only | Never send both legacy sandbox and permission profile; pin one versioned mapping |
| Environment allowlist | Equivalent narrow allowlist | Same narrow allowlist in native and app-server; no credential environment inherited | Server-owned allowlist only; never accept browser environment values |
| Questions/approvals | Question live-tested; generic permission identity from installed types | Plan question and command approval live-tested; default-mode question did not trigger | Require full addressable tuple; unsupported requests fail closed |
| Interrupt/stop | SDK interrupt plus exact process stop observed | Exact turn interrupt/completion and exact process stop observed | Interrupt, await terminal event, then stop/wait exact process |
| Resume/compaction | Exact resume observed; compaction not exercised | Exact resume/restart live-tested; compaction not exercised | Preserve exact ID; version/fixture gate compaction before support |

The intentionally different Claude rows are evidence that provider defaults are not a parity contract. Production support depends on an explicit manifest, not on what either interface happens to restore.

## 10. Stable interaction identity

| Interaction | Claude 2.1.224 + SDK 0.3.241 | Codex app-server 0.149.1 |
| --- | --- | --- |
| Session/thread | Stable session ID from System init and Result; live-tested | Exact `thread.id` resume target plus verified `thread.sessionId`; live-tested |
| Turn | No first-class provider turn ID; use Quarterdeck operation ID and provider message/completion UUIDs | Unique turn ID returned by start and repeated by completion; `clientUserMessageId` remains correlation, not assumed idempotency |
| Question | Live `requestId` and `toolUseID`; question text itself is not an identity | Live connection request ID, thread/turn/item IDs, and per-question ID in Plan mode |
| Permission/tool approval | Installed `CanUseTool` options include `requestId` and `toolUseID`; not separately triggered live | Live connection request ID plus thread/turn/item IDs; regular shell had null `approvalId`, as typed |
| Interrupt target | The owning `Query` handle; no provider turn ID | Exact `threadId` plus `turnId` |
| Completion | Stable Result UUID and message IDs; live-tested | Exact `turn/completed` thread/turn scope; live-tested for completed and interrupted turns |

Quarterdeck must give every handoff and submitted interaction its own durable idempotent operation ID. Provider IDs correlate provider events; they do not replace Quarterdeck idempotency unless the provider explicitly documents that guarantee. Codex JSON-RPC request IDs repeated across separate app-server processes, so route them only inside the current owner generation/connection and never persist them as globally unique identities.

## 11. Durable history and P2 impact

### Claude answers

| Question | Answer |
| --- | --- |
| Same durable history as native TUI? | Yes |
| Same exact provider session ID? | Yes |
| Fork or replacement session? | No |
| Filename or root changed? | No |
| JSONL envelope/record shape changed? | The file format stayed JSONL, but SDK ownership added `queue-operation`, `attachment`, tool-use/result, and interrupt-sentinel envelopes |
| Codex `historyMode` impact? | Not applicable |
| Native IDs stable? | Yes; prefix and ID-subset checks passed |
| Source-byte fallback IDs valid? | Yes for existing append-only records; no observed rewrite moved old byte coordinates, and ordinary SDK messages carried UUIDs |
| P2 additions? | No new locator or general second parser; add a Claude SDK fixture family, interrupt-boundary parser case, and version compatibility gate |
| Can P2 remain read-only? | Yes |

The read-only P2B Claude parser at commit `6510f0bf` already ignores non-message envelopes and tool-only content, and it consumes SDK text-array messages. One precise gap was found: the provider-generated interrupt sentinel is a `type: "user"` text-array record with a UUID and prompt ID, but without the preceding SDK prompt's `promptSource`, origin, or permission-mode fields. The current parser would expose it as a normal user message.

Recommended P2 integration work:

1. Add a `claude/agent-sdk-round-trip` fixture family with content-redacted equivalents of normal SDK question/tool subrecords, native handback, interrupt sentinel, crash-before-append, and compaction once tested.
2. Recognize the installed-format interrupt sentinel narrowly. Prefer a typed `interrupted` conversation boundary with the provider UUID; if the public contract cannot add that boundary yet, ignore it rather than rendering it as user text.
3. Test that the sentinel and immediately preceding SDK prompt share one provider prompt ID, that no completed assistant record is fabricated, and that old native IDs/source-coordinate fallbacks remain stable.
4. Add a Claude CLI/SDK version compatibility gate; unknown envelope or sentinel changes should degrade or fail closed rather than silently changing recent context.
5. Keep the existing exact-root locator. No new Claude history root, filename pattern, or second transcript source is needed.

Integration resolution for item 4: the observed Claude JSONL contains no authoritative CLI/SDK writer version. P2 therefore cannot enforce the Codex-style per-file range honestly. It retains Quarterdeck's runtime Claude minimum-version check, recognizes only the fixture-proven single-block sentinel, and requires fixture review when supported Claude or SDK versions change. An unknown sentinel shape remains ordinary text unless it matches some future explicit provider discriminator; silently guessing that user-role text is provider metadata would be less safe.

### Codex answers

| Question | Answer |
| --- | --- |
| Same durable history as native TUI? | Yes; both owners appended to the same provider rollout |
| Same exact provider session ID? | Yes; `thread.id` and the separately verified `thread.sessionId` remained unchanged |
| Fork or replacement session? | No; source stayed `cli`, fork parent stayed null, and no second rollout appeared |
| Filename or root changed? | No; the same file beneath the isolated `CODEX_HOME/sessions` tree was used throughout |
| JSONL envelope/record shape changed? | No new top-level envelope family appeared; structured turns used the native file's existing `event_msg`, `response_item`, `world_state`, and `turn_context` families |
| `historyMode` changed? | No; the native-created 0.149.1 thread was already `paginated` and remained so |
| Native message IDs stable? | Yes; every baseline ID remained, all 17 parser-shaped message IDs were unique, and every checkpoint retained the baseline prefix |
| Source-byte fallback IDs valid? | Yes for append-only existing records; every observed parser-shaped message had a native ID, but unchanged prefixes prove old byte coordinates were not moved |
| P2B additions? | Add a narrow injected-context exclusion; no new locator or second parser is needed. Add authenticated paginated round-trip, interrupt, crash-incomplete, and owner-switch fixtures plus a version/history-mode gate |
| Can P2 remain read-only? | Yes; it can continue bounded raw rollout reads independent of execution owner |

Read-only inspection of P2B at `6510f0bf` found that its current Codex adapter already:

- searches only `CODEX_HOME/sessions` and `archived_sessions` for an exact-ID filename;
- validates the first `session_meta.payload.id` before trusting the source;
- accepts `response_item.payload.type: "message"` with user `input_text` or assistant `output_text`;
- preserves native message IDs and uses immutable byte coordinates only when an ID is absent; and
- ignores provider-maintenance, tool, reasoning, developer, `event_msg`, `world_state`, `turn_context`, and unknown records.

Those rules accepted all 17 parser-shaped records in the live rollout, and every one had a native ID. The first turn exposed a precise gap: an older user-role record shared the real prompt's provider turn ID but consisted of two `input_text` blocks containing the installed provider's repository-instruction and environment-context wrappers. It had a distinct native message ID and would be returned as ordinary conversation text. No second parser or source root is warranted, but the current Codex parser/filter is not safe for this authenticated fixture without excluding that provider-injected record.

Recommended P2 integration work:

1. Add a `codex/paginated-native-app-server-round-trip` fixture family with content-redacted records from native baseline, its injected instruction/environment record, normal structured append, exact native handback, Plan-mode question, declined approval, explicit interrupt, crash-incomplete `task_started`, and native recovery.
2. Update the Codex parser/tail normalization to ignore the installed provider-injected record without hiding arbitrary user text. The narrow evidence-backed discriminator is: an older user-role response item shares a provider turn ID with a newer user-role prompt in the same turn and has the observed two-block repository-instruction plus environment-context wrapper shape. Because the bounded tail is scanned newest-first, it can remember the newer user turn ID; expose only the actual prompt. Fixture-gate the wrapper tags/shape and fail safely on an unknown replacement format rather than returning it as user conversation.
3. Add a regression proving no repository instruction, cwd/environment wrapper, or other injected provider context reaches the provider-neutral response, including when the requested window is large enough to reach the first turn.
4. Keep the existing locator and `session_meta` head check. Add a regression proving the nested date/rollout filename remains discoverable after both owners append and the exact ID still matches.
5. Assert that existing response-item IDs and byte-coordinate fallback inputs remain stable across every appended checkpoint. The fixture should fail if a provider upgrade rewrites or migrates the rollout.
6. Treat `event_msg.turn_aborted` and dangling `task_started` as known non-content boundaries. The current parser may continue ignoring them, but fixtures must prove they cannot leak error/reason/provider text or fabricate an assistant message. A future typed interrupted boundary is optional product work, not a prerequisite for parsing ordinary messages.
7. Replace the legacy-only ownership assumption with a versioned compatibility gate that admits the observed 0.149.1 paginated rollout shape. Preserve legacy fixtures because P2 still reads older supported sessions.
8. Keep app-server out of the P2 read path. `thread/turns/list` reconstructed the history but is experimental and unbounded-provider work is unnecessary when bounded raw reads already work.
9. Add compaction coverage before claiming compacted paginated sessions supported. Compaction was not exercised in this spike.

P2 must remain an execution-owner-independent, read-only provider-history service. Ownership may trigger a refresh after a terminal provider event, but it must not supply content, IDs, paths, or process authority from the browser and must not write provider history.

## 12. Recommended P3 execution-owner design

### Durable states

Use the proposed states exactly, plus a typed degraded recovery outcome rather than pretending an ambiguous owner transition completed:

```text
native_tui
  -> handoff_to_structured_pending
  -> structured
  -> handoff_to_native_pending
  -> native_tui
```

Pending state is durable before stopping the old owner. Failure remains attached to the pending operation until reconciliation either proves one owner or returns a typed recovery-required result.

### Durable owner record

Store server-derived metadata only:

- provider and exact provider resume-target ID
- separately reported session-tree/root ID where the provider has one
- server-owned provider profile/config root identity; for Codex this includes the exact `CODEX_HOME` classification
- owner mode and desired target mode
- owner generation and `sessionInstanceId`
- idempotent handoff operation ID and phase
- exact process identity/start token or structured process-group identity
- active provider turn/interaction IDs when available
- structured connection/owner generation for connection-local request IDs
- configuration-manifest fingerprint
- provider CLI, SDK, protocol-schema, and history-format compatibility versions
- stop request time, terminal outcome, and content-free failure classification

Do not store a Quarterdeck transcript. Do not accept any of these fields from a browser.

### Coordinator placement and transition algorithm

Add a server-owned `TaskExecutionOwnershipService` above `TerminalSessionManager` and future provider-structured runners. It should enter through `ProjectTaskLifecycleService` and share the existing per-task resource-operation serialization. `TerminalSessionManager` remains the native PTY owner; a provider-specific structured registry owns SDK/app-server processes. Neither registry may start directly from a browser handler.

For every transition:

1. Resolve provider, task, worktree, exact resume target, current owner, version gate, and server-derived configuration manifest.
2. Reject an active/mid-turn owner by default. A separate interrupt option must be explicit and provider-supported.
3. Persist pending state with operation ID, source instance/generation, and desired target.
4. Stop or interrupt through the current owner interface.
5. Wait for `exited`/`not_running` or the provider's terminal turn event plus confirmed loss of process write authority. Timeout, identity ambiguity, and stop failure start nothing.
6. Start the replacement with the exact stored resume target—never latest/list/continue fallback.
7. Verify provider identity from init/resume response or native launch hook before changing authority.
8. Commit the new owner generation/state.
9. Fence every late output, question, approval, completion, and exit callback by task, operation ID, owner generation, and session instance.

### Mid-turn and failure policy

- Default: `mid_turn` rejection.
- Optional interrupt: persist intent, call provider interrupt, await terminal resolution, reread durable history, then stop/wait and replace.
- Structured crash: mark `turn_outcome_unknown`, confirm exact process group gone, reread exact history, and offer exact structured reconstruction or native handback. Never auto-replay prompt content. A later provider classification of interrupted narrows presentation but does not retroactively make replay safe.
- Runtime restart: recover one owner conservatively. A live exact process may be reattached only with trustworthy process identity; otherwise stop/clean it and resume exact history once. Ambiguity fails closed.
- Provider upgrade/schema mismatch: refuse conversion while native desktop and read-only P2 remain available.

### Task lifecycle behavior

| Lifecycle event | Required behavior |
| --- | --- |
| Restart | Restart the current owner mode against the exact ID after stop/wait; no latest fallback |
| Trash | Stop whichever owner is authoritative and wait; retain provider ID/source hint but clear live process authority |
| Restore | Require previous exit to have settled and worktree to exist; default to exact native handback unless a supported structured preference is explicit |
| Hard delete | Refuse until owner stop succeeds; do not delete provider history as an incidental process effect |
| Missing worktree | Refuse launch and surface typed `worktree_missing`; never fall back to project root or stale cwd |
| Provider history missing | Return typed `session_missing`; never create a fresh session as resume recovery |

### Typed outcomes

At minimum: `provider_unsupported`, `provider_version_unsupported`, `provider_profile_unavailable`, `history_mode_unsupported`, `authentication_unavailable`, `owner_active`, `mid_turn`, `stop_timed_out`, `stop_failed`, `owner_identity_ambiguous`, `replacement_spawn_failed`, `provider_identity_mismatch`, `session_missing`, `worktree_missing`, `configuration_parity_unavailable`, `interaction_identity_unsupported`, `runner_crashed`, and `turn_outcome_unknown`.

Diagnostics should contain only provider/version classifications, state/operation/generation IDs or hashes, counts, durations, process outcomes, history mode, and schema/manifest hashes.

### Fresh-agent implementation order

Implement Codex first because it is the higher-priority structured owner and has the stronger installed protocol/schema evidence. This ordering does not permit provider-neutral code to assume Codex behavior:

1. Add only the durable provider-neutral owner record, typed outcomes, operation/generation fencing, and migration/recovery tests. Do not start a structured provider process yet.
2. Add fake native and structured owner registries behind `TaskExecutionOwnershipService`; prove stop/wait, duplicate operation IDs, delayed callback fencing, runtime reconstruction, crash ambiguity, trash/restore/restart/hard-delete, and missing-worktree behavior without credentials or network access.
3. Implement the Codex adapter against generated schemas from the exact supported CLI. Use stdio app-server, exact `thread/resume`, explicit configuration reapplication, exact `CODEX_HOME` profile identity, connection-scoped JSON-RPC routing, and the paginated/legacy P2 compatibility gate. Never call `thread/list`, fork, latest, or a browser/network listener.
4. Exercise Codex through deterministic fake-protocol tests first. Run a fresh isolated authenticated compatibility check only if the supported CLI/schema/history tuple changes; that call requires the credential-isolation gate and confirmation described in section 16.
5. Implement the Claude adapter separately through Agent SDK `query(...)`, an explicitly pinned Claude executable, the exact resume ID, a frozen configuration manifest, and the installed-version question/permission identifiers. Keep Claude-specific constraints out of the Codex adapter and shared contract.
6. Add the idempotent non-PTY `TaskInteractionService` only after both the coordinator and at least the Codex adapter can prove exclusive ownership. Remote projection, pairing, and transport remain later phases.

The first implementation agent should inspect `src/server/project-task-lifecycle-service.ts`, `src/core/task-resource-operation-coordinator.ts`, `src/terminal/agent-session-adapters.ts`, `src/terminal/session-lifecycle-controller.ts`, `src/terminal/session-manager.ts`, `src/terminal/session-summary-store.ts`, `src/terminal/session-transition-controller.ts`, `src/server/task-session-start-service.ts`, and `src/server/startup-session-recovery.ts` before choosing persistence or coordinator seams. Reuse their task serialization, stop outcomes, process-instance fencing, and recovery ownership instead of creating a parallel lifecycle path.

## 13. Provider-specific decisions

### Claude Code: supported with documented constraints

The exact round trip, restart reconstruction, interrupt handback, crash handback, append-only identity stability, and question identity all passed. Support depends on the explicit constraints in sections 5, 9, 11, and 12. Compaction and every approval subtype remain compatibility-gated rather than implied.

### Codex: supported with documented constraints

The exact round trip, fresh-process reconstruction, interrupt, crash handback, append-only identity stability, Plan-mode question identity, and declined command approval all passed. Support depends on the constraints in sections 6, 9, 11, and 12, especially the exact `CODEX_HOME` profile, paginated-history fixtures, explicit configuration reapplication, connection-scoped request routing, and outcome-unknown crash policy. Compaction, MCP failure, and every approval subtype remain compatibility-gated rather than implied.

## 14. Rejected alternatives

- Copying, symlinking, exporting, or reading the real Codex `auth.json`: violates credential and real-history isolation; a symlink could also permit refresh mutation.
- Persisting a fresh device-code OAuth token in the disposable root: violates the no-persisted-user-credential requirement.
- Making one global Codex Keychain credential independent of `CODEX_HOME`: no supported configuration exists in 0.149.1, it would broaden credential access across profiles, and it would erase a useful production isolation boundary.
- One ephemeral app-server login shared through remote TUI mode: requires a WebSocket/Unix listener, uses an experimental transport, and tests a shared server owner rather than the required native-process handoff.
- Using the active Quarterdeck runtime or real project/provider history: outside scope and unsafe.
- Claude `--continue`, Codex `resume --last`, `thread/list`, or any global-latest lookup: can target the wrong conversation.
- Starting the replacement while stop is pending: violates the single-writer invariant.
- Intentionally running two writers as a test: unnecessary; coordinator rejection was tested without concurrency.
- `thread/fork` or Claude fork-session: creates a different lineage, not ownership handoff.
- Automatic replay after crash: can duplicate an already accepted provider prompt; ambiguous outcomes must surface instead.
- Treating Codex as legacy-history-only: contradicted by the authenticated native 0.149.1 session, which began as paginated while retaining a P2-readable rollout JSONL.
- A Quarterdeck-owned transcript: creates a second source of truth and is unnecessary for both observed provider-owned histories.
- Browser-provided session IDs, paths, cwd, process IDs, or raw PTY input: crosses the trust boundary and is not part of the design.

## 15. Remaining risks and format assumptions

- One OS, one Claude CLI/SDK/Bedrock tuple, one Codex CLI/app-server/ChatGPT-account tuple, and synthetic repositories were tested.
- SDK 0.3.241's installed types describe bundled Claude Code 2.1.241 while the experiment intentionally pinned executable 2.1.224. Future support must gate that tuple explicitly.
- Claude compaction, MCP startup failure, plugins, real repository instruction layering, and a deterministic non-question permission prompt were not live-tested.
- The Claude interrupt sentinel is provider-owned and not documented as a durable public JSONL contract. Its parser must be fixture/version gated.
- The Claude native harness used exact process termination after an idle Stop hook rather than a slash-command exit because slash commands were disabled for safety. The Codex native harness used interrupt plus EOF through its dedicated PTY and observed clean exit.
- A crash between provider acceptance and local durable observation remains fundamentally ambiguous without a documented provider idempotency key. The design avoids duplication by refusing automatic replay.
- Codex's Keychain lookup dependence on exact `CODEX_HOME` is installed-version behavior, not a documented cross-version guarantee. Support must probe it without exposing credentials.
- The native Codex thread began as paginated despite earlier legacy-default documentation/static evidence. Account/cloud rollout may influence that choice, so production must inspect and gate the reported mode rather than infer it from CLI version alone.
- Codex `thread/resume` returned null reasoning effort while the persisted and explicitly applied value was low. Other omitted configuration fields may require the same explicit manifest treatment.
- Codex JSON-RPC request IDs are connection-local; reuse was observed across processes. A missing owner-generation fence could route a delayed response to the wrong request.
- The structured-crash raw rollout had a dangling `task_started` without a prompt, while `thread/turns/list` later classified the turn interrupted. This reconstruction rule is provider-owned and version-sensitive.
- Codex compaction, required MCP failure, hooks under structured ownership, non-system skills/plugins, granular permission profiles, file-change approvals, and subcommand approvals were not live-tested.
- `thread/turns/list`, item pagination, history-mode fields, and structured question APIs include experimental Codex surface. P3 should minimize that surface and fail closed; P2 should continue bounded raw reads.
- Provider-generated schemas and transcript formats can change independently of Quarterdeck. Version/schema/fixture gates are part of support, not optional tests.
- P2B was inspected while developing in parallel. Its eventual integration commit must recheck the parser and contract recommendations against the merged P2 implementation.

## 16. Reproduction procedure

The following is a template, not a ready-to-run credential script. Secret values and real IDs are intentionally omitted.

1. Create a disposable root under `/private/tmp` containing provider config/history, XDG, schema, log, PID, artifact, and synthetic Git-project directories.
2. Snapshot only content-free environment/version classifications. Verify the synthetic repository is the cwd and contains no real data.
3. Inspect credential mechanisms without reading secret values. State the provider, process, roots, network/cost effect, and synthetic prompt labels, then obtain fresh confirmation before login or model access. Do not copy credential files.
4. Configure a metadata-only native SessionStart/Stop hook that writes the exact session ID to a mode-0600 control file and writes only its hash to evidence.
5. Launch native Claude in a PTY with explicit cwd/settings/tools/permissions. Send `<synthetic-marker-NATIVE_A>`, wait for Stop, stop the exact PID, and wait for exit.
6. Locate the exact purpose-created JSONL by the captured ID beneath the isolated Claude root. Record only line count, size, hash, record-type counts, and hashed IDs.
7. Run Agent SDK `query(...)` with `resume: <exact-id>`, the same cwd/config manifest, and an externally pinned Claude executable. Verify init identity before sending `<synthetic-marker-STRUCTURED_B>`. Wait for Result, close, and wait for process exit.
8. Launch native `claude --resume <exact-id>`, verify the launch hook identity, send `<synthetic-marker-NATIVE_C>`, wait for Stop, and stop/wait exactly.
9. For interrupt, use the owning SDK `Query.interrupt()` and await its terminal/error path before handback. For crash, isolate the structured process group, verify init identity, terminate only that group, verify absence, then hand back natively.
10. Compare append-only prefixes, hashed IDs, high-level prompt/assistant UUID uniqueness, record-type changes, and context-presence booleans. Do not retain response text.
11. Generate Codex schemas from the exact installed CLI:

    ```text
    codex app-server generate-json-schema --out <isolated-standard-schema-root>
    codex app-server generate-json-schema --experimental --out <isolated-experimental-schema-root>
    codex app-server generate-ts --experimental --out <isolated-types-root>
    ```

12. For Codex Keychain isolation, select one disposable `CODEX_HOME` and reuse that exact root for login, native TUI, and app-server. Supply the account HOME only for OS Keychain access; keep XDG roots, provider history/config/cache, project, and temporary files disposable. Verify `codex login status` by classification only and confirm no `auth.json` appears.
13. Put the synthetic project's exact path in the isolated `config.toml` using a quoted project table and `trust_level = "trusted"`. Do not express a path containing dots through a dotted `-c` override; 0.149.1 split that key and failed to trust the intended project.
14. Launch native `codex` with explicit cwd, model, effort, sandbox, approval policy, and `<synthetic-marker-NATIVE_A>`. Capture the exact ID only from the purpose-created `session_meta`, stop the PTY owner, and wait for exit.
15. Start `codex app-server --listen stdio://`; send `initialize`/`initialized`, exact `thread/read`, and exact `thread/resume`. Verify thread ID, session-tree ID, cwd, history mode, source, model, and instruction sources before `turn/start`. Never use `thread/list`, latest, fork, or resume history/path inputs.
16. Wait for exact `turn/completed`, stop app-server, and launch `codex resume <exact-id> <synthetic-marker-NATIVE_C>`. Verify both earlier context booleans, then stop/wait exactly.
17. In separate exact-owner processes, exercise fresh-process reread, `thread/turns/list`, exact interrupt, killed-owner recovery, Plan-mode question, and declined approval. Record only hashes/counts/statuses and never replay the crash-ambiguous prompt.
18. Compare rollout path, history mode, append-only prefixes, envelope families, provider IDs, message shapes, and P2 parser compatibility after each owner.
19. Stop all process trees, run the safety audit, package only content-free evidence, then remove disposable data. Log out the isolated Keychain profile before deleting its `CODEX_HOME` if cleanup is authorized.

## 17. Content-free artifact inventory

Experiment artifacts were beneath separate purpose-created `/private/tmp` roots for the Claude and Codex matrices:

- one synthetic Git repository per provider experiment, clean after each experiment
- isolated Claude HOME/config/history and one exact provider JSONL lineage
- isolated authenticated `CODEX_HOME` containing one synthetic paginated rollout and provider-owned state/cache only
- isolated XDG config/cache/state roots
- Claude SDK package and disposable harness scripts
- Codex 0.149.1 standard/experimental JSON Schemas and generated TypeScript
- mode-0600 exact-ID/PID control files used only inside the disposable root
- content-free JSON evidence containing version classifications, hashes, counts, sizes, boolean identity/config results, process outcomes, and fencing results
- no copied raw provider response logs or prompt transcripts outside provider-owned isolated history, credentials, real IDs in committed files, or real project data

The Claude safety audit reported zero active harness/provider processes, one Claude history file confined to its disposable root, zero forbidden credential files, zero secret-like Claude metadata keys, and a clean synthetic repository. The final Codex safety audit reported zero recorded live harness/provider processes, one rollout confined to the disposable root, zero `auth.json` files, a clean synthetic repository, and 25 content-free evidence files totaling 35,163 bytes.

The disposable roots are not committed artifacts. The Claude root was removed after its clean safety audit. The Codex root and its exact-`CODEX_HOME`-scoped Keychain login remain intentionally retained for possible reproduction and authorized cleanup; no process remains active. Because deleting the profile before logout could orphan the Keychain entry, cleanup requires an explicit `codex logout` against that exact isolated profile before removing the root. No global Codex credential was created.

## 18. Recommended shared-document edits and integration status

These were the required recommendations when the evidence spike completed. After P2B merged into this branch, the explicitly requested integration follow-up applied the P2 parser, fixture, and shared-document portions here. The P3 ownership items remain design requirements only; no production owner was implemented.

### [docs/conversation-provider-boundary-spike.md](./conversation-provider-boundary-spike.md)

- Add the provider-specific Decision-B table from section 1.
- Record that Claude SDK writes the same JSONL lineage but adds queue/attachment/tool and interrupt-sentinel envelopes.
- Add the precise P2 Claude interrupt-boundary fixture/parser requirement and version gate.
- Record Codex as supported with constraints: exact round trip/recovery passed, native 0.149.1 began paginated, and structured mode preserved the same rollout/envelope/message shape.
- Replace the Codex legacy-only assumption with the paginated native/app-server fixture and version/history-mode gate from section 11; keep the current bounded raw reader and exact locator.
- Record the authenticated first-turn injected user-role context record and require the narrow same-turn/wrapper-shape exclusion before exposing Codex recent context.
- State that P2 remains read-only and independent of execution owner.

### [docs/remote-companion-plan.md](./remote-companion-plan.md)

- Replace any single generic owner handoff assumption with provider-specific support status.
- Add the durable five-state ownership lifecycle, owner generation/session-instance fence, idempotent operation ID, exact stop/wait protocol, and server-only identity derivation.
- Add default mid-turn rejection, optional interrupt-and-wait, `turn_outcome_unknown`, no automatic crash replay, and native handback recovery.
- Add provider CLI/SDK/schema/history compatibility gates, exact Codex profile-root identity, explicit configuration reapplication, and connection-scoped interaction routing.
- Add the trash/restore/restart/hard-delete/missing-worktree policies from section 12.

### [docs/todo.md](./todo.md)

- Add a P2 integration follow-up for the Claude Agent SDK round-trip fixture family and interrupt-boundary parser/contract case.
- Add a P2 integration follow-up for the narrow Codex injected-context parser exclusion plus authenticated paginated round-trip, interrupt, crash-incomplete, handback, stable-ID, and locator fixtures; no new parser family or source is indicated.
- Add P3 implementation work for the server-owned execution coordinator, durable owner record, native and structured registries, operation/generation fencing, typed outcomes, and recovery tests.
- Add Codex P3 adapter work behind a 0.149.1-or-newer compatibility matrix, exact `CODEX_HOME` profile, stdio-only app-server, explicit manifest, paginated-history gate, and no-replay crash policy.
- Keep Pi excluded.

### [docs/implementation-log.md](./implementation-log.md)

- After integration, add one concise forensic entry: both constrained Decision-B results, Claude same-lineage/interrupt-envelope finding, Codex paginated same-rollout/crash-boundary finding, P2 fixture consequences, and the P3 single-writer/recovery invariant.
- Reference this document and the integration commit; do not duplicate the entire matrix.

The evidence spike alone required no CHANGELOG entry. The later production P2 history-hardening follow-up is recorded in `CHANGELOG.md`.

## 19. Scope confirmation

This branch began as a documentation-only evidence spike. The later P2 integration follow-up adds only read-only provider-history parsing, contract, fixture, and planning changes. It does **not** add or change:

- a production execution-owner state machine
- a production Claude Agent SDK or Codex app-server execution integration
- a remote listener or remotely reachable endpoint
- pairing, authentication, or authorization flows
- browser-supplied provider, process, or filesystem identity
- raw PTY input as a remote capability
- a Quarterdeck transcript store
- mobile UI
- Pi support

The shared P2 documents and existing read-only implementation are now intentionally modified by the integration follow-up. The changes remain confined to provider-history interpretation and do not add process ownership, provider writes, or a second transcript.

### Validation record

- All isolated provider/harness processes stopped; final process count was zero.
- Provider history was confined to the disposable roots; the Codex root held exactly one rollout, and the synthetic repositories were clean.
- No forbidden credential file was found beneath either disposable root; the retained Codex root contains no `auth.json` and used the OS Keychain only.
- Production source changes are limited to the existing read-only `src/conversation/` provider adapter/parser/contract boundary; shared P2 planning documents were updated after the parallel P2 work was merged locally.
- `npm run check:agent-instructions` passed.
- All local Markdown links in the seven changed Markdown files resolved. A repository-wide scan also found one pre-existing stale link in archived `docs/history/implementation-log-through-0.11.0.md`; it was already stale at protected base `c602b294` and remains outside this spike.
- The results-document sensitive-path/UUID/environment-name scan returned no matches.
- The final root check passed 148 files and 1,384 tests; 40 focused conversation and cold-project resolver tests passed; Knip, the changed-document Markdown-link check, fixture credential scan, and `git diff --check` passed.
- A read-only `review-branch` review against `feature/remote-access` first found that the authenticated Codex rollout's injected repository/environment context would parse as a user message. The P2 follow-up implements that exclusion. A later review against merged base `c602b294` found this document's original documentation-only scope statements had become stale; this integration status corrects them.
