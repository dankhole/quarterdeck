# Remote Companion: Prerequisites and Implementation Plan

Status: active architecture plan. No remote listener, authentication flow, or mobile UI has been implemented on this branch.

Implementation progress as of 2026-08-11:

- P0 baseline is green: root checks, web tests, web production build, and integration tests pass before the ownership cutover.
- P1 is implemented. `ProjectBoardCommandService` is the sole production board writer; the desktop applies edits optimistically but submits typed command batches through `project.applyBoardCommands`. Runtime session/title/base-ref/worktree projections use the same locked authority, command receipts make lost-response retries idempotent, lifecycle effects flush pending board commands first, and the public whole-board save procedure has been removed.
- No remote listener was added by P1. Remaining prerequisite work begins at P2: provider-neutral bounded conversation reads, structured non-PTY task interaction, strict remote projections, and the browserless acceptance harness.

## Decision Summary

Quarterdeck should build a narrow **Remote Companion**, not expose the existing desktop application over the network.

The intended end state is a phone browser that can:

- List configured projects.
- List task cards and their coarse state.
- Read user and assistant conversation text.
- See which task needs attention.
- Send a follow-up message or answer the currently outstanding structured question.
- Create and start a task from a constrained Quarterdeck-owned preset.
- Optionally see a branch name and a very small amount of explicitly approved Git metadata.

It must not expose:

- Project, checkout, worktree, session, or transcript paths.
- Files, file lists, file contents, diffs, patches, or repository search.
- Tool-call arguments, tool results, thinking/reasoning blocks, system prompts, or raw provider records.
- Terminal output, raw terminal input, shell terminals, arbitrary commands, environment variables, or launch arguments.
- Existing desktop tRPC procedures for configuration, files, Git mutations, worktree management, or terminals.
- Repository remotes or credentials.

The implementation should begin with behavior-preserving prerequisites. Those prerequisites can be tested and dogfooded with the existing desktop UI and native agent terminals unchanged. Remote networking and the mobile UI begin only after the prerequisite acceptance gate passes.

## Direct Answer: Do We Need a New Renderer?

Yes, but **not a new terminal renderer and not a replacement agent runner**.

Quarterdeck currently launches Claude and Codex in their native interactive TUIs and renders their PTY output through xterm. That remains the local, full-fidelity interactive experience.

The repository retains a legacy experimental Pi integration, but Pi is not a supported forward target for the Remote Companion or its compatibility gates.

The phone needs a separate, simple React conversation renderer:

```text
Provider-owned session history
          |
          v
Provider adapter (Claude / Codex)
          |
          v
Provider-neutral conversation entries
          |
          v
Text-only remote projection
          |
          v
Mobile message-list renderer
```

The renderer displays normalized user and assistant messages. It does not interpret terminal pixels, scrape the TUI, or decide whether an agent is working, blocked, or finished.

Sending a message travels in the opposite direction through a structured interaction service:

```text
Mobile composer
     |
     v
send_message command
     |
     v
TaskInteractionService
     |
     v
provider/session-aware delivery into the existing agent session
```

The read path and write path therefore meet at the agent session, not inside the renderer. The existing native TUI remains mounted and usable locally.

## Product and Trust Boundary

The Remote Companion is a single-user extension of a locally running Quarterdeck runtime. It is not initially:

- A hosted multi-user Quarterdeck service.
- A remote executor that runs agents on another machine.
- A remote desktop or raw terminal product.
- A complete clone of the desktop interface.
- A Slack bot. Slack can later consume the same narrow contract, but it has a different data-retention and third-party trust boundary.

The runtime must be running for the phone to connect. The desktop browser does not need to remain open. Agent processes and runtime session state are already server-owned and survive browser closure; the missing headless capability is authoritative board mutation, especially creating a card before starting a new task.

### Honest Content Boundary

Removing file, diff, tool, and terminal APIs materially reduces accidental disclosure and attack surface. It does not create a cryptographic guarantee that repository-derived content can never appear remotely:

- An assistant can quote code or a secret in ordinary assistant text.
- A trusted remote user who can send messages can ask an agent to read and repeat repository content.
- Task prompts, task titles, project names, and branch names can themselves contain sensitive information.

The proposed v1 promise is therefore:

> Quarterdeck never directly transports file, diff, terminal, tool, path, or command payloads through the Remote Companion. User-authored and assistant-authored conversation text is transported and may contain repository-derived content.

