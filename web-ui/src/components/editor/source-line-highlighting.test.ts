// @vitest-environment node

import { LanguageSupport, StreamLanguage } from "@codemirror/language";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { type Tag, tags } from "@lezer/highlight";
import { describe, expect, it, vi } from "vitest";
import { MAX_SYNC_HIGHLIGHT_LINE_LENGTH } from "@/components/shared/syntax-highlighting";
import { loadSourceLanguage, resolveSourceLanguage } from "./source-language-registry";
import { createSourceLineCache } from "./source-line-highlighting";
import { quarterdeckHighlightStyle } from "./source-presentation";

function expectEditorToken(html: string | null, text: string, tag: Tag): void {
	const expectedClass = quarterdeckHighlightStyle.style([tag]);
	expect(expectedClass).not.toBeNull();
	const spans = [...(html ?? "").matchAll(/<span class="([^"]+)">([^<]*)<\/span>/g)];
	expect(
		spans.some(
			([, classes, content]) => classes?.split(" ").includes(expectedClass ?? "") && content?.includes(text),
		),
		`${JSON.stringify(text)} should use the editor's token category`,
	).toBe(true);
}

describe("editor highlighting in review rows", () => {
	it("escapes source text while using editor token classes", () => {
		const html = createSourceLineCache("file.ts").get('const value = "<script>";');
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
		expect(html).toContain('class="');
	});
	it.each(["Example.cs", "models/Example.CS"])("uses the editor palette for C# review rows in %s", (path) => {
		const html = createSourceLineCache(path).get('public string Name { get; init; } = "demo"; // note');
		expectEditorToken(html, "public", tags.keyword);
		expectEditorToken(html, "&quot;demo&quot;", tags.string);
		expectEditorToken(html, "// note", tags.comment);
		expect(html).not.toContain('class="token ');
	});

	it("highlights C# character and number literals with the editor palette", () => {
		const cache = createSourceLineCache("Example.cs");
		expectEditorToken(cache.get("public char Separator { get; init; } = '|';"), "'|'", tags.character);
		expectEditorToken(cache.get("public int Retries { get; init; } = 3;"), "3", tags.number);
	});

	it("escapes HTML metacharacters in C# strings and comments", () => {
		const html = createSourceLineCache("Example.cs").get(
			'var value = "<script>&"; // <img src=x onerror="alert(1)"> & text',
		);
		expect(html).toContain("&lt;script&gt;&amp;");
		expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; text");
		expect(html).not.toMatch(/<(?:script|img)\b/);
		expectEditorToken(html, "// &lt;img", tags.comment);
	});

	it("reuses C# lines and clears the per-file cache", () => {
		const cache = createSourceLineCache("Example.cs");
		const line = "public int Count = 42;";
		expect(cache.size).toBe(0);
		const first = cache.get(line);
		expectEditorToken(first, "42", tags.number);
		expect(cache.size).toBe(1);
		expect(cache.get(line)).toBe(first);
		expect(cache.size).toBe(1);
		cache.get("// another row");
		expect(cache.size).toBe(2);
		cache.clear();
		expect(cache.size).toBe(0);
		expect(cache.get(line)).toBe(first);
		expect(cache.size).toBe(1);
	});

	it("keeps empty C# rows empty and bounds synchronous highlighting", () => {
		const cache = createSourceLineCache("Example.cs");
		expect(cache.get("")).toBe("");
		const boundedLine = `//${"x".repeat(MAX_SYNC_HIGHLIGHT_LINE_LENGTH - 2)}`;
		expect(cache.get(boundedLine)).not.toBeNull();
		const cachedCount = cache.size;
		expect(cache.get(`${boundedLine}x`)).toBeNull();
		expect(cache.size).toBe(cachedCount);
	});

	it("keeps the editor palette through the C# stream parser's supported line length", () => {
		const tail = " public int Count = 42;";
		const line = `/*${"x".repeat(10_000 - tail.length - 4)}*/${tail}`;
		expect(line.length).toBe(10_000);
		expectEditorToken(createSourceLineCache("Example.cs").get(line), "42", tags.number);
	});

	it.each([10_001, MAX_SYNC_HIGHLIGHT_LINE_LENGTH])(
		"uses the Prism fallback for a C# tail token on a %i-character line",
		(length) => {
			const tail = " public int Count = 42;";
			const line = `/*${"x".repeat(length - tail.length - 4)}*/${tail}`;
			expect(line.length).toBe(length);
			const html = createSourceLineCache("Example.cs").get(line);
			expect(html).toContain('<span class="token number">42</span>');
		},
	);

	it("retains Prism while support is unavailable and unknown-language fallback", () => {
		const shell = createSourceLineCache("file.sh", null);
		expect(shell.get('echo "hello"')).toContain('class="token string"');
		expect(createSourceLineCache("file.unknown").get('<script> & "text"')).toBeNull();
		expect(createSourceLineCache("file.ts").get("x".repeat(MAX_SYNC_HIGHLIGHT_LINE_LENGTH + 1))).toBeNull();
	});

	it.each([
		["main.go", 'var message = "hello"', "var", tags.keyword],
		["main.rb", 'return "hello"', "return", tags.keyword],
		["config.yaml", 'message: "hello"', "&quot;hello&quot;", tags.string],
		["script.sh", 'echo "hello"', "&quot;hello&quot;", tags.string],
	] as const)(
		"uses the lazy catalog grammar for %s and keeps synchronous warm lookup",
		async (path, source, token, tag) => {
			const fallback = createSourceLineCache(path, null).get(source);
			expect(fallback).toContain('class="token ');
			const support = await loadSourceLanguage("", path);
			expect(support).not.toBeNull();
			const cache = createSourceLineCache(path, support);
			expectEditorToken(cache.get(source), token, tag);
			expect(cache.get(source)).not.toContain('class="token ');
			expect(createSourceLineCache(path).get(source)).toBe(cache.get(source));
			// A caller waiting on its effect must not accidentally consume newly warm global support.
			expect(createSourceLineCache(path, null).get(source)).toBe(fallback);
		},
	);

	it.each([10_001, MAX_SYNC_HIGHLIGHT_LINE_LENGTH])(
		"uses Prism beyond the stream limit for Ruby as well as C# (%i characters)",
		async (length) => {
			const support = await loadSourceLanguage("", "main.rb");
			expect(support?.language).toBeInstanceOf(StreamLanguage);
			const tail = " ; return 42";
			const line = `"${"x".repeat(length - tail.length - 2)}"${tail}`;
			expect(line).toHaveLength(length);
			expect(createSourceLineCache("main.rb", support).get(line)).toContain('<span class="token number">42</span>');
		},
	);

	it.each([
		["file.ts", `${"const n = 1; ".repeat(1_300)}const tail = "done";`, "&quot;done&quot;", tags.string],
		["file.xml", `${"<item>text</item>".repeat(875)}<tail>done</tail>`, "tail", tags.tagName],
	] as const)(
		"finishes bounded LR fragments in %s beyond the initial parser viewport",
		async (path, source, token, tag) => {
			expect(source.length).toBeGreaterThan(10_000);
			expect(source.length).toBeLessThanOrEqual(MAX_SYNC_HIGHLIGHT_LINE_LENGTH);
			const support = await loadSourceLanguage("", path);
			// Exercise completion independently of workstation load. CodeMirror's
			// initial parse still stops at its 3k viewport with a frozen clock, so
			// these tail assertions continue to catch using only that partial tree.
			const clock = vi.spyOn(Date, "now").mockReturnValue(0);
			try {
				const html = createSourceLineCache(path, support).get(source);
				expectEditorToken(html, token, tag);
				expect(html).not.toContain('class="token ');
			} finally {
				clock.mockRestore();
			}
		},
	);

	it("uses Prism or plain text, not an incomplete tree, when the parse budget expires", async () => {
		const support = await loadSourceLanguage("", "file.ts");
		const source = `${"const n = 1; ".repeat(1_300)}const tail = "<script>";`;
		// CodeMirror checks Date.now for its finite work budget. Advance the
		// clock between checks without replacing the real parser or tree API.
		let now = 0;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 100));
		try {
			const html = createSourceLineCache("file.ts", support).get(source);
			expect(html?.slice(-150)).toContain('<span class="token string">"&lt;script>"</span>');
			expect(html).not.toContain("<script>");
			expect(createSourceLineCache("file.unknown", support).get(source)).toBeNull();
		} finally {
			clock.mockRestore();
		}
	});

	it.each([
		["build/Dockerfile", "Dockerfile"],
		["styles/main.scss", "SCSS"],
	])("uses catalog filename metadata rather than the coarse Prism hint for %s", async (path, name) => {
		expect(resolveSourceLanguage("", path)?.name).toBe(name);
		const support = await loadSourceLanguage("", path);
		expect(support).not.toBeNull();
		expect(createSourceLineCache(path).get("/* fragment */")).toBe(
			createSourceLineCache(path, support).get("/* fragment */"),
		);
	});

	it("uses plain text rather than truncated stream colors when no Prism grammar exists", () => {
		const support = new LanguageSupport(StreamLanguage.define(ruby));
		const cache = createSourceLineCache("fragment.unknown", support);
		expectEditorToken(cache.get("return 42"), "return", tags.keyword);
		const line = `# ${"x".repeat(10_001)}`;
		expect(cache.get(line)).toBeNull();
		const count = cache.size;
		expect(cache.get(line)).toBeNull();
		expect(cache.size).toBe(count);
		cache.clear();
		expect(cache.size).toBe(0);
	});
});
