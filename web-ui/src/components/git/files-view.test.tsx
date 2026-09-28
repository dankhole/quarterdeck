import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceEditorProps } from "@/components/editor/source-editor";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createFileBrowserContentScopeKey } from "@/hooks/git/file-browser-scope";
import { setLastSelectedFileBrowserPath } from "@/hooks/git/file-browser-selection-cache";
import { clearCachedFileEditorTabs } from "@/hooks/git/file-editor-cache";
import { useFileBrowserData } from "@/hooks/git/use-file-browser-data";
import type { RuntimeFileContentRequest, RuntimeFileContentResponse } from "@/runtime/types";
import { FilesView } from "./files-view";

const rpc = vi.hoisted(() => ({
	listFiles: vi.fn(),
	getFileContent: vi.fn(),
	saveFileContent: vi.fn(),
	definition: vi.fn(),
}));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		project: {
			listFiles: { query: rpc.listFiles },
			getFileContent: { query: rpc.getFileContent },
			saveFileContent: { mutate: rpc.saveFileContent },
			codeNavigation: { definition: { mutate: rpc.definition } },
		},
	}),
}));
vi.mock("@/hooks/git/use-agent-editor-actions", () => ({ useAgentEditorActions: () => [] }));
vi.mock("@/components/app-toaster", () => ({ showAppToast: vi.fn() }));
vi.mock("@/components/git/panels/file-browser-tree-panel", () => ({
	FileBrowserTreePanel: ({
		files,
		onSelectPath,
	}: {
		files: string[] | null;
		onSelectPath: (path: string) => void;
	}) => (
		<nav aria-label="File tree">
			{files?.map((path) => (
				<button type="button" key={path} onClick={() => onSelectPath(path)}>
					{path}
				</button>
			))}
		</nav>
	),
}));
// Keep Files, results, content loading, editor workspace and FileEditorPanel real.
// Only replace CodeMirror's DOM renderer; the receiving props expose the navigation handoff.
vi.mock("@/components/editor/source-editor", () => ({
	SourceEditor: (props: SourceEditorProps) => (
		<div
			data-editor-path={props.path}
			data-read-only={String(props.readOnly)}
			data-range={JSON.stringify(props.scrollToRange)}
		>
			<pre>{props.value}</pre>
			<button type="button" onClick={() => props.onChange(`${props.value}// draft\n`)}>
				Edit source
			</button>
			{props.actions?.map((action) => (
				<button
					type="button"
					key={action.id}
					disabled={action.disabled}
					onClick={() =>
						action.onSelect({
							path: props.path,
							content: props.value,
							documentVersion: 1,
							position: { line: 1, character: 0 },
							selection: {
								from: 0,
								to: 0,
								text: "",
								range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
							},
						})
					}
				>
					{action.label}
				</button>
			))}
		</div>
	),
}));

const projectId = "navigation-project";
const scopeKey = createFileBrowserContentScopeKey({ projectId, taskId: null, rootPath: "/project" });
const target = {
	path: "node_modules/dependency/index.d.ts",
	range: { start: { line: 0, character: 21 }, end: { line: 0, character: 26 } },
};

function contentResponse(content: string, editable: boolean): RuntimeFileContentResponse {
	return {
		content,
		language: "typescript",
		binary: false,
		size: content.length,
		truncated: false,
		contentHash: "content-hash",
		editable,
		...(editable ? {} : { editBlockedReason: "Dependency files are read-only." }),
	};
}

function Harness() {
	const browser = useFileBrowserData({ projectId, taskId: null, rootPath: "/project" });
	return (
		<FilesView
			projectId={projectId}
			fileBrowserData={browser}
			fileEditorAutosaveMode="focus"
			scopeBar={null}
			codeNavigationConfig={{
				codeNavigationEnabled: true,
				lspServers: [
					{
						id: "typescript",
						label: "TypeScript",
						enabled: true,
						command: "server",
						args: [],
						extensions: [".ts"],
						rootMarkers: [],
					},
				],
			}}
		/>
	);
}

describe("FilesView code navigation", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	beforeEach(() => {
		previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		clearCachedFileEditorTabs();
		setLastSelectedFileBrowserPath(scopeKey, null);
		vi.clearAllMocks();
		rpc.listFiles.mockResolvedValue({ files: ["src/app.ts"], directories: ["src"], mutable: true });
		rpc.getFileContent.mockImplementation(async ({ path }: RuntimeFileContentRequest) =>
			path === target.path
				? contentResponse("export declare const value: number;\n", false)
				: contentResponse("import { value } from 'dependency';\nvalue;\n", true),
		);
		rpc.definition.mockResolvedValue({ status: "ok", documentVersion: 1, locations: [target], truncated: false });
		rpc.saveFileContent.mockImplementation(async ({ content }: { content: string }) =>
			contentResponse(content, true),
		);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		clearCachedFileEditorTabs();
		setLastSelectedFileBrowserPath(scopeKey, null);
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
	});
	function button(text: string): HTMLButtonElement {
		const match = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === text);
		if (!match) throw new Error(`Missing button: ${text}`);
		return match;
	}

	it("opens an excluded dependency result read-only at its complete range and permits revisiting its tab", async () => {
		await act(async () =>
			root.render(
				<TooltipProvider>
					<Harness />
				</TooltipProvider>,
			),
		);
		await act(async () => button("src/app.ts").click());
		await act(async () => button("Edit source").click());
		await act(async () => button("Go to Definition").click());
		expect(rpc.definition).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("// draft") }),
		);
		await act(async () => button("Line 1, column 22").click());

		const editor = container.querySelector("[data-editor-path]");
		expect(editor?.getAttribute("data-editor-path")).toBe(target.path);
		expect(editor?.textContent).toContain("export declare const value: number;");
		expect(editor?.getAttribute("data-read-only")).toBe("true");
		expect(JSON.parse(editor?.getAttribute("data-range") ?? "null")).toEqual(target.range);
		expect(rpc.getFileContent).toHaveBeenCalledWith({ taskId: null, path: target.path });
		expect(rpc.saveFileContent).toHaveBeenCalledWith(
			expect.objectContaining({ path: "src/app.ts", content: expect.stringContaining("// draft") }),
		);
		expect(container.querySelector('[aria-label="File tree"]')?.textContent).not.toContain("node_modules");

		await act(async () => button("src/app.ts").click());
		expect(container.querySelector("[data-editor-path]")?.getAttribute("data-read-only")).toBe("false");
		const targetTab = container.querySelector(`span[title="${target.path}"]`)?.closest("button");
		expect(targetTab).not.toBeNull();
		await act(async () => targetTab?.click());
		expect(container.querySelector("[data-editor-path]")?.getAttribute("data-editor-path")).toBe(target.path);
		expect(container.querySelector("[data-editor-path]")?.getAttribute("data-read-only")).toBe("true");
	});
});
