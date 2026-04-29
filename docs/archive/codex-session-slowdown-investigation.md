# Codex Session Slowdown Investigation

Investigation date: 2026-04-28

Scope: static review of `HEAD~15..HEAD`, plus follow-up runtime/code-path investigation for branch detection, title generation, resume behavior, CPU pressure, and stale session state. Focused on regressions or architecture paths that could cause major slowdown, CPU churn, UI lag, excess I/O, memory growth, or terminal rendering overhead when multiple Codex task sessions run at once.

User symptom: running even 3 Codex sessions feels slow.

## Executive Summary

I did not find a convincing new unbounded memory leak in the last 15 commits. The main risk is event amplification: Codex sessions now emit more lifecycle/activity events, and existing runtime/UI paths make those events more expensive than they need to be.

The most likely slowdown chain is:

1. Codex emits native hook events for tool use, prompt submit, permissions, stop, and session start.
2. Each native hook runs a Quarterdeck CLI process.
3. The hook CLI parses stdin, writes a diagnostic line to stderr, creates a tRPC client, and mutates runtime state.
4. Runtime state changes trigger session-summary websocket batches.
5. Each session-summary batch also requests a project-summary refresh.
6. Some hook transitions also broadcast full project-state snapshots.
7. The browser currently treats every new streamed project-state object as a reason to call `project.getState` again.

With one session, this is easy to miss. With 3 Codex sessions, especially if they are all using tools, spinners, status redraws, or approval flows, the system can repeatedly do redundant project-state reads, project-summary rebuilds, terminal output processing, websocket fanout, and xterm rendering.

The top fixes should be:

1. Stop refetching project state every time `streamedProjectState` changes.
2. Remove or gate successful `[hooks:cli] parsed` stderr diagnostics.
3. Stop refreshing project summaries for pure activity/`lastOutputAt` session updates.
4. Throttle or make non-broadcasting the high-frequency `lastOutputAt` output updates.
5. Restore concurrent initial stream snapshot loading.
6. Add timeouts and slow-command diagnostics to git metadata polling.
7. Prevent title generation from retrying forever for cards whose title remains `null`.
8. Prune stale session summaries so project-state snapshots do not carry old task history forever.
9. Add runtime CPU/event-loop instrumentation so "everything is slow" incidents have a direct signal.

## Commit Window Reviewed

Last 15 commits reviewed:

| Commit | Title | Performance risk |
| --- | --- | --- |
| `7302a1e8c` | `fix: add terminal restore diagnostics` | Low. Adds one-shot restore watchdog logging. No obvious leak. |
| `af37ce32c` | `fix: seed cross-project notification snapshots` | Low. Adds connection-time notification snapshot seeding. Payload can grow with managed active sessions, but not a live loop. |
| `b6b1926dd` | `fix: suppress closed pty write noise` | Low. Guards node-pty async write errors. No persistent timer or buffer growth found. |
| `8ba3c8903` | `fix: preserve failed Codex startup resume` | Low. Writes system output once on failed startup resume. |
| `dc2f6d459` | `refactor: switch Codex to native hooks` | High. Moves Codex lifecycle to native hooks, increasing per-tool hook process/tRPC/terminal-output overhead. |
| `6a15910cd` | `fix: lower normal auto-restart skip severity` | Very low. Log severity only. |
| `c0cfd575b` | `fix: stabilize Codex resume lifecycle` | Medium for startup bursts. Can resume multiple interrupted sessions concurrently. Not the main ongoing slowdown path. |
| `99099025e` | `fix: skip shell stop RPC when home terminal was never opened` | Very low. Avoids unnecessary RPC. |
| `2767e5f5d` | `fix: stop shell terminal sessions on close` | Low. Tracks pending stops; promises should clear because server stop has a timeout. |
| `7f5a47de2` | `docs: consolidate architecture and convention docs` | None. Documentation only. |
| `94bdae0eb` | `fix: repair invalid project sessions on load` | High. Added `streamedProjectState` dependency that can refetch state after every streamed state update; also serialized initial stream snapshot loading. |
| `70f9cfa4f` | `fix: log full toast warning/error messages to debug log` | Low. Could add debug-log volume when errors are frequent, but not likely for 3 normal sessions. |
| `a24b9cf6a` | `chore: bump postcss to 8.5.10 in both packages` | None for runtime session slowdown. |
| `348c41af5` | `fix: resume Codex task sessions by stored session id` | Low. Resume correctness, not ongoing hot path. |
| `dccf2e0f5` | `fix: stabilize untrash task resume` | Low. Restore/resume correctness, not ongoing hot path. |

## Follow-Up Live Investigation

After the initial static review, a follow-up check looked specifically at why unrelated features appeared to degrade together:

- branch/base-ref detection not appearing even when git UI was not visible,
- title or branch-name generation showing UI failure but little or no server warning,
- concern that bad resume attempts might be looping,
- general app slowdown that felt CPU-bound rather than memory-bound.

The live process snapshot supported the CPU/event-loop contention theory:

- the main `quarterdeck` runtime Node process was actively using roughly `20-24%` CPU,
- runtime memory looked ordinary, around `175MB`,
- multiple Codex processes were active with native hook config,
- one active process was a `codex resume <stored-session-id> ...` launch,
- at least one short-lived `git` process appeared in the process table during sampling.

The project state also showed stale-session bloat:

- `/Users/d.cole/.quarterdeck/projects/quarterdeck/sessions.json` contained `189` session summaries,
- the current board for that project had only one visible work-column card,
- `buildProjectStateSnapshot()` merges every `terminalManager.store.listSummaries()` entry into the streamed project-state response.

That means the slowdown is probably not a classic heap leak. The stronger model is CPU and event-loop pressure from many small operations: hook processes, tRPC hook ingests, terminal output updates, git metadata probes, full project-state snapshots, project summary rebuilds, and background LLM generation.

## Finding 1: Streamed Project State Triggers Redundant Fetches