A stricter promise would require a separate local summarization/redaction product that does not send original assistant messages. That is a different experience and is not assumed by this plan.

## Target Architecture

```text
                                 LOCAL-ONLY AUTHORITY

 Desktop browser ───────────────> Existing runtime API / terminal WebSockets
       |                                      |
       |                                      v
       |                            Runtime sessions + board command authority
       |                                      ^
       |                                      |
       +──────────────────────────────────────+

                                 REMOTE-COMPANION BOUNDARY

 Phone PWA ── paired session ──> Remote Companion Gateway
                                      |
                         +------------+-------------+
                         |                          |
                         v                          v
                allowlisted projections      typed commands
                projects/tasks/chat          reply/create/start
                         |                          |
                         +------------+-------------+
                                      |
                                      v
                            shared internal services
```

The existing full-authority runtime should remain loopback-only. The Remote Companion should use a separate gateway/listener or outbound relay adapter that registers only the narrow remote protocol. It must not proxy or mount the existing desktop router.

This separation gives two useful security properties:

1. A remote device cannot discover a hidden Files, Git, shell, or terminal route because those routes do not exist on the remote gateway.
2. Local hooks, CLI probes, runtime state, and terminal sockets keep their current loopback behavior instead of being mixed into a new public authentication exception list.

## Existing Foundation

Quarterdeck already has several pieces that reduce the prerequisite work:

- The runtime and task agent processes do not depend on a browser tab remaining open.
- Native hooks remain the authority for running, needs-input, review, failure, and completion semantics.
- Runtime session identity is server-owned through `resumeSessionId`, `sessionLaunchPath`, and the terminal/session store.
- Pure provider-independent board mutation functions already live in [`../src/core/task-board-mutations.ts`](../src/core/task-board-mutations.ts).
- Project state already has atomic writes, per-project locks, revisions, and optimistic conflict detection in [`../src/state/project-state.ts`](../src/state/project-state.ts).
- Runtime state WebSockets already deliver project and task-session changes.
- The desktop UI already has bounded task summaries and centralized indicator semantics.

An earlier unmerged foundation commit, `28c987584`, contains:

- A provider-neutral conversation entry contract.
- A server-owned conversation source locator boundary.
- Canonical path/root validation and task/session scoping tests.
- Research records for conversation rendering and remote-access options.

That work should be reviewed and reapplied onto current `main`; it should not be assumed present on this branch or copied without reconciling current runtime changes.

## Invariants That Must Not Change

The prerequisite work is allowed to change internal ownership, but it has a zero-intent behavior-drift requirement for existing local workflows.

1. Native hooks remain the only lifecycle authority.
2. Conversation files, terminal output, timestamps, polling, and the mobile renderer cannot move cards or change session state.
3. The native Claude and Codex TUIs remain the local interactive surfaces.
4. Task agent terminals and shell terminals remain separate lifecycle domains.
5. Runtime session truth remains server-owned and is never accepted from browser board payloads.
6. At every migration step there is exactly one persisted board writer.
7. Existing task creation, edit, move, start, stop, restart, trash, restore, title, dependency, and branch-selection behavior remains equivalent.
8. Existing local APIs are not made network-reachable as a side effect of prerequisite work.
9. Unsupported or malformed provider history degrades the Conversation feature only; it cannot affect the terminal or agent process.
10. Disabling every optional cache, watcher, retry, and streaming optimization leaves a slower but correct implementation.

---

# Prerequisite Work

Everything in this section lands before the first remote listener or mobile UI. Each phase should be independently reviewable and exercised through local or browserless tests without exposing the desktop API remotely.

## P0. Establish the Regression Baseline

Before moving an ownership boundary, record and preserve the current behavior with characterization tests.

Add or confirm coverage for:

- Create task, create-and-start, and create-start-and-open.
- Agent selection, base ref, worktree selection, generated task ID, and title generation.
- Backlog to in-progress and in-progress to review projection.
- Stop, restart, resume, trash, restore, and restore-before-old-exit protection.
- Task metadata reconciliation after session launch.
- Board revision conflict handling and authoritative hydration.
- Runtime operation with zero connected browser clients.
- Claude and Codex launch/resume argument behavior.
- Terminal input, paste, permission-state clearing, and interrupt semantics.
- Runtime restart with persisted boards and interrupted sessions.

