import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { type BrowserDiagnosticSnapshot, browserDiagnosticSnapshotSchema, type DiagnosticCaptureScope } from "../core";
import { applyBrowserSnapshotContentPolicy } from "./browser-snapshot-policy";
import type { BrowserDiagnosticIngestResult } from "./recorder";

const BROWSER_SNAPSHOT_WAIT_MS = 1_250;

interface BrowserCapability {
	clientId: string;
}

export interface BrowserLiveSubscriptionState {
	subscribed: boolean;
	revision: number;
}

interface BrowserSnapshotRequestState {
	nonce: string;
	expectedClientIds: Set<string>;
	receivedClientIds: Set<string>;
	resolve: () => void;
}

export interface BrowserSnapshotRequest {
	nonce: string;
	deadline: number;
}

export type BrowserSnapshotRequester = (request: BrowserSnapshotRequest) => void;

export interface BrowserSnapshotRequestResult {
	requestedClientIds: string[];
	receivedClientIds: string[];
	missingClientIds: string[];
	requesterAvailable: boolean;
}

export interface RuntimeBrowserDiagnosticsOptions {
	captureTier: "flight" | "agent-lab";
	ingestRecords: (clientId: string, candidates: readonly unknown[]) => BrowserDiagnosticIngestResult;
}

function tokensEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/** Owns the browser-only diagnostic capability, tail ingestion, and snapshots. */
export class RuntimeBrowserDiagnostics {
	private readonly capabilities = new Map<string, BrowserCapability>();
	private readonly capabilityByClientId = new Map<string, string>();
	private readonly liveSubscriptionByCapability = new Map<string, BrowserLiveSubscriptionState>();
	private readonly snapshots = new Map<string, BrowserDiagnosticSnapshot>();
	private requester: BrowserSnapshotRequester | null = null;
	private pendingRequest: BrowserSnapshotRequestState | null = null;
	private requestPromise: Promise<BrowserSnapshotRequestResult> | null = null;

	constructor(private readonly options: RuntimeBrowserDiagnosticsOptions) {}

	issueCapability(clientId: string): string {
		this.revokeCapability(clientId);
		const capability = randomBytes(24).toString("base64url");
		this.capabilities.set(capability, { clientId });
		this.capabilityByClientId.set(clientId, capability);
		return capability;
	}

	revokeCapability(clientId: string, expectedCapability?: string): void {
		const capability = this.capabilityByClientId.get(clientId);
		if (expectedCapability && capability !== expectedCapability) return;
		if (capability) this.capabilities.delete(capability);
		this.capabilityByClientId.delete(clientId);
		if (capability) this.liveSubscriptionByCapability.delete(capability);
		this.snapshots.delete(clientId);
		if (this.pendingRequest?.expectedClientIds.delete(clientId)) {
			if (this.pendingRequest.receivedClientIds.size >= this.pendingRequest.expectedClientIds.size) {
				this.pendingRequest.resolve();
			}
		}
	}

	verifyCapability(token: string | undefined, clientId?: string): string | null {
		if (!token) return null;
		for (const [candidate, capability] of this.capabilities) {
			if (!tokensEqual(candidate, token)) continue;
			if (clientId && capability.clientId !== clientId) return null;
			return capability.clientId;
		}
		return null;
	}

	setLiveSubscription(
		clientId: string,
		capability: string,
		subscribed: boolean,
		revision: number,
	): BrowserLiveSubscriptionState {
		if (this.capabilityByClientId.get(clientId) !== capability) return { subscribed: false, revision };
		const existing = this.liveSubscriptionByCapability.get(capability);
		if (existing && existing.revision >= revision) return { ...existing };
		const state = { subscribed, revision };
		this.liveSubscriptionByCapability.set(capability, state);
		return { ...state };
	}

	hasLiveSubscribers(): boolean {
		return this.countLiveSubscribers() > 0;
	}

	isLiveSubscribed(clientId: string, capability: string): boolean {
		return (
			this.capabilityByClientId.get(clientId) === capability &&
			this.liveSubscriptionByCapability.get(capability)?.subscribed === true
		);
	}

	ingestRecords(clientId: string, candidates: readonly unknown[]): BrowserDiagnosticIngestResult {
		return this.options.ingestRecords(clientId, candidates);
	}