Primary file: `web-ui/src/hooks/project/use-project-sync.ts`

Relevant current code:

```ts
useEffect(() => {
	if (!hasReceivedSnapshot || !isDocumentVisible || !streamedProjectState) {
		return;
	}
	void refreshProjectState();
}, [hasReceivedSnapshot, isDocumentVisible, refreshProjectState, streamedProjectState]);
```

Commit: `94bdae0eb` (`fix: repair invalid project sessions on load`)

### What Changed

Before `94bdae0eb`, the visibility refresh effect depended on:

```ts
[hasReceivedSnapshot, isDocumentVisible, refreshProjectState]
```

After `94bdae0eb`, it depends on:

```ts
[hasReceivedSnapshot, isDocumentVisible, refreshProjectState, streamedProjectState]
```

The new guard avoids fetching project state when the initial websocket snapshot has no project state, which is good. The problem is using the full `streamedProjectState` object as a dependency.

Every websocket `project_state_updated` message creates a new project-state object. That object is already authoritative and already applied by the adjacent effect:

```ts
useEffect(() => {
	if (hasNoProjects) {
		applyProjectState(null);
		return;
	}
	if (!streamedProjectState) {
		return;
	}
	applyProjectState(streamedProjectState);
}, [applyProjectState, hasNoProjects, streamedProjectState]);
```

Then the second effect sees `streamedProjectState` changed and calls `refreshProjectState()`, which calls `fetchProjectState()`.

### Why It Slows Down Multiple Codex Sessions

For a task-state transition, the runtime may send a full `project_state_updated` snapshot. With this effect, the browser can respond by asking the server for another full project-state snapshot immediately after receiving one.

The resulting loop is not infinite, but it is redundant:

1. Server builds project state.
2. Server sends `project_state_updated`.
3. Browser applies the streamed state.
4. Browser sees `streamedProjectState` changed.
5. Browser calls `project.getState`.
6. Server builds project state again.
7. Browser applies the fetched state.

The server-side build path is not free:

```ts
const response = await loadProjectState(projectPath);
const terminalManager = await ensureTerminalManagerForProject(projectId, projectPath);
for (const summary of terminalManager.store.listSummaries()) {
	response.sessions[summary.taskId] = summary;
}
```

`loadProjectState()` reads project context, board, sessions, and meta. With several sessions, each redundant refresh also merges live summaries.

### Why This Is Probably Recent

The exact dependency change is from `94bdae0eb`, which is within the reviewed range. This is the strongest recent regression candidate.

### Expected Symptoms

- Browser network panel shows repeated `project.getState` calls shortly after websocket `project_state_updated` messages.
- UI feels worse during task transitions, approvals, or review transitions.
- Server spends extra time in `buildProjectStateSnapshot` and `loadProjectState`.
- More React updates because the same project state is applied through both stream and fetch paths.

### Recommended Fix

Keep the "do not refresh until a streamed state exists" guard, but do not depend on the full object identity.

One minimal shape:

```ts
const hasStreamedProjectState = streamedProjectState !== null;

useEffect(() => {
	if (!hasReceivedSnapshot || !isDocumentVisible || !hasStreamedProjectState) {
		return;
	}
	void refreshProjectState();
}, [hasReceivedSnapshot, isDocumentVisible, refreshProjectState, hasStreamedProjectState]);
```

A more precise shape would refresh only when visibility changes from hidden to visible, or when the active project changes and the stream has not delivered usable state yet. The important invariant: a new streamed authoritative state object should not itself trigger `project.getState`.

### Recommended Test

Add a `useProjectSync` test that:

1. Mounts with `hasReceivedSnapshot=true`, `isDocumentVisible=true`, and a non-null streamed project state.
2. Rerenders with a second non-null streamed project state object for the same project.
3. Asserts `fetchProjectState` is not called just because the streamed object changed.

Existing tests cover the "do not refresh when no snapshot/no state" cases, but not this repeated-stream update case.

## Finding 2: Native Codex Hooks Add Per-Hook Process, tRPC, and Terminal Output Work

Primary files:

- `src/codex-hooks.ts`
- `src/terminal/agent-session-adapters.ts`
- `src/commands/hooks.ts`
- `src/trpc/hooks-api.ts`

Commit: `dc2f6d459` (`refactor: switch Codex to native hooks`)

### What Changed

The Codex adapter now enables the Codex hooks feature and injects launch-scoped hook config:

```ts
if (!hasCodexFeatureEnabled(codexArgs, CODEX_HOOKS_FEATURE_NAME)) {
	codexArgs.push("--enable", CODEX_HOOKS_FEATURE_NAME);
}

const hookOverrides = buildCodexHookConfigOverrides();
codexArgs.push(...hookOverrides);
```

The hook config wires several Codex events to `quarterdeck hooks ingest`:

```ts
SessionStart -> activity
PreToolUse -> activity
PermissionRequest -> to_review
PostToolUse -> to_in_progress
UserPromptSubmit -> to_in_progress
Stop -> to_review
```

The old wrapper/log-watcher path was removed. Before this commit, the wrapper watched Codex session logs and rollout logs on intervals, then emitted detached `hooks notify` events. After this commit, native Codex hooks run Quarterdeck commands directly for each configured event.

### Per-Hook Cost

Each successful native hook currently does this:

1. Spawns a Quarterdeck CLI process.
2. Reads hook JSON from stdin.
3. Parses and normalizes metadata.
4. Writes a success diagnostic to stderr:

   ```ts
   writeHookCliDiagnostic(args, "parsed");
   ```

5. Creates a tRPC proxy client:

   ```ts
   createTRPCProxyClient<RuntimeAppRouter>({
    links: [httpBatchLink({ url: buildQuarterdeckRuntimeUrl("/api/trpc"), maxItems: 1 })],
   });
   ```

6. Calls `hooks.ingest.mutate`.
7. On failure, waits 1 second and retries once.

