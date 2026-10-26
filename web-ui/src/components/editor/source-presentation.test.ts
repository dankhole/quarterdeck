// @vitest-environment node

import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { highlightTree, type Tag, tags } from "@lezer/highlight";
import { describe, expect, it } from "vitest";
import { languageExtension, quarterdeckHighlightStyle } from "./source-presentation";

interface HighlightedSpan {
	from: number;
	to: number;
	classes: string;
}

function highlightDocument(source: string, language: string, path: string): HighlightedSpan[] {
	const extension = languageExtension(language, path);
	expect(extension).not.toBeNull();
	if (!extension) throw new Error(`No language support for ${language} (${path})`);
	const state = EditorState.create({ doc: source, extensions: extension });
	const tree = ensureSyntaxTree(state, state.doc.length, 1_000);
	expect(tree, "the complete document should parse synchronously").not.toBeNull();
	if (!tree) throw new Error("The document did not finish parsing");
	const spans: HighlightedSpan[] = [];
	highlightTree(tree, quarterdeckHighlightStyle, (from, to, classes) => spans.push({ from, to, classes }));
	return spans;
}

function expectCategory(source: string, spans: HighlightedSpan[], text: string, tag: Tag, searchFrom = 0): void {
	const from = source.indexOf(text, searchFrom);
	expect(from, `${text} must occur in the fixture`).toBeGreaterThanOrEqual(0);
	const expectedClass = quarterdeckHighlightStyle.style([tag]);
	expect(expectedClass).not.toBeNull();
	const span = spans.find((candidate) => candidate.from <= from && candidate.to >= from + text.length);
	expect(span, `${JSON.stringify(text)} must have its own expected token category`).toBeDefined();
	expect(span?.classes.split(" ")).toContain(expectedClass);
}

describe("source language presentation", () => {
	it.each(["cs", "csharp", "c#", "CS", "CSharp", "C#"])("highlights C# through the %s alias", (language) => {
		const source = 'public class Example { string Name = "hello"; int Count = 42; } // note';
		const spans = highlightDocument(source, language, "example.txt");
		expectCategory(source, spans, "public", tags.keyword);
		expectCategory(source, spans, "class", tags.keyword);
		expectCategory(source, spans, '"hello"', tags.string);
		expectCategory(source, spans, "42", tags.number);
		expectCategory(source, spans, "// note", tags.comment);
	});

	it.each([
		["", "models/Example.cs"],
		["", "models/Example.CS"],
		["unknown", "models/Example.cs"],
	])("falls back to %s / %s when the hint is not supported", (language, path) => {
		const source = "public class Example { }";
		expectCategory(source, highlightDocument(source, language, path), "public", tags.keyword);
	});

	it("preserves a recognized TypeScript hint over a .cs extension", () => {
		const source = "const item: number = 42;";
		const spans = highlightDocument(source, "typescript", "Example.cs");
		expectCategory(source, spans, "const", tags.keyword);
		expectCategory(source, spans, "number", tags.typeName);
	});

	it("preserves a recognized markup hint over a .cs extension", () => {
		const source = '<section title="demo">hello</section>';
		const spans = highlightDocument(source, "markup", "Example.cs");
		expectCategory(source, spans, "section", tags.tagName);
		expectCategory(source, spans, "title", tags.attributeName);
	});

	it("highlights literals and declarations in a nullable generic record with init accessors", () => {
		const source = [
			"public sealed record TaskDefinition",
			"{",
			'    public required string? Name { get; init; } = "demo";',
			"    public List<string> Arguments { get; init; } = new();",
			"    public char Separator { get; init; } = '|';",
			"    public int Retries { get; init; } = 3;",
			"    // Keep nullable and generic declarations readable.",
			"}",
		].join("\n");
		const spans = highlightDocument(source, "csharp", "TaskDefinition.cs");
		expectCategory(source, spans, "public", tags.keyword);
		expectCategory(source, spans, "sealed", tags.keyword);
		expectCategory(source, spans, "record", tags.keyword);
		expectCategory(source, spans, "required", tags.keyword);
		expectCategory(source, spans, "init", tags.keyword, source.indexOf("get; init"));
		expectCategory(source, spans, '"demo"', tags.string);
		expectCategory(source, spans, "'|'", tags.character);
		expectCategory(source, spans, "3", tags.number);
		expectCategory(source, spans, "// Keep nullable and generic declarations readable.", tags.comment);
	});

	it("retains full-document state through multiline comments and verbatim strings", () => {
		const source = [
			"/* opening comment",
			"public class NotCode { int Count = 42; }",
			"closing comment */",
			"public class Example {",
			'    string Text = @"opening string',
			"public class AlsoNotCode { }",
			'closing string";',
			"    int Count = 7;",
			"}",
		].join("\n");
		const spans = highlightDocument(source, "csharp", "Example.cs");
		expectCategory(source, spans, "public class NotCode", tags.comment);
		expectCategory(source, spans, "closing comment", tags.comment);
		expectCategory(source, spans, "public", tags.keyword, source.indexOf("public class Example"));
		expectCategory(source, spans, "public class AlsoNotCode", tags.string);
		expectCategory(source, spans, "closing string", tags.string);
		expectCategory(source, spans, "7", tags.number);
	});

	it.each([
		["typescript", "example.ts", 'const value: string = "hello"; // note', "const"],
		["python", "example.py", 'return "hello" # note', "return"],
		["java", "Example.java", 'public class Example { String value = "hello"; } // note', "public"],
	])("preserves %s highlighting", (language, path, source, keyword) => {
		const spans = highlightDocument(source, language, path);
		expectCategory(source, spans, keyword, tags.keyword);
		expectCategory(source, spans, '"hello"', tags.string);
	});

	it("retains the null result for unknown languages", () => {
		expect(languageExtension("unknown", "file.unknown")).toBeNull();
	});
});
