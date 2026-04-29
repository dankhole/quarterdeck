import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getWorkdirChanges, getWorkdirFileDiff } from "../../src/workdir";
import { commitAll, initGitRepository } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

describe("get workdir changes runtime", () => {
	it("updates content revision when working-tree content changes with unchanged diff stats", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-workdir-changes-");
		try {
			initGitRepository(repoPath);
			mkdirSync(join(repoPath, "src"), { recursive: true });
			const filePath = join(repoPath, "src", "app.ts");
			writeFileSync(filePath, "const value = 1;\n", "utf8");
			commitAll(repoPath, "add file");

			writeFileSync(filePath, "const value = 2;\n", "utf8");
			utimesSync(filePath, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
			const first = await getWorkdirChanges(repoPath);

			writeFileSync(filePath, "const value = 3;\n", "utf8");
			utimesSync(filePath, new Date("2026-01-01T00:00:02.000Z"), new Date("2026-01-01T00:00:02.000Z"));
			const second = await getWorkdirChanges(repoPath);

			const firstFile = first.files.find((file) => file.path === "src/app.ts");
			const secondFile = second.files.find((file) => file.path === "src/app.ts");
			expect(firstFile).toMatchObject({ additions: 1, deletions: 1 });
			expect(secondFile).toMatchObject({ additions: 1, deletions: 1 });
			expect(firstFile?.contentRevision).toBeTruthy();
			expect(secondFile?.contentRevision).toBeTruthy();
			expect(secondFile?.contentRevision).not.toBe(firstFile?.contentRevision);
		} finally {
			cleanup();
		}
	});

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
