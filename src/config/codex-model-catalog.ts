import packageJson from "../../package.json" with { type: "json" };
import type { RuntimeCodexModelsResponse } from "../core/codex-model-contracts";
import {
	CodexAppServerClient,
	type OwnedCodexAppServerTransport,
	type SpawnCodexAppServerTransportOptions,
	spawnCodexAppServerTransport,
} from "../execution/codex-app-server-client";
import { resolveAgentCommandForLaunch } from "./agent-registry";
import type { RuntimeConfigState } from "./runtime-config-normalizers";

/** Metadata-only discovery: never starts or resumes a thread or submits a turn. */
export async function loadCodexModelCatalog(
	config: RuntimeConfigState,
	cwd: string,
	dependencies: {
		resolveCommand?: typeof resolveAgentCommandForLaunch;
		spawnTransport?: (options: SpawnCodexAppServerTransportOptions) => OwnedCodexAppServerTransport;
	} = {},
): Promise<RuntimeCodexModelsResponse> {
	const command = await (dependencies.resolveCommand ?? resolveAgentCommandForLaunch)({
		...config,
		selectedAgentId: "codex",
	});
	const transport = (dependencies.spawnTransport ?? spawnCodexAppServerTransport)({
		binary: command.binary,
		args: ["app-server", ...command.args, "--stdio"],
		cwd,
		env: { ...process.env },
	});
	const client = new CodexAppServerClient(transport, { clientVersion: packageJson.version, requestTimeoutMs: 5_000 });
	const models: RuntimeCodexModelsResponse["models"] = [];
	try {
		await client.initialize();
		let cursor: string | null = null;
		const cursors = new Set<string>();
		for (let page = 0; page < 20; page += 1) {
			const response = await client.listModels(cursor);
			models.push(...response.data.filter((model) => !model.hidden));
			cursor = response.nextCursor ?? null;
			if (!cursor) break;
			if (cursors.has(cursor)) throw new Error("Codex returned a repeated model catalog cursor.");
			cursors.add(cursor);
		}
		if (cursor) throw new Error("Codex model catalog exceeded the page limit.");
	} finally {
		await transport.stopAndReap(2_000);
	}
	return { models };
}
