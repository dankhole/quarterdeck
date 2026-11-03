import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeNavigationLocation } from "../../../src/core/api/code-navigation";
import { filterReferenceComments } from "../../../src/language-navigation/reference-comments";
import { MAX_COMMENT_SOURCE_BYTES } from "../../../src/search/comment-ranges";
import * as workdirFiles from "../../../src/workdir/read-workdir-file";

function location(path: string, line: number, character = 0, length = 6): CodeNavigationLocation {
	return { path, range: { start: { line, character }, end: { line, character: character + length } } };
}

describe("reference comment filtering", () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "quarterdeck-reference-comments-"));
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(root, { recursive: true, force: true });
	});

	it("uses the unsaved source snapshot and preserves code and string occurrences", async () => {
		await writeFile(join(root, "source.ts"), "target;\ntarget;\ntarget;");
		const source = { path: "source.ts", content: '// target\nconst target = "// target";\n/*\ntarget\n*/' };
		const comments = [location(source.path, 0, 3), location(source.path, 3)];
		const code = location(source.path, 1, 6);
		const string = location(source.path, 1, 19);
		expect(await filterReferenceComments(root, [...comments, code, string], source)).toEqual([code, string]);
	});

	it("reads other files and handles multiline comments, CRLF and UTF16 columns", async () => {
		await writeFile(
			join(root, "Other.java"),
			'class Other {\r\n/* target\r\ntarget */\r\nString s = "😀"; target(); // target\r\n}',
		);
		const code = location("Other.java", 3, 17);
		const comments = [location("Other.java", 1, 3), location("Other.java", 2), location("Other.java", 3, 30)];
		expect(await filterReferenceComments(root, [...comments, code], { path: "source.ts", content: "" })).toEqual([
			code,
		]);
	});

	it.each([
		["source.js", "if (ok) /[//]x/.test(text); const needle = 1;"],
		["source.py", 'text = f"{"# literal"}"; needle = 1'],
		["source.sh", "echo foo#needle; echo needle"],
		["source.yaml", "url: https://example.test/#needle"],
	])("preserves references in ambiguous %s syntax", async (path, content) => {
		const reference = location(path, 0, content.lastIndexOf("needle"));
		expect(await filterReferenceComments(root, [reference], { path, content })).toEqual([reference]);
	});

	it("keeps unsupported, missing, invalid-range and oversized targets conservatively", async () => {
		await writeFile(join(root, "unknown.custom"), "// target");
		await writeFile(join(root, "large.ts"), `// target${" ".repeat(MAX_COMMENT_SOURCE_BYTES)}`);
		await writeFile(join(root, "binary.ts"), "\0// target");
		const locations = [
			location("unknown.custom", 0, 3),
			location("missing.ts", 0),
			location("large.ts", 0, 3),
			location("binary.ts", 0, 4),
			location("source.ts", 5),
			location("source.ts", 0, 100),
		];
		expect(await filterReferenceComments(root, locations, { path: "source.ts", content: "// target" })).toEqual(
			locations,
		);
	});

	it("preserves remaining results when the aggregate classification budget is exhausted", async () => {
		const content = "// target".padEnd(MAX_COMMENT_SOURCE_BYTES, " ");
		const locations: CodeNavigationLocation[] = [];
		for (let index = 0; index < 11; index++) {
			const path = `${index}.ts`;
			await writeFile(join(root, path), content);
			locations.push(location(path, 0, 3));
		}
		expect(await filterReferenceComments(root, locations, { path: "source.ts", content: "" })).toEqual([
			locations[10],
		]);
	});

	it("charges failed or growing-file reads against the aggregate budget", async () => {
		const locations: CodeNavigationLocation[] = [];
		for (let index = 0; index < 20; index++) {
			const path = `${index}.ts`;
			await writeFile(join(root, path), "target");
			locations.push(location(path, 0));
		}
		const read = vi
			.spyOn(workdirFiles, "readWorkdirFileHandle")
			.mockRejectedValue(new Error("File grew beyond read limit"));
		expect(await filterReferenceComments(root, locations, { path: "source.ts", content: "" })).toEqual(locations);
		expect(read).toHaveBeenCalledTimes(10);
	});

	it("does not read through an escaped symlink", async () => {
		const outside = await mkdtemp(join(tmpdir(), "quarterdeck-reference-outside-"));
		try {
			await writeFile(join(outside, "secret.ts"), "// target");
			await symlink(join(outside, "secret.ts"), join(root, "link.ts"));
			const reference = location("link.ts", 0, 3);
			expect(await filterReferenceComments(root, [reference], { path: "source.ts", content: "" })).toEqual([
				reference,
			]);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
});
