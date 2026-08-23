import { dirname, resolve } from "node:path";
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
	outputDir: resolve(repoRoot, "test-results", "playwright"),
	reporter: [["list"], ["html", { open: "never", outputFolder: resolve(repoRoot, "playwright-report") }]],
	use: {
		baseURL,
		headless: true,
		screenshot: "only-on-failure",
		trace: "retain-on-failure",
		video: "retain-on-failure",
	},
	webServer: {
		command: "node --import tsx scripts/playwright-e2e-runtime.ts",
		cwd: repoRoot,
		url: baseURL,
		reuseExistingServer: false,
		timeout: 75_000,
		gracefulShutdown: {
			signal: "SIGTERM",
			timeout: 20_000,
		},
		env: {
			QUARTERDECK_E2E_RUNTIME_PORT: runtimePort,
			QUARTERDECK_E2E_WEB_PORT: webPort,
			NODE_ENV: "development",
		},
	},
});
