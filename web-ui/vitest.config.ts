import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const rootPkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf-8")) as {
	version: string;
};

export default defineConfig({
	plugins: [react()],
	define: {
		__APP_VERSION__: JSON.stringify(rootPkg.version),
	},
	resolve: {
		alias: {
			"@": resolve(import.meta.dirname, "src"),
			"@runtime-agent-catalog": resolve(import.meta.dirname, "../src/core/agent-catalog.ts"),
			"@runtime-contract": resolve(import.meta.dirname, "../src/core/api-contract.ts"),
			"@runtime-config-defaults": resolve(import.meta.dirname, "../src/config/config-defaults.ts"),
			"@runtime-task-resource-operation-coordinator": resolve(
				import.meta.dirname,
				"../src/core/task-resource-operation-coordinator.ts",
			),
			"@runtime-shortcuts": resolve(import.meta.dirname, "../src/config/shortcut-utils.ts"),
			"@runtime-task-id": resolve(import.meta.dirname, "../src/core/task-id.ts"),
			"@runtime-task-worktree-path": resolve(import.meta.dirname, "../src/workdir/task-worktree-path.ts"),
			"@runtime-task-state": resolve(import.meta.dirname, "../src/core/task-board-mutations.ts"),
			"@runtime-terminal-utils": resolve(import.meta.dirname, "../src/terminal/output-utils.ts"),
		},
		conditions: ["import", "module", "browser", "default"],
	},
	test: {
		environment: "jsdom",
		include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
		passWithNoTests: true,
		setupFiles: ["./vitest.setup.ts"],
		coverage: {
			provider: "v8",
			include: ["src/**/*.{ts,tsx}"],
			exclude: ["src/**/*.test.{ts,tsx}", "src/test-utils/**", "src/main.tsx", "src/vite-env.d.ts"],
			reporter: ["text", "html", "json-summary"],
			reportsDirectory: "coverage",
		},
	},
});
