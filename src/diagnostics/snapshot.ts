import type { DiagnosticCaptureScope, DiagnosticProviderResult, DiagnosticSnapshot } from "../core";
import { type DiagnosticPathAliases, getDiagnosticErrorClass, sanitizeDiagnosticValue } from "./bounded-value";

const DEFAULT_PROVIDER_TIMEOUT_MS = 2_000;

class DiagnosticProviderTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Diagnostic provider exceeded its ${timeoutMs}ms deadline.`);
		this.name = "DiagnosticProviderTimeoutError";
	}
}

export interface DiagnosticSnapshotProvider {
	name: string;
	timeoutMs?: number;
	capture: (scope: Readonly<DiagnosticCaptureScope>) => unknown | Promise<unknown>;
}

export class DiagnosticSnapshotCoordinator {
	private readonly providers = new Map<string, DiagnosticSnapshotProvider>();

	constructor(
		private readonly runtimeInstanceId: string,
		private readonly pathAliases?: DiagnosticPathAliases,
	) {}

	register(provider: DiagnosticSnapshotProvider): () => void {
		if (this.providers.has(provider.name))
			throw new Error(`Diagnostic provider already registered: ${provider.name}`);
		this.providers.set(provider.name, provider);
		return () => {
			if (this.providers.get(provider.name) === provider) this.providers.delete(provider.name);
		};
	}

	listProviders(): string[] {
		return Array.from(this.providers.keys()).sort();
	}

	async capture(
		requestedProviders?: readonly string[],
		scope: Readonly<DiagnosticCaptureScope> = {},
	): Promise<DiagnosticSnapshot> {
		const selected = requestedProviders?.length
			? requestedProviders.map((name) => this.providers.get(name) ?? { name, capture: () => undefined })
			: Array.from(this.providers.values());
		const providers = await Promise.all(
			selected.map(async (provider) => {
				if (!this.providers.has(provider.name)) {
					return {
						name: provider.name,
						status: "unavailable",
						durationMs: 0,
						error: "Provider is not registered.",
					} satisfies DiagnosticProviderResult;
				}
				return await this.captureProvider(provider, scope);
			}),
		);
		return {
			version: 1,
			runtimeInstanceId: this.runtimeInstanceId,
			capturedAt: Date.now(),
			scope: { ...scope },
			providers,
		};
	}

	private async captureProvider(
		provider: DiagnosticSnapshotProvider,
		scope: Readonly<DiagnosticCaptureScope>,
	): Promise<DiagnosticProviderResult> {
		const startedAt = performance.now();
		const timeoutMs = provider.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
		let timeout: NodeJS.Timeout | null = null;
		try {
			const result = await Promise.race([
				Promise.resolve().then(() => provider.capture(scope)),
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(() => reject(new DiagnosticProviderTimeoutError(timeoutMs)), timeoutMs);
					timeout.unref();
				}),
			]);
			if (timeout) clearTimeout(timeout);
			return {
				name: provider.name,
				status: "completed",
				durationMs: performance.now() - startedAt,
				data: sanitizeDiagnosticValue(result, { pathAliases: this.pathAliases }).value,
			};
		} catch (error) {
			if (timeout) clearTimeout(timeout);
			const errorClass = getDiagnosticErrorClass(error);
			return {
				name: provider.name,
				status: error instanceof DiagnosticProviderTimeoutError ? "timed_out" : "failed",
				durationMs: performance.now() - startedAt,
				error: errorClass,
			};
		}
	}
}
