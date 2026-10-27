import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiffViewerPanel } from "./diff-viewer-panel";

const { definition, openContext, hotkeys } = vi.hoisted(() => ({
	definition: vi.fn(),
	openContext: vi.fn(),
	hotkeys: vi.fn(),
}));
vi.mock("react-hotkeys-hook", () => ({ useHotkeys: hotkeys }));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({ project: { codeNavigation: { definition: { mutate: definition } } } }),
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
		definition.mockReset();
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
					onAddToTerminal={() => {}}
					onSendToTerminal={() => {}}
					navigateToFile={navigateToFile}
					codeNavigationConfig={{ codeNavigationEnabled: true, lspServers: CONFIG_DEFAULTS.lspServers }}
				/>,
			),
		);
	}
	async function chooseDefinition(text: HTMLElement) {
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
		await act(async () =>
			text.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 20 })),
		);
		const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
			(item) => item.textContent === "Go to Definition",
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
			const result = Array.from(container.querySelectorAll("button")).find(
				(button) => button.textContent === "Line 5, column 3",
			)!;
			await act(async () => result.dispatchEvent(new MouseEvent("click", { bubbles: true })));
			expect(navigateToFile).toHaveBeenCalledWith({
				targetView: "files",
				filePath: "target.ts",
				codeLocation: location,
				codeTaskId: "task",
			});
			expect(onCommentsChange).not.toHaveBeenCalled();
		},
	);
	it("rejects the old split context side even when its displayed text also exists on the right", async () => {
		await render("split");
		await chooseDefinition(container.querySelector<HTMLElement>('[data-code-navigation-side="old"] .kb-diff-text')!);
		expect(definition).not.toHaveBeenCalled();
		expect(container.textContent).toContain("old/base");
	});
	it("explains historical right-side unavailability", async () => {
		await render("unified", false, "main", "revision");
		await chooseDefinition(container.querySelector<HTMLElement>(".kb-diff-row-added .kb-diff-text")!);
		expect(definition).not.toHaveBeenCalled();
		expect(container.textContent).toContain("historical");
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
