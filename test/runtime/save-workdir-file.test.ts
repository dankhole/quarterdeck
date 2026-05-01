import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	MAX_WORKDIR_FILE_EDIT_SIZE,
	readWorkdirFile,
	saveWorkdirFile,
	WORKDIR_FILE_TOO_LARGE_TO_EDIT_MESSAGE,
	WorkdirFileConflictError,
} from "../../src/workdir";
import { createTempDir } from "../utilities/temp-dir";

function requireContentHash(contentHash: string | undefined): string {
	expect(contentHash).toBeTruthy();
	return contentHash ?? "";
}

describe("workdir file editing", () => {
	it("saves text files when the loaded content hash still matches", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-save-workdir-file-");
		try {
			mkdirSync(join(repoPath, "src"), { recursive: true });
			writeFileSync(join(repoPath, "src", "app.ts"), "const value = 1;\n", "utf8");

			const loaded = await readWorkdirFile(repoPath, "src/app.ts");
			const loadedHash = requireContentHash(loaded.contentHash);

			const saved = await saveWorkdirFile(repoPath, "src/app.ts", "const value = 2;\n", loadedHash);

			expect(readFileSync(join(repoPath, "src", "app.ts"), "utf8")).toBe("const value = 2;\n");
			expect(saved).toMatchObject({
				content: "const value = 2;\n",
				language: "typescript",
				binary: false,
				truncated: false,
				editable: true,
			});
			expect(saved.contentHash).toBeTruthy();
			expect(saved.contentHash).not.toBe(loaded.contentHash);
		} finally {
			cleanup();
		}
	});

	it("rejects saves when the file changed after it was opened", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-save-workdir-conflict-");
		try {
			writeFileSync(join(repoPath, "app.ts"), "const value = 1;\n", "utf8");
			const loaded = await readWorkdirFile(repoPath, "app.ts");
			const loadedHash = requireContentHash(loaded.contentHash);
			writeFileSync(join(repoPath, "app.ts"), "const value = 99;\n", "utf8");

			await expect(saveWorkdirFile(repoPath, "app.ts", "const value = 2;\n", loadedHash)).rejects.toBeInstanceOf(
				WorkdirFileConflictError,
			);
			expect(readFileSync(join(repoPath, "app.ts"), "utf8")).toBe("const value = 99;\n");
		} finally {
			cleanup();
		}
	});

	it("preserves executable permissions when saving scripts", async () => {
		if (process.platform === "win32") {
			return;
		}
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-save-workdir-mode-");
		try {
			const scriptPath = join(repoPath, "script.sh");
			writeFileSync(scriptPath, "#!/usr/bin/env bash\necho before\n", "utf8");
			chmodSync(scriptPath, 0o755);
			const loaded = await readWorkdirFile(repoPath, "script.sh");
			const loadedHash = requireContentHash(loaded.contentHash);

			await saveWorkdirFile(repoPath, "script.sh", "#!/usr/bin/env bash\necho after\n", loadedHash);

			expect(statSync(scriptPath).mode & 0o777).toBe(0o755);
		} finally {
			cleanup();
		}
	});

	it("rejects binary files", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-save-workdir-binary-");
		try {
			writeFileSync(join(repoPath, "image.bin"), Buffer.from([0x00, 0x01, 0x02]));
			const loaded = await readWorkdirFile(repoPath, "image.bin");
			const loadedHash = requireContentHash(loaded.contentHash);

			await expect(saveWorkdirFile(repoPath, "image.bin", "text", loadedHash)).rejects.toThrow(
				"Cannot edit binary files.",
			);
		} finally {
			cleanup();
		}
	});

	it("opens files over the edit limit read-only", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-read-too-large-to-edit-");
		try {
			const content = `${"a".repeat(MAX_WORKDIR_FILE_EDIT_SIZE + 1)}\n`;
			writeFileSync(join(repoPath, "large.ts"), content, "utf8");

			const loaded = await readWorkdirFile(repoPath, "large.ts");

			expect(loaded.content).toBe(content);
			expect(loaded.truncated).toBe(false);
			expect(loaded.editable).toBe(false);
			expect(loaded.editBlockedReason).toBe(WORKDIR_FILE_TOO_LARGE_TO_EDIT_MESSAGE);
			expect(loaded.contentHash).toBeTruthy();
		} finally {
			cleanup();
		}
	});

	it("opens skipped workdir paths read-only and rejects saves to them", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-save-workdir-skipped-");
		try {
			mkdirSync(join(repoPath, ".git"), { recursive: true });
			writeFileSync(join(repoPath, ".git", "config"), "[core]\nrepositoryformatversion = 0\n", "utf8");

			const loaded = await readWorkdirFile(repoPath, ".git/config");
			const loadedHash = requireContentHash(loaded.contentHash);

			expect(loaded.editable).toBe(false);
			expect(loaded.editBlockedReason).toBe("Cannot modify skipped workdir paths.");
			await expect(saveWorkdirFile(repoPath, ".git/config", "[core]\n", loadedHash)).rejects.toThrow(
				"Cannot modify skipped workdir paths.",
			);
			expect(readFileSync(join(repoPath, ".git", "config"), "utf8")).toBe("[core]\nrepositoryformatversion = 0\n");
		} finally {
			cleanup();
		}
	});

	it("rejects saves over the edit limit", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-save-too-large-to-edit-");
		try {
			const content = `${"a".repeat(MAX_WORKDIR_FILE_EDIT_SIZE + 1)}\n`;
			writeFileSync(join(repoPath, "large.ts"), content, "utf8");
			const loaded = await readWorkdirFile(repoPath, "large.ts");
			const loadedHash = requireContentHash(loaded.contentHash);

			await expect(saveWorkdirFile(repoPath, "large.ts", "const value = 2;\n", loadedHash)).rejects.toThrow(
				WORKDIR_FILE_TOO_LARGE_TO_EDIT_MESSAGE,
			);
		} finally {
			cleanup();
		}
	});

	it("reads full text files over the old 1MB viewer limit", async () => {
		const { path: repoPath, cleanup } = createTempDir("quarterdeck-read-large-workdir-file-");
		try {
			const content = `${"a".repeat(1_048_576 + 10)}\n`;
			writeFileSync(join(repoPath, "large.ts"), content, "utf8");

			const loaded = await readWorkdirFile(repoPath, "large.ts");

			expect(loaded.content).toBe(content);
			expect(loaded.truncated).toBe(false);
			expect(loaded.editable).toBe(true);
			expect(loaded.contentHash).toBeTruthy();
		} finally {
			cleanup();
		}
	});
});
