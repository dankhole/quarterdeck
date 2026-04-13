import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const rootPkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8")) as { version: string };

export default defineConfig({
	plugins: [react()],
	define: {
		__APP_VERSION__: JSON.stringify(rootPkg.version),
	},
	resolve: {
		alias: {
			"@": resolve(__dirname, "src"),
			"@runtime-agent-catalog": resolve(__dirname, "../src/core/agent-catalog.ts"),
			"@runtime-config-defaults": resolve(__dirname, "../src/config/config-defaults.ts"),
			"@runtime-shortcuts": resolve(__dirname, "../src/config/shortcut-utils.ts"),
			"@runtime-task-id": resolve(__dirname, "../src/core/task-id.ts"),
			"@runtime-task-worktree-path": resolve(__dirname, "../src/workspace/task-worktree-path.ts"),
			"@runtime-task-state": resolve(__dirname, "../src/core/task-board-mutations.ts"),
			"@runtime-terminal-utils": resolve(__dirname, "../src/terminal/output-utils.ts"),
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
