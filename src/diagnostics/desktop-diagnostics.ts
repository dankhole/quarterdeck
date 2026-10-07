import {
	type DesktopDiagnosticState,
	desktopDiagnosticStateSchema,
	desktopDiagnosticsPayloadSchema,
} from "../core/api/desktop-diagnostics.js";
import type { DiagnosticRecordEnvelope } from "../core/api/diagnostics.js";
import type { RuntimeDiagnostics } from "./runtime-diagnostics.js";

export interface DesktopDiagnosticObservedState {
	state: DesktopDiagnosticState;
	observedAt: number;
	desktopInstanceId: string;
}

/** Read only typed metadata from the canonical journal; this is an observed state, not a live probe. */
export function getDesktopDiagnosticJournalState(
	records: readonly DiagnosticRecordEnvelope[],
): DesktopDiagnosticObservedState | null {
	for (const record of [...records].reverse()) {
		if (!record.name.startsWith("desktop.") || typeof record.payload !== "object" || record.payload === null)
			continue;
		if (!("state" in record.payload)) continue;
		const state = desktopDiagnosticStateSchema.safeParse(record.payload.state);
		if (!state.success) continue;
		const observedAt =
			"observedAt" in record.payload &&
			typeof record.payload.observedAt === "number" &&
			Number.isSafeInteger(record.payload.observedAt) &&
			record.payload.observedAt >= 0
				? record.payload.observedAt
				: record.timestamp;
		return {
			state: state.data,
			observedAt,
			desktopInstanceId: record.context.operationId ?? record.runtimeInstanceId,
		};
	}
	return null;
}

/** The helper observes a bounded parent projection through its private channel. */
export function createDesktopRuntimeDiagnosticsIngestor(diagnostics: RuntimeDiagnostics): {
	ingest: (payload: unknown) => boolean;
	dispose: () => void;
} {
	let parentInstanceId: string | null = null;
	let lastSequence = 0;
	let latest: DesktopDiagnosticObservedState | null = null;
	let disposed = false;
	const unregister = diagnostics.registerSnapshotProvider({
		name: "desktop",
		capture: () => (latest ? structuredClone(latest) : { available: false }),
	});
	return {
		ingest: (payload) => {
			if (disposed) return false;
			const parsed = desktopDiagnosticsPayloadSchema.safeParse(payload);
			if (!parsed.success || (parentInstanceId !== null && parentInstanceId !== parsed.data.desktopInstanceId))
				return false;
			parentInstanceId = parsed.data.desktopInstanceId;
			for (const record of parsed.data.records) {
				if (record.sequence <= lastSequence) continue;
				lastSequence = record.sequence;
				latest = {
					state: record.state,
					observedAt: record.observedAt,
					desktopInstanceId: parentInstanceId,
				};
				diagnostics.recordEvent(
					`desktop.${record.event.kind}`,
					{
						event: record.event,
						state: record.state,
						observedAt: record.observedAt,
						desktopSequence: record.sequence,
					},
					{ operationId: parentInstanceId },
					{
						essential: true,
						level:
							(record.event.kind === "startup" && record.event.phase === "failed") ||
							(record.event.kind === "shutdown" && record.event.phase === "failed")
								? "warn"
								: "info",
					},
				);
			}
			return true;
		},
		dispose: () => {
			disposed = true;
			unregister();
			latest = null;
		},
	};
}
