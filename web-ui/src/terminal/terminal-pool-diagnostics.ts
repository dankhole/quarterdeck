import { collectTerminalDomDiagnostics, type TerminalDomDiagnostics } from "@/terminal/terminal-dom-diagnostics";
import type { SlotRole } from "@/terminal/terminal-pool-types";
import type { TerminalSlot } from "@/terminal/terminal-slot";
import { warnToBrowserConsole } from "@/utils/global-error-capture";

const TERMINAL_DOM_ALERT_MESSAGE = "terminal DOM count exceeded expected ceiling";
const TERMINAL_DOM_ALERT_CONSOLE_MESSAGE =
	"[quarterdeck] terminal DOM count exceeded expected ceiling; run window.__quarterdeckDumpTerminalState() for details.";
const TERMINAL_DOM_ALERT_THRESHOLD = 8;
const TERMINAL_DOM_ALERT_INTERVAL_MS = 60_000;
const TERMINAL_DOM_ALERT_REPEAT_MS = 5 * 60_000;

type TerminalBufferDebugInfo = ReturnType<TerminalSlot["getBufferDebugInfo"]>;

interface TerminalDiagnosticsLogger {
	info: (message: string, metadata?: unknown) => void;
	warn: (message: string, metadata?: unknown) => void;
}

interface DedicatedTerminalDebugEntry {
	key: string;
	slot: TerminalSlot;
}

export interface TerminalDebugSnapshotProvider {
	getPoolSlots: () => readonly TerminalSlot[];
	getPoolSlotRole: (slot: TerminalSlot) => SlotRole;
	getDedicatedSlots: () => readonly DedicatedTerminalDebugEntry[];
}

export interface RegisteredTerminalDebugSnapshot {
	kind: "pool" | "dedicated";
	key: string | null;
	slotId: number;
	role: SlotRole | null;
	taskId: string | null;
	projectId: string | null;
	buffer: TerminalBufferDebugInfo;
}

export interface TerminalDebugState {
	generatedAt: string;
	registered: {
		total: number;
		pool: number;
		dedicated: number;
	};
	dom: TerminalDomDiagnostics;
	poolSlots: RegisteredTerminalDebugSnapshot[];
	dedicatedSlots: RegisteredTerminalDebugSnapshot[];
}

declare global {
	interface Window {
		__quarterdeckDumpTerminalState?: () => TerminalDebugState;
	}
}

function buildSlotDebugSnapshot(
	kind: "pool" | "dedicated",
	slot: TerminalSlot,
	options: { key?: string; role?: SlotRole } = {},
): RegisteredTerminalDebugSnapshot {
	return {
		kind,
		key: options.key ?? null,
		slotId: slot.slotId,
		role: options.role ?? null,
		taskId: slot.connectedTaskId,
		projectId: slot.connectedProjectId,
		buffer: slot.getBufferDebugInfo(),
	};
}

function getRegisteredCounts(provider: TerminalDebugSnapshotProvider): {
	total: number;
	pool: number;
	dedicated: number;
} {
	const pool = provider.getPoolSlots().length;
	const dedicated = provider.getDedicatedSlots().length;
	return {
		total: pool + dedicated,
		pool,
		dedicated,
	};
}

export function collectTerminalDebugState(provider: TerminalDebugSnapshotProvider): TerminalDebugState {
	const poolSlots = provider.getPoolSlots();
	const dedicatedSlots = provider.getDedicatedSlots();
	const registered = getRegisteredCounts(provider);

	return {
		generatedAt: new Date().toISOString(),
		registered,
		dom: collectTerminalDomDiagnostics(),
		poolSlots: poolSlots.map((slot) =>
			buildSlotDebugSnapshot("pool", slot, { role: provider.getPoolSlotRole(slot) }),
		),
		dedicatedSlots: dedicatedSlots.map(({ key, slot }) => buildSlotDebugSnapshot("dedicated", slot, { key })),
	};
}

export function dumpTerminalDebugInfo(
	provider: TerminalDebugSnapshotProvider,
	log: TerminalDiagnosticsLogger,
): TerminalDebugState {
	const state = collectTerminalDebugState(provider);
	logTerminalDebugState(state, log);
	dumpTerminalDebugStateToConsole(state);
	return state;
}

function logTerminalDebugState(state: TerminalDebugState, log: TerminalDiagnosticsLogger): void {
	if (state.registered.total === 0) {
		log.info("No active terminals");
		return;
	}

	log.info("terminal instance counts", {
		total: state.registered.total,
		pool: state.registered.pool,
		dedicated: state.registered.dedicated,
		helperTextareas: state.dom.helperTextareaCount,
		helperTextareasMissingId: state.dom.helperTextareasMissingId,
		helperTextareasMissingName: state.dom.helperTextareasMissingName,
		parkingRootChildren: state.dom.parkingRoot?.childElementCount ?? 0,
	});

	for (const slot of state.poolSlots) {
		log.info(`pool slot ${slot.slotId} [${slot.role ?? "unknown"}]`, {
			taskId: slot.taskId ?? "(none)",
			projectId: slot.projectId ?? "(none)",
			buffer: slot.buffer.activeBuffer,
			scrollback: `${slot.buffer.normalScrollbackLines} lines (max ${slot.buffer.scrollbackOption})`,
			normal: `len=${slot.buffer.normalLength} baseY=${slot.buffer.normalBaseY}`,
			alternate: `len=${slot.buffer.alternateLength}`,
			viewport: slot.buffer.viewportRows,
			session: slot.buffer.sessionState,
		});
	}

	for (const slot of state.dedicatedSlots) {
		log.info(`dedicated ${slot.key ?? "(unknown)"}`, {
			taskId: slot.taskId ?? "(none)",
			projectId: slot.projectId ?? "(none)",
			buffer: slot.buffer.activeBuffer,
			scrollback: `${slot.buffer.normalScrollbackLines} lines (max ${slot.buffer.scrollbackOption})`,
			normal: `len=${slot.buffer.normalLength} baseY=${slot.buffer.normalBaseY}`,
			alternate: `len=${slot.buffer.alternateLength}`,
			viewport: slot.buffer.viewportRows,
			session: slot.buffer.sessionState,
		});
	}
}