Baseline commands:

```bash
npm run check
npm run web:test
npm run web:build
npm run test:integration
```

Do not start a second Quarterdeck runtime for validation without confirming that it will not overlap the user's active instance. Headless integration tests should use isolated temporary state roots and fake agent executables.

### P0 exit gate

- The baseline is green on current `main`.
- Any existing flaky or platform-dependent tests are identified before prerequisite changes begin.
- The no-browser runtime scenario has an explicit automated test rather than being an assumption.

## P1. Move Board Persistence to a Runtime Command Authority

This is the largest prerequisite and the one required for creating tasks while no desktop browser is open.

Before P1, the connected desktop browser was the board-state writer: it applied session projection and replaced `board.json`. Adding a phone as another snapshot writer would have created revision conflicts and disruptive refreshes.

The target is one server-side `ProjectBoardCommandService` as the only persisted board writer. Desktop and future remote clients send typed intent; neither sends an authoritative replacement board.

```text
desktop action ─┐
                ├─> ProjectBoardCommandService ─> locked load/reduce/save ─> revision + broadcast
remote action ──┘
```

Implemented result:

- `project.applyBoardCommands` accepts bounded typed batches; the old public `project.saveState` procedure and browser persistence debounce are gone.
- The desktop derives commands from each existing board transition, applies the intended board immediately, and overlays any still-pending batches on streamed authoritative state.
- A successful command response forces authoritative reconciliation. A real conflict removes the rejected optimistic overlay and refreshes state; an ambiguous lost response retries the identical command ID once so the durable receipt can replay it safely.
- Session-state work-column changes, generated titles, base-ref changes, and worktree/branch metadata persist through runtime-owned internal mutations under the same project lock.
- Task session start/stop, worktree ensure, and worktree deletion wait for pending commands to commit, preventing process/filesystem effects from overtaking their card transition.
- The low-level whole-state writer remains an internal utility for migrations, isolated tests, and controlled maintenance only.

The service should reuse the pure functions in `src/core/task-board-mutations.ts` and add a typed envelope:

```ts
interface ProjectBoardCommandEnvelope {
  commandId: string;
  projectId: string;
  expectedRevision: number;
  command: ProjectBoardCommand;
}
```

Initial command families must cover every existing browser write before cutover:

- Create one or multiple tasks.
- Edit task prompt/base ref/worktree choice.
- Reorder within a column and move between columns.
- Apply the deterministic session-state column projection.
- Update title, branch/base-ref metadata, and assigned task/worktree metadata.
- Add/remove dependencies.
- Trash, restore, clear trash, and permanently delete.
- Pin/unpin and other persisted card metadata.

The service owns:

- Per-project serialization using the existing state lock.
- Expected-revision checks.
- Deterministic IDs and timestamps supplied once per command.
- Persisted or bounded durable command deduplication.
- Runtime-owned session pruning before persistence.
- Authoritative state/revision broadcast after every accepted command.
- Post-commit effects such as title generation, worktree cleanup, or session start orchestration.

### Implemented migration strategy

Do not introduce a temporary writer lease that lets the runtime write only when the browser appears absent. That creates timing-dependent ownership and makes reconnect behavior the architecture.

The cutover followed these controlled steps:

1. Added command schemas and pure reducer tests without changing persistence.
2. Compared existing UI transitions with the equivalent command reducer in memory without dual-writing files.
3. Added the server command service and integration tests against temporary project state.
4. Moved all desktop mutation families to the command API while retaining optimistic local application.
5. Added authoritative success reconciliation, conflict rehydration, and same-ID retry only for ambiguous transport failures.
6. Moved session-column, generated-title, and task-metadata persistence through the same authority.
7. Removed public/browser use of whole-board `project.saveState`; retained low-level state writers for migrations, tests, and controlled maintenance.

During migration, each project must still have exactly one actual file writer. Shadow comparison is allowed; shadow persistence is not.

### Create-and-start semantics

`create_and_start_task` should be an orchestration over durable board commands and the existing session launcher:

1. Validate the selected project and approved task preset.
2. Persist the new backlog card.
3. Apply the normal start/move intent.
4. Resolve or create its worktree using existing server-side rules.
5. Start the configured agent session.
6. Return the authoritative task/session projection.

