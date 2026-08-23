import {
	type BrowserDiagnosticSnapshot,
	type DiagnosticContext,
	type DiagnosticFinding,
	type DiagnosticRecordEnvelope,
	type DiagnosticRecordingScope,
	type DiagnosticRecordingState,
	type DiagnosticSnapshot,
	diagnosticRecordingScopeSchema,
	type PublicRuntimeDiagnosticDescriptor,
} from "../core";
import { getRuntimeHomePath } from "../state";
import { getDiagnosticErrorClass } from "./bounded-value";
import { type WriteDiagnosticBundleOptions, type WriteDiagnosticBundleResult, writeDiagnosticBundle } from "./bundle";
import {
	captureScopeFromRecordFilter,
	type DiagnosticLogCandidate,
	type DiagnosticRecordCandidate,
	type DiagnosticRecordFilter,
} from "./diagnostic-record";
import { evaluateDiagnosticSnapshot, filterDiagnosticFindingsByScope } from "./doctor";
import { DiagnosticJournal } from "./journal";
import { DiagnosticRecorder } from "./recorder";
import {
	type BrowserDiagnosticIngestResult,
	type BrowserLiveSubscriptionState,
	type BrowserSnapshotRequester,
	type BrowserSnapshotRequestResult,
	RuntimeBrowserDiagnostics,
} from "./runtime-browser-diagnostics";
import { RuntimeDiagnosticInstance } from "./runtime-instance";
import { DiagnosticSnapshotCoordinator, type DiagnosticSnapshotProvider } from "./snapshot";

const BROWSER_TIMELINE_RECORD_LIMIT = 200;

export interface CreateRuntimeDiagnosticsOptions {
	stateHome?: string;
	host: string;
	port: number;
	quarterdeckVersion: string;
	captureTier?: "flight" | "agent-lab";
}

export interface DiagnosticCaptureData {
	descriptor: PublicRuntimeDiagnosticDescriptor;
	health: ReturnType<DiagnosticRecorder["getHealth"]>;
	records: DiagnosticRecordEnvelope[];
	snapshot: DiagnosticSnapshot;
	findings: DiagnosticFinding[];
	warnings: string[];
}

export class RuntimeDiagnostics {
	readonly instance: RuntimeDiagnosticInstance;
	readonly recorder: DiagnosticRecorder;
	readonly snapshots: DiagnosticSnapshotCoordinator;
	readonly stateHome: string;
	readonly quarterdeckVersion: string;
	readonly captureTier: "flight" | "agent-lab";
	private readonly browser: RuntimeBrowserDiagnostics;
	private readonly providerDisposers = new Set<() => void>();
	private closed = false;
	private failed = false;

	private constructor(
		options: CreateRuntimeDiagnosticsOptions,
		instance: RuntimeDiagnosticInstance,
		recorder: DiagnosticRecorder,
		snapshots: DiagnosticSnapshotCoordinator,
	) {
		this.instance = instance;
		this.recorder = recorder;
		this.snapshots = snapshots;
		this.stateHome = options.stateHome ?? getRuntimeHomePath();
		this.quarterdeckVersion = options.quarterdeckVersion;
		this.captureTier = options.captureTier ?? "flight";
		this.browser = new RuntimeBrowserDiagnostics({
			captureTier: this.captureTier,
			ingestRecords: (clientId, candidates) => recorder.ingestBrowserRecords(clientId, candidates),
		});
	}

	static async create(options: CreateRuntimeDiagnosticsOptions): Promise<RuntimeDiagnostics> {
		const stateHome = options.stateHome ?? getRuntimeHomePath();
		let recorder: DiagnosticRecorder | null = null;
		const instance = await RuntimeDiagnosticInstance.create({
			...options,
			stateHome,
			onPersistenceFailure: (error) => {
				const failureClass = getDiagnosticErrorClass(error);
				process.stderr.write(
					`[quarterdeck] diagnostic descriptor persistence unavailable (${failureClass}); continuing without automatic runtime discovery.\n`,
				);
				if (recorder) {
					recorder.recordEvent(
						"runtime.descriptor_write_failed",
						{ errorClass: failureClass },
						{},
						{ level: "warn", essential: true },
					);
				}
			},
		});
		let journalInitializationFailure: Error | null = null;
		const journal = new DiagnosticJournal(instance.journalDirectory, {
			onFailure: (error) => {
				journalInitializationFailure ??= error;
				recorder?.reportJournalFailure(error);
			},
		});
		await journal.initialize();
		recorder = new DiagnosticRecorder({
			runtimeInstanceId: instance.getDescriptor().runtimeInstanceId,
			journal,
			pathAliases: { stateHome },
			admissionProfile: options.captureTier === "agent-lab" ? "agent-lab" : "flight",
		});
		if (journalInitializationFailure) recorder.reportJournalFailure(journalInitializationFailure);
		const descriptorPersistence = instance.getPersistenceHealth();
		if (!descriptorPersistence.persistent) {
			recorder.recordEvent(
				"runtime.descriptor_write_failed",
				{ errorClass: descriptorPersistence.failureClass },
				{},
				{ level: "warn", essential: true },
			);
		}
		const snapshots = new DiagnosticSnapshotCoordinator(instance.getDescriptor().runtimeInstanceId, { stateHome });
		const diagnostics = new RuntimeDiagnostics({ ...options, stateHome }, instance, recorder, snapshots);
		diagnostics.registerCoreProviders();
		recorder.recordEvent(
			"runtime.starting",
			{
				quarterdeckVersion: options.quarterdeckVersion,
				platform: instance.getDescriptor().platform,
				nodeMajorVersion: instance.getDescriptor().nodeMajorVersion,
				hostClassification: options.host === "127.0.0.1" || options.host === "localhost" ? "loopback" : "custom",
				port: options.port,
			},
			{},
			{ essential: true },
		);
		return diagnostics;
	}