### Why It Slows Down Multiple Codex Sessions

For one ordinary tool call, a Codex session can emit at least:

- `PreToolUse`
- `PostToolUse`

Permission flows add `PermissionRequest`. User input adds `UserPromptSubmit`. Completion adds `Stop`. Session metadata can add `SessionStart`.

With 3 Codex sessions using tools, this multiplies quickly:

- 3 sessions x multiple tool calls x multiple hook commands per tool call.
- Each hook command starts a process and performs an HTTP mutation.
- Successful hooks write diagnostic text to the same PTY the user sees.
- That diagnostic text goes through the terminal pipeline, headless xterm mirror, websocket output fanout, browser xterm renderer, and scrollback.

This is not a memory leak, but it is on the foreground path of active Codex work.

### Important Detail: Successful Diagnostics Are User-Visible Work

The current code always writes this on successful `hooks ingest`:

```ts
[hooks:cli] parsed event=... project=... task=... source=... hookEvent=...
```

Because native hooks run inside the agent session environment, this stderr output can become terminal output. That has several costs:

- PTY output read on the server.
- Terminal protocol filtering.
- Headless xterm state mirror update.
- `lastOutputAt` store update.
- Browser IO websocket message.
- xterm render and scrollback update.

With 3 sessions, diagnostic lines from hooks can add visible terminal churn even when the actual agent work is modest.

### Important Detail: Hook Transitions Broadcast Full Project State

In `src/trpc/hooks-api.ts`, when a hook actually transitions state, it creates transition effects:

```ts
const effects = createHookTransitionEffects({
	projectId,
	projectPath,
	taskId,
	event,
});
```

`createHookTransitionEffects()` includes:

```ts
{
	type: "project_state_updated",
	projectId,
	projectPath,
}
```

Then `broadcastRuntimeProjectStateUpdated()` rebuilds full project state and sends it to project clients.

This is correct for authoritative board/session reconciliation, but it makes hook transitions more expensive. Finding 1 then makes the browser ask for the same state again.

### Important Detail: Stop Hooks Queue Checkpoint Capture

For `to_review` transitions, the hook path queues turn checkpoint capture:

```ts
void (async () => {
	const checkpoint = await checkpointCapture({
		cwd: checkpointCwd,
		taskId,
		turn: nextTurn,
	});
	store.applyTurnCheckpoint(taskId, checkpoint);
})();
```

The comment notes checkpoint capture runs git operations. This is backgrounded after the response, so it should not block the hook response directly, but several sessions completing together can still create concurrent git work.

### Recommended Fixes

Recommended in priority order:

1. Gate successful hook diagnostics behind debug mode or an explicit env var. Keep error/retry diagnostics.
2. Use `hooks notify` or another best-effort path for low-value activity-only hooks if reliability is not required.
3. Consider removing or sampling `PreToolUse`/`PostToolUse` activity updates if the UI does not need every tool event.
4. Keep reliable `ingest` semantics for state-critical hooks: `PermissionRequest`, `UserPromptSubmit`, and `Stop`.
5. Avoid full project-state broadcasts when a hook only updates activity metadata and does not change board placement or task state.

## Finding 3: Session Summary Fanout Refreshes Project Summaries Too Often

Primary files:

- `src/terminal/session-output-pipeline.ts`
- `src/server/runtime-state-message-batcher.ts`
- `src/server/runtime-state-hub.ts`
- `src/server/project-registry.ts`

This is mostly pre-existing, but the native-hook change and extra terminal output make it much more visible.

### Current Output Hot Path

Every task PTY output chunk does:

```ts
deps.updateStore(taskId, { lastOutputAt: Date.now() });
```

That store update emits a session summary change.

The runtime state batcher coalesces session summary changes for 150ms:

```ts
const TASK_SESSION_STREAM_BATCH_MS = 150;
```

When the batch flushes, it does three things:

```ts
this.deps.onTaskSessionBatch(event.projectId, event.summaries);
this.deps.onTaskNotificationBatch(event.projectId, event.summaries);
this.deps.onProjectsRefreshRequested(event.projectId);
```

The third call rebuilds and broadcasts the project list:

```ts
const payload = await this.deps.projectRegistry.buildProjectsPayload(preferredCurrentProjectId);
this.clients.broadcastToAll(buildProjectsUpdatedMessage(payload.currentProjectId, payload.projects));
```

`buildProjectsPayload()` maps over projects and summarizes task counts. For projects with active terminal managers, task count summarization reads board state:

```ts
const board = await loadProjectBoardById(projectId);
const persistedCounts = countTasksByColumn(board);
const liveSessionsByTaskId = {};
for (const summary of terminalManager.store.listSummaries()) {
	liveSessionsByTaskId[summary.taskId] = summary;
}
const nextCounts = applyLiveSessionStateToProjectTaskCounts(persistedCounts, board, liveSessionsByTaskId);
```

### Why It Slows Down Multiple Codex Sessions

Codex and Claude can produce frequent incidental terminal output: status redraws, spinners, prompt updates, ANSI cursor movement, and now hook diagnostics. The AGENTS guidance already calls this out: terminal output does not mean the agent is working.

Even so, every output chunk currently updates `lastOutputAt`, and every resulting session-summary batch asks for a project-summary refresh.

With 3 active Codex sessions, the system can approach:

- many terminal output chunks per second,
- up to one task-session batch every 150ms per project,
- one project-list refresh per batch,
- repeated board reads/count recomputations,
- websocket broadcasts to all clients,
- browser state updates for project summaries.

The batcher prevents a truly per-chunk project refresh, but a 150ms interval still allows roughly 6 to 7 project-summary refreshes per second during continuous output.

### Why This Is Not Strictly a Recent Regression

The `lastOutputAt` update and batcher behavior predate the latest 15 commits. However, the native Codex hook refactor adds more events and terminal output to feed this existing mechanism.