If session start fails after card creation, preserve the card in a recoverable non-running state and return a typed failure. Do not roll back by deleting worktree/branch state speculatively.

The headless create-and-start service implements this as three durable subcommands: create in backlog, move from backlog to in-progress with an explicit source-column precondition, and recover from in-progress to backlog if setup/start fails or a restart finds that the move committed without a session. The receipt records whether the original subcommand actually changed the board, so a replay cannot reinterpret a first-seen no-op as permission to launch. Concurrent duplicates on one runtime share one in-flight launch; after runtime reconstruction, a replay returns an authoritative existing session or recovers the card instead of blindly spawning again.

### P1 exit gate — implemented

- Closing every desktop tab does not prevent create, create-and-start, session-state projection, title update, or persistence through internal integration tests.
- Two browser clients cannot become competing board writers.
- Existing desktop interaction tests pass without visible workflow changes.
- Revision conflicts do not silently discard accepted commands.
- Runtime restart reconstructs the same authoritative board and sessions.

## P2. Land the Provider-Neutral Conversation Read Boundary

Reapply and update the conversation foundation from `28c987584`.

The internal contract should support richer local presentation without becoming the remote contract. It may represent:

- User messages.
- Assistant text.
- Thinking blocks.
- Tool calls and correlated tool results.
- Explicit session, resume, restart, compaction, and history-gap boundaries.

Required properties:

- Stable entry/block IDs across rereads and reconnects.
- Provider-native IDs when available; deterministic immutable source coordinates otherwise.
- Strict task, agent, and provider-session scoping.
- No browser-supplied source paths or provider session IDs.
- Canonical `realpath` containment inside provider-owned roots.
- Bounded response bytes, entries, block text, and diagnostics.
- Cursor/window reads rather than full-history fanout.
- Tolerance for incomplete JSONL tails, unknown record types, and isolated malformed records.
- No board, transition-controller, hook, or terminal mutation dependency.

Define a provider adapter contract such as:

```ts
interface ConversationProviderAdapter {
  locateSource(input: ConversationSourceLocatorInput): Promise<ConversationSourceLookup>;
  readWindow(input: ConversationReadWindowInput): Promise<ConversationReadWindowResult>;
}
```

Provider-specific parsing stays behind this interface.

### Claude adapter

- Treat hook-provided `transcript_path` as an untrusted locator hint.
- Match the stored Claude session ID and validate the canonical path against Claude-owned history roots.
- Use native message/content-block/tool-use IDs where present.
- Tolerate transcript lag behind hook delivery.

### Codex adapter

- Locate history from the stored targeted resume/session ID, never from provider-global “latest.”
- Validate any discovered source under Codex-owned session roots.
- Preserve native item and call IDs.
- Treat compaction and maintenance events as presentation boundaries, never lifecycle events.

### P2 tests

- Golden fixtures for every supported provider and known format version.
- Partial final record, malformed middle record, unknown record type, and pruned source.
- Symlink/path escape and mismatched session identity.
- Stable IDs after append, reread, restart, and pagination.
- Resume/restart stitching without duplicate entries.
- Bounded text/tool output and content-free diagnostics.
- Proof that reads cannot change lifecycle, board revision, or terminal state.

### P2 exit gate

- Claude and Codex either produce correct bounded windows or an explicit provider-scoped degraded/unsupported result.
- The existing terminal is unchanged and remains fully usable when conversation history is absent or malformed.

## P3. Add an Agent-Agnostic Task Interaction Service

The current `sendTaskSessionInput` path is intentionally a generic PTY write. The Remote Companion must not receive that capability.

Add a server-owned `TaskInteractionService` with narrow operations:

```ts
type TaskInteractionCommand =
  | { kind: "send_message"; commandId: string; taskId: string; text: string }
  | { kind: "answer_prompt"; commandId: string; taskId: string; promptId: string; answer: string }
  | { kind: "stop_task"; commandId: string; taskId: string };
```

This service should:

- Resolve project, task, active agent, and exact session instance server-side.
- Reject control characters and terminal escape sequences in message text.
- Enforce prompt and message byte limits.
- Apply command IDs and bounded deduplication before side effects.
- Reject stale session targets and stale prompt IDs.
- Return typed `accepted`, `already_applied`, `not_ready`, `stale`, `unsupported`, or `failed` results.
- Log actor/device, command kind, target IDs, and outcome without logging message or answer contents.
- Keep generic PTY writes local-only and outside the remote capability model.