	ingestSnapshot(clientId: string, nonce: string, rawSnapshot: unknown): BrowserDiagnosticSnapshot {
		const snapshot = applyBrowserSnapshotContentPolicy(
			browserDiagnosticSnapshotSchema.parse(rawSnapshot),
			this.options.captureTier,
		);
		if (snapshot.clientId !== clientId) throw new Error("Browser snapshot client does not match capability.");
		this.snapshots.set(clientId, snapshot);
		const pending = this.pendingRequest;
		if (pending?.nonce === nonce && pending.expectedClientIds.has(clientId)) {
			pending.receivedClientIds.add(clientId);
			if (pending.receivedClientIds.size >= pending.expectedClientIds.size) pending.resolve();
		}
		return snapshot;
	}

	setRequester(requester: BrowserSnapshotRequester | null): void {
		this.requester = requester;
		if (!requester) this.pendingRequest?.resolve();
	}

	async requestSnapshots(): Promise<BrowserSnapshotRequestResult> {
		if (this.requestPromise) return await this.requestPromise;
		if (!this.requester) return this.emptyResult(false);
		const expectedClientIds = new Set(this.capabilityByClientId.keys());
		if (expectedClientIds.size === 0) return this.emptyResult(true);

		const nonce = randomUUID();
		const deadline = Date.now() + BROWSER_SNAPSHOT_WAIT_MS;
		const requestedClientIds = new Set(expectedClientIds);
		this.requestPromise = new Promise<BrowserSnapshotRequestResult>((resolve) => {
			let settled = false;
			let timeout: NodeJS.Timeout | null = null;
			const finish = (): void => {
				if (settled) return;
				settled = true;
				if (timeout) clearTimeout(timeout);
				const received = this.pendingRequest?.receivedClientIds ?? new Set<string>();
				if (this.pendingRequest?.nonce === nonce) this.pendingRequest = null;
				const requested = Array.from(requestedClientIds).sort();
				const receivedClientIds = Array.from(received).sort();
				resolve({
					requestedClientIds: requested,
					receivedClientIds,
					missingClientIds: requested.filter((clientId) => !received.has(clientId)),
					requesterAvailable: true,
				});
			};
			this.pendingRequest = {
				nonce,
				expectedClientIds,
				receivedClientIds: new Set(),
				resolve: finish,
			};
			timeout = setTimeout(finish, BROWSER_SNAPSHOT_WAIT_MS);
			timeout.unref();
			try {
				this.requester?.({ nonce, deadline });
			} catch {
				finish();
			}
		});
		try {
			return await this.requestPromise;
		} finally {
			this.requestPromise = null;
		}
	}

	getSnapshot(scope: Readonly<DiagnosticCaptureScope> = {}): {
		clients: BrowserDiagnosticSnapshot[];
		connectedClientIds: string[];
		liveSubscriberCount: number;
	} {
		const clients = Array.from(this.snapshots.values()).filter((snapshot) => {
			if (scope.projectId && snapshot.activeProjectId !== scope.projectId) return false;
			if (scope.taskId && snapshot.activeTaskId !== scope.taskId) return false;
			return true;
		});
		return {
			clients: clients.map((snapshot) => structuredClone(snapshot)),
			connectedClientIds:
				scope.projectId || scope.taskId
					? clients.map((snapshot) => snapshot.clientId).sort()
					: Array.from(this.capabilityByClientId.keys()).sort(),
			liveSubscriberCount:
				scope.projectId || scope.taskId
					? clients.filter((snapshot) => {
							const capability = this.capabilityByClientId.get(snapshot.clientId);
							return capability ? this.liveSubscriptionByCapability.get(capability)?.subscribed === true : false;
						}).length
					: this.countLiveSubscribers(),
		};
	}

	close(): void {
		this.pendingRequest?.resolve();
		this.capabilities.clear();
		this.capabilityByClientId.clear();
		this.liveSubscriptionByCapability.clear();
		this.snapshots.clear();
		this.requester = null;
	}

	private emptyResult(requesterAvailable: boolean): BrowserSnapshotRequestResult {
		return {
			requestedClientIds: [],
			receivedClientIds: [],
			missingClientIds: [],
			requesterAvailable,
		};
	}

	private countLiveSubscribers(): number {
		let count = 0;
		for (const state of this.liveSubscriptionByCapability.values()) {
			if (state.subscribed) count += 1;
		}
		return count;
	}
}

export type { BrowserDiagnosticIngestResult };
