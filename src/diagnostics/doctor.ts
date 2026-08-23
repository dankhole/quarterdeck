import type {
	DiagnosticCaptureScope,
	DiagnosticContext,
	DiagnosticFinding,
	DiagnosticRecordEnvelope,
	DiagnosticSnapshot,
} from "../core";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function evidenceIds(records: readonly DiagnosticRecordEnvelope[], names: readonly string[]): string[] {
	const nameSet = new Set(names);
	return records
		.filter((record) => nameSet.has(record.name))
		.slice(-20)
		.map((record) => record.id);
}

function diagnosticTaskKey(context: DiagnosticContext): string | null {
	const projectId = stringValue(context.projectId);
	const taskId = stringValue(context.taskId);
	return projectId && taskId ? `${projectId}\u0000${taskId}` : null;
}

function isLaterRecord(candidate: DiagnosticRecordEnvelope, current: DiagnosticRecordEnvelope): boolean {
	return (
		candidate.timestamp > current.timestamp ||
		(candidate.timestamp === current.timestamp && candidate.sequence > current.sequence)
	);
}

function latestStartupRecoveryRecords(records: readonly DiagnosticRecordEnvelope[]): DiagnosticRecordEnvelope[] {
	const latestByTask = new Map<string, DiagnosticRecordEnvelope>();
	for (const record of records) {
		if (record.name !== "session.startup_recovery_completed" || !isRecord(record.payload)) continue;
		const taskKey = diagnosticTaskKey(record.context) ?? `record:${record.id}`;
		const current = latestByTask.get(taskKey);
		if (!current || isLaterRecord(record, current)) {
			latestByTask.set(taskKey, record);
		}
	}
	return Array.from(latestByTask.values());
}

function currentProjectSessions(snapshot: DiagnosticSnapshot): Map<string, Record<string, unknown>> | null {
	const provider = snapshot.providers.find((candidate) => candidate.name === "projects");
	if (
		!provider ||
		provider.status !== "completed" ||
		!isRecord(provider.data) ||
		!Array.isArray(provider.data.sessions)
	) {
		return null;
	}
	const sessions = new Map<string, Record<string, unknown>>();
	for (const rawSession of provider.data.sessions) {
		if (!isRecord(rawSession)) continue;
		const taskKey = diagnosticTaskKey({
			projectId: stringValue(rawSession.projectId) ?? undefined,
			taskId: stringValue(rawSession.taskId) ?? undefined,
		});
		if (taskKey) sessions.set(taskKey, rawSession);
	}
	return sessions;
}

function isUnresolvedStartupRecoveryExhaustion(
	record: DiagnosticRecordEnvelope,
	sessions: ReadonlyMap<string, Record<string, unknown>> | null,
): boolean {
	if (!isRecord(record.payload) || stringValue(record.payload.status) !== "exhausted") return false;
	if (!sessions) return true;
	const taskKey = diagnosticTaskKey(record.context);
	if (!taskKey) return true;
	const session = sessions.get(taskKey);
	return stringValue(session?.state) === "awaiting_review" && stringValue(session?.reviewReason) === "error";
}

function createFinding(
	code: string,
	severity: DiagnosticFinding["severity"],
	summary: string,
	explanation: string,
	context: DiagnosticContext,
	evidenceRecordIds: string[],
	limitations?: string[],
): DiagnosticFinding {
	return {
		code,
		severity,
		summary,
		explanation,
		context,
		evidenceRecordIds,
		observedAt: Date.now(),
		...(limitations?.length ? { limitations } : undefined),
	};
}

export function filterDiagnosticFindingsByScope(
	findings: readonly DiagnosticFinding[],
	scope: Readonly<DiagnosticCaptureScope>,
): DiagnosticFinding[] {
	return findings.filter((finding) => {
		if (scope.projectId && finding.context.projectId && finding.context.projectId !== scope.projectId) return false;
		if (scope.taskId && finding.context.taskId && finding.context.taskId !== scope.taskId) return false;
		if (
			scope.sessionInstanceId &&
			finding.context.sessionInstanceId &&
			finding.context.sessionInstanceId !== scope.sessionInstanceId
		)
			return false;
		if (scope.operationId && finding.context.operationId && finding.context.operationId !== scope.operationId)
			return false;
		return true;
	});
}