So this is likely a pre-existing architecture issue that became noticeably worse after `dc2f6d459`.

### Recommended Fixes

Recommended in priority order:

1. Do not request `projects_updated` for summary changes that cannot affect project task counts.
2. Classify summary changes before fanout. Count-affecting fields include at least `state` and possibly `reviewReason`. Non-count-affecting fields include `lastOutputAt`, `latestHookActivity`, and possibly `resumeSessionId`.
3. Throttle project-summary refreshes separately from task-session batches. For example, allow fast task-session deltas but project summary refresh at a much lower rate.
4. Consider making `lastOutputAt` an internal volatile field that does not emit a full session-summary store change on every chunk, or throttle it to once every few seconds.
5. Keep task-session websocket updates for UI details that truly need them, but decouple them from project-list/count refreshes.

### Suggested Test Coverage

Add a batcher or integration test that simulates repeated `lastOutputAt`-only summary updates and asserts:

- task-session batch is sent,
- task-notification batch is sent only if needed,
- project-summary refresh is not requested for non-count-affecting updates.

Add a second test showing state transition updates still request project-summary refresh.

## Finding 4: Initial Stream Snapshot Loading Became Serialized

Primary file: `src/server/runtime-state-hub.ts`

Commit: `94bdae0eb`

### What Changed

Before:

```ts
const [projectsPayload, projectState] = await Promise.all([
	this.deps.projectRegistry.buildProjectsPayload(resolved.projectId),
	this.deps.projectRegistry.buildProjectStateSnapshot(resolved.projectId, resolved.projectPath),
]);
```

After:

```ts
const projectsPayload = await this.deps.projectRegistry.buildProjectsPayload(resolved.projectId);
let projectState: RuntimeProjectStateResponse | null = null;
let projectStateError: string | null = null;
try {
	projectState = await this.deps.projectRegistry.buildProjectStateSnapshot(
		resolved.projectId,
		resolved.projectPath,
	);
} catch (error) {
	projectStateError = error instanceof Error ? error.message : String(error);
}
```

### Why It Matters

This makes first websocket snapshot loading take roughly:

```text
projects payload time + project state snapshot time
```

instead of:

```text
max(projects payload time, project state snapshot time)
```

That affects reload/connect/hydration latency, not ongoing session activity.

### Why It Changed

The intent was good: keep the project list visible if loading the selected project state fails, and surface the project-state error separately.

### Recommended Fix

Use concurrent promise execution while preserving independent error handling:

```ts
const projectsPromise = this.deps.projectRegistry.buildProjectsPayload(resolved.projectId);
const projectStatePromise = this.deps.projectRegistry.buildProjectStateSnapshot(
	resolved.projectId,
	resolved.projectPath,
);

const projectsPayload = await projectsPromise;
let projectState: RuntimeProjectStateResponse | null = null;
let projectStateError: string | null = null;
try {
	projectState = await projectStatePromise;
} catch (error) {
	projectStateError = error instanceof Error ? error.message : String(error);
}
```

If `buildProjectsPayload` itself fails, the whole snapshot can still fail as before.

## Finding 5: Startup Resume Can Launch Multiple Codex Sessions at Once

Primary file: `src/server/project-registry.ts`

Relevant code:

```ts
for (const { taskId, cwd, resumeSessionId } of resumable) {
	void manager
		.startTaskSession({
			taskId,
			agentId: resolved.agentId,
			...
			resumeConversation: true,
			resumeSessionId,
			awaitReview: true,
			...
		})
		.catch(...);
}
```

Commit: `c0cfd575b`

### What Changed

Startup resume handling was made more robust. The selector now considers this resumable:

```ts
return summary.state === "awaiting_review" && summary.reviewReason === "attention" && summary.pid !== null;
```

That catches hard server/process exits where the persisted summary still says the agent was awaiting attention but the PID is stale.

### Why It Can Slow Startup

If several work-column sessions are considered resumable, Quarterdeck starts them all without a concurrency cap. With 3 Codex sessions, this can launch 3 Codex processes close together, and each starts with native hook config.

This is a startup/reload burst, not an ongoing runtime leak.

### Recommended Fix

Add a small concurrency limit for startup resume launches, or stagger them. A limit of 1 or 2 is probably enough. Also keep the warning logs for failed or skipped startup resume so missed resumes stay visible.

## Finding 6: Latest Two Commits Do Not Look Like the Main Cause

### `7302a1e8c`: Terminal Restore Diagnostics

Primary file: `web-ui/src/terminal/slot-socket-manager.ts`

The restore watchdog is one-shot:

```ts
this.restoreStallWarningTimer = setTimeout(() => {
	this.restoreStallWarningTimer = null;
	if (!this.restoreInProgress) {
		return;
	}
	log.warn(...);
}, RESTORE_STALL_WARNING_MS);
```

It is cleared on restore completion, socket reset, and close paths. This does not look like an active memory leak or a repeated CPU loop.

Potential minor issue: if restore remains stuck, the flag can stay true and the warning fires once. That is a stuck-terminal diagnostic path, not a broad slowdown mechanism.

### `af37ce32c`: Cross-Project Notification Snapshots

Primary file: `src/server/runtime-state-hub.ts`

The new snapshot collection runs during stream snapshot loading:

```ts
private collectNotificationSummariesByProject(): Record<string, RuntimeTaskSessionSummary[]> {
	const summariesByProject: Record<string, RuntimeTaskSessionSummary[]> = {};
	for (const project of this.deps.projectRegistry.listManagedProjects()) {
		const summaries = project.terminalManager.store.listSummaries();
		if (summaries.length === 0) {
			continue;
		}
		summariesByProject[project.projectId] = summaries;
	}
	return summariesByProject;
}
```

This can increase initial snapshot payload size in proportion to active managed sessions, but it does not run continuously. It is unlikely to explain ongoing slowdown while 3 sessions are active.

## Finding 7: Pre-Existing Leak Candidate Outside the 15-Commit Window

