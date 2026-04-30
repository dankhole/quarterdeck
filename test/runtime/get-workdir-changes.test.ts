import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	getWorkdirChanges,
	getWorkdirChangesForPaths,
	getWorkdirFileDiff,
	readWorkdirFileExcerpt,
} from "../../src/workdir";
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

	it("loads workdir changes for selected paths only", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-path-changes-");
		try {
			initGitRepository(repoPath);
			mkdirSync(join(repoPath, "src"), { recursive: true });
			writeFileSync(join(repoPath, "src", "a.ts"), "const value = 1;\n", "utf8");
			writeFileSync(join(repoPath, "src", "b.ts"), "const value = 1;\n", "utf8");
			commitAll(repoPath, "add files");

			writeFileSync(join(repoPath, "src", "a.ts"), "const value = 2;\n", "utf8");
			writeFileSync(join(repoPath, "src", "b.ts"), "const value = 2;\n", "utf8");
			writeFileSync(join(repoPath, "src", "new.ts"), "const value = 3;\n", "utf8");

			const selected = await getWorkdirChangesForPaths(repoPath, ["src/a.ts", "src/new.ts"]);
			expect(selected.files.map((file) => file.path)).toEqual(["src/a.ts", "src/new.ts"]);
			expect(selected.files.find((file) => file.path === "src/new.ts")).toMatchObject({ status: "untracked" });

			const stale = await getWorkdirChangesForPaths(repoPath, ["src/missing.ts"]);
			expect(stale.files).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("reads bounded untracked excerpts without following symlinks or including binary content", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-file-excerpt-");
		const { path: outsidePath, cleanup: cleanupOutside } = createTempDir("quarterdeck-file-excerpt-outside-");
		try {
			writeFileSync(join(repoPath, "large.txt"), `${"a".repeat(100)}\n${"b".repeat(100)}`, "utf8");
			writeFileSync(join(repoPath, "asset.bin"), Buffer.from([0, 1, 2, 3]));
			writeFileSync(join(outsidePath, "secret.txt"), "outside secret", "utf8");
			symlinkSync(join(outsidePath, "secret.txt"), join(repoPath, "linked-secret.txt"));

			const text = await readWorkdirFileExcerpt(repoPath, "large.txt", 32);
			expect(text.content.length).toBeLessThanOrEqual(32);
			expect(text.truncated).toBe(true);
			expect(text.omittedReason).toBeUndefined();

			const binary = await readWorkdirFileExcerpt(repoPath, "asset.bin", 32);
			expect(binary).toMatchObject({ content: "", binary: true, omittedReason: "binary" });

			const symlink = await readWorkdirFileExcerpt(repoPath, "linked-secret.txt", 32);
			expect(symlink).toMatchObject({ content: "", binary: false, omittedReason: "symlink" });
		} finally {
			cleanup();
			cleanupOutside();
		}
	});
});
