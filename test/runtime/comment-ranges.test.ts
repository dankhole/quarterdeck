import { Buffer } from "node:buffer";
import { refractor } from "refractor/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCommentRanges, MAX_COMMENT_SOURCE_BYTES, overlapsComment } from "../../src/search/comment-ranges.js";

function commentText(path: string, source: string): string[] {
	const ranges = getCommentRanges(path, source);
	expect(ranges).not.toBeNull();
	return (ranges ?? []).map(({ from, to }) => source.slice(from, to));
}

afterEach(() => vi.restoreAllMocks());

describe("getCommentRanges", () => {
	it.each(["Example.java", "Example.cs", "script.csx"])(
		"finds inline, multiline and documentation comments in %s",
		(path) => {
			const source = [
				"/** docs mention Widget */",
				"class Widget {",
				'  string url = "https://example.test/#Widget/*literal*/"; // inline Widget',
				"  /* first Widget",
				"     second Widget */ int value;",
				"}",
			].join("\r\n");
			expect(commentText(path, source)).toEqual([
				"/** docs mention Widget */",
				"// inline Widget",
				"/* first Widget\r\n     second Widget */",
			]);
		},
	);

	it("preserves Java strings, characters and multiline text blocks", () => {
		const source = [
			'class Demo { String text = "\\"// not a comment /* #";',
			"char slash = '/';",
			'String block = """',
			"// not a comment",
			"/* neither is this */ #",
			'"""; /* real */ }',
		].join("\n");
		expect(commentText("Demo.java", source)).toEqual(["/* real */"]);
	});

	it("preserves C# regular, verbatim, interpolated strings and characters", () => {
		const source = [
			'String a = "\\"// literal /* #";',
			'String b = @"C:\\folder ""// literal',
			'/* literal */ #";',
			'String c = $"// literal {1 + 2}";',
			'String d = $@"/* literal */ {1 + 2}";',
			'String e = @$"// literal {1 + 2}";',
			"char slash = '/'; // real",
		].join("\n");
		expect(commentText("Demo.cs", source)).toEqual(["// real"]);
	});

	it("declines C# raw strings rather than misclassifying their content", () => {
		for (const prefix of ["", "$", "$$"]) {
			for (const path of ["Demo.cs", "script.csx"]) {
				expect(getCommentRanges(path, `var s = ${prefix}"""\n// literal\n/* literal */\n""";`)).toBeNull();
			}
		}
	});

	it("declines the known C# backslash/doubled-quote verbatim tokenizer ambiguity", () => {
		const source = 'var path = @"C:\\folder\\""// literal\n/* literal */";';
		expect(getCommentRanges("Demo.cs", source)).toBeNull();
	});

	it.each(["code.js", "code.mjs", "code.cjs", "code.ts", "code.mts", "code.cts"])(
		"preserves regex and template text while finding interpolation comments in %s",
		(path) => {
			const source = [
				'const url = "https://example.test/#literal";',
				"const pattern = /https?:\\/\\/[^#]+/;",
				`const template = \`// literal /* literal */ # \${1 /* real */ + 2}\`;`,
				"// final",
			].join("\n");
			expect(commentText(path, source)).toEqual(["/* real */", "// final"]);
		},
	);

	it.each(["view.jsx", "view.tsx"])("handles JSX text, attributes and expression comments in %s", (path) => {
		const source = '<div title="// literal">// literal /* literal */ # {value /* real */}</div>\n// final';
		expect(commentText(path, source)).toEqual(["/* real */", "// final"]);
	});

	it.each([
		["code.c", 'char *s = "// literal /* #"; /* real */'],
		["code.cpp", 'auto s = R"(// literal /* #)"; /* real */'],
		["code.h", 'char *s = "// literal /* #"; /* real */'],
		["code.py", 'text = """# literal // /*\n# literal"""\n# real'],
		["code.rb", 'text = "# literal // /*"\n# real'],
		["code.go", "text := `// literal /* #`\n/* real */"],
		["code.rs", 'let text = r#"// literal /* #"#; /* real */'],
		["query.sql", "SELECT '-- literal /* #', 'it''s -- literal'; /* real */"],
		["style.css", 'a { content: "/* literal */ // #"; } /* real */'],
		["page.html", '<div title="<!-- literal -->">&amp; &#x1f600;</div><!-- real -->'],
		["data.xml", '<a value="<!-- literal -->"><![CDATA[<!-- literal -->]]>&amp;</a><!-- real -->'],
		["data.yaml", 'value: "# literal // /*"\nblock: |\n  # literal\n# real'],
		["data.yml", 'value: "# literal // /*" # real'],
		["data.json", '{"value":"// literal /* #"} /* real */'],
		["data.jsonc", '{"value":"// literal /* #"} /* real */'],
	])("classifies the curated %s grammar without treating strings as comments", (path, source) => {
		const expected =
			path.endsWith(".html") || path.endsWith(".xml")
				? "<!-- real -->"
				: path.endsWith(".py") || path.endsWith(".rb") || path.endsWith(".yaml") || path.endsWith(".yml")
					? "# real"
					: "/* real */";
		expect(commentText(path, source)).toEqual([expected]);
	});

	it.each([
		["code.js", "if (ok) /[//]x/.test(text); const needle = 1;"],
		["code.py", 'text = f"{"# literal"}"; needle = 1'],
		["script.sh", "echo foo#needle; echo needle"],
		["data.yaml", "url: https://example.test/#needle"],
	])("fails open for known ambiguous tokenizer forms in %s", (path, source) => {
		// Callers must preserve all matches/references when classification is unknown.
		expect(getCommentRanges(path, source)).toBeNull();
	});

	it.each(["code.js", "code.ts", "view.jsx", "view.tsx"])(
		"declines ambiguous regex context in the complete JS family (%s)",
		(path) => expect(getCommentRanges(path, "if (ok) /[a/*]x/.test(text); const needle = 1;")).toBeNull(),
	);

	it("conservatively declines JS division before a comment rather than inferring regex context", () => {
		expect(getCommentRanges("code.js", "const n = 4 / 2; // real")).toBeNull();
		expect(commentText("code.js", "const n = 4 / 2;\n// real")).toEqual(["// real"]);
	});

	it.each(["\n", "\r\n", "\r", "\u2028", "\u2029"])(
		"resets the JS ambiguity guard across source line boundaries (%j)",
		(newline) => expect(commentText("code.js", `const n = 4 / 2;${newline}// real`)).toEqual(["// real"]),
	);

	it.each(["f", "F", "fr", "Fr", "rf", "rF"])(
		"declines Python %s-string syntax rather than relying on pre-3.12 quote rules",
		(prefix) => expect(getCommentRanges("code.py", `value = ${prefix}"text {value}" # real`)).toBeNull(),
	);

	it("retains useful common JS inline and full-line comment filtering", () => {
		const source = 'const pattern = /[//]x/; /* real */\nconst url = "https://x/#literal"; // real\n// final';
		expect(commentText("code.js", source)).toEqual(["/* real */", "// real", "// final"]);
	});

	it("applies regex ambiguity protection to embedded HTML JavaScript", () => {
		const source = "<script>if (ok) /[//]x/.test(text); const needle = 1;</script>";
		expect(getCommentRanges("page.html", source)).toBeNull();
	});

	it("declines JS inline comments after an unclassified JSX closing-tag slash", () => {
		expect(getCommentRanges("view.jsx", "const view = <div />; // real")).toBeNull();
	});

	it("finds nested Rust comments within the tokenizer's supported depth", () => {
		expect(commentText("code.rs", "a /* outer /* inner */ outer */ b")).toEqual(["/* outer /* inner */ outer */"]);
	});

	it("includes embedded HTML script and style comments but not XML script text", () => {
		const source = '<script>const x = "// literal"; /* js */</script><style>/* css */</style><!-- html -->';
		expect(commentText("page.html", source)).toEqual(["/* js */", "/* css */", "<!-- html -->"]);
		expect(commentText("data.xml", source)).toEqual(["<!-- html -->"]);
	});

	it("preserves UTF-16 offsets, CRLF, tabs, entities and source reconstruction", () => {
		const source = '\ufeffconst text = "😀 café // # /*";\r\n\t/* 😀\r\n e\u0301 */\r\nvalue(); // café';
		const block = "/* 😀\r\n e\u0301 */";
		const line = "// café";
		expect(getCommentRanges("/repo/code.TS", source)).toEqual([
			{ from: source.indexOf(block), to: source.indexOf(block) + block.length },
			{ from: source.indexOf(line), to: source.indexOf(line) + line.length },
		]);
		const markup = "😀 &amp; &#x1f600;\r\n<!-- café 😀 -->";
		expect(getCommentRanges("C:\\repo\\page.HTML", markup)).toEqual([
			{ from: markup.indexOf("<!--"), to: markup.length },
		]);
	});

	it.each(["code.ts", "Example.java", "Example.cs", "script.csx", "data.json", "data.xml"])(
		"returns [] for recognized comment-free or empty %s content",
		(path) => {
			expect(getCommentRanges(path, "")).toEqual([]);
			expect(getCommentRanges(path, '"// literal /* literal */ #"')).toEqual([]);
		},
	);

	it.each([
		"README.md",
		"plain.txt",
		"script",
		"Dockerfile",
		".js",
		"code.vue",
		"code.scss",
		"script.zsh",
		"script.sh",
		"script.bash",
		"code.ts.bak",
	])("does not guess a grammar for unsupported path %s", (path) =>
		expect(getCommentRanges(path, "// comment\n# comment\n/* comment */")).toBeNull(),
	);

	it("declines sources above the shared UTF-8 byte limit before tokenizing", () => {
		const highlight = vi.spyOn(refractor, "highlight");
		expect(getCommentRanges("large.ts", " ".repeat(MAX_COMMENT_SOURCE_BYTES + 1))).toBeNull();
		const unicode = "é".repeat(MAX_COMMENT_SOURCE_BYTES / 2 + 1);
		expect(unicode.length).toBeLessThan(MAX_COMMENT_SOURCE_BYTES);
		expect(Buffer.byteLength(unicode, "utf8")).toBeGreaterThan(MAX_COMMENT_SOURCE_BYTES);
		expect(getCommentRanges("large.ts", unicode)).toBeNull();
		expect(highlight).not.toHaveBeenCalled();
	});

	it("admits the exact shared byte limit", () => {
		const source = `//${"é".repeat((MAX_COMMENT_SOURCE_BYTES - 2) / 2)}`;
		expect(Buffer.byteLength(source, "utf8")).toBe(MAX_COMMENT_SOURCE_BYTES);
		expect(getCommentRanges("large.ts", source)).toEqual([{ from: 0, to: source.length }]);
	});

	it("returns unknown on tokenizer failures", () => {
		vi.spyOn(refractor, "highlight").mockImplementation(() => {
			throw new Error("tokenizer failed");
		});
		expect(getCommentRanges("code.ts", "// real")).toBeNull();
	});

	it("declines altered source instead of returning shifted offsets", () => {
		const highlight = vi.spyOn(refractor, "highlight");
		highlight.mockReturnValue({ type: "root", children: [{ type: "text", value: "changed" }] });
		expect(getCommentRanges("code.ts", "// real")).toBeNull();
		highlight.mockReturnValue({ type: "root", children: [{ type: "text", value: "//" }] });
		expect(getCommentRanges("code.ts", "// real")).toBeNull();
	});
});

describe("overlapsComment", () => {
	const ranges = [
		{ from: 5, to: 10 },
		{ from: 15, to: 20 },
	];

	it.each([
		[0, 5],
		[10, 15],
		[20, 25],
		[0, 0],
		[10, 10],
		[20, 20],
		[8, 7],
	])("excludes touching, outside or reversed [%s, %s)", (from, to) =>
		expect(overlapsComment(ranges, from, to)).toBe(false),
	);

	it.each([
		[0, 6],
		[9, 15],
		[10, 16],
		[5, 10],
		[0, 30],
		[5, 5],
		[9, 9],
		[15, 15],
		[19, 19],
	])("includes overlapping ranges and inside zero-width points [%s, %s)", (from, to) =>
		expect(overlapsComment(ranges, from, to)).toBe(true),
	);

	it("handles no comments and invalid offsets", () => {
		expect(overlapsComment([], 1, 2)).toBe(false);
		expect(overlapsComment(ranges, Number.NaN, 8)).toBe(false);
		expect(overlapsComment(ranges, 8, Number.POSITIVE_INFINITY)).toBe(false);
	});
});
