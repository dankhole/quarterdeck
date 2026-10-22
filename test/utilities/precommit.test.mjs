import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { shouldCheckInstructionBridge } from "../../scripts/precommit.mjs";
import { createTempDir } from "./temp-dir.ts";

const scriptPath = fileURLToPath(new URL("../../scripts/precommit.mjs", import.meta.url));
const hookPath = fileURLToPath(new URL("../../.husky/pre-commit", import.meta.url));

describe("lightweight staged validation selection", () => {
	it("never selects typechecks or test suites for code, tests, shared inputs, or tooling", () => {
		const paths = [
			"src/server/runtime-server.ts",
			"web-ui/src/components/button.tsx",
			"desktop/src/main.ts",
			"test/runtime/example.test.ts",
			"test/utilities/git-env.ts",
			"web-ui/src/deleted.test.ts",
			"src/core/api-contract.ts",
			"src/config/global-config-fields.ts",
			"src/shared/desktop-bridge-contract.ts",
			"src/terminal/output-utils.ts",
			"package.json",
			"package-lock.json",
			"scripts/precommit.mjs",
			".husky/pre-commit",
			".github/workflows/test.yml",
			"README.md",
			"unknown-input",
		];
		for (const path of paths) expect(shouldCheckInstructionBridge([path])).toBe(false);
		expect(shouldCheckInstructionBridge(paths)).toBe(false);
		expect(shouldCheckInstructionBridge([])).toBe(false);
	});

	it("checks the bridge once when its instructions, checker, or required guides change", () => {
		const inputs = [
			"AGENTS.md",
			"CLAUDE.md",
			"scripts/check-agent-instructions.mjs",
			"docs/testing.md",
			"docs/conventions/structured-execution.md",
		];
		for (const path of inputs) expect(shouldCheckInstructionBridge([path])).toBe(true);
		expect(shouldCheckInstructionBridge([...inputs, ...inputs, "package-lock.json"])).toBe(true);
	});

	it("matches whole Git paths without treating whitespace or nested names as bridge inputs", () => {
		expect(shouldCheckInstructionBridge([
			"docs/AGENTS.md",
			"AGENTS.md backup",
			"AGENTS.md\nother.ts",
			" AGENTS.md",
			"docs/testing.md.old",
		])).toBe(false);
	});
});

describe("pre-commit runner", () => {
	const fixtures = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	function fixture() {
		const temp = createTempDir("quarterdeck-precommit-");
		fixtures.push(temp);
		// A hook or developer shell may export Git's repository/index overrides.
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
		const git = (args) => {
			const result = spawnSync("git", ["-c", "core.hooksPath=.no-hooks", ...args], {
				cwd: temp.path, env, encoding: "utf8", windowsHide: true,
			});
			expect(result.error).toBeUndefined();
			expect(result.status, result.stderr).toBe(0);
			return result.stdout;
		};
		const write = (path, text) => {
			mkdirSync(dirname(join(temp.path, path)), { recursive: true });
			writeFileSync(join(temp.path, path), text);
		};
		const run = (overrides = {}) => spawnSync(process.execPath, [scriptPath], {
			cwd: temp.path, env: { ...env, ...overrides }, encoding: "utf8", windowsHide: true, timeout: 15_000,
		});
		write("package.json", JSON.stringify({
			private: true,
			scripts: {
				"check:agent-instructions": "node check.cjs",
				typecheck: "node forbidden.cjs",
				test: "node forbidden.cjs",
				"test:fast": "node forbidden.cjs",
			},
		}));
		write("check.cjs", "console.log('instruction-check-ran'); process.exit(Number(process.env.PRECOMMIT_EXIT || 0));\n");
		write("forbidden.cjs", "console.error('unexpected broad check'); process.exit(99);\n");
		return { path: temp.path, git, write, run, env };
	}

	it("accepts an empty index and code paths with spaces without running broad checks or restaging", () => {
		const repo = fixture();
		repo.git(["init"]);
		const empty = repo.run();
		expect(empty.error).toBeUndefined();
		expect(empty.status, empty.stderr).toBe(0);
		expect(empty.stdout).toContain("No instruction-bridge changes");

		const path = "src/a file with spaces.ts";
		repo.write(path, "staged content\n");
		repo.git(["add", "--", path]);
		if (process.platform !== "win32") {
			const newlinePath = "AGENTS.md\nother.ts";
			repo.write(newlinePath, "ordinary file with a newline in its name\n");
			repo.git(["add", "--", newlinePath]);
		}
		repo.write(path, "unstaged content\n");
		const before = repo.git(["diff", "--cached", "--raw", "-z"]);
		const result = repo.run();
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("No instruction-bridge changes");
		expect(result.stdout).not.toContain("Pre-commit: npm");
		expect(repo.git(["diff", "--cached", "--raw", "-z"])).toBe(before);
		expect(repo.git(["show", `:${path}`])).toBe("staged content\n");
		expect(readFileSync(join(repo.path, path), "utf8")).toBe("unstaged content\n");
	});

	it.each([
		["AGENTS.md", "renamed instructions.md"],
		["source instructions.md", "CLAUDE.md"],
	])("checks an instruction rename from %s to %s", (oldPath, newPath) => {
		const repo = fixture();
		repo.git(["init"]);
		repo.write(oldPath, "original instructions\n");
		repo.git(["add", "--", oldPath]);
		repo.git(["-c", "user.name=Precommit Test", "-c", "user.email=precommit@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture baseline"]);
		repo.git(["mv", "--", oldPath, newPath]);
		const result = repo.run();
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.match(/instruction-check-ran/gu)).toHaveLength(1);
	});

	it("propagates a failing check instead of accepting the commit", () => {
		const repo = fixture();
		repo.git(["init"]);
		repo.write("CLAUDE.md", "instructions\n");
		repo.git(["add", "--", "CLAUDE.md"]);
		const result = repo.run({ PRECOMMIT_EXIT: "7" });
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(7);
		expect(result.stdout).toContain("instruction-check-ran");
	});

	it("fails closed when Git cannot read staged paths", () => {
		const repo = fixture();
		const result = repo.run();
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Could not read staged paths for validation.");
		expect(result.stdout).not.toContain("instruction-check-ran");
	});

	it.skipIf(process.platform === "win32")("fails clearly without downloading Biome when root dependencies are missing", () => {
		const repo = fixture();
		const result = spawnSync("sh", [hookPath], {
			cwd: repo.path, env: repo.env, encoding: "utf8", windowsHide: true, timeout: 15_000,
		});
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("Biome is not installed. Run npm ci in the repository root");
		expect(result.stdout).not.toContain("Running lightweight staged checks");
	});
});
