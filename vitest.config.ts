import { defineConfig } from "vitest/config";

// A test run may inherit launcher paths for the developer's active instance.
// Fixtures choose their own runtime environment; never inherit live state or
// desktop/native-hook settings from the process that launched Vitest.
for (const key of Object.keys(process.env)) {
	if (key.startsWith("QUARTERDECK_")) delete process.env[key];
}

process.env.NODE_ENV = "production";
// Runtime/integration tests must never discover and launch the developer's real
// Codex CLI for background task-title generation. Provider-specific unit tests
// override this with mocked Codex/LLM dependencies.
process.env.QUARTERDECK_TITLE_PROVIDER = "local";

export default defineConfig(({ mode }) => ({
	test: {
		provide: { compileIntegrationCli: mode === "integration" },
		globals: true,
		environment: "node",
		globalSetup: "./test/global-setup.ts",
		exclude: [
			".github/**", // Release policy checks use Node's test runner, not Vitest.
			"apps/**",
			"desktop/**",
			"web-ui/**",
			"third_party/**",
			"**/node_modules/**",
			"**/dist/**",
			".worktrees/**",
		],
		testTimeout: 15_000,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/index.ts"],
			reporter: ["text", "html", "json-summary"],
			reportsDirectory: "coverage",
		},
	},
}));
