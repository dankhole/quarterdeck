import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMacPlatform } from "@/utils/platform";
import { DiffViewerPanel } from "./diff-viewer-panel";

const { definition, readFile, openContext, hotkeys } = vi.hoisted(() => ({
	definition: vi.fn(),
	readFile: vi.fn(),
	openContext: vi.fn(),
	hotkeys: vi.fn(),
}));
vi.mock("react-hotkeys-hook", () => ({ useHotkeys: hotkeys }));
vi.mock("@/components/editor/source-editor", () => ({
	SourceEditor: ({ value, readOnly }: { value: string; readOnly: boolean }) => (
		<pre data-read-only={readOnly}>{value}</pre>
	),
}));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		project: { codeNavigation: { definition: { mutate: definition } }, getFileContent: { query: readFile } },
	}),
}));
vi.mock("@/providers/task-agent-context-provider", () => ({ useTaskAgentContext: () => ({ openContext }) }));

const location = { path: "target.ts", range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } } };

describe("Compare code navigation wiring", () => {
	let root: Root;
	let container: HTMLDivElement;
	let priorAct: boolean | undefined;
	const navigateToFile = vi.fn();
	const onCommentsChange = vi.fn();
	beforeEach(() => {
		priorAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		// Give the occurrence highlighter a real glyph hit so it replaces syntax spans
		// during click capture, before the navigation wrapper handles the bubble.
		Object.defineProperty(Range.prototype, "getClientRects", {
			configurable: true,
			value: () => [{ left: 0, right: 100, top: 0, bottom: 100 }],
		});
		definition.mockReset();
		readFile.mockReset();
		readFile.mockResolvedValue({ content: "const preview = 1;", binary: false, truncated: false });
		navigateToFile.mockReset();
		onCommentsChange.mockReset();
		openContext.mockReset();
		hotkeys.mockReset();
		definition.mockImplementation(async (input) => ({
			status: "ok",
			documentVersion: input.documentVersion,
			locations: [location],
			truncated: false,
		}));
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
		Reflect.deleteProperty(Range.prototype, "getClientRects");
		delete (document as Partial<Document>).caretPositionFromPoint;
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = priorAct;
	});
	async function render(
		viewMode: "split" | "unified",
		readOnlyReview = false,
		head = "WORKTREE",
		headSource: "live-worktree" | "revision" = "live-worktree",
	) {
		await act(async () =>
			root.render(
				<DiffViewerPanel
					reviewScope={{
						repository: { projectId: "p", taskId: "task" },
						revisions: {
							kind: "compare",
							base: "HEAD",
							head,
							headSource,
						},
					}}
					projectFiles={[
						{
							path: "a.ts",
							status: "modified",
							additions: 1,
							deletions: 1,
							oldText: "shared();\nold();",
							newText: "shared();\n😀 target();",
						},
					]}
					selectedPath="a.ts"
					onSelectedPathChange={() => {}}
					viewMode={viewMode}
					readOnlyReview={readOnlyReview}
					comments={
						new Map([
							[
								"a.ts:added:2",
								{
									id: "comment",
									filePath: "a.ts",
									lineNumber: 2,
									lineText: "😀 target();",
									variant: "added",
									comment: "review comment",
								},
							],
						])
					}
					onCommentsChange={onCommentsChange}
					onSendToTerminal={async () => ({ ok: true })}
					navigateToFile={navigateToFile}
					codeNavigationConfig={{ codeNavigationEnabled: true, lspServers: CONFIG_DEFAULTS.lspServers }}
				/>,
			),
		);
	}
	function pointAtSymbol(text: HTMLElement) {
		const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		let offset = 4;
		while (node && offset > (node.textContent?.length ?? 0)) {
			offset -= node.textContent?.length ?? 0;
			node = walker.nextNode();
		}
		Object.defineProperty(document, "caretPositionFromPoint", {
			configurable: true,
			value: () => ({ offsetNode: node!, offset }),
		});
	}
	async function chooseDefinition(text: HTMLElement) {
		pointAtSymbol(text);
		await act(async () =>
			text.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 20 })),
		);
		const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) =>
			item.textContent?.startsWith("Go to Definition"),
		);
		expect(item).toBeDefined();
		await act(async () => item!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	}
	it.each(["split", "unified"] as const)(
		"requests the clicked UTF-16 position in %s and forwards exact live Files destination",
		async (viewMode) => {
			await render(viewMode);
			const text = container.querySelector<HTMLElement>(".kb-diff-row-added .kb-diff-text")!;
			await chooseDefinition(text);
			expect(definition).toHaveBeenCalledWith(
				expect.objectContaining({
					taskId: "task",
					content: "shared();\n😀 target();",
					position: { line: 1, character: 4 },
				}),
			);
			expect(document.querySelector('[aria-label="Code navigation results"]')).toBeNull();
			expect(navigateToFile).toHaveBeenCalledWith({
				targetView: "files",
				filePath: "target.ts",
				codeLocation: location,
				codeTaskId: "task",
			});
			expect(onCommentsChange).not.toHaveBeenCalled();
		},
	);
	it.each(["modifier-click", "keyboard", "keyboard-menu"] as const)(
		"navigates from a %s without creating a comment",
		async (gesture) => {
			await render("split");
			const text = container.querySelector<HTMLElement>(".kb-diff-row-added .kb-diff-text")!;
			pointAtSymbol(text);
			await act(async () =>
				text.dispatchEvent(
					new MouseEvent("click", {
						bubbles: true,
						clientX: 10,
						clientY: 20,
						metaKey: gesture === "modifier-click" && isMacPlatform,
						ctrlKey: gesture === "modifier-click" && !isMacPlatform,
					}),
				),
			);
			if (gesture === "keyboard-menu") {
				const region = container.querySelector<HTMLElement>('[aria-label="Diff code navigation"]')!;
				await act(async () => region.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
				const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) =>
					item.textContent?.startsWith("Go to Definition"),
				)!;
				await act(async () => item.dispatchEvent(new MouseEvent("click", { bubbles: true })));
			} else if (gesture === "keyboard") {
				const region = container.querySelector<HTMLElement>('[aria-label="Diff code navigation"]')!;
				expect(document.activeElement).toBe(region);
				await act(async () =>
					region.dispatchEvent(
						new KeyboardEvent("keydown", {
							key: "b",
							bubbles: true,
							metaKey: isMacPlatform,
							ctrlKey: !isMacPlatform,
						}),
					),
				);
			}
			expect(definition).toHaveBeenCalledWith(expect.objectContaining({ position: { line: 1, character: 4 } }));
			expect(navigateToFile).toHaveBeenCalledOnce();
			expect(onCommentsChange).not.toHaveBeenCalled();
		},
	);
	it("shows multiple definitions without reflowing the diff, dismisses and restores the diff", async () => {
		definition.mockImplementation(async (input) => ({
			status: "ok",
			documentVersion: input.documentVersion,
			locations: [location, { ...location, path: "second.ts" }],
			truncated: false,
		}));
		await render("split");
		await chooseDefinition(container.querySelector<HTMLElement>(".kb-diff-row-added .kb-diff-text")!);
		const popup = document.querySelector<HTMLElement>('[role="dialog"]')!;
		expect(popup).not.toBeNull();
		expect(container.contains(popup)).toBe(false);
		expect(document.activeElement?.getAttribute("role")).toBe("listbox");
		expect(readFile).toHaveBeenCalledExactlyOnceWith({ taskId: "task", path: "target.ts" });
		expect(navigateToFile).not.toHaveBeenCalled();
		await act(async () =>
			document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
		);
		await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.activeElement).toBe(container.querySelector('[aria-label="Diff code navigation"]'));
		expect(onCommentsChange).not.toHaveBeenCalled();
	});
	it("closes multiple definitions before handing off the selected exact-range destination", async () => {
		definition.mockImplementation(async (input) => ({
			status: "ok",
			documentVersion: input.documentVersion,
			locations: [location, { ...location, path: "second.ts" }],
			truncated: false,
		}));
		await render("unified", true);
		await chooseDefinition(container.querySelector<HTMLElement>(".kb-diff-row-added .kb-diff-text")!);
		await act(async () => document.querySelector<HTMLButtonElement>('[role="option"]')!.click());
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(navigateToFile).toHaveBeenCalledWith(expect.objectContaining({ codeLocation: location }));
		expect(onCommentsChange).not.toHaveBeenCalled();
	});
	it("does not restore the diff over a direct-single-definition destination after showing busy", async () => {
		let finish!: (value: unknown) => void;
		definition.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await render("split");
		await chooseDefinition(container.querySelector<HTMLElement>(".kb-diff-row-added .kb-diff-text")!);
		expect(document.body.textContent).toContain("Searching symbols");
		await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
		const source = container.querySelector<HTMLElement>('[aria-label="Diff code navigation"]')!;
		const restore = vi.spyOn(source, "focus");
		await act(async () => finish({ status: "ok", documentVersion: 1, locations: [location], truncated: false }));
		await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(navigateToFile).toHaveBeenCalledWith(expect.objectContaining({ codeLocation: location }));
		expect(restore).not.toHaveBeenCalled();
		// A later denied lookup has no busy stage, but must still regain dismissal focus.
		await chooseDefinition(container.querySelector<HTMLElement>('[data-code-navigation-side="old"] .kb-diff-text')!);
		await act(async () =>
			document.activeElement!.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			),
		);
		await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
		expect(document.activeElement).toBe(source);
	});
	it("does not reopen a dismissed pending response", async () => {
		let finish!: (value: unknown) => void;
		definition.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await render("split");
		await chooseDefinition(container.querySelector<HTMLElement>(".kb-diff-row-added .kb-diff-text")!);
		expect(document.body.textContent).toContain("Searching symbols");
		await act(async () =>
			document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
		);
		await act(async () =>
			finish({ status: "ok", documentVersion: 1, locations: [location, location], truncated: false }),
		);
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(navigateToFile).not.toHaveBeenCalled();
	});
	it("rejects the old split context side even when its displayed text also exists on the right", async () => {
		await render("split");
		await chooseDefinition(container.querySelector<HTMLElement>('[data-code-navigation-side="old"] .kb-diff-text')!);
		expect(definition).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("old/base");
	});
	it("explains historical right-side unavailability", async () => {
		await render("unified", false, "main", "revision");
		await chooseDefinition(container.querySelector<HTMLElement>(".kb-diff-row-added .kb-diff-text")!);
		expect(definition).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("historical");
	});
	it.each(["split", "unified"] as const)(
		"read-only %s reviews omit comments and agent actions but retain code navigation",
		async (viewMode) => {
			await render(viewMode, true);
			expect(container.querySelector("textarea")).toBeNull();
			expect(container.textContent).not.toContain("Ask agent about hunk");
			expect(container.textContent).not.toContain("Clear All");
			for (const registration of hotkeys.mock.calls) {
				expect(registration[2]).toMatchObject({ enabled: false });
				await act(async () => registration[1](new KeyboardEvent("keydown", { key: "Enter", metaKey: true })));
			}
			expect(onCommentsChange).not.toHaveBeenCalled();
			const text = container.querySelector<HTMLElement>(".kb-diff-row-added .kb-diff-text")!;
			await act(async () => text.dispatchEvent(new MouseEvent("click", { bubbles: true })));
			expect(onCommentsChange).not.toHaveBeenCalled();
			await chooseDefinition(text);
			expect(definition).toHaveBeenCalledOnce();
		},
	);
});