### Message delivery

The service may ultimately deliver text into the existing native TUI. That does not make the renderer a terminal.

Delivery belongs behind an agent/session interaction adapter so provider differences do not leak into clients. Depending on current session state, an adapter may:

- Use a validated bracketed-paste-and-submit sequence for a live TUI at a known safe prompt.
- Resume a known provider session with the message as its explicit prompt.
- Reject or queue a message while a turn is running, according to an explicit policy.

The first correct policy should reject `send_message` when safe delivery cannot be established. A durable message queue can be added later as replaceable policy; it should not be required for correctness.

### Structured attention identity

Remote answers and approvals cannot be inferred from terminal text. Extend the existing semantic hook layer with a provider-neutral outstanding attention request:

```ts
interface RuntimeAttentionRequest {
  id: string;
  kind: "question" | "permission" | "elicitation";
  sessionInstanceId: string;
  createdAt: number;
  promptText: string | null;
  options: readonly string[];
}
```

Requirements:

- Native provider/tool IDs are used when available.
- An answer must match the current request and session instance.
- Unrelated hook/tool activity cannot clear or replace a stronger outstanding wait.
- Session exit, restart, and reconciliation have attention-state cleanup paths. Device revocation cancels in-flight remote commands without clearing the agent's outstanding request.
- Providers without stable prompt identity report structured answering as unsupported rather than falling back to arbitrary keystrokes.

### P3 exit gate

- Fake Claude and Codex sessions pass the same interaction contract tests.
- Duplicate command IDs cannot send a message, answer, stop, or resume twice.
- Existing local terminal typing/paste behavior is unchanged.
- No remote transport exists yet.

## P4. Define a Text-Only Remote Projection

The provider-neutral conversation contract is richer than the remote product. Never return it directly to a paired device.

Create a second, strict remote contract containing only allowlisted data.

### Project projection

```ts
interface RemoteProjectSummary {
  id: string;
  displayName: string;
  taskCounts: RemoteTaskCounts;
  needsAttention: boolean;
}
```

Do not include repository path, state path, remote URL, default filesystem location, or configuration.

### Task projection

```ts
interface RemoteTaskSummary {
  id: string;
  projectId: string;
  title: string | null;
  state: "backlog" | "working" | "needs_input" | "review" | "done" | "failed";
  agentId: RuntimeAgentId | null;
  branchName: string | null;
  createdAt: number;
  updatedAt: number;
}
```

Begin with branch name only. Ahead/behind counts, dirty state, or a short commit ID should be added individually only after a demonstrated mobile-management need. Do not return the Git metadata objects used by desktop views.

### Conversation projection

```ts
type RemoteConversationItem =
  | { type: "user"; id: string; text: string; createdAt: number | null }
  | { type: "assistant"; id: string; text: string; createdAt: number | null }
  | { type: "attention"; id: string; prompt: string | null; options: readonly string[] }
  | { type: "boundary"; id: string; kind: "started" | "resumed" | "restarted" | "history_gap" };
```

Projection rules:

- Include only text blocks from user and assistant messages.
- Exclude thinking, tool calls, tool results, commands, raw errors, provider metadata, and system records.
- Normalize and bound Unicode/control characters and response size.
- Preserve explicit truncation and history-gap markers.
- Do not transform tool output into an assistant message.
- Do not load remote images or render raw HTML from Markdown.
- Treat external links as untrusted and require deliberate navigation.

### Leak-resistance tests

Use sentinel secrets in every forbidden source field and assert that none appear in serialized remote payloads, logs, errors, or snapshots.

Add tests that fail if remote DTOs gain keys matching sensitive concepts such as:

- `path`, `cwd`, `worktree`, `transcript`, `file`, `diff`, or `patch`
- `command`, `args`, `environment`, or `terminal`
- `tool`, `thinking`, `reasoning`, or raw provider payloads
- repository remote URLs or credential-bearing fields

Key-name tests are defense in depth; explicit `.strict()` schemas and hand-written mapping functions remain the primary boundary.

### P4 exit gate

- Remote schemas import no desktop file/Git/terminal contracts.
- Every payload is constructed by an explicit mapper rather than object spreading a broader runtime type.
- Sentinel leak tests cover success, empty, degraded, and error responses.

## P5. Build a Browserless Internal Acceptance Harness

