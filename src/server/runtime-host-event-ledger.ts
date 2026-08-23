import { randomBytes } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
	RuntimeBrowserHostIntegrationEventRequest,
	RuntimeHostIntegrationEvent,
	RuntimeHostIntegrationEventKind,
	RuntimeHostIntegrationEventLedgerFile,
	RuntimeHostIntegrationEventLedgerResponse,
	RuntimeHostIntegrationSanitizedPath,
	RuntimeOpenTargetId,
} from "../core";
import {
	MAX_RUNTIME_HOST_INTEGRATION_EVENTS,
	runtimeHostIntegrationEventLedgerFileSchema,
	runtimeHostIntegrationEventSchema,
} from "../core";

type RuntimeHostIntegrationEventDraft =
	| { kind: "directory_picker"; outcome: "unsupported"; origin: "runtime" }
	| { kind: "external_url"; outcome: "simulated"; origin: "runtime"; url: string }
	| {
			kind: "open_path";
			outcome: "simulated";
			origin: "runtime";
			target: RuntimeHostIntegrationSanitizedPath;
			projectId: string | null;
			taskId: string | null;
	  }
	| {
			kind: "open_project";
			outcome: "simulated";
			origin: "runtime";
			targetId: RuntimeOpenTargetId;
			target: RuntimeHostIntegrationSanitizedPath;
			projectId: string | null;
	  }
	| (RuntimeBrowserHostIntegrationEventRequest & { outcome: "simulated"; origin: "browser" });

interface EventWaiter {
	afterSequence: number;
	kind: RuntimeHostIntegrationEventKind | null;
	resolve: (response: RuntimeHostIntegrationEventLedgerResponse) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
}

export interface RuntimeHostEventQuery {
	afterSequence?: number;
	kind?: RuntimeHostIntegrationEventKind | null;
}

export interface RuntimeHostEventLedgerOptions {
	maxEvents?: number;
	persist?: (ledgerPath: string, payload: RuntimeHostIntegrationEventLedgerFile) => Promise<void>;
	now?: () => Date;
}