Primary files:

- `src/server/project-registry.ts`
- `src/terminal/session-manager.ts`
- `src/terminal/session-reconciliation-sweep.ts`

This was not introduced by the reviewed commits, but it is worth tracking separately.

`ensureTerminalManagerForProject()` starts reconciliation:

```ts
manager.startReconciliation(repoPath);
```

`TerminalSessionManager` exposes:

```ts
startReconciliation(repoPath?: string): void {
	this.reconciliation.start(repoPath);
}

stopReconciliation(): void {
	this.reconciliation.stop();
}
```

The reconciliation timer is a 10-second interval:

```ts
timer = setInterval(() => {
	reconcileSessionStates(ctx, storedRepoPath);
}, SESSION_RECONCILIATION_INTERVAL_MS);
timer.unref();
```

But `ProjectRegistry.disposeProject()` deletes the terminal manager without stopping reconciliation:

```ts
if (terminalManager) {
	if (options?.stopTerminalSessions !== false) {
		terminalManager.markInterruptedAndStopAll();
	}
	terminalManagersByProjectId.delete(projectId);
	terminalManagerLoadPromises.delete(projectId);
}
```

That can retain an old manager through the interval closure after a project is removed. It is pre-existing, so it does not explain a new slowdown from the last 15 commits unless project removal happens frequently, but it is a real cleanup gap.

Recommended fix:

```ts
terminalManager.stopReconciliation();
```

Call it during project disposal, alongside `markInterruptedAndStopAll()`.

## Finding 8: Git and Branch Metadata Polling Runs Even When Git UI Is Not Visible

Primary files:

- `src/server/project-metadata-controller.ts`
- `src/server/project-metadata-poller.ts`
- `src/server/project-metadata-remote-fetch.ts`
- `src/server/project-metadata-loaders.ts`
- `src/workdir/git-utils.ts`
- `src/workdir/git-probe.ts`

### What Is Happening

Branch/base-ref detection is not only top-bar UI work. The server metadata monitor starts as part of the runtime project stream connection. When a project connects, the controller starts metadata polling and remote fetch policy:

```ts
this.poller.start();
this.remoteFetchPolicy.start();
this.remoteFetchPolicy.requestFetch();
return await this.refresher.refreshProject();
```

The default polling cadence is:

```ts
focusedTaskPollMs: 2_000
backgroundTaskPollMs: 5_000
homeRepoPollMs: 10_000
```

The remote fetch policy also runs:

```ts
git fetch --all --prune
```

every 60 seconds, and once immediately on project connect.

### Why Top-Bar Visibility Does Not Matter

The browser does not need to show the git surface for this work to run. Once the project stream is connected, the server tracks home repo metadata and work-column task worktree metadata so task badges, behind-base counts, conflict state, branch/base-ref auto-detection, and other metadata-dependent views can stay fresh.

This explains why branch detection can degrade even when "the top bar git stuff" is not visible. The feature is fed by the server metadata poller, not by a top-bar-only UI query.

### Why Degraded Runtime Performance Can Break Branch Detection

Task metadata refresh is git-heavy. A single task worktree metadata load can run:

- `git status --porcelain=v2 --branch --untracked-files=all`
- `git rev-parse --verify HEAD`
- `git rev-parse --verify <baseRef>`
- `git rev-parse --verify origin/<baseRef>`
- `git diff --quiet <baseRef>...HEAD`
- `git diff --quiet <baseRef> HEAD`
- merge-base and rev-list calls for behind-base counts
- conflict detection helpers when relevant

The `runGit()` helper uses `execFileAsync("git", ...)` with a large buffer but no timeout:

```ts
const { stdout, stderr } = await execFileAsync("git", fullArgs, {
	cwd,
	encoding: "utf8",
	maxBuffer: GIT_MAX_BUFFER_BYTES,
	env: options.env || createGitProcessEnv(),
});
```

When the runtime is under CPU pressure or git is slow, metadata refreshes can lag. If git hangs or slows down on a particular worktree, that refresh can wait indefinitely. Many failures are intentionally swallowed:

```ts
} catch {
	return currentHomeGit;
}
```

and:

```ts
} catch {
	if (current) {
		return current;
	}
	return { ...null metadata... };
}
```

So branch/base-ref detection can appear to silently stop working: the UI sees stale or missing metadata, but the server may not emit a warning.

### Why This Gets Worse With Multiple Codex Sessions

Multiple active sessions increase:

- PTY output events,
- hook-ingest events,
- project-state broadcasts,
- project-summary rebuilds,
- task metadata tracked in active columns,
- child-process contention with git and hook CLI processes.

Even if the git polling itself is rate-limited, it shares the same Node runtime and machine CPU with hook processing and terminal fanout.

### Recommended Fixes

1. Add a timeout to `runGit()` and include the command name, cwd, duration, and timeout in warn-level logs for metadata poll paths.
2. Add slow-command diagnostics before timeout, for example warn if a metadata git command exceeds 2 seconds.
3. Add visibility or subscriber sensitivity for expensive metadata work. If the project has no visible client or the document is hidden, increase poll intervals or pause background task polling.
4. Do not run immediate `git fetch --all --prune` on every stream connect if another fetch recently ran.
5. Make metadata refresh failures visible enough to distinguish "no branch changed" from "metadata probe failed or timed out."

## Finding 9: Title and Branch Generation Fail Quietly Under Runtime Pressure

Primary files:

- `src/title/llm-client.ts`
- `src/title/title-generator.ts`
- `src/trpc/project-procedures.ts`
- `src/trpc/project-api-state.ts`
- `web-ui/src/hooks/board/use-title-actions.ts`
- `web-ui/src/hooks/board/use-task-editor.ts`

### What Is Happening

Task title, branch name, display summary, and commit message generation all use the shared lightweight LLM client. The LLM client has a 5-second default timeout:

```ts
signal: AbortSignal.timeout(options.timeoutMs ?? 5_000)
```