Before networking, test the exact future workflow through internal service interfaces with no React tree or runtime-state browser client.

The harness should:

1. Create two temporary projects and persisted boards.
2. Start the runtime services with isolated `QUARTERDECK_STATE_HOME` and fake agent executables.
3. List the safe project/task projections.
4. Start fake Claude and Codex tasks.
5. Append provider history and hook events.
6. Read bounded text-only conversation windows.
7. Send a message and reconcile its eventual transcript echo.
8. Answer a matching prompt and reject a stale prompt ID.
9. Create and start a new task while zero browser clients are connected.
10. Retry every mutation with the same command ID and prove it runs once.
11. Restart the runtime and verify board, session identity, conversation continuity, and dedup behavior.
12. Confirm no path/file/tool/terminal sentinel crosses the safe projection.

The harness should exercise the same services the future remote gateway will call. It must not create a parallel mock-only orchestration path that production does not use.

### P5 exit gate

- The desired workflow works in-process with no GUI and no network exposure.
- All existing desktop tests and the new browserless acceptance suite are green.
- Provider failure is isolated to one task/provider and cannot stall project listing or other sessions.

## Prerequisite Acceptance Gate

Prerequisite work is complete only when all of the following are true:

- Existing local desktop behavior is unchanged in normal dogfood use.
- Claude and Codex still launch in and interact through their native TUIs.
- Hooks remain the only lifecycle authority.
- A provider-neutral, bounded, read-only conversation service works or degrades explicitly.
- A structured task interaction service works without exposing raw PTY input.
- The runtime is the single persisted board command authority.
- Project/task/conversation remote projections are strict, text-only, and leak-tested.
- The complete list/read/respond/create/start flow passes with no browser connected.
- `npm run check`, `npm run web:test`, `npm run web:build`, and `npm run test:integration` pass.
- Manual dogfood covers browser open/closed, project switching, long sessions, restart/resume, trash/restore, Claude, and Codex.

---

# End of Prerequisite Work

**Everything below this point is remote-access feature work.**

---

# Remote Feature Work

## R1. Add the Isolated Remote Companion Gateway

Create a separate gateway that serves only:

- The mobile/PWA static bundle.
- Pairing and device-session endpoints.
- Strict remote query/command endpoints.
- A remote state/conversation WebSocket or similarly bounded event stream.
- Minimal health/version compatibility information.

It must not register:

- Existing desktop tRPC routes.
- Runtime-state desktop WebSockets.
- Terminal IO/control WebSockets.
- Static desktop bundles containing full-control assumptions.

Security requirements:

- Disabled by default.
- Existing full runtime remains loopback-only.
- Explicit secure transport or trusted reverse-proxy configuration for non-loopback access.
- Refuse unsafe non-loopback startup rather than treating a warning as the security boundary.
- Short-lived, single-use, high-entropy pairing challenge displayed locally.
- Per-device opaque sessions stored hashed at rest.
- Device names, last use, expiry, capability list, and individual revocation.
- `HttpOnly`, `Secure`, host-only, same-site cookies for the browser session.
- CSRF protection for every state-changing HTTP request.
- Exact Origin/Host validation for browser requests and WebSocket upgrades.
- Explicit trusted-proxy configuration before honoring forwarded headers.
- Body, frame, connection, subscription, and command rate limits.
- Metadata-only audit events and sanitized errors.
- Route-coverage tests proving every non-public endpoint rejects anonymous, revoked, expired, and under-capability devices.

Initial device capabilities should be granular:

- `projects.read`
- `tasks.read`
- `conversation.read`
- `conversation.send`
- `attention.answer`
- `tasks.create`
- `tasks.start`
- `tasks.stop`

No terminal, shell, file, diff, Git mutation, configuration, or arbitrary-command capability should exist in the remote protocol.

## R2. Ship the Read-Only Mobile Surface

Build a separate mobile-first React entry point or package. Enforce an import boundary so it can consume only the remote contract and shared presentation primitives, not the desktop runtime client.

Initial screens:

- Pairing/device enrollment.
- Project list with attention counts.
- Task list grouped by coarse state.
- Task conversation view.
- Devices/session settings and logout.

The first conversation renderer should be deliberately simple:

