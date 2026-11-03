import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { MAX_COMMENT_SOURCE_BYTES } from "../../src/search/comment-ranges";
import { searchWorkdirText } from "../../src/workdir";
import * as gitUtils from "../../src/workdir/git-utils";
import { createTextSearchCommentFilter } from "../../src/workdir/text-search-comment-filter";
import {
	stageAndCommitAll as commitAll,
	commitAll as commitAllAndReadHead,
	initGitRepository as initRepository,
} from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

async function withFiles(files: Record<string, string>, run: (path: string) => Promise<void>) {
	const repo = createTempDir("quarterdeck-search-comments-");
	try {
		initRepository(repo.path);
		for (const [path, content] of Object.entries(files)) {
			writeFileSync(join(repo.path, path), content, "utf8");
		}
		commitAll(repo.path, "search fixtures");
		await run(repo.path);
	} finally {
		repo.cleanup();
	}
}

function codeMatch(line: number, content: string, text = "needle") {
	const start = content.toLowerCase().indexOf(text);
	return { line, content, ranges: [{ start, end: start + text.length }] };
}

describe("search workdir text runtime", { concurrent: false }, () => {
	it("keeps default/off results unchanged and acknowledges only enabled filtering", async () => {
		await withFiles({ "app.ts": "// needle\nconst needle = 1;\n" }, async (cwd) => {
			const original = await searchWorkdirText(cwd, "needle");
			expect(original.totalMatches).toBe(2);
			expect(original).not.toHaveProperty("ignoreComments");
			expect(await searchWorkdirText(cwd, "needle", { ignoreComments: false })).toEqual(original);
			expect(await searchWorkdirText(cwd, "absent", { ignoreComments: true })).toEqual({
				query: "absent",
				files: [],
				totalMatches: 0,
				truncated: false,
				ignoreComments: true,
			});
		});
	});

	it("filters occurrences, not lines, and keeps original multiline source coordinates", async () => {
		const content = [
			"/* start",
			"needle in a block",
			"*/",
			"const needle = 1; // needle comment",
			"const other = 1; // needle only",
			'const text = "// needle /* text */";',
			"// needle",
			"const NEEDLE = 2;",
			"",
		].join("\n");
		await withFiles({ "app.ts": content }, async (cwd) => {
			const result = await searchWorkdirText(cwd, "needle", { ignoreComments: true });
			expect(result).toEqual({
				query: "needle",
				ignoreComments: true,
				totalMatches: 3,
				truncated: false,
				files: [
					{
						path: "app.ts",
						matches: [4, 6, 8].map((line) => codeMatch(line, content.split("\n")[line - 1] ?? "")),
					},
				],
			});
			expect(
				(await searchWorkdirText(cwd, "needle", { ignoreComments: true, caseSensitive: true })).totalMatches,
			).toBe(2);
		});
	});

	it.each(["java", "cs"])("supports %s comments while preserving comment markers in strings", async (extension) => {
		await withFiles(
			{ [`app.${extension}`]: '// needle\n/* begin\nneedle\n*/\nString text = "/* needle */"; // needle\n' },
			async (cwd) => {
				const result = await searchWorkdirText(cwd, "needle", { ignoreComments: true });
				expect(result.files[0]?.matches).toEqual([codeMatch(5, 'String text = "/* needle */"; // needle')]);
			},
		);
	});

	it("uses Git POSIX expressions and maps UTF-8 byte columns to UTF-16 comment offsets", async () => {
		await withFiles(
			{
				"app.ts": '// é 😀 needle22\r\nconst é = "😀 needle11"; // needle22\r\nconst word = "é😀"; // needle33\r\n',
			},
			async (cwd) => {
				const result = await searchWorkdirText(cwd, "needle[[:digit:]]+", { ignoreComments: true, isRegex: true });
				expect(result.files).toEqual([
					{
						path: "app.ts",
						matches: [
							{ line: 2, content: 'const é = "😀 needle11"; // needle22', ranges: [{ start: 14, end: 22 }] },
						],
					},
				]);
			},
		);
	});

	it("returns all surviving UTF-16 ranges without trimming source whitespace", async () => {
		const content = '\t  const needle = "😀 needle"; /* needle */  ';
		await withFiles({ "app.ts": `${content}\n` }, async (cwd) => {
			const result = await searchWorkdirText(cwd, "needle", { ignoreComments: true });
			expect(result.files[0]?.matches).toEqual([
				{
					line: 1,
					content,
					ranges: [
						{ start: 9, end: 15 },
						{ start: 22, end: 28 },
					],
				},
			]);
		});
	});

	it("keeps delimiter collisions and literal escape sequences unclassified", async () => {
		const content = "// \u001b[31mneedle\u001b[m";
		await withFiles({ "app.ts": `${content}\n` }, async (cwd) => {
			const result = await searchWorkdirText(cwd, "needle", { ignoreComments: true });
			expect(result.files).toEqual([{ path: "app.ts", matches: [{ line: 1, content }] }]);
		});
	});

	it("filters before the limit and truncates only for an additional surviving line", async () => {
		await withFiles(
			{ "app.ts": "// needle\n/* needle */\nconst needle = 1;\n// needle\nconst needle2 = 2;\n// needle\n" },
			async (cwd) => {
				const limited = await searchWorkdirText(cwd, "needle", { ignoreComments: true, limit: 1 });
				expect(limited.files[0]?.matches.map((match) => match.line)).toEqual([3]);
				expect(limited.truncated).toBe(true);
				const exact = await searchWorkdirText(cwd, "needle", { ignoreComments: true, limit: 2 });
				expect(exact.totalMatches).toBe(2);
				expect(exact.truncated).toBe(false);
			},
		);
	});

	it("uses the selected immutable ref, not modified worktree source", async () => {
		await withFiles({ "app.ts": "/* start\nneedle\n*/\nconst needle = 1;\n" }, async (cwd) => {
			writeFileSync(join(cwd, "app.ts"), "const start = 1;\nneedle\nconst end = 1;\n// needle\n");
			const result = await searchWorkdirText(cwd, "needle", { ignoreComments: true, ref: "HEAD" });
			expect(result.files).toEqual([{ path: "app.ts", matches: [codeMatch(4, "const needle = 1;")] }]);
		});
	});

	it("captures a moving symbolic ref once for both grep streams and source reads", async () => {
		await withFiles({ "app.ts": "// needle\nconst needle = 1;\n" }, async (cwd) => {
			const original = gitUtils.runGit;
			let moved = false;
			const spy = vi.spyOn(gitUtils, "runGit").mockImplementation(async (path, args, options) => {
				const result = await original(path, args, options);
				if (!moved && args[0] === "grep") {
					moved = true;
					writeFileSync(join(cwd, "app.ts"), "const needle = 2;\n// needle\n");
					commitAll(cwd, "move HEAD");
				}
				return result;
			});
			try {
				const result = await searchWorkdirText(cwd, "needle", { ignoreComments: true, ref: "HEAD" });
				expect(moved).toBe(true);
				expect(result.files).toEqual([{ path: "app.ts", matches: [codeMatch(2, "const needle = 1;")] }]);
			} finally {
				spy.mockRestore();
			}
		});
	});

	it("preserves unknown languages and over-limit source conservatively", async () => {
		await withFiles(
			{ "notes.unknown": "// needle\n", "large.ts": `// needle${" ".repeat(MAX_COMMENT_SOURCE_BYTES)}\n` },
			async (cwd) => {
				const result = await searchWorkdirText(cwd, "needle", { ignoreComments: true });
				expect(result.totalMatches).toBe(2);
				expect(result.files.map((file) => file.path)).toEqual(["large.ts", "notes.unknown"]);
				expect(result.files.every((file) => file.matches.every((match) => match.ranges === undefined))).toBe(true);
			},
		);
	});

	it("filters a folder project without consulting an enclosing Git index", async () => {
		const folder = createTempDir("quarterdeck-search-folder-");
		try {
			writeFileSync(join(folder.path, "app.ts"), "// needle\nconst needle = 1;\n");
			const result = await searchWorkdirText(folder.path, "needle", { noIndex: true, ignoreComments: true });
			expect(result.files).toEqual([{ path: "app.ts", matches: [codeMatch(2, "const needle = 1;")] }]);
		} finally {
			folder.cleanup();
		}
	});

	it("preserves a missing source and never follows an escaping symlink", async () => {
		const root = createTempDir("quarterdeck-search-safe-");
		const outside = createTempDir("quarterdeck-search-outside-");
		try {
			writeFileSync(join(outside.path, "app.ts"), "// needle\n");
			symlinkSync(outside.path, join(root.path, "linked"), process.platform === "win32" ? "junction" : "dir");
			const keepLine = createTextSearchCommentFilter(
				root.path,
				"linked/app.ts\0" + "1\0// \u001b[31mneedle\u001b[m\nmissing.ts\0" + "1\0// \u001b[31mneedle\u001b[m\n",
			);
			expect(await keepLine("linked/app.ts", 1, "// needle")).toEqual({ keep: true });
			expect(await keepLine("missing.ts", 1, "// needle")).toEqual({ keep: true });
		} finally {
			root.cleanup();
			outside.cleanup();
		}
	});

	it.each([undefined, "HEAD"])("bounds aggregate classification at ref=%s without false truncation", async (ref) => {
		const files = Object.fromEntries(
			Array.from({ length: 11 }, (_, index) => [
				`app${index.toString().padStart(2, "0")}.ts`,
				`/* needle\n${" ".repeat(MAX_COMMENT_SOURCE_BYTES - 14)}\n */`,
			]),
		);
		await withFiles(files, async (cwd) => {
			const result = await searchWorkdirText(cwd, "needle", { ignoreComments: true, limit: 1, ref });
			expect(result.files.map((file) => file.path)).toEqual(["app10.ts"]);
			expect(result.files[0]?.matches[0]).not.toHaveProperty("ranges");
			expect(result.totalMatches).toBe(1);
			expect(result.truncated).toBe(false);
		});
	});

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