`generateTaskTitle()` and `generateBranchName()` also pass `timeoutMs: 5_000`.

When the fetch times out, the client logs at debug level rather than warn:

```ts
const isTimeout = error instanceof DOMException && error.name === "AbortError";
const level = isTimeout ? "debug" : "warn";
log[level]("LLM call error", {
	error: isTimeout ? "timeout" : error instanceof Error ? error.message : String(error),
});
return null;
```

That means a title or branch-name failure can produce a UI failure state with no warn/error log at the default log level.

### Why The Timeout Can Feel Longer Than 5 Seconds

The timeout is attached to the `fetch()` call once the LLM call actually starts. If the runtime is CPU-bound or backlogged, the request handler may not start immediately, and timers can fire late when the Node event loop is saturated. From the user's perspective, this can feel like a very long title-generation attempt even though the fetch timeout is nominally 5 seconds.

The LLM client also has a process-wide rate limiter:

```ts
MAX_CONCURRENT = 5
MAX_PER_MINUTE = 20
```

When the limiter is hit, `callLlm()` returns `null`. That can look identical to timeout or provider failure at the API response level.

### Auto-Title Generation Can Retry Too Broadly

`saveState()` currently kicks off background title generation for every card in the saved board whose `title === null`:

```ts
const untitledCards = input.board.columns.flatMap((col) => col.cards.filter((card) => card.title === null));
```

It batches those calls three at a time:

```ts
for (let i = 0; i < untitledCards.length; i += MAX_CONCURRENT_TITLE_REQUESTS) {
	const batch = untitledCards.slice(i, i + MAX_CONCURRENT_TITLE_REQUESTS);
	await Promise.allSettled(batch.map(generateTitle));
}
```

This is fire-and-forget, so it does not block the save response. But if title generation repeatedly returns `null`, those cards remain untitled, and later board saves can attempt generation again. During degraded runtime conditions, this can create recurring background LLM attempts that are hard to see.

### UI Error Paths Are Inconsistent

Manual branch-name generation explicitly shows a toast when the server returns `ok: false`.

Manual title regeneration currently only shows a toast on rejected tRPC calls:

```ts
void trpcClient.project.regenerateTaskTitle.mutate({ taskId }).catch(() => {
	showAppToast({ message: "Could not regenerate title", intent: "danger" });
});
```

If the mutation successfully returns `{ ok: false, title: null }`, that path does not currently surface the same kind of UI error. This makes it harder to distinguish transport failures from ordinary LLM-null responses.

### Recommended Fixes

1. Log LLM timeout at warn level, with operation type (`task title`, `branch name`, `display summary`, `commit message`), task id when available, and elapsed time.
2. Add server-side timing around the whole mutation, not only the fetch call, so event-loop queuing becomes visible.
3. Track auto-title generation attempts per task and apply a cooldown after failure.
4. Generate titles only for newly created cards, or persist enough metadata to avoid retrying every board save for permanently untitled cards.
5. Make manual title regeneration inspect `{ ok: false }` and show a clear UI message.
6. Consider a separate queue for background title generation so it cannot compete directly with hook ingest and project-state work.

## Finding 10: Bad Resume Attempts Look Bounded, But Resume Bursts Still Add Load

Primary files:

- `src/server/runtime-state-hub.ts`
- `src/server/project-registry.ts`
- `src/terminal/session-auto-restart.ts`
- `src/terminal/session-lifecycle.ts`

### What The Code Does To Prevent Infinite Loops

I did not find evidence of an unbounded bad-resume loop.

Startup resume is guarded per project in the runtime state hub:

```ts
if (snapshot.projectId && snapshot.projectPath && snapshot.projectState && !this.resumeAttempted.has(snapshot.projectId)) {
	this.resumeAttempted.add(snapshot.projectId);
	void this.deps.projectRegistry.resumeInterruptedSessions(snapshot.projectId, snapshot.projectPath);
}
```

Auto-restart is rate-limited:

```ts
AUTO_RESTART_WINDOW_MS = 5_000
MAX_AUTO_RESTARTS_PER_WINDOW = 3
```

Non-zero startup resume failure is preserved instead of falling back to a fresh blank prompt:

```ts
const message = `Resume failed before opening an interactive session (exit code ${event.exitCode}).`;
deps.updateStore(request.taskId, {
	state: "awaiting_review",
	reviewReason: "error",
	warningMessage: message,
});
```

### What Can Still Hurt Performance

The startup resume path launches all resumable tasks without a concurrency cap:

```ts
for (const { taskId, cwd, resumeSessionId } of resumable) {
	void manager.startTaskSession(...);
}
```

A live process sample also showed an active `codex resume <stored-session-id>` process plus other Codex sessions. That is not proof of a loop, but resumed sessions still participate in the same native-hook and terminal-output pipeline as fresh sessions.

### Recommended Fixes

1. Add a small concurrency limit for startup resume, likely 1 or 2.
2. Add counters for startup resume selected, launched, succeeded, failed, and skipped.
3. Add explicit logs when `resumeAttempted` suppresses additional startup resume attempts for a project.
4. Surface failed resume summaries more directly in the UI so users do not interpret a quiet error state as background retrying.
5. Add process-table or runtime diagnostics listing active task sessions and whether they came from resume.

## Finding 11: The Current Symptom Looks CPU/Event-Loop Bound, Not Memory Bound

The live process sample did not show a large runtime heap. The main runtime process was using normal-looking memory but sustained noticeable CPU.

Observed snapshot:

```text
quarterdeck node process: roughly 20-24% CPU
quarterdeck node memory: roughly 175 MB
multiple Codex child processes active
at least one git child process appeared during sampling
```

This fits the event-amplification model:

- many short-lived hook CLI processes,
- frequent tRPC hook mutations,
- terminal output and xterm mirror updates,
- session summary store emissions,
- project summary refreshes,
- project-state snapshot rebuilds,
- git metadata polling,
- background LLM requests.

