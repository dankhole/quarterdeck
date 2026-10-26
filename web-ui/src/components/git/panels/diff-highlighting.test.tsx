import { LanguageDescription, type LanguageSupport } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as languageRegistry from "@/components/editor/source-language-registry";
import { quarterdeckHighlightStyle } from "@/components/editor/source-presentation";
import { parsePatchToRows, ReadOnlyUnifiedDiff } from "@/components/shared/diff-renderer";
import { SplitDiff } from "./diff-split";
import { UnifiedDiff } from "./diff-unified";

const fixtures = [
	{ path: "main.go", source: 'var message = "<script>"' },
	{ path: "main.rb", source: 'return "<script>"' },
	{ path: "config.yaml", source: 'message: "<script>"' },
	{ path: "script.sh", source: 'echo "<script>"' },
] as const;
const supports = new Map<string, LanguageSupport>();

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

beforeAll(async () => {
	for (const { path } of fixtures) {
		const support = await languageRegistry.loadSourceLanguage("", path);
		if (!support) throw new Error(`Missing catalog grammar for ${path}`);
		supports.set(path, support);
	}
});

describe.each(["unified", "split", "patch"] as const)("%s lazy review highlighting", (view) => {
	let container: HTMLDivElement;
	let root: Root;
	const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
		environment.IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
		environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
	});

	async function render(path: string, source: string) {
		await act(async () => {
			if (view === "patch") {
				// Deliberately partial, offset patch: grammar readiness must not convert
				// these fragments into a full file or change their line numbers.
				const rows = parsePatchToRows(`@@ -40,2 +70,2 @@\n ${source}\n-1\n+2\n`);
				root.render(<ReadOnlyUnifiedDiff path={path} rows={rows} />);
			} else {
				const Renderer = view === "split" ? SplitDiff : UnifiedDiff;
				root.render(
					<Renderer
						path={path}
						oldText={`${source}\n1`}
						newText={`${source}\n2`}
						comments={new Map()}
						onAddComment={() => {}}
						onUpdateComment={() => {}}
						onDeleteComment={() => {}}
					/>,
				);
			}
		});
	}

	function mockPendingLanguages(paths: readonly string[]) {
		const pending = new Map(paths.map((path) => [path, deferred<LanguageSupport>()]));
		const descriptions = new Map(
			paths.map((path) => [path, LanguageDescription.of({ name: path, load: () => pending.get(path)!.promise })]),
		);
		// Keep the real shared hook and its effects. Only grammar delivery is
		// controlled, so these tests detect stale hook results and stale row caches.
		const resolve = vi
			.spyOn(languageRegistry, "resolveSourceLanguage")
			.mockImplementation((_language, path) => descriptions.get(path) ?? null);
		return { pending, resolve };
	}

	function expectEditorStrings() {
		const stringClass = quarterdeckHighlightStyle.style([tags.string]);
		expect(stringClass).not.toBeNull();
		expect(
			[...container.querySelectorAll(".kb-diff-text span")].some((span) => span.classList.contains(stringClass!)),
		).toBe(true);
		expect(container.querySelector(".kb-diff-text .token")).toBeNull();
		expect(container.querySelector("script")).toBeNull();
	}

	it.each(fixtures)(
		"recolors already-visible $path rows and inline segments on readiness",
		async ({ path, source }) => {
			const { pending, resolve } = mockPendingLanguages([path]);
			await render(path, source);
			expect(resolve).toHaveBeenCalledWith("", path);
			expect(container.querySelector(".kb-diff-text .token.string")).not.toBeNull();
			const rows = [...container.querySelectorAll(".kb-diff-row")];
			const text = container.textContent;
			await act(async () => pending.get(path)!.resolve(supports.get(path)!));
			expectEditorStrings();
			expect(container.textContent).toBe(text);
			expect([...container.querySelectorAll(".kb-diff-row")]).toEqual(rows);
			if (view === "patch") expect(container.querySelector(".kb-diff-line-number-text")?.textContent).toBe("70");
			if (path === "main.go") {
				const numberClass = quarterdeckHighlightStyle.style([tags.number]);
				const segment = container.querySelector(".kb-diff-segment-added");
				expect(segment?.textContent).toBe("2");
				expect(segment?.querySelector("span")?.classList.contains(numberClass!)).toBe(true);
			}
		},
	);

	it("retains Prism after a grammar load failure and plain text for an unknown path", async () => {
		const fixture = fixtures[0];
		const { pending } = mockPendingLanguages([fixture.path]);
		await render(fixture.path, fixture.source);
		await act(async () => pending.get(fixture.path)!.reject(new Error("synthetic grammar load failure")));
		expect(container.querySelector(".kb-diff-text .token.string")).not.toBeNull();
		await render("unknown.extension", '<script> & "plain"');
		expect(container.querySelector(".kb-diff-text")?.querySelector("span")).toBeNull();
		expect(container.textContent).toContain('<script> & "plain"');
		expect(container.querySelector("script")).toBeNull();
	});

	it("does not apply a late grammar after switching files", async () => {
		const [go, ruby] = fixtures;
		const { pending, resolve } = mockPendingLanguages([go.path, ruby.path]);
		await render(go.path, go.source);
		await render(ruby.path, ruby.source);
		expect(resolve).toHaveBeenLastCalledWith("", ruby.path);
		expect(container.textContent).not.toContain("var message");
		await act(async () => pending.get(go.path)!.resolve(supports.get(go.path)!));
		expect(container.querySelector(".kb-diff-text .token.string")).not.toBeNull();
		await act(async () => pending.get(ruby.path)!.resolve(supports.get(ruby.path)!));
		expectEditorStrings();
	});
});
