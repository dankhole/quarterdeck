import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveTsxLoaderImportSpecifier } from "../utilities/integration-server";

describe("cli compatibility flags", () => {
	it("accepts the deprecated --agent flag as a no-op", () => {
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				resolveTsxLoaderImportSpecifier(),
				resolve(process.cwd(), "src/cli.ts"),
				"--agent",
				"legacy-alias-value",
				"--help",
			],
			{
				encoding: "utf8",
			},
		);

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("--port");
		expect(result.stdout).not.toContain("--agent");
		expect(result.stdout).not.toContain("Agent IDs:");
	});
});