It does not fit an obvious heap leak as the primary cause.

### Recommended Fixes

1. Track event-loop delay with `perf_hooks.monitorEventLoopDelay()` and expose it in the debug panel.
2. Track per-minute counts for hook ingests, project-state broadcasts, project-summary refreshes, git commands, and LLM calls.
3. Add a lightweight runtime health snapshot endpoint for active sessions, pending hooks, pending git probes, pending LLM calls, websocket client counts, and event-loop lag.
4. Add a "performance degraded" warning when event-loop delay or runtime CPU crosses a threshold.

## Finding 12: Stale Session Summaries Bloat Project-State Work

Primary files:

- `src/terminal/session-summary-store.ts`
- `src/server/project-registry.ts`
- `src/server/runtime-state-hub.ts`
- `src/trpc/project-api-state.ts`

### What Is Happening

The in-memory summary store hydrates every persisted summary:

```ts
hydrateFromRecord(record: Record<string, RuntimeTaskSessionSummary>): void {
	for (const [taskId, summary] of Object.entries(record)) {
		this.entries.set(taskId, cloneSummary(summary));
	}
}
```

There is no obvious store-level deletion/pruning path for summaries whose cards no longer exist on the board.

Project-state snapshot building then merges every summary into the response:

```ts
for (const summary of terminalManager.store.listSummaries()) {
	response.sessions[summary.taskId] = summary;
}
```

The browser save path also persists every authoritative summary:

```ts
const authoritativeSessions = Object.fromEntries(
	terminalManager.store.listSummaries().map((summary) => [summary.taskId, summary]),
);
```

And cross-project notification snapshots enumerate summaries from managed projects:

```ts
const summaries = project.terminalManager.store.listSummaries();
```

### Evidence From The Live Project State

The `quarterdeck` project state had:

- `189` persisted session summaries,
- only one visible work-column card in `board.json`.

That means full project-state snapshots and save payloads can carry a lot of old session data that is not relevant to the current board.

### Why This Can Degrade General Performance

Stale session bloat increases:

- JSON serialization and parsing cost,
- websocket payload size,
- React state reconciliation cost,
- session merge cost in project-state apply logic,
- project save payload size,
- notification snapshot work.

It also makes debugging harder because old Codex attention/error states remain in `sessions.json` long after their cards are gone.

### Recommended Fixes

1. Add a store pruning method that keeps only:
   - task ids present in active board columns,
   - shell terminal task ids that still exist,
   - currently active task sessions,
   - recently completed summaries still needed for restore/review.
2. Prune summaries during project-state load or authoritative project-state reconciliation.
3. Ensure trash/hard-delete flows remove obsolete session summaries once they are no longer needed for restore.
4. Add a test fixture with many orphan summaries and assert project-state snapshots exclude them.
5. Add a diagnostic count: total summaries, board-linked summaries, active summaries, orphan summaries.

## Less Concerning Items Reviewed

### PTY Write Guard

Commit: `b6b1926dd`

File: `src/terminal/pty-session.ts`

This replaces node-pty's private write queue processor to suppress expected closed-PTY write errors. It preserves `EAGAIN` retry with `setImmediate`, clears the write queue on terminal closure errors, and does not introduce a repeating timer.

Risk: private API fragility.

Performance/memory risk: low.

### Failed Codex Startup Resume Output

Commit: `8ba3c8903`

File: `src/terminal/session-lifecycle.ts`

The new `writeSystemOutput()` path writes a small system message into the terminal mirror/listeners when startup resume fails. It is one-shot per failed resume.

Performance/memory risk: low.

### Shell Terminal Stop on Close

Commit: `2767e5f5d`

Files:

- `web-ui/src/hooks/terminal/use-terminal-panels.ts`
- `src/terminal/session-manager.ts`

The browser tracks pending shell stop promises in a map and removes them on settle. The server wait path has a timeout. This does not look like a leak under normal failure modes.

Performance/memory risk: low.

## Concrete Follow-Up Plan

### Phase 1: Remove Clear Recent Regression

Patch `useProjectSync` so a new streamed project-state object does not automatically call `refreshProjectState()`.

Add a regression test for repeated streamed state updates.

Expected impact: reduces duplicate project-state fetches and React re-application after project-state websocket messages.

### Phase 2: Reduce Hook Terminal Churn

Gate successful hook CLI diagnostics:

- Keep parse/ingest errors visible.
- Keep retry diagnostics visible.
- Hide `[hooks:cli] parsed ...` unless a debug env var or runtime debug mode explicitly asks for it.

Expected impact: less PTY output, less xterm render work, fewer `lastOutputAt` updates caused solely by internal hook diagnostics.

### Phase 3: Decouple Session Deltas From Project Summary Refreshes

Teach the runtime state batcher not to call `onProjectsRefreshRequested()` for every session-summary batch.

Reasonable count-affecting fields:

- `state`
- `reviewReason`
- possibly `pid` when the UI uses active/inactive counts

Likely non-count-affecting fields:

- `lastOutputAt`
- `lastHookAt`
- `latestHookActivity`
- `resumeSessionId`
- `displaySummary`
- `conversationSummaries`
- `latestTurnCheckpoint`

Expected impact: continuous terminal output no longer causes repeated project-list rebuilds.

### Phase 4: Throttle Output Timestamp Store Updates

Avoid emitting a session store change for every PTY output chunk. Options:

1. Throttle `lastOutputAt` updates per task.
2. Keep `lastOutputAt` in a separate volatile map that does not emit full summary changes.
3. Update `lastOutputAt` only when needed for diagnostics/reconciliation, not for every visible output chunk.

Expected impact: reduces websocket summary batches during spinner/status redraw periods.

### Phase 5: Restore Concurrent Initial Snapshot Loading

Run `buildProjectsPayload()` and `buildProjectStateSnapshot()` concurrently again while preserving independent project-state error handling.