	get runtimeInstanceId(): string {
		return this.instance.getDescriptor().runtimeInstanceId;
	}

	verifyDiagnosticToken(token: string | undefined): boolean {
		return this.instance.verifyToken(token);
	}

	record(candidate: DiagnosticRecordCandidate): DiagnosticRecordEnvelope | null {
		return this.recorder.record(candidate);
	}

	recordEvent(
		name: string,
		payload: unknown,
		context: DiagnosticContext,
		options: {
			level?: DiagnosticRecordCandidate["level"];
			essential: boolean;
			source?: DiagnosticRecordCandidate["source"];
		},
	): DiagnosticRecordEnvelope | null {
		return this.recorder.recordEvent(name, payload, context, options);
	}

	recordLog(candidate: DiagnosticLogCandidate): DiagnosticRecordEnvelope | null {
		return this.recorder.recordLog(candidate);
	}

	getRecords(filter: DiagnosticRecordFilter = {}): DiagnosticRecordEnvelope[] {
		return this.recorder.getRecentRecords(filter);
	}

	getBrowserTimelineRecords(): DiagnosticRecordEnvelope[] {
		return this.recorder.getRecentRecordTail(BROWSER_TIMELINE_RECORD_LIMIT);
	}

	registerSnapshotProvider(provider: DiagnosticSnapshotProvider): () => void {
		const unregister = this.snapshots.register(provider);
		let active = true;
		const dispose = (): void => {
			if (!active) return;
			active = false;
			this.providerDisposers.delete(dispose);
			unregister();
		};
		this.providerDisposers.add(dispose);
		return dispose;
	}

	issueBrowserCapability(clientId: string): string {
		return this.browser.issueCapability(clientId);
	}

	revokeBrowserCapability(clientId: string, expectedCapability?: string): void {
		this.browser.revokeCapability(clientId, expectedCapability);
	}

	verifyBrowserCapability(token: string | undefined, clientId?: string): string | null {
		return this.browser.verifyCapability(token, clientId);
	}

	setBrowserLiveSubscription(
		clientId: string,
		capability: string,
		subscribed: boolean,
		revision: number,
	): BrowserLiveSubscriptionState {
		return this.browser.setLiveSubscription(clientId, capability, subscribed, revision);
	}

	hasBrowserLiveSubscribers(): boolean {
		return this.browser.hasLiveSubscribers();
	}

	isBrowserLiveSubscribed(clientId: string, capability: string): boolean {
		return this.browser.isLiveSubscribed(clientId, capability);
	}

	ingestBrowserRecords(clientId: string, candidates: readonly unknown[]): BrowserDiagnosticIngestResult {
		return this.browser.ingestRecords(clientId, candidates);
	}

	ingestBrowserSnapshot(clientId: string, nonce: string, rawSnapshot: unknown): BrowserDiagnosticSnapshot {
		return this.browser.ingestSnapshot(clientId, nonce, rawSnapshot);
	}

	setBrowserSnapshotRequester(requester: BrowserSnapshotRequester | null): void {
		this.browser.setRequester(requester);
	}

	async requestBrowserSnapshots(): Promise<BrowserSnapshotRequestResult> {
		return await this.browser.requestSnapshots();
	}

	startRecording(durationMs: number, rawScope: DiagnosticRecordingScope): DiagnosticRecordingState {
		const scope = diagnosticRecordingScopeSchema.parse(rawScope);
		return this.recorder.startRecording(durationMs, scope);
	}

