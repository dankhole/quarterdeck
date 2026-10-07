import {
	type DesktopDiagnosticEvent,
	type DesktopDiagnosticState,
	type DesktopDiagnosticsPayload,
	desktopDiagnosticEventSchema,
	desktopDiagnosticRecordDataSchema,
	desktopDiagnosticStateSchema,
} from "../../src/core/api/desktop-diagnostics.js";
import type { DiagnosticRecordEnvelope } from "../../src/core/api/diagnostics.js";
import { createRuntimeDiagnostics, type RuntimeDiagnostics } from "../../src/diagnostics/runtime-diagnostics.js";

export interface DesktopDiagnosticsOptions {
	stateHome: string;
	quarterdeckVersion: string;
	getState: () => DesktopDiagnosticState;
}

type ForwardDesktopDiagnostics = (payload: DesktopDiagnosticsPayload) => boolean;

/** The desktop uses the canonical recorder; its descriptor has no runtime endpoint or authority. */
export class DesktopDiagnostics {
	private forward: ForwardDesktopDiagnostics | null = null;

	private constructor(
		private readonly diagnostics: RuntimeDiagnostics,
		private readonly getState: () => DesktopDiagnosticState,
	) {}

	static async create(options: DesktopDiagnosticsOptions): Promise<DesktopDiagnostics> {
		const diagnostics = await createRuntimeDiagnostics({
			stateHome: options.stateHome,
			quarterdeckVersion: options.quarterdeckVersion,
			processKind: "desktop",
			host: null,
			port: null,
		});
		const desktop = new DesktopDiagnostics(diagnostics, options.getState);
		diagnostics.registerSnapshotProvider({
			name: "desktop",
			capture: () => desktopDiagnosticStateSchema.parse(options.getState()),
		});
		desktop.record({ kind: "startup", phase: "requested" });
		return desktop;
	}

	get instanceId(): string {
		return this.diagnostics.runtimeInstanceId;
	}

	record(candidate: DesktopDiagnosticEvent): boolean {
		const event = desktopDiagnosticEventSchema.safeParse(candidate);
		let state: unknown;
		try {
			state = this.getState();
		} catch {
			return false;
		}
		const parsedState = desktopDiagnosticStateSchema.safeParse(state);
		if (!event.success || !parsedState.success) return false;
		const record = this.diagnostics.recordEvent(
			`desktop.${event.data.kind}`,
			{ event: event.data, state: parsedState.data },
			{ operationId: this.instanceId },
			{
				essential: true,
				level:
					(event.data.kind === "startup" && event.data.phase === "failed") ||
					(event.data.kind === "shutdown" && event.data.phase === "failed")
						? "warn"
						: "info",
			},
		);
		if (record && this.forward) this.forwardRecords([record]);
		return record !== null;
	}

	/** Replay the existing canonical tail, then forward live events; no second queue or journal is created. */
	connect(forward: ForwardDesktopDiagnostics): void {
		this.forward = forward;
		this.forwardRecords(this.diagnostics.getRecords({ name: "desktop" }).slice(-100));
	}

	disconnect(): void {
		this.forward = null;
	}

	async markReady(): Promise<void> {
		await this.diagnostics.markReady(null, null);
	}

	async markFailed(): Promise<void> {
		await this.diagnostics.markFailed(new Error("Desktop startup failed."));
	}

	async flush(): Promise<void> {
		await this.diagnostics.recorder.flush();
	}

	async close(): Promise<void> {
		this.disconnect();
		await this.diagnostics.close();
	}

	private forwardRecords(records: readonly DiagnosticRecordEnvelope[]): void {
		const accepted = records.flatMap((record) => {
			const data = desktopDiagnosticRecordDataSchema.safeParse(record.payload);
			return data.success ? [{ sequence: record.sequence, observedAt: record.timestamp, ...data.data }] : [];
		});
		if (!this.forward || accepted.length === 0) return;
		let sent = false;
		try {
			sent = this.forward({ desktopInstanceId: this.instanceId, records: accepted });
		} catch {
			/* A failed diagnostics projection cannot alter startup or lifecycle authority. */
		}
		if (!sent) {
			this.forward = null;
			this.diagnostics.recordEvent(
				"desktop.forward_unavailable",
				{ recordCount: accepted.length },
				{ operationId: this.instanceId },
				{ essential: true, level: "warn" },
			);
		}
	}
}

export async function createDesktopDiagnostics(options: DesktopDiagnosticsOptions): Promise<DesktopDiagnostics> {
	return await DesktopDiagnostics.create(options);
}
