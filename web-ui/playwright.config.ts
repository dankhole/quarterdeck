import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(currentDir);
const webPort = process.env.QUARTERDECK_E2E_WEB_PORT ?? "4174";
const runtimePort = process.env.QUARTERDECK_E2E_RUNTIME_PORT ?? "3597";
const baseURL = `http://127.0.0.1:${webPort}`;

export default defineConfig({
	testDir: "./tests",
	timeout: 30_000,
	use: {
		baseURL,
		headless: true,
	},
	webServer: [
		{
			command: "node scripts/playwright-e2e-runtime.mjs",
			cwd: repoRoot,
			url: `http://127.0.0.1:${runtimePort}/api/trpc/projects.list`,
			reuseExistingServer: false,
			timeout: 45_000,
			env: {
				QUARTERDECK_E2E_RUNTIME_PORT: runtimePort,
			},
		},
		{
			command: `npm run dev -- --host 127.0.0.1 --port ${webPort}`,
			cwd: currentDir,
			url: baseURL,
			reuseExistingServer: false,
			env: {
				QUARTERDECK_E2E_RUNTIME_PORT: runtimePort,
			},
		},
	],
});
