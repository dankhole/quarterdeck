import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { searchWorkdirText } from "../../src/workdir";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: createGitTestEnv(),
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function initRepository(path: string): void {
	runGit(path, ["init", "-q"]);
	runGit(path, ["config", "user.name", "Test User"]);
	runGit(path, ["config", "user.email", "test@example.com"]);
}

function commitAll(cwd: string, message: string): string {
	runGit(cwd, ["add", "."]);
	runGit(cwd, ["commit", "-qm", message]);
	return runGit(cwd, ["rev-parse", "HEAD"]);
}

describe.sequential("search workdir text runtime", () => {
	it("searches text at a read-only git ref", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-search-text-ref-");
		try {
			initRepository(repoPath);
			mkdirSync(join(repoPath, "src"), { recursive: true });
			writeFileSync(join(repoPath, "src", "app.ts"), "export const refOnly = true;\n", "utf8");
			const firstCommit = commitAll(repoPath, "add ref text");
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
