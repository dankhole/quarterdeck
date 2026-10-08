import { describe, expect, it } from "vitest";

import { selectPrecommitChecks } from "../../scripts/precommit.mjs";

describe("staged validation selection", () => {
	it("skips runtime checks for prose but validates the instruction bridge", () => {
		expect(selectPrecommitChecks(["docs/testing.md", "README.md"])).toEqual([]);
		expect(selectPrecommitChecks(["AGENTS.md", "CLAUDE.md"])).toEqual([["run", "check:agent-instructions"]]);
	});
	it("keeps runtime implementation changes in the runtime lane", () => {
		expect(selectPrecommitChecks(["src/server/runtime-server.ts"])).toEqual([["run", "typecheck"], ["run", "test:fast"]]);
	});
	it("checks the web boundary instead of unrelated runtime tests", () => {
		expect(selectPrecommitChecks(["web-ui/src/components/button.tsx"])).toEqual([
			["--prefix", "web-ui", "run", "typecheck"],
			["--prefix", "web-ui", "run", "test"],
		]);
	});
	it("selects existing changed tests without splitting spaces in paths", () => {
		expect(selectPrecommitChecks(["test/integration/a test.test.ts"], () => true)).toEqual([
			["run", "typecheck"], ["run", "test", "--", "test/integration/a test.test.ts"],
		]);
	});
	it("falls back for deleted tests and changed helpers instead of passing an empty filter", () => {
		for (const paths of [["test/runtime/deleted.test.ts"], ["test/utilities/git-env.ts"]]) {
			expect(selectPrecommitChecks(paths, () => false)).toEqual([["run", "typecheck"], ["run", "test:fast"]]);
		}
	});
	it("keeps the broad fallback for shared code, tooling, and unknown inputs", () => {
		for (const path of ["src/core/api-contract.ts", "src/shared/desktop-bridge-contract.ts", "src/terminal/output-utils.ts", "package-lock.json", "scripts/build.mjs", ".github/workflows/test.yml", "src/prompt.txt"]) {
			expect(selectPrecommitChecks([path])).toEqual([
				["run", "typecheck"], ["run", "test:fast"],
				["--prefix", "web-ui", "run", "typecheck"], ["--prefix", "web-ui", "run", "test"],
				["--prefix", "desktop", "run", "typecheck"], ["--prefix", "desktop", "run", "test"],
			]);
		}
	});
	it("combines changed boundaries once and includes both sides of renames", () => {
		const checks = selectPrecommitChecks(["web-ui/src/old.test.ts", "desktop/test/new.test.ts"], (path) => path.startsWith("desktop/"));
		expect(checks).toEqual([
			["--prefix", "web-ui", "run", "typecheck"], ["--prefix", "web-ui", "run", "test"],
			["--prefix", "desktop", "run", "typecheck"], ["--prefix", "desktop", "run", "test", "--", "test/new.test.ts"],
		]);
	});
});