async function persistLedgerFileAtomic(
	ledgerPath: string,
	payload: RuntimeHostIntegrationEventLedgerFile,
): Promise<void> {
	await mkdir(dirname(ledgerPath), { recursive: true });
	const temporaryPath = `${ledgerPath}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
	try {
		await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		await rename(temporaryPath, ledgerPath);
	} finally {
		await unlink(temporaryPath).catch(() => {});
	}
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export class RuntimeHostEventLedger {
	private readonly events: RuntimeHostIntegrationEvent[] = [];
	private readonly waiters = new Set<EventWaiter>();
	private readonly maxEvents: number;
	private readonly persistFile: NonNullable<RuntimeHostEventLedgerOptions["persist"]>;
	private readonly now: NonNullable<RuntimeHostEventLedgerOptions["now"]>;
	private nextSequence = 1;
	private mutation: Promise<void> = Promise.resolve();
	private failure: Error | null = null;

	constructor(
		private readonly ledgerPath: string,
		options: RuntimeHostEventLedgerOptions = {},
	) {
		this.maxEvents = options.maxEvents ?? MAX_RUNTIME_HOST_INTEGRATION_EVENTS;
		if (
			!Number.isInteger(this.maxEvents) ||
			this.maxEvents < 1 ||
			this.maxEvents > MAX_RUNTIME_HOST_INTEGRATION_EVENTS
		) {
			throw new Error(`Host event ledger maxEvents must be between 1 and ${MAX_RUNTIME_HOST_INTEGRATION_EVENTS}.`);
		}
		this.persistFile = options.persist ?? persistLedgerFileAtomic;
		this.now = options.now ?? (() => new Date());
	}

	async initialize(): Promise<void> {
		try {
			await this.persistSnapshot([], 0);
		} catch (error) {
			this.failure = toError(error);
			throw this.failure;
		}
	}

	private response(query: RuntimeHostEventQuery = {}): RuntimeHostIntegrationEventLedgerResponse {
		const afterSequence = query.afterSequence ?? 0;
		const events = this.events.filter(
			(event) => event.sequence > afterSequence && (!query.kind || event.kind === query.kind),
		);
		return {
			events,
			lastSequence: this.nextSequence - 1,
		};
	}

	private async persistSnapshot(events: RuntimeHostIntegrationEvent[], lastSequence: number): Promise<void> {
		const payload = runtimeHostIntegrationEventLedgerFileSchema.parse({
			schemaVersion: 1,
			events,
			lastSequence,
		});
		await this.persistFile(this.ledgerPath, payload);
	}

	private notifyWaiters(): void {
		for (const waiter of this.waiters) {
			const response = this.response(waiter);
			if (response.events.length === 0) {
				continue;
			}
			clearTimeout(waiter.timeout);
			this.waiters.delete(waiter);
			waiter.resolve(response);
		}
	}

	private assertHealthy(): void {
		if (this.failure) {
			throw new Error(`Host event ledger is unhealthy: ${this.failure.message}`, { cause: this.failure });
		}
	}

	private markFailure(error: unknown): Error {
		this.failure = toError(error);
		for (const waiter of this.waiters) {
			clearTimeout(waiter.timeout);
			waiter.reject(this.failure);
		}
		this.waiters.clear();
		return this.failure;
	}

	async record(draft: RuntimeHostIntegrationEventDraft): Promise<RuntimeHostIntegrationEvent> {
		const operation = this.mutation.then(async () => {
			this.assertHealthy();
			if (this.events.length >= this.maxEvents) {
				throw this.markFailure(new Error(`Host event ledger reached its ${this.maxEvents}-event limit.`));
			}

			let recorded: RuntimeHostIntegrationEvent;
			try {
				recorded = runtimeHostIntegrationEventSchema.parse({
					...draft,
					sequence: this.nextSequence,
					timestamp: this.now().toISOString(),
				});
				await this.persistSnapshot([...this.events, recorded], recorded.sequence);
			} catch (error) {
				throw this.markFailure(error);
			}

			this.events.push(recorded);
			this.nextSequence = recorded.sequence + 1;
			this.notifyWaiters();
			return recorded;
		});
		this.mutation = operation.then(
			() => {},
			() => {},
		);
		return await operation;
	}

	async recordBrowserEvent(request: RuntimeBrowserHostIntegrationEventRequest): Promise<RuntimeHostIntegrationEvent> {
		return await this.record({
			...request,
			origin: "browser",
			outcome: "simulated",
		});
	}

	list(query: RuntimeHostEventQuery = {}): RuntimeHostIntegrationEventLedgerResponse {
		return this.response(query);
	}

	async waitFor(query: RuntimeHostEventQuery, timeoutMs: number): Promise<RuntimeHostIntegrationEventLedgerResponse> {
		this.assertHealthy();
		const immediate = this.response(query);
		if (immediate.events.length > 0 || timeoutMs <= 0) {
			return immediate;
		}
		return await new Promise((resolve, reject) => {
			const waiter: EventWaiter = {
				afterSequence: query.afterSequence ?? 0,
				kind: query.kind ?? null,
				resolve,
				reject,
				timeout: setTimeout(() => {
					this.waiters.delete(waiter);
					resolve(this.response(query));
				}, timeoutMs),
			};
			this.waiters.add(waiter);
		});
	}

	async flush(): Promise<RuntimeHostIntegrationEventLedgerResponse> {
		await this.mutation;
		this.assertHealthy();
		return this.response();
	}

	async reset(): Promise<void> {
		const operation = this.mutation.then(async () => {
			try {
				await this.persistSnapshot([], 0);
			} catch (error) {
				throw this.markFailure(error);
			}
			this.events.length = 0;
			this.nextSequence = 1;
			this.failure = null;
			for (const waiter of this.waiters) {
				clearTimeout(waiter.timeout);
				waiter.resolve(this.response(waiter));
			}
			this.waiters.clear();
		});
		this.mutation = operation.catch(() => {});
		await operation;
	}
}
