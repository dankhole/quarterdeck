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
const INCLUDE_VISIBLE_TERMINAL_LINES = import.meta.env.VITE_QUARTERDECK_AGENT_LAB === "1";

type TerminalBufferDiagnosticInfo = ReturnType<TerminalSlot["getBufferDebugInfo"]>;

interface TerminalDiagnosticsLogger {
	warn: (message: string, metadata?: unknown) => void;
}

interface DedicatedTerminalDiagnosticEntry {
	key: string;
	slot: TerminalSlot;
}

export interface TerminalDiagnosticSnapshotProvider {
	getPoolSlots: () => readonly TerminalSlot[];
	getPoolSlotRole: (slot: TerminalSlot) => SlotRole;
	getDedicatedSlots: () => readonly DedicatedTerminalDiagnosticEntry[];
}

export interface RegisteredTerminalDiagnosticSnapshot {
	kind: "pool" | "dedicated";
	key: string | null;
	slotId: number;
	role: SlotRole | null;
	taskId: string | null;
	projectId: string | null;
	buffer: TerminalBufferDiagnosticInfo;
	visibleLines: string[];
}

export interface TerminalDiagnosticState {
	generatedAt: string;
	registered: {
		total: number;
		pool: number;
		dedicated: number;
	};
	dom: TerminalDomDiagnostics;
	poolSlots: RegisteredTerminalDiagnosticSnapshot[];
	dedicatedSlots: RegisteredTerminalDiagnosticSnapshot[];
}

declare global {
	interface Window {
		__quarterdeckDumpTerminalState?: () => TerminalDiagnosticState;
	}
}

function buildSlotDiagnosticSnapshot(
	kind: "pool" | "dedicated",
	slot: TerminalSlot,
	options: { key?: string; role?: SlotRole } = {},
): RegisteredTerminalDiagnosticSnapshot {
	return {
		kind,
		key: options.key ?? null,
		slotId: slot.slotId,
		role: options.role ?? null,
		taskId: slot.connectedTaskId,
		projectId: slot.connectedProjectId,
		buffer: slot.getBufferDebugInfo(),
		visibleLines: INCLUDE_VISIBLE_TERMINAL_LINES
			? slot
					.readBufferLines()
					.slice(-200)
					.map((line) => line.slice(0, 500))
			: [],
	};
}

function getRegisteredCounts(provider: TerminalDiagnosticSnapshotProvider): {
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

export function collectTerminalDiagnosticState(provider: TerminalDiagnosticSnapshotProvider): TerminalDiagnosticState {
	const poolSlots = provider.getPoolSlots();
	const dedicatedSlots = provider.getDedicatedSlots();
	const registered = getRegisteredCounts(provider);

	return {
		generatedAt: new Date().toISOString(),
		registered,
		dom: collectTerminalDomDiagnostics(),
		poolSlots: poolSlots.map((slot) =>
			buildSlotDiagnosticSnapshot("pool", slot, { role: provider.getPoolSlotRole(slot) }),
		),
		dedicatedSlots: dedicatedSlots.map(({ key, slot }) => buildSlotDiagnosticSnapshot("dedicated", slot, { key })),
	};
}

export function installTerminalDiagnosticHook(provider: TerminalDiagnosticSnapshotProvider): () => void {
	const dump = () => collectTerminalDiagnosticState(provider);
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
	provider: TerminalDiagnosticSnapshotProvider,
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
		// Diagnostics panel or structured recorder path may be too slow to use.
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
