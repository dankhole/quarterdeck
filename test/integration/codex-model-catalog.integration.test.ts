import { describe, expect, it } from "vitest";

import { loadCodexModelCatalog } from "../../src/config/codex-model-catalog";
import {
	type OwnedCodexAppServerTransport,
	spawnCodexAppServerTransport,
} from "../../src/execution/codex-app-server-client";
import { createTestRuntimeConfigState } from "../utilities/runtime-config-factory";
import { createTempDir } from "../utilities/temp-dir";

function ignoringTerminationServer(malformed: boolean): string {
	return `
		const readline = require('node:readline');
		require('node:child_process').spawn(process.execPath, ['-e',
			"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
		], { stdio: 'inherit' });
		process.on('SIGTERM', () => {});
		setInterval(() => {}, 1000);
		readline.createInterface({ input: process.stdin }).on('line', line => {
			const request = JSON.parse(line);
			if (request.id === undefined) return;
			const result = request.method === 'initialize'
				? { userAgent: 'synthetic', codexHome: process.cwd(), platformFamily: 'unix', platformOs: 'linux' }
				: ${malformed ? "{ data: 'invalid' }" : "{ data: [], nextCursor: null }"};
			process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
		});
	`;
}

describe("Codex model discovery process cleanup", () => {
	it.each([false, true])(
		"reaps a SIGTERM-ignoring app-server and inherited stdio before settling (malformed=%s)",
		async (malformed) => {
			const sandbox = createTempDir("quarterdeck-model-discovery-");
			let transport: OwnedCodexAppServerTransport | undefined;
			try {
				const discovery = loadCodexModelCatalog(createTestRuntimeConfigState(), sandbox.path, {
					resolveCommand: async () => ({
						agentId: "codex",
						label: "Synthetic Codex",
						command: process.execPath,
						binary: process.execPath,
						args: [],
					}),
					spawnTransport: (options) => {
						transport = spawnCodexAppServerTransport({
							...options,
							args: ["-e", ignoringTerminationServer(malformed)],
						});
						return transport;
					},
				});
				if (malformed) await expect(discovery).rejects.toThrow();
				else await expect(discovery).resolves.toEqual({ models: [] });
				expect(transport).toBeDefined();
				expect(await transport?.waitForExit(0)).toBe(true);
				expect(() => process.kill(transport?.pid ?? 0, 0)).toThrow();
			} finally {
				await transport?.stopAndReap(0);
				sandbox.cleanup();
			}
		},
		10_000,
	);
});
