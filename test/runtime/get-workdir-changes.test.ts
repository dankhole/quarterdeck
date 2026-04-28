import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getWorkdirFileDiff } from "../../src/workdir";
import { commitAll, initGitRepository } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

describe("get workdir changes runtime", () => {
	it("loads old and new file text between refs", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-file-diff-");
		try {
			initGitRepository(repoPath);
			mkdirSync(join(repoPath, "src"), { recursive: true });
			writeFileSync(join(repoPath, "src", "app.ts"), "const value = 'old';\n", "utf8");
			const baseCommit = commitAll(repoPath, "add file");
			writeFileSync(join(repoPath, "src", "app.ts"), "const value = 'new';\n", "utf8");
			const headCommit = commitAll(repoPath, "update file");

			const diff = await getWorkdirFileDiff({
				cwd: repoPath,
				path: "src/app.ts",
				status: "modified",
				fromRef: baseCommit,
				toRef: headCommit,
			});

			expect(diff).toEqual({
				path: "src/app.ts",
				oldText: "const value = 'old';",
				newText: "const value = 'new';",
			});
		} finally {
			cleanup();
		}
	});
});