export function evaluateDiagnosticSnapshot(
	snapshot: DiagnosticSnapshot,
	records: readonly DiagnosticRecordEnvelope[],
): DiagnosticFinding[] {
	const findings: DiagnosticFinding[] = [];
	const now = Date.now();
	const projectSessions = currentProjectSessions(snapshot);
	for (const record of latestStartupRecoveryRecords(records)) {
		if (!isUnresolvedStartupRecoveryExhaustion(record, projectSessions)) continue;
		findings.push(
			createFinding(
				"STARTUP_SESSION_RECOVERY_EXHAUSTED",
				"error",
				"A task chat could not be restored during startup",
				"Quarterdeck exhausted its bounded recovery attempts and surfaced the task as an error instead of retrying indefinitely.",
				record.context,
				[record.id],
			),
		);
	}
	for (const provider of snapshot.providers) {
		if (provider.status === "timed_out") {
			findings.push(
				createFinding(
					"DIAGNOSTIC_PROVIDER_TIMED_OUT",
					"warn",
					`Diagnostic provider ${provider.name} timed out`,
					"The bundle is usable, but this provider's current state is unavailable. No repair or refresh was attempted.",
					{},
					[],
				),
			);
		}
		if (provider.name === "runtime" && provider.status === "unavailable") {
			findings.push(
				createFinding(
					"RUNTIME_DESCRIPTOR_UNREACHABLE",
					"warn",
					"The recorded runtime instance is not reachable",
					"Crash-surviving journal records remain usable, but current in-memory state and live subsystem snapshots are unavailable.",
					{},
					evidenceIds(records, ["runtime.shutdown_failed", "runtime.shutdown_requested"]),
					["The runtime may have exited normally after its last journal flush."],
				),
			);
		}
		if (provider.name === "runtime" && isRecord(provider.data)) {
			const journalHealthy = booleanValue(provider.data.journalHealthy);
			const dropped = numberValue(provider.data.droppedRecords) ?? 0;
			const descriptorPersistence = isRecord(provider.data.descriptorPersistence)
				? provider.data.descriptorPersistence
				: null;
			if (descriptorPersistence && booleanValue(descriptorPersistence.persistent) === false) {
				findings.push(
					createFinding(
						"RUNTIME_DESCRIPTOR_PERSISTENCE_DEGRADED",
						"warn",
						"The live runtime descriptor could not be persisted",
						"Quarterdeck is still running, but a later agent cannot discover this instance automatically from the state directory.",
						{},
						[],
					),
				);
			}
			if (journalHealthy === false) {
				findings.push(
					createFinding(
						"DIAGNOSTIC_JOURNAL_DEGRADED",
						"warn",
						"Diagnostic journal persistence is degraded",
						"Recent in-memory records may still be available, but crash-surviving evidence can be incomplete.",
						{},
						evidenceIds(records, ["diagnostics.journal_write_failed"]),
					),
				);
			}
			if (dropped > 0) {
				findings.push(
					createFinding(
						"DIAGNOSTIC_RECORDS_DROPPED",
						"warn",
						`${dropped} diagnostic records were dropped`,
						"Recorder bounds protected the application, so the timeline contains a documented gap.",
						{},
						evidenceIds(records, ["diagnostics.records_dropped"]),
					),
				);
			}
		}
		if (provider.name === "projects" && isRecord(provider.data) && Array.isArray(provider.data.sessions)) {
			if (Array.isArray(provider.data.managedProjects)) {
				for (const rawProject of provider.data.managedProjects) {
					if (!isRecord(rawProject) || booleanValue(rawProject.hasTerminalManager) !== false) continue;
					const projectId = stringValue(rawProject.projectId);
					findings.push(
						createFinding(
							"PROJECT_MANAGER_MISSING",
							"warn",
							"A managed project has no terminal session manager",
							"The project registry knows this project, but process/session diagnostics are unavailable until its manager is initialized.",
							projectId ? { projectId } : {},
							[],
							["A newly registered inactive project can briefly be in this state."],
						),
					);
				}
			}
			for (const rawSession of provider.data.sessions) {
				if (!isRecord(rawSession)) continue;
				const context: DiagnosticContext = {
					...(stringValue(rawSession.projectId)
						? { projectId: stringValue(rawSession.projectId) ?? undefined }
						: {}),
					...(stringValue(rawSession.taskId) ? { taskId: stringValue(rawSession.taskId) ?? undefined } : {}),
					...(stringValue(rawSession.sessionInstanceId)
						? { sessionInstanceId: stringValue(rawSession.sessionInstanceId) ?? undefined }
						: {}),
				};
				if (numberValue(rawSession.pid) !== null && booleanValue(rawSession.pidAlive) === false) {
					findings.push(
						createFinding(
							"SESSION_PID_NOT_ALIVE",
							"error",
							"A session summary references a process that is not alive",
							"The check is read-only and does not reconcile or stop anything. A lifecycle sweep may still be within its grace period.",
							context,
							evidenceIds(records, ["session.process_spawned", "session.process_exit_observed"]),
							["Process liveness is a point-in-time observation."],
						),
					);
				}
				const pendingSince = numberValue(rawSession.pendingSince);
				if (booleanValue(rawSession.pendingSessionStart) === true && pendingSince && now - pendingSince > 30_000) {
					findings.push(
						createFinding(
							"SESSION_START_PENDING_TOO_LONG",
							"warn",
							"A task session start has remained pending",
							"The runtime still owns this lifecycle; diagnostics did not retry or cancel it.",
							context,
							evidenceIds(records, ["session.start_requested", "session.start_rejected"]),
						),
					);
				}
				if (
					(stringValue(rawSession.state) === "running" ||
						(stringValue(rawSession.state) === "awaiting_review" && numberValue(rawSession.pid) !== null)) &&
					booleanValue(rawSession.hasActiveProcess) === false &&
					booleanValue(rawSession.pendingSessionStart) !== true &&
					booleanValue(rawSession.exiting) !== true
				) {
					findings.push(
						createFinding(
							"SESSION_PROCESS_ENTRY_MISSING",
							"error",
							"An active session summary has no process entry",
							"The runtime summary references an active or interactive task process, but no live or pending process is represented. Diagnostics did not reconcile or restart it.",
							context,
							evidenceIds(records, ["session.process_spawned", "session.process_exit_observed"]),
						),
					);
				}
				if (
					booleanValue(rawSession.hasSummary) === false &&
					(booleanValue(rawSession.hasActiveProcess) === true || isRecord(rawSession.mirror))
				) {
					findings.push(
						createFinding(
							"TERMINAL_PROCESS_WITHOUT_SESSION_SUMMARY",
							"warn",
							"A terminal process or mirror has no session summary",
							"Process-side terminal state exists without the server-owned summary used by the UI and recovery logic. Diagnostics did not attach, stop, or reconcile it.",
							context,
							evidenceIds(records, ["session.process_spawned", "session.process_exit_observed"]),
							["The session reconciliation sweep may still be within its normal grace period."],
						),
					);
				}
				if (numberValue(rawSession.pid) !== null && booleanValue(rawSession.hasLaunchPath) === false) {
					findings.push(
						createFinding(
							"SESSION_LAUNCH_PATH_MISSING",
							"warn",
							"A live task process has no recorded launch path",
							"Restart and worktree-divergence guidance may be incomplete for this session.",
							context,
							evidenceIds(records, ["session.process_spawned"]),
						),
					);
				}
			}
		}
		if (provider.name === "hook_outbox" && isRecord(provider.data)) {
			const pendingRecords = numberValue(provider.data.pendingRecords) ?? 0;
			const oldestPendingAgeMs = numberValue(provider.data.oldestPendingAgeMs) ?? 0;
			const deferred = numberValue(provider.data.lastDeferred) ?? 0;
			if (pendingRecords > 0 && oldestPendingAgeMs > 10_000) {
				findings.push(
					createFinding(
						"HOOK_OUTBOX_DELIVERY_OVERDUE",
						"warn",
						`${pendingRecords} native-hook deliveries remain pending`,
						"The replay outbox has retained a transition beyond the normal retry window. The task state may lag the agent until delivery succeeds.",
						{},
						evidenceIds(records, ["hook.ingest_failed"]),
						["Outbox age is measured from its private metadata, not terminal output."],
					),
				);
			}
			if (deferred >= 3) {
				findings.push(
					createFinding(
						"HOOK_REPLAY_REPEATEDLY_DEFERRED",
						"warn",
						"Several hook deliveries were deferred in the latest replay scan",
						"The target runtime or task was not ready to acknowledge multiple queued transition deliveries.",
						{},
						evidenceIds(records, ["hook.ingest_failed"]),
					),
				);
			}
		}
		if (provider.name === "terminal_transport" && isRecord(provider.data) && Array.isArray(provider.data.viewers)) {
			for (const rawViewer of provider.data.viewers) {
				if (!isRecord(rawViewer)) continue;
				const context: DiagnosticContext = {
					...(stringValue(rawViewer.projectId)
						? { projectId: stringValue(rawViewer.projectId) ?? undefined }
						: {}),
					...(stringValue(rawViewer.taskId) ? { taskId: stringValue(rawViewer.taskId) ?? undefined } : {}),
					...(stringValue(rawViewer.clientId) ? { clientId: stringValue(rawViewer.clientId) ?? undefined } : {}),
				};
				const ioConnected = booleanValue(rawViewer.ioConnected) === true;
				const controlConnected = booleanValue(rawViewer.controlConnected) === true;
				if (controlConnected && !ioConnected) {
					findings.push(
						createFinding(
							"TERMINAL_CONTROL_WITHOUT_IO",
							"warn",
							"A terminal control socket has no matching IO socket",
							"The browser may be reconnecting. Diagnostics did not attach or request a restore.",
							context,
							evidenceIds(records, ["terminal.io_disconnected", "terminal.control_connected"]),
						),
					);
				}
				if (ioConnected && controlConnected && booleanValue(rawViewer.restoreComplete) === false) {
					const restoreStartedAt = numberValue(rawViewer.restoreStartedAt);
					if (restoreStartedAt && now - restoreStartedAt > 10_000) {
						findings.push(
							createFinding(
								"TERMINAL_RESTORE_HANDSHAKE_STALLED",
								"warn",
								"A terminal restore handshake appears stalled",
								"This is an observation only; the terminal was not resized, reattached, or reset.",
								context,
								evidenceIds(records, ["terminal.restore_started", "terminal.restore_completed"]),
							),
						);
					}
				}
				const lastActivityAt = numberValue(rawViewer.lastProtocolActivityAt);
				if (
					booleanValue(rawViewer.backpressured) === true &&
					lastActivityAt !== null &&
					now - lastActivityAt > 10_000
				) {
					findings.push(
						createFinding(
							"TERMINAL_BACKPRESSURE_STUCK",
							"warn",
							"A terminal viewer has remained backpressured",
							"The server is protecting the runtime from a slow browser, but terminal delivery may remain paused for this viewer.",
							context,
							evidenceIds(records, ["terminal.backpressure_entered", "terminal.backpressure_cleared"]),
							["The activity timestamp is a point-in-time proxy; diagnostics did not resume the socket."],
						),
					);
				}
			}
		}
		if (provider.name === "project_metadata" && isRecord(provider.data) && Array.isArray(provider.data.projects)) {
			for (const rawProject of provider.data.projects) {
				if (!isRecord(rawProject) || !isRecord(rawProject.remoteFetch)) continue;
				const startedAt = numberValue(rawProject.remoteFetch.lastStartedAt);
				if (
					booleanValue(rawProject.remoteFetch.fetchInFlight) === true &&
					startedAt !== null &&
					now - startedAt > 60_000
				) {
					const projectId = stringValue(rawProject.projectId);
					findings.push(
						createFinding(
							"METADATA_OPERATION_OVERDUE",
							"warn",
							"A project metadata fetch has remained in flight",
							"The read-only snapshot found an operation beyond the normal remote-fetch window; it was not cancelled or retried.",
							projectId ? { projectId } : {},
							[],
						),
					);
				}
			}
		}
		if (provider.name === "project_state" && isRecord(provider.data) && Array.isArray(provider.data.projects)) {
			for (const rawProject of provider.data.projects) {
				if (!isRecord(rawProject) || !Array.isArray(rawProject.sessionColumnDivergences)) continue;
				for (const rawDivergence of rawProject.sessionColumnDivergences) {
					if (!isRecord(rawDivergence)) continue;
					const projectId = stringValue(rawProject.projectId);
					const taskId = stringValue(rawDivergence.taskId);
					const actualColumnId = stringValue(rawDivergence.actualColumnId);
					const expectedColumnId = stringValue(rawDivergence.expectedColumnId);
					findings.push(
						createFinding(
							"BOARD_SESSION_PROJECTION_DIVERGED",
							"warn",
							"Board placement does not match authoritative session state",
							`The card is in ${actualColumnId ?? "an unknown column"}, while runtime session state projects it to ${expectedColumnId ?? "an unknown work column"}. Diagnostics did not move or persist the card.`,
							{
								...(projectId ? { projectId } : {}),
								...(taskId ? { taskId } : {}),
							},
							evidenceIds(records, ["project.board_save_completed"]),
							["A newly connected browser may still be applying and persisting the authoritative projection."],
						),
					);
				}
			}
		}
		if (provider.name === "runtime_stream" && isRecord(provider.data) && isRecord(provider.data.batcher)) {
			const diagnosticRecords = isRecord(provider.data.batcher.diagnosticRecords)
				? provider.data.batcher.diagnosticRecords
				: null;
			const dropped = diagnosticRecords ? (numberValue(diagnosticRecords.droppedRecords) ?? 0) : 0;
			if (dropped > 0) {
				findings.push(
					createFinding(
						"DIAGNOSTIC_STREAM_DELIVERIES_DROPPED",
						"info",
						`${dropped} live diagnostic deliveries were dropped`,
						"The bounded browser fanout queue protected runtime-state delivery. Canonical memory/journal records remain available through refresh, capture, or reconnect.",
						{},
						[],
					),
				);
			}
			const clients = isRecord(provider.data.clients) ? provider.data.clients : null;
			const backpressureDrops = clients ? (numberValue(clients.diagnosticBackpressureDrops) ?? 0) : 0;
			if (backpressureDrops > 0) {
				findings.push(
					createFinding(
						"DIAGNOSTIC_STREAM_BACKPRESSURE_DROPS",
						"info",
						`${backpressureDrops} live diagnostic deliveries yielded to socket backpressure`,
						"Diagnostic batches are best effort and never compete indefinitely with primary runtime state. Canonical records remain available through panel refresh or capture.",
						{},
						[],
					),
				);
			}
		}
		if (provider.name === "browser" && isRecord(provider.data) && Array.isArray(provider.data.clients)) {
			for (const rawClient of provider.data.clients) {
				if (!isRecord(rawClient) || !isRecord(rawClient.terminal) || !isRecord(rawClient.terminal.dom)) continue;
				const xtermCount = numberValue(rawClient.terminal.dom.xtermElementCount) ?? 0;
				if (xtermCount <= 8) continue;
				const clientId = stringValue(rawClient.clientId);
				findings.push(
					createFinding(
						"TERMINAL_DOM_INSTANCE_CEILING_EXCEEDED",
						"warn",
						`The browser contains ${xtermCount} xterm DOM instances`,
						"The task-terminal pool plus dedicated shells normally remain below this ceiling. Detached DOM instances can indicate a lifecycle leak.",
						clientId ? { clientId } : {},
						[],
						["This finding requires a successfully returned browser snapshot."],
					),
				);
			}
		}
	}

	const recentConflicts = records.filter(
		(record) => record.name === "project.board_save_conflict" && now - record.timestamp <= 2 * 60_000,
	);
	for (const conflict of recentConflicts.slice(-10)) {
		findings.push(
			createFinding(
				"BOARD_REVISION_CONFLICT_RECENT",
				"warn",
				"The browser recently encountered a board revision conflict",
				"Another writer or stale client revision interrupted the browser-owned persistence path. Diagnostics did not rewrite board state.",
				conflict.context,
				[conflict.id],
			),
		);
	}
	const stateLoadFailures = records.filter(
		(record) => record.name === "project.state_load_failed" && now - record.timestamp <= 5 * 60_000,
	);
	for (const failure of stateLoadFailures.slice(-10)) {
		findings.push(
			createFinding(
				"PROJECT_STATE_LOAD_FAILED",
				"error",
				"A project state load failed recently",
				"The capture preserves the failure class and project identity but does not retry, migrate, or repair persisted state.",
				failure.context,
				[failure.id],
			),
		);
	}
	const recentReconnects = records.filter(
		(record) => record.name === "browser.runtime_stream_reconnecting" && now - record.timestamp <= 60_000,
	);
	if (recentReconnects.length >= 5) {
		findings.push(
			createFinding(
				"RUNTIME_STREAM_RECONNECT_LOOP",
				"warn",
				"The browser runtime stream is reconnecting repeatedly",
				`${recentReconnects.length} reconnect attempts were retained in the last minute. Diagnostics did not reconnect or reload the browser.`,
				recentReconnects.at(-1)?.context ?? {},
				recentReconnects.slice(-20).map((record) => record.id),
			),
		);
	}
	return findings;
}
