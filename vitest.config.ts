import { defineConfig } from "vitest/config";

process.env.NODE_ENV = "production";
// Runtime/integration tests must never discover and launch the developer's real
// Codex CLI for background task-title generation. Provider-specific unit tests
// override this with mocked Codex/LLM dependencies.
process.env.QUARTERDECK_TITLE_PROVIDER = "local";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		exclude: ["apps/**", "web-ui/**", "third_party/**", "**/node_modules/**", "**/dist/**", ".worktrees/**"],
		testTimeout: 15_000,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/index.ts"],
			reporter: ["text", "html", "json-summary"],
			reportsDirectory: "coverage",
		},
	},
});