function summarizeHelperForConsole(helper: TerminalDomDiagnostics["helperTextareas"][number]): {
	index: number;
	id: string;
	name: string;
	inParkingRoot: boolean;
	isConnected: boolean;
	parentPath: string;
} {
	return {
		index: helper.index,
		id: helper.id || "(missing)",
		name: helper.name || "(missing)",
		inParkingRoot: helper.inParkingRoot,
		isConnected: helper.isConnected,
		parentPath: helper.parentPath,
	};
}

function dumpTerminalDebugStateToConsole(state: TerminalDebugState): TerminalDebugState {
	console.groupCollapsed(
		`[quarterdeck] terminal state: ${state.registered.total} registered, ${state.dom.helperTextareaCount} helper textarea(s)`,
	);
	console.info(state);
	if (state.dom.helperTextareas.length > 0) {
		console.table(state.dom.helperTextareas.map(summarizeHelperForConsole));
	}
	if (state.dom.parkingRoot?.children.length) {
		console.table(state.dom.parkingRoot.children);
	}
	console.groupEnd();
	return state;
}

export function installTerminalDebugHook(provider: TerminalDebugSnapshotProvider): () => void {
	const dump = () => dumpTerminalDebugStateToConsole(collectTerminalDebugState(provider));
	window.__quarterdeckDumpTerminalState = dump;

	return () => {
		if (window.__quarterdeckDumpTerminalState === dump) {
			delete window.__quarterdeckDumpTerminalState;
		}
	};
}

export interface TerminalDomHealthMonitor {
	start: () => void;
	stop: () => void;
}

export function createTerminalDomHealthMonitor(
	provider: TerminalDebugSnapshotProvider,
	log: TerminalDiagnosticsLogger,
): TerminalDomHealthMonitor {
	let terminalDomHealthTimer: ReturnType<typeof setInterval> | null = null;
	let lastTerminalDomAlert: { signature: string; timestamp: number } | null = null;

	function buildTerminalDomAlertPayload(trigger: string): {
		trigger: string;
		threshold: number;
		registeredTotal: number;
		registeredPool: number;
		registeredDedicated: number;
		helperTextareas: number;
		helperTextareasMissingId: number;
		helperTextareasMissingName: number;
		xtermElements: number;
		parkingRootChildren: number;
	} {
		const dom = collectTerminalDomDiagnostics();
		const registered = getRegisteredCounts(provider);
		return {
			trigger,
			threshold: TERMINAL_DOM_ALERT_THRESHOLD,
			registeredTotal: registered.total,
			registeredPool: registered.pool,
			registeredDedicated: registered.dedicated,
			helperTextareas: dom.helperTextareaCount,
			helperTextareasMissingId: dom.helperTextareasMissingId,
			helperTextareasMissingName: dom.helperTextareasMissingName,
			xtermElements: dom.xtermElementCount,
			parkingRootChildren: dom.parkingRoot?.childElementCount ?? 0,
		};
	}

	function queueQuarterdeckTerminalDomAlert(payload: ReturnType<typeof buildTerminalDomAlertPayload>): void {
		setTimeout(() => {
			try {
				log.warn(TERMINAL_DOM_ALERT_MESSAGE, payload);
			} catch {
				// Browser console output above is the reliable diagnostic path.
			}
		}, 0);
	}

	function maybeWarnAboutTerminalDomGrowth(trigger: string): void {
		const payload = buildTerminalDomAlertPayload(trigger);
		const observedCount = Math.max(payload.registeredTotal, payload.helperTextareas, payload.xtermElements);
		if (observedCount <= TERMINAL_DOM_ALERT_THRESHOLD) {
			lastTerminalDomAlert = null;
			return;
		}

		const signature = [
			payload.registeredTotal,
			payload.helperTextareas,
			payload.xtermElements,
			payload.parkingRootChildren,
			payload.helperTextareasMissingId,
			payload.helperTextareasMissingName,
		].join(":");
		const now = Date.now();
		if (
			lastTerminalDomAlert?.signature === signature &&
			now - lastTerminalDomAlert.timestamp < TERMINAL_DOM_ALERT_REPEAT_MS
		) {
			return;
		}

		lastTerminalDomAlert = { signature, timestamp: now };
		// Raw console first because this alert is specifically for cases where the
		// debug panel or Quarterdeck logging path may be too slow to use.
		warnToBrowserConsole(TERMINAL_DOM_ALERT_CONSOLE_MESSAGE, payload);
		queueQuarterdeckTerminalDomAlert(payload);
	}

	return {
		start() {
			if (terminalDomHealthTimer !== null) {
				return;
			}
			terminalDomHealthTimer = setInterval(
				() => maybeWarnAboutTerminalDomGrowth("interval"),
				TERMINAL_DOM_ALERT_INTERVAL_MS,
			);
			maybeWarnAboutTerminalDomGrowth("init");
		},
		stop() {
			if (terminalDomHealthTimer !== null) {
				clearInterval(terminalDomHealthTimer);
				terminalDomHealthTimer = null;
			}
			lastTerminalDomAlert = null;
		},
	};
}