Expected impact: faster reload/connect, especially with many projects or slow state files.

### Phase 6: Startup Resume Concurrency Limit

Limit concurrent startup resumes to avoid launching several Codex processes at once after server restart.

Expected impact: smoother startup when multiple work-column tasks need resume.

### Phase 7: Fix Pre-Existing Reconciliation Cleanup

Call `terminalManager.stopReconciliation()` when disposing a project terminal manager.

Expected impact: prevents removed projects from retaining reconciliation intervals until process exit.

### Phase 8: Add Git Metadata Timeouts And Diagnostics

Add timeout support to `runGit()` and use it from metadata polling paths. Log slow and timed-out git commands with command name, cwd, duration, and whether the call was home, focused task, background task, branch/base-ref detection, or remote fetch.

Expected impact: branch/base-ref detection failures stop being silent, and hung git probes cannot indefinitely occupy metadata refresh work.

### Phase 9: Make LLM Generation Failures Visible And Bounded

Log LLM timeouts at warn level with operation context. Add full mutation timing around title and branch generation. Add cooldown or "already attempted" state for auto-title generation so cards that remain `title === null` do not trigger background LLM calls on every board save.

Expected impact: "could not generate title/branch" becomes diagnosable, and degraded LLM/provider state does not create recurring background work.

### Phase 10: Prune Stale Session Summaries

Add summary-store pruning so project-state snapshots carry only board-linked, active, shell, or recently restorable sessions. Add diagnostics for total summaries vs board-linked summaries.

Expected impact: smaller project-state snapshots, smaller save payloads, less stale notification/session state, and easier debugging.

### Phase 11: Add Runtime Health Signals

Add low-cost counters and event-loop delay tracking so CPU-bound degradation is visible in-app.

Expected impact: future "everything is slow" reports can distinguish event-loop lag, hook storms, git probe backlog, LLM backlog, websocket pressure, and memory growth.

## Suggested Instrumentation

Add temporary counters or debug timings around these paths:

1. Hook ingest count per minute by event and source.
2. Hook CLI elapsed time from process start to mutation response.
3. `broadcastRuntimeProjectStateUpdated()` duration and count.
4. `buildProjectStateSnapshot()` duration and count.
5. `fetchProjectState()` browser call count per minute.
6. `buildProjectsPayload()` duration and count.
7. Project-summary refresh reason: task state transition, output timestamp, hook activity, notification, manual project change.
8. PTY output chunk count per task session per minute.
9. Browser websocket message counts by type.
10. xterm write volume per terminal slot.
11. Git command count, duration, timeout count, and caller category.
12. Metadata refresh count and duration by home/focused/background/full refresh.
13. LLM call count, queue/start latency, fetch duration, timeout count, rate-limit drops, and operation type.
14. Startup resume scan counts: considered, resumable, launched, failed, skipped.
15. Session summary counts: total, board-linked, active, orphaned, shell.
16. Node event-loop delay p50/p95/p99 and runtime CPU sample.

Avoid relying on full debug logging while measuring performance, because debug logging itself can add websocket and browser work.

## Practical Diagnosis Checklist

To confirm the highest-probability issue:

1. Open the browser network panel.
2. Run 3 Codex sessions.
3. Watch for repeated `project.getState` requests immediately after project-state stream updates.
4. Compare with the count of `project_state_updated` websocket messages.

To confirm hook overhead:

1. Run a Codex session that uses several tools.
2. Watch terminal output for `[hooks:cli] parsed ...` lines.
3. Count how many appear per tool call.
4. Check whether removing those lines improves terminal responsiveness.

To confirm project-summary fanout:

1. Add temporary logging to `onProjectsRefreshRequested`.
2. Include the triggering session fields that changed.
3. Run 3 Codex sessions.
4. Check whether pure `lastOutputAt` or hook activity updates are refreshing the project list repeatedly.

To confirm git metadata pressure:

1. Add timing around `runGit()` or metadata refresh methods.
2. Keep the git UI closed.
3. Run 3 Codex sessions.
4. Check whether home/focused/background metadata polling and remote fetch still run.
5. Check whether git calls exceed 1-2 seconds or pile up without warnings.

To confirm LLM/title-generation pressure:

1. Add warn-level logs for LLM timeout and rate-limit drops.
2. Create or save a board with one or more `title === null` cards.
3. Trigger several normal board saves.
4. Check whether the same untitled cards repeatedly enqueue title generation.

To confirm stale session bloat:

1. Count persisted session summaries in `sessions.json`.
2. Count task ids present in work-column board cards.
3. Compare snapshot payload size before and after pruning orphan summaries.
4. Check whether project-state apply and save operations get measurably cheaper.

## Confidence

High confidence:

- The `streamedProjectState` dependency can cause redundant project-state fetches.
- Native Codex hooks significantly increase per-tool runtime work compared with an idle session.
- Successful hook diagnostics add unnecessary terminal output.
- Session-summary batches currently request project-summary refreshes too broadly.
- Branch/base-ref metadata polling runs server-side even when git UI is not visible.
- LLM timeouts can be hidden at the default log level.
- The live symptom looks CPU/event-loop bound more than memory-bound.
- Stale persisted session summaries can bloat project-state snapshots.

Medium confidence:

- These combined effects explain the observed slowdown with 3 Codex sessions.
- Project-summary refresh fanout is a larger structural multiplier than the single redundant fetch issue.
- Repeated auto-title attempts for `title === null` cards contribute to background load during degraded runtime state.
- Git metadata polling without timeouts contributes to "branch detection broke" symptoms under load.

Low confidence:

- Any new unbounded memory leak was introduced in the last 15 commits. I did not find one.
- The latest two commits are the primary cause. They look more like diagnostics/snapshot correctness changes than active slowdown sources.
- Bad resume attempts are looping forever. The code has guards and rate limits; resume bursts are plausible, but an infinite loop is not supported by the evidence so far.
