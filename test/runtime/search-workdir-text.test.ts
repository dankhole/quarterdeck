import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { searchWorkdirText } from "../../src/workdir";
import {
	stageAndCommitAll as commitAll,
	commitAll as commitAllAndReadHead,
	initGitRepository as initRepository,
} from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

describe("search workdir text runtime", { concurrent: false }, () => {
	it("searches text at a read-only git ref", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-search-text-ref-");
		try {
			initRepository(repoPath);
			mkdirSync(join(repoPath, "src"), { recursive: true });
			writeFileSync(join(repoPath, "src", "app.ts"), "export const refOnly = true;\n", "utf8");
			const firstCommit = commitAllAndReadHead(repoPath, "add ref text");
			writeFileSync(join(repoPath, "src", "app.ts"), "export const currentOnly = true;\n", "utf8");
			commitAll(repoPath, "replace ref text");

			const result = await searchWorkdirText(repoPath, "refOnly", { ref: firstCommit });

			expect(result.files).toEqual([
				{
					path: "src/app.ts",
					matches: [{ line: 1, content: "export const refOnly = true;" }],
				},
			]);
			expect(result.totalMatches).toBe(1);
			expect(result.truncated).toBe(false);
		} finally {
			cleanup();
		}
	});
});