- User and assistant message cells.
- Sanitized Markdown without raw HTML or remote images.
- Structured attention cards.
- Restart/resume/history-gap dividers.
- Bounded pagination.
- Auto-follow only while already at the bottom.
- Jump to latest when detached.
- Loading, empty, unavailable, unsupported, degraded, and offline states.

Do not start with tool folding, inline diffs, file chips, terminal emulation, or complete desktop layout reuse.

## R3. Enable Safe Conversation Interaction

Add:

- Plain-text composer with visible size limits.
- Optimistic pending message keyed by `commandId`.
- Reconciliation when the provider history echoes the user message.
- Clear `accepted`, `waiting`, `not ready`, `stale session`, and failed states.
- Structured question/permission answers bound to the current prompt ID.
- Optional task stop after a separate confirmation.

Do not silently reinterpret a failed message as raw terminal input. If the current provider/session cannot accept structured input safely, show that limitation.

## R4. Enable Create and Start Task

Expose a constrained mobile form:

- Project.
- Prompt.
- Approved agent/preset.
- Optional worktree-isolation choice if the project policy permits it.

The phone must not supply:

- Files or images initially.
- Arbitrary cwd/worktree paths.
- Environment variables.
- Agent executable or flags.
- Shell commands.
- Repository remotes.
- Unvalidated base refs or branch commands.

Quarterdeck resolves local configuration, default base ref, worktree, branch naming, agent executable, environment, and launch arguments.

Rate-limit task creation per device and define a runtime/project concurrency limit before enabling remote starts; do not assume starts can be unbounded. Consider recent reauthentication for create/start because a compromised paired session can steer an agent that edits code and runs tools.

## R5. Connectivity, Notifications, and Later Clients

Prove the product first over a private connection such as an SSH tunnel, private VPN, or explicitly configured HTTPS reverse proxy plus Quarterdeck device authentication.

Later options:

- Outbound-only, end-to-end encrypted relay so the desktop needs no inbound port.
- Encrypted push notifications containing no conversation plaintext.
- Installable PWA lifecycle and notification handling.
- Slack as an explicit separate adapter over the same safe projection/command service.

A relay must use a versioned fixed protocol, stable command IDs, replay protection, bounded buffers, honest metadata documentation, device key rotation, and a reviewed revocation design. It is not part of the prerequisite or first remote milestone.

Slack is not equivalent to the private mobile web client: message text would enter Slack's infrastructure and retention policies. It should therefore be independently enabled and scoped even if it reuses the same internal facade.

## Validation Matrix

### Contract and parser tests

- Claude and Codex fixtures across supported versions.
- Stable IDs, active branch selection, pagination, truncation, and malformed tails.
- No lifecycle or persistence dependencies in conversation reads.

### Board command tests

- Every desktop mutation has command/reducer parity.
- Concurrent expected revisions and retry classification.
- Stable command dedup across connection loss and runtime restart.
- Create/start partial failure is recoverable.

### Interaction tests

- Live prompt, review prompt, running turn, stopped task, stale session, and unsupported provider.
- Duplicate send/answer/stop commands execute once.
- Control characters and oversized payloads are rejected.
- Prompt answers require an exact current prompt ID.

### Security tests

- Anonymous and revoked HTTP and WebSocket clients.
- CSRF, Origin/Host, cookie, expiry, and trusted-proxy cases.
- Oversized frames, message floods, connection limits, and slow consumers.
- Forbidden-field and sentinel-secret serialization tests.
- Build/import test proving the mobile bundle cannot import desktop API clients.
- Logs and errors contain IDs/outcomes but not credentials or conversation contents.

### UI tests

- Narrow phone widths, touch behavior, safe areas, keyboard/composer layout, and rotation policy.
- Conversation pagination, tail-following, offline/reconnect, and pending-message reconciliation.
- Project switching and task updates while backgrounded/foregrounded.
- No remote images, raw HTML, or unsafe external link behavior.

### Manual dogfood

- Desktop browser open and closed.
- Local terminal interaction while the phone reads/sends messages.
- Runtime restart and agent resume.
- Two paired devices, device revocation, and expired sessions.
- Claude and Codex long conversations and compaction.
- No terminal/file/diff routes visible from the phone origin.

## Rollout Rules

