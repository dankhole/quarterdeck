import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceEditorActionContext } from "@/components/editor/source-editor-context";
import type { CodeNavigationResponse } from "@/runtime/types";
import { createFileEditorTab } from "./file-editor-workspace";
import { type UseCodeNavigationOptions, type UseCodeNavigationResult, useCodeNavigation } from "./use-code-navigation";

const { definition, references, hover } = vi.hoisted(() => ({
	definition: vi.fn(),
	references: vi.fn(),
	hover: vi.fn(),
}));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		project: {
			codeNavigation: {
				definition: { mutate: definition },
				references: { mutate: references },
				hover: { mutate: hover },
			},
		},
	}),
}));

describe("useCodeNavigation", () => {
	let root: Root;
	let container: HTMLDivElement;
	let current: UseCodeNavigationResult;
	let previousActEnvironment: boolean | undefined;
	const context: SourceEditorActionContext = {
		path: "src/example.ts",
		content: "const unsaved = 42;",
		documentVersion: 12,
		position: { line: 0, character: 8 },
		selection: {
			from: 8,
			to: 8,
			text: "",
			range: { start: { line: 0, character: 8 }, end: { line: 0, character: 8 } },
		},
	};
	const createOptions = (): UseCodeNavigationOptions => ({
		projectId: "project",
		scopeKey: "project:task",
		scope: { taskId: "task" },
		config: { codeNavigationEnabled: true, lspServers: CONFIG_DEFAULTS.lspServers },
		readOnly: false,
		tab: createFileEditorTab(context.path, {
			content: context.content,
			contentHash: "old-disk-hash",
			language: "typescript",
			size: 19,
			binary: false,
			truncated: false,
		}),
	});
	function Harness({ options }: { options: UseCodeNavigationOptions }): null {
		current = useCodeNavigation(options);
		return null;
	}
	async function render(options: UseCodeNavigationOptions) {
		await act(async () => {
			root.render(<Harness options={options} />);
		});
	}
	beforeEach(() => {
		previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		definition.mockReset();
		references.mockReset();
		hover.mockReset();
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
	});
	it("sends the current unsaved editor revision and cursor and shows busy then results", async () => {
		let resolve!: (response: CodeNavigationResponse) => void;
		references.mockReturnValue(
			new Promise<CodeNavigationResponse>((done) => {
				resolve = done;
			}),
		);
		await render(createOptions());
		await act(async () =>
			current.actions.find((action) => action.id === "code-navigation-references")!.onSelect(context),
		);
		expect(current.result?.status).toBe("busy");
		expect(references).toHaveBeenCalledWith({
			taskId: "task",
			path: context.path,
			position: context.position,
			documentVersion: 12,
			content: context.content,
			includeDeclaration: true,
		});
		await act(async () =>
			resolve({
				status: "ok",
				documentVersion: 12,
				locations: [{ path: "src/target.ts", range: context.selection.range }],
				truncated: false,
			}),
		);
		expect(current.result).toMatchObject({ status: "locations", locations: [{ path: "src/target.ts" }] });
	});
	it("drops an in-flight result after a scope change even when path and content match", async () => {
		let resolve!: (response: CodeNavigationResponse) => void;
		definition.mockReturnValue(
			new Promise<CodeNavigationResponse>((done) => {
				resolve = done;
			}),
		);
		const options = createOptions();
		await render(options);
		await act(async () => current.actions[0]!.onSelect(context));
		await render({ ...options, scopeKey: "project:other-task", scope: { taskId: "other-task" } });
		await act(async () => resolve({ status: "ok", documentVersion: 12, locations: [], truncated: false }));
		expect(current.result).toBeNull();
	});
	it("drops results after editing and explains disabled navigation without making a request", async () => {
		let resolve!: (response: CodeNavigationResponse) => void;
		definition.mockReturnValue(
			new Promise<CodeNavigationResponse>((done) => {
				resolve = done;
			}),
		);
		const options = createOptions();
		await render(options);
		await act(async () => current.actions[0]!.onSelect(context));
		await render({ ...options, tab: { ...options.tab!, value: "new draft" } });
		await act(async () => resolve({ status: "ok", documentVersion: 12, locations: [], truncated: false }));
		expect(current.result).toBeNull();
		definition.mockClear();
		await render({ ...options, config: { ...options.config!, codeNavigationEnabled: false } });
		await act(async () => current.actions[0]!.onSelect(context));
		expect(definition).not.toHaveBeenCalled();
		expect(current.result).toMatchObject({
			status: "unavailable",
			message: expect.stringContaining("Enable Code Navigation"),
		});
	});
	it("shows actionable unavailable errors returned by the runtime", async () => {
		definition.mockResolvedValue({
			status: "unavailable",
			documentVersion: 12,
			message: "Could not find typescript-language-server. Configure its executable in Settings.",
		});
		await render(createOptions());
		await act(async () => current.actions[0]!.onSelect(context));
		expect(current.result).toMatchObject({
			status: "unavailable",
			message: expect.stringContaining("typescript-language-server"),
		});
	});

	it("preserves the completed result list while visiting files, and clears it on a scope change", async () => {
		references.mockResolvedValue({
			status: "ok",
			documentVersion: 12,
			locations: [{ path: "src/target.ts", range: context.selection.range }],
			truncated: false,
		});
		const options = createOptions();
		await render(options);
		await act(async () => current.actions[1]!.onSelect(context));
		await render({ ...options, tab: { ...options.tab!, path: "src/target.ts", value: "target" } });
		expect(current.result).toMatchObject({ status: "locations", sourcePath: "src/example.ts" });
		await render({ ...options, scopeKey: "other-project" });
		expect(current.result).toBeNull();
	});
});
