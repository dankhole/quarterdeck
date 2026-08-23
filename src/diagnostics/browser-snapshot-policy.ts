import type { BrowserDiagnosticSnapshot } from "../core";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boundedString(value: unknown, maximum = 256): string | null {
	return typeof value === "string" ? value.slice(0, maximum) : null;
}

function normalizeCount(value: unknown): number {
	const parsed = finiteNumber(value);
	return parsed === null ? 0 : Math.max(0, Math.floor(parsed));
}

function normalizeTerminalBuffer(value: unknown): Record<string, unknown> | null {
	if (!isRecord(value)) return null;
	return {
		activeBuffer: value.activeBuffer === "ALTERNATE" ? "ALTERNATE" : "NORMAL",
		normalLength: normalizeCount(value.normalLength),
		normalBaseY: normalizeCount(value.normalBaseY),
		normalScrollbackLines: normalizeCount(value.normalScrollbackLines),
		alternateLength: normalizeCount(value.alternateLength),
		viewportRows: normalizeCount(value.viewportRows),
		scrollbackOption: normalizeCount(value.scrollbackOption),
		sessionState: boundedString(value.sessionState),
	};
}

function normalizeTerminalSlot(value: unknown): Record<string, unknown> | null {
	if (!isRecord(value)) return null;
	const buffer = normalizeTerminalBuffer(value.buffer);
	if (!buffer) return null;
	return {
		kind: value.kind === "dedicated" ? "dedicated" : "pool",
		key: boundedString(value.key),
		slotId: normalizeCount(value.slotId),
		role: boundedString(value.role),
		taskId: boundedString(value.taskId),
		projectId: boundedString(value.projectId),
		buffer,
	};
}

function normalizeTerminalSlots(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, 100).flatMap((entry) => {
		const normalized = normalizeTerminalSlot(entry);
		return normalized ? [normalized] : [];
	});
}

function normalizeProductionLayout(layout: BrowserDiagnosticSnapshot["layout"]): BrowserDiagnosticSnapshot["layout"] {
	const normalized: BrowserDiagnosticSnapshot["layout"] = {};
	for (const name of ["root", "topBar", "terminalParking"] as const) {
		const rect = layout[name];
		if (rect) normalized[name] = rect;
	}
	return normalized;
}

/**
 * Accept only the production metadata allowlist from an untrusted browser
 * snapshot. In particular, terminal lines and arbitrary nested DOM strings can
 * never enter a normal runtime bundle even if a client submits them manually.
 */
export function normalizeProductionBrowserTerminalSnapshot(terminal: unknown): unknown {
	if (!isRecord(terminal)) return null;
	const registered = isRecord(terminal.registered) ? terminal.registered : {};
	const dom = isRecord(terminal.dom) ? terminal.dom : {};
	const parkingRoot = isRecord(dom.parkingRoot) ? dom.parkingRoot : null;
	return {
		generatedAt: boundedString(terminal.generatedAt),
		registered: {
			total: normalizeCount(registered.total),
			pool: normalizeCount(registered.pool),
			dedicated: normalizeCount(registered.dedicated),
		},
		dom: {
			helperTextareaCount: normalizeCount(dom.helperTextareaCount),
			helperTextareasMissingId: normalizeCount(dom.helperTextareasMissingId),
			helperTextareasMissingName: normalizeCount(dom.helperTextareasMissingName),
			xtermElementCount: normalizeCount(dom.xtermElementCount),
			parkingRoot: parkingRoot
				? {
						childElementCount: normalizeCount(parkingRoot.childElementCount),
						helperTextareaCount: normalizeCount(parkingRoot.helperTextareaCount),
						xtermElementCount: normalizeCount(parkingRoot.xtermElementCount),
					}
				: null,
		},
		poolSlots: normalizeTerminalSlots(terminal.poolSlots),
		dedicatedSlots: normalizeTerminalSlots(terminal.dedicatedSlots),
	};
}

export function applyBrowserSnapshotContentPolicy(
	snapshot: BrowserDiagnosticSnapshot,
	captureTier: "flight" | "agent-lab",
): BrowserDiagnosticSnapshot {
	return captureTier === "agent-lab"
		? snapshot
		: {
				...snapshot,
				terminal: normalizeProductionBrowserTerminalSnapshot(snapshot.terminal),
				layout: normalizeProductionLayout(snapshot.layout),
			};
}