- Keep remote access default-off until the security and browserless acceptance gates pass.
- Land prerequisite phases separately from remote networking so regressions can be bisected.
- Prefer service-first boundaries and fixture-based tests before adding remote UI state.
- Do not run old and new persisted board writers simultaneously.
- Add caches, transcript watchers, reconnect batching, and feed optimizations only after the simplest correct version is measured.
- Update [`todo.md`](./todo.md), [`../CHANGELOG.md`](../CHANGELOG.md), and [`implementation-log.md`](./implementation-log.md) as implementation milestones land, following release hygiene rules.
- Update [`../SECURITY.md`](../SECURITY.md) before remote access ships: remote compromise becomes in-scope because a paired client can steer local code-running agents.

## Relative Size and Risk

| Area | Relative size | Main risk |
| --- | --- | --- |
| Regression characterization | Small-medium | Missing a current implicit behavior |
| Conversation contract/source boundary | Medium | Provider format drift and path scoping |
| Claude/Codex adapters | Medium-large | Partial records, resume, and compaction |
| Structured task interaction | Medium | Delivering text only when the TUI/session is safe |
| Board command authority | Large | Ownership cutover and optimistic UI parity |
| Safe remote projection | Small-medium | Accidental field/content leakage |
| Browserless acceptance harness | Medium | Testing the real path rather than a mock-only path |
| Pairing/authenticated gateway | Large | Missing one route/upgrade or incomplete revocation |
| Mobile read UI | Medium | Pagination/reconnect/phone interaction |
| Mobile write/create UI | Medium | Idempotency, stale targets, high-impact commands |
| E2E relay/push | Very large | Cryptographic lifecycle, metadata, compatibility |

The board command authority is the biggest prerequisite. The provider history adapters are the largest source of uncertainty. The renderer itself is comparatively straightforward once those boundaries are correct.

## Open Product Decisions

These do not block P0 and P1, but must be resolved before their associated remote feature ships:

1. Confirm the practical content promise: original user/assistant text may contain repository-derived content.
2. Decide whether branch names are on by default or a per-project/device option.
3. Decide whether v1 allows sending a follow-up while an agent is running or returns “not ready.”
4. Define the mobile-approved agent/task presets and whether a paired device may choose among all locally enabled agents.
5. Choose the first supported reachability model: private VPN/SSH only, or authenticated HTTPS behind an explicit reverse proxy.
6. Decide whether answering a permission prompt requires recent reauthentication in addition to possession of a paired session.
7. Decide whether two phones may be paired simultaneously in v1; the architecture should support it even if UI policy initially limits it.

## Likely Integration Areas

- [`../src/core/task-board-mutations.ts`](../src/core/task-board-mutations.ts): shared pure board reducers.
- [`../src/state/project-state.ts`](../src/state/project-state.ts): locked/revisioned persistence.
- [`../src/terminal/session-summary-store.ts`](../src/terminal/session-summary-store.ts): session identity and outstanding attention state.
- [`../src/terminal/session-transition-controller.ts`](../src/terminal/session-transition-controller.ts): lifecycle consequences; conversation must not bypass it.
- [`../src/terminal/session-input-pipeline.ts`](../src/terminal/session-input-pipeline.ts): existing raw local PTY input semantics.
- [`../src/terminal/agent-session-adapters.ts`](../src/terminal/agent-session-adapters.ts): provider launch/resume behavior.
- [`../src/commands/hook-metadata.ts`](../src/commands/hook-metadata.ts): provider hook identity and prompt metadata.
- [`../src/trpc/hooks-api.ts`](../src/trpc/hooks-api.ts): current hook ingestion and activity boundary.
- [`../src/server/runtime-state-hub.ts`](../src/server/runtime-state-hub.ts): authoritative update delivery to local clients.
- [`../web-ui/src/hooks/project/project-sync.ts`](../web-ui/src/hooks/project/project-sync.ts): current authoritative hydrate/reconciliation seam.
- [`../web-ui/src/state/board-state.ts`](../web-ui/src/state/board-state.ts): desktop adapters over shared board reducers.
- A new `src/conversation/` provider-adapter/service boundary.
- A new `src/remote/` contract, projection, command facade, authentication, and gateway boundary.
- A separate mobile entry point/package that cannot import desktop API clients.

## References

- [Herdr persistence and remote access](https://herdr.dev/docs/persistence-remote/)
- [Kandev authentication](https://kandev.ai/docs/authentication)
- [Kangentic Mobile](https://kangentic.com/mobile/)
- [OWASP WebSocket Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
