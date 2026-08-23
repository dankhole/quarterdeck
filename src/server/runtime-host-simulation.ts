import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { z } from "zod";
import type { RuntimeHostActionContext, RuntimeHostIntegrationSanitizedPath, RuntimeOpenTargetId } from "../core";
import { runtimeHostIntegrationSanitizedPathSchema, runtimeHostIntegrationSanitizedUrlSchema } from "../core";
import { RuntimeHostEventLedger } from "./runtime-host-event-ledger";
import type { RuntimeHostIntegrationSimulator } from "./runtime-host-integrations";

const runtimeHostSimulationConfigSchema = z.object({
	schemaVersion: z.literal(1),
	ledgerPath: z.string().min(1),
	pathScopes: z
		.array(
			z.object({
				id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
				rootPath: z.string().min(1),
			}),
		)
		.min(1),
});

export type RuntimeHostSimulationConfig = z.infer<typeof runtimeHostSimulationConfigSchema>;

interface RuntimeHostSimulationEnvironment {
	ledger: RuntimeHostEventLedger;
	simulator: RuntimeHostIntegrationSimulator;
}

function normalizeIdentifier(value: string | undefined): string | null {
	const normalized = value?.trim();
	return normalized ? normalized.slice(0, 128) : null;
}

class LedgerRuntimeHostIntegrationSimulator implements RuntimeHostIntegrationSimulator {
	private readonly pathScopes: Array<{ id: string; rootPath: string }>;

	constructor(
		private readonly ledger: RuntimeHostEventLedger,
		pathScopes: RuntimeHostSimulationConfig["pathScopes"],
	) {
		this.pathScopes = pathScopes
			.map((scope) => ({ id: scope.id, rootPath: resolve(scope.rootPath) }))
			.sort((left, right) => right.rootPath.length - left.rootPath.length);
	}

	private async sanitizePath(targetPath: string): Promise<RuntimeHostIntegrationSanitizedPath | null> {
		const normalizedTarget = await realpath(targetPath).catch(() => resolve(targetPath));
		for (const scope of this.pathScopes) {
			const relativePath = relative(scope.rootPath, normalizedTarget);
			if (
				relativePath === "" ||
				(relativePath !== ".." && !isAbsolute(relativePath) && !relativePath.startsWith(`..${sep}`))
			) {
				const parsed = runtimeHostIntegrationSanitizedPathSchema.safeParse({
					scope: scope.id,
					relativePath: relativePath || ".",
				});
				return parsed.success ? parsed.data : null;
			}
		}
		return null;
	}

	async recordUnsupportedDirectoryPicker(): Promise<void> {
		await this.ledger.record({ kind: "directory_picker", outcome: "unsupported", origin: "runtime" });
	}

	async openPath(targetPath: string, context?: RuntimeHostActionContext): Promise<{ ok: true } | { ok: false }> {
		const target = await this.sanitizePath(targetPath);
		if (!target) {
			return { ok: false };
		}
		await this.ledger.record({
			kind: "open_path",
			outcome: "simulated",
			origin: "runtime",
			target,
			projectId: normalizeIdentifier(context?.projectId),
			taskId: normalizeIdentifier(context?.taskId),
		});
		return { ok: true };
	}

	async openExternalUrl(url: string): Promise<{ ok: true } | { ok: false }> {
		let sanitizedUrl: URL;
		try {
			sanitizedUrl = new URL(url);
		} catch {
			return { ok: false };
		}
		if (sanitizedUrl.protocol !== "http:" && sanitizedUrl.protocol !== "https:") {
			return { ok: false };
		}
		sanitizedUrl.username = "";
		sanitizedUrl.password = "";
		sanitizedUrl.search = "";
		sanitizedUrl.hash = "";
		const parsedUrl = runtimeHostIntegrationSanitizedUrlSchema.safeParse(sanitizedUrl.toString());
		if (!parsedUrl.success) {
			return { ok: false };
		}
		await this.ledger.record({
			kind: "external_url",
			outcome: "simulated",
			origin: "runtime",
			url: parsedUrl.data,
		});
		return { ok: true };
	}

	async openProject(
		targetId: RuntimeOpenTargetId,
		cwd: string,
		context?: RuntimeHostActionContext,
	): Promise<{ ok: true } | { ok: false }> {
		const target = await this.sanitizePath(cwd);
		if (!target) {
			return { ok: false };
		}
		await this.ledger.record({
			kind: "open_project",
			outcome: "simulated",
			origin: "runtime",
			targetId,
			target,
			projectId: normalizeIdentifier(context?.projectId),
		});
		return { ok: true };
	}
}

export async function loadRuntimeHostSimulation(configPath: string): Promise<RuntimeHostSimulationEnvironment> {
	const contents = await readFile(configPath, "utf8");
	const config = runtimeHostSimulationConfigSchema.parse(JSON.parse(contents) as unknown);
	const ledger = new RuntimeHostEventLedger(resolve(config.ledgerPath));
	await ledger.initialize();
	const canonicalPathScopes = await Promise.all(
		config.pathScopes.map(async (scope) => ({
			...scope,
			rootPath: await realpath(scope.rootPath).catch(() => resolve(scope.rootPath)),
		})),
	);
	return {
		ledger,
		simulator: new LedgerRuntimeHostIntegrationSimulator(ledger, canonicalPathScopes),
	};
}
