// @vitest-environment node

import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { languageExtension, loadSourceLanguage, resolveSourceLanguage } from "./source-language-registry";

afterEach(() => vi.restoreAllMocks());

describe("source language registry", () => {
	it.each([
		["", "main.go", "Go"],
		["", "lib/example.rb", "Ruby"],
		["", "scripts/start.sh", "Shell"],
		["", "config.YAML", "YAML"],
		["", "guide.MDX", "Markdown"],
		["", "scripts/start.ZSH", "Shell"],
		["", "index.php", "PHP"],
		["", "Example.CS", "C#"],
		["", "source.d.ts", "TypeScript"],
		["", "source.MTS", "TypeScript"],
		["", "source.cjs", "JavaScript"],
		["", "source.rs", "Rust"],
		["", "C:\\repo\\Dockerfile", "Dockerfile"],
		["", "repo/dockerfile", "Dockerfile"],
		["", "C:\\repo\\CMakeLists.txt", "CMake"],
		["", "project/toolchain.CMAKE.IN", "CMake"],
		["", "Gemfile", "Ruby"],
		["", "images/icon.SVG", "XML"],
		["Go", "example.cs", "Go"],
		["RUBY", "example.rs", "Ruby"],
		["rs", "example.rb", "Rust"],
		["Cs", "example.ts", "C#"],
		["C#", "example.ts", "C#"],
		["CSharp", "example.ts", "C#"],
		["markup", "example.cs", "HTML"],
		[" md ", "example.cs", "Markdown"],
		["py", "example.cs", "Python"],
		["TS", "example.cs", "TypeScript"],
		["js", "example.cs", "JavaScript"],
		["tsx", "example.cs", "TSX"],
		["jsx", "example.cs", "JSX"],
		["bash", "example.cs", "Shell"],
		["unknown", "example.go", "Go"],
		["not-ruby", "example.rs", "Rust"],
		["not-javascript", "example.php", "PHP"],
	])("resolves %s / %s to %s", (hint, path, expected) => {
		expect(resolveSourceLanguage(hint, path)?.name).toBe(expected);
	});

	it.each([
		["", "Makefile"], // Not provided by the maintained catalog; do not guess CMake or Shell.
		["unknown", "README.unknown"],
		["not-javascript", "README"],
		["", "folder.go/README"],
		["", ""],
	])("leaves unsupported %s / %s as plain text", async (hint, path) => {
		expect(resolveSourceLanguage(hint, path)).toBeNull();
		expect(languageExtension(hint, path)).toBeNull();
		expect(await loadSourceLanguage(hint, path)).toBeNull();
	});

	it.each([
		"c#",
		"typescript",
		"tsx",
		"javascript",
		"jsx",
		"markdown",
		"python",
		"java",
		"c",
		"cpp",
		"css",
		"html",
		"json",
		"rust",
		"sql",
	])("retains synchronous %s support across subsequent loads", async (hint) => {
		const support = languageExtension(hint, "");
		expect(support).not.toBeNull();
		expect(await loadSourceLanguage(hint, "")).toBe(support);
		expect(languageExtension(hint, "")).toBe(support);
	});

	it("resolves metadata and reads support without initiating loads", () => {
		const description = resolveSourceLanguage("", "Dockerfile");
		if (!description) throw new Error("Dockerfile must be catalogued");
		const load = vi.spyOn(description, "load");
		expect(resolveSourceLanguage("dockerfile", "")).toBe(description);
		expect(languageExtension("", "Dockerfile")).toBeNull();
		expect(load).not.toHaveBeenCalled();
	});

	it("uses SDK load deduplication and exposes successfully loaded support synchronously", async () => {
		const description = resolveSourceLanguage("ruby", "");
		if (!description) throw new Error("Ruby must be catalogued");
		expect(description.load()).toBe(description.load());
		const [first, second] = await Promise.all([loadSourceLanguage("rb", ""), loadSourceLanguage("", "lib/a.rb")]);
		expect(first).not.toBeNull();
		expect(second).toBe(first);
		expect(languageExtension("ruby", "")).toBe(first);
		expect(await description.load()).toBe(first);
	});

	it("propagates load failures without manufacturing support", async () => {
		const description = resolveSourceLanguage("dockerfile", "");
		if (!description) throw new Error("Dockerfile must be catalogued");
		const failure = new Error("chunk unavailable");
		const load = vi.spyOn(description, "load").mockRejectedValueOnce(failure);
		await expect(loadSourceLanguage("", "Dockerfile")).rejects.toBe(failure);
		load.mockImplementationOnce(() => {
			throw failure;
		});
		await expect(loadSourceLanguage("", "Dockerfile")).rejects.toBe(failure);
		expect(languageExtension("", "Dockerfile")).toBeNull();
	});

	it.each([
		["main.go", "package main\nfunc main() {}"],
		["main.rb", 'class Example\n  puts "hello"\nend'],
		["start.sh", 'if true; then echo "hello"; fi'],
		["config.yaml", "items:\n  - hello"],
		["index.php", '<?php echo "hello"; ?>'],
		["Example.cs", 'public class Example { string Name = "hello"; }'],
		["main.ts", 'const message: string = "hello";'],
		["main.js", 'const message = "hello";'],
	])("loads an actual parser for %s", async (path, source) => {
		const support = await loadSourceLanguage("", path);
		if (!support) throw new Error(`Missing support for ${path}`);
		const state = EditorState.create({ doc: source, extensions: support });
		const tree = ensureSyntaxTree(state, source.length, 1_000);
		expect(tree?.length).toBe(source.length);
		expect(tree?.topNode.firstChild).not.toBeNull();
	});
});