	stopRecording(): DiagnosticRecordingState {
		return this.recorder.stopRecording();
	}

	async collectCaptureData(
		options: { filter?: DiagnosticRecordFilter; providers?: readonly string[]; requestBrowser?: boolean } = {},
	): Promise<DiagnosticCaptureData> {
		const browserRequest = options.requestBrowser ? await this.requestBrowserSnapshots() : null;
		const recordCollection = await this.recorder.collectCaptureRecords(options.filter);
		const records = recordCollection.records;
		const captureScope = captureScopeFromRecordFilter(options.filter);
		const snapshot = await this.snapshots.capture(options.providers, captureScope);
		const findings = filterDiagnosticFindingsByScope(evaluateDiagnosticSnapshot(snapshot, records), captureScope);
		const warnings = [
			...recordCollection.warnings,
			...snapshot.providers
				.filter((provider) => provider.status !== "completed")
				.map((provider) => `${provider.name}: ${provider.error ?? provider.status}`),
		];
		if (browserRequest && !browserRequest.requesterAvailable) {
			warnings.push("Browser snapshot request transport is unavailable.");
		} else if (browserRequest?.requestedClientIds.length === 0) {
			warnings.push("No browser clients were connected for the requested snapshot.");
		} else if (browserRequest && browserRequest.missingClientIds.length > 0) {
			warnings.push(
				`${browserRequest.missingClientIds.length} of ${browserRequest.requestedClientIds.length} browser clients did not return a snapshot before the deadline.`,
			);
		}
		return {
			descriptor: this.instance.getPublicDescriptor(),
			health: this.recorder.getHealth(),
			records,
			snapshot,
			findings,
			warnings,
		};
	}

	async writeBundle(
		options: Omit<
			WriteDiagnosticBundleOptions,
			"quarterdeckVersion" | "descriptor" | "records" | "snapshot" | "findings" | "health"
		> & {
			filter?: DiagnosticRecordFilter;
			providers?: readonly string[];
			requestBrowser?: boolean;
		} = {},
	): Promise<WriteDiagnosticBundleResult> {
		const data = await this.collectCaptureData(options);
		return await writeDiagnosticBundle({
			...options,
			projectId: options.projectId ?? options.filter?.projectId ?? null,
			taskId: options.taskId ?? options.filter?.taskId ?? null,
			tier: options.tier ?? this.captureTier,
			quarterdeckVersion: this.quarterdeckVersion,
			descriptor: data.descriptor,
			records: data.records,
			snapshot: data.snapshot,
			findings: data.findings,
			health: data.health,
			warnings: [...(options.warnings ?? []), ...data.warnings],
			stateHome: options.stateHome ?? this.stateHome,
		});
	}

	async markReady(host: string, port: number): Promise<void> {
		await this.instance.markReady(host, port);
		this.recordEvent(
			"runtime.listening",
			{ hostClassification: host === "127.0.0.1" ? "loopback" : "custom", port },
			{},
			{ essential: true },
		);
	}

	async markFailed(error: unknown): Promise<void> {
		const errorClass = getDiagnosticErrorClass(error);
		this.recordEvent("runtime.shutdown_failed", { errorClass }, {}, { level: "error", essential: true });
		await this.recorder.flush();
		await this.instance.markFailed(errorClass);
	}

	async fail(error: unknown): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.failed = true;
		await this.markFailed(error).catch(() => undefined);
		this.disposeProvidersAndCapabilities();
		await this.recorder.close().catch(() => undefined);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.recordEvent("runtime.shutdown_requested", {}, {}, { essential: true });
		await this.instance.markStopping().catch(() => undefined);
		this.recordEvent("runtime.shutdown_completed", {}, {}, { essential: true });
		this.disposeProvidersAndCapabilities();
		await this.recorder.close();
		if (!this.failed) await this.instance.markStopped();
	}

	private disposeProvidersAndCapabilities(): void {
		for (const dispose of Array.from(this.providerDisposers)) dispose();
		this.browser.close();
	}

	private registerCoreProviders(): void {
		this.registerSnapshotProvider({
			name: "runtime",
			capture: () => ({
				...this.recorder.getHealth(),
				status: this.instance.getPublicDescriptor().status,
				descriptorPersistence: this.instance.getPersistenceHealth(),
				providerNames: this.snapshots.listProviders(),
			}),
		});
		this.registerSnapshotProvider({
			name: "browser",
			capture: (scope) => this.browser.getSnapshot(scope),
		});
	}
}

export async function createRuntimeDiagnostics(options: CreateRuntimeDiagnosticsOptions): Promise<RuntimeDiagnostics> {
	return await RuntimeDiagnostics.create(options);
}
