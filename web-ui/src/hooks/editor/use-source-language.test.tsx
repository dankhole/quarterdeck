import { LanguageDescription, LanguageSupport, StreamLanguage } from "@codemirror/language";
import { act, StrictMode, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSourceLanguage } from "@/components/editor/source-language-registry";
import { useSourceLanguage } from "./use-source-language";

vi.mock("@/components/editor/source-language-registry", () => ({ resolveSourceLanguage: vi.fn() }));

function deferredSupport(name: string) {
	let resolve!: (support: LanguageSupport) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<LanguageSupport>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	const load = vi.fn(() => promise);
	return { description: LanguageDescription.of({ name, load }), load, resolve, reject };
}

function support() {
	return new LanguageSupport(
		StreamLanguage.define({
			token: (stream) => {
				stream.skipToEnd();
				return null;
			},
		}),
	);
}

describe("useSourceLanguage", () => {
	let root: Root;
	let container: HTMLDivElement;
	let current: LanguageSupport | null;
	let renders: Array<LanguageSupport | null>;
	let previousActEnvironment: boolean | undefined;
	const descriptions = new Map<string, LanguageDescription>();

	function Harness({ language = "", path = "" }: { language?: string; path?: string }) {
		current = useSourceLanguage(language, path);
		renders.push(current);
		return null;
	}
	async function render(language = "", path = "", strict = false) {
		await act(async () => {
			root.render(
				strict ? (
					<StrictMode>
						<Harness language={language} path={path} />
					</StrictMode>
				) : (
					<Harness language={language} path={path} />
				),
			);
		});
	}

	beforeEach(() => {
		previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		renders = [];
		descriptions.clear();
		vi.mocked(resolveSourceLanguage).mockImplementation(
			(language, path) => descriptions.get(language || path) ?? null,
		);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.clearAllMocks();
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
	});

	it("does not start grammar loading during render", () => {
		const pending = deferredSupport("Go");
		descriptions.set("go", pending.description);
		renderToString(<Harness language="go" />);
		expect(pending.load).not.toHaveBeenCalled();
		expect(current).toBeNull();
	});

	it("returns preloaded support synchronously without loading", async () => {
		const available = support();
		const description = LanguageDescription.of({ name: "C#", support: available });
		const load = vi.spyOn(description, "load");
		descriptions.set("cs", description);
		await render("cs");
		expect(renders).toEqual([available]);
		expect(load).not.toHaveBeenCalled();
	});

	it("settles support warmed after render but before the passive effect", async () => {
		const pending = deferredSupport("Go");
		const available = support();
		descriptions.set("go", pending.description);
		function WarmDuringCommit() {
			current = useSourceLanguage("go", "main.go");
			renders.push(current);
			useLayoutEffect(() => {
				// Simulate another consumer completing the SDK cache during commit.
				pending.description.support = available;
				pending.resolve(available);
			}, []);
			return null;
		}
		await act(async () => root.render(<WarmDuringCommit />));
		expect(renders[0]).toBeNull();
		expect(current).toBe(available);
	});

	it("loads in effects and uses upstream deduplication during StrictMode replay", async () => {
		const pending = deferredSupport("Go");
		descriptions.set("go", pending.description);
		await render("go", "", true);
		expect(current).toBeNull();
		expect(pending.load).toHaveBeenCalledTimes(1);
		const available = support();
		await act(async () => pending.resolve(available));
		expect(current).toBe(available);
	});

	it("never presents the previous grammar when a path selects a pending language", async () => {
		const first = deferredSupport("Ruby");
		const second = deferredSupport("Go");
		descriptions.set("example.rb", first.description);
		descriptions.set("example.go", second.description);
		await render("", "example.rb");
		const ruby = support();
		await act(async () => first.resolve(ruby));
		expect(current).toBe(ruby);
		renders = [];
		await render("", "example.go");
		expect(renders).toEqual([null]);
		const go = support();
		await act(async () => second.resolve(go));
		expect(current).toBe(go);
		await render("unknown");
		expect(current).toBeNull();
	});

	it("ignores stale completions after an explicit hint changes", async () => {
		const first = deferredSupport("Ruby");
		const second = deferredSupport("Go");
		descriptions.set("ruby", first.description);
		descriptions.set("go", second.description);
		await render("ruby", "example.rb");
		await render("go", "example.rb");
		const count = renders.length;
		await act(async () => first.resolve(support()));
		expect(renders).toHaveLength(count);
		expect(current).toBeNull();
		const available = support();
		await act(async () => second.resolve(available));
		expect(current).toBe(available);
	});

	it("ignores completions after unmount", async () => {
		const pending = deferredSupport("Go");
		descriptions.set("go", pending.description);
		await render("go");
		await act(async () => root.render(null));
		const count = renders.length;
		await act(async () => pending.resolve(support()));
		expect(renders).toHaveLength(count);
	});

	it("catches synchronous loader throws without render-driven retries", async () => {
		const pending = deferredSupport("Go");
		pending.load.mockImplementation(() => {
			throw new Error("synchronous loader failure");
		});
		descriptions.set("go", pending.description);
		await render("go");
		await render("go", "another.go");
		expect(current).toBeNull();
		expect(pending.load).toHaveBeenCalledTimes(1);
	});

	it("catches load failures and does not retry on same-language rerenders", async () => {
		const pending = deferredSupport("Go");
		descriptions.set("go", pending.description);
		descriptions.set("example.go", pending.description);
		await render("go");
		await act(async () => pending.reject(new Error("chunk unavailable")));
		await render("go", "another.go");
		await render("", "example.go");
		expect(current).toBeNull();
		expect(pending.load).toHaveBeenCalledTimes(1);
	});
});
