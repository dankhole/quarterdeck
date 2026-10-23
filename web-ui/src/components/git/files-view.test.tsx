import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceEditorProps } from "@/components/editor/source-editor";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createFileBrowserContentScopeKey } from "@/hooks/git/file-browser-scope";
import { setLastSelectedFileBrowserPath } from "@/hooks/git/file-browser-selection-cache";
import { clearCachedFileEditorTabs } from "@/hooks/git/file-editor-cache";
import { useFileBrowserData } from "@/hooks/git/use-file-browser-data";
import type { RuntimeFileContentRequest, RuntimeFileContentResponse, RuntimeListFilesResponse } from "@/runtime/types";
import { fileTreePage } from "@/test-utils/file-tree";
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
			{files?.length === 0 ? "No files" : null}
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

function Harness({ taskId = null }: { taskId?: string | null }) {
	const browser = useFileBrowserData({ projectId, taskId, rootPath: "/project" });
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

describe("FilesView", () => {
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
		rpc.listFiles.mockResolvedValue(fileTreePage({ files: ["src/app.ts"], directories: ["src"], mutable: true }));
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
		vi.useRealTimers();
	});
	function button(text: string): HTMLButtonElement {
		const match = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === text);
		if (!match) throw new Error(`Missing button: ${text}`);
		return match;
	}

	it("shows the listing error instead of No files and drops the error when switching scope", async () => {
		vi.useFakeTimers();
		const message = "File tree exceeds the 20,000-entry limit. Narrow the workspace root.";
		rpc.listFiles.mockRejectedValueOnce(new Error(message));
		await act(async () =>
			root.render(
				<TooltipProvider>
					<Harness />
				</TooltipProvider>,
			),
		);
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(message);
		expect(container.textContent).not.toContain("No files");
		// Hold the next poll pending: the existing failure must remain visible.
		rpc.listFiles.mockImplementationOnce(() => new Promise<RuntimeListFilesResponse>(() => {}));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(message);
		expect(container.textContent).not.toContain("No files");

		let resolveListing: (value: RuntimeListFilesResponse) => void = () => {
			throw new Error("Missing new scope request");
		};
		rpc.listFiles.mockImplementationOnce(
			() => new Promise<RuntimeListFilesResponse>((resolve) => (resolveListing = resolve)),
		);
		await act(async () =>
			root.render(
				<TooltipProvider>
					<Harness taskId="empty-task" />
				</TooltipProvider>,
			),
		);
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.textContent).not.toContain(message);
		await act(async () => resolveListing(fileTreePage({ files: [], directories: [], mutable: false })));
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.textContent).toContain("No files");
	});

	it("preserves an open editor draft through a listing failure and clears the alert after recovery", async () => {
		vi.useFakeTimers();
		await act(async () =>
			root.render(
				<TooltipProvider>
					<Harness />
				</TooltipProvider>,
			),
		);
		await act(async () => button("src/app.ts").click());
		await act(async () => button("Edit source").click());
		const editor = container.querySelector("[data-editor-path]");
		expect(editor?.textContent).toContain("// draft");

		const message = "File tree exceeds the 20,000-entry limit.";
		rpc.listFiles.mockRejectedValue(new Error(message));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(message);
		expect(container.textContent).not.toContain("No files");
		expect(container.querySelector("[data-editor-path]")).toBe(editor);
		expect(editor?.textContent).toContain("// draft");
		expect(editor?.getAttribute("data-read-only")).toBe("false");

		let resolveRetry!: (value: RuntimeListFilesResponse) => void;
		rpc.listFiles.mockImplementationOnce(
			() =>
				new Promise<RuntimeListFilesResponse>((resolve) => {
					resolveRetry = resolve;
				}),
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(message);
		expect(container.querySelector('[aria-label="File tree"]')).not.toBeNull();
		expect(container.querySelector("[data-editor-path]")).toBe(editor);
		await act(async () => resolveRetry(fileTreePage({ files: ["src/app.ts"], directories: ["src"], mutable: true })));
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.querySelector('[aria-label="File tree"]')?.textContent).toContain("src/app.ts");
		expect(container.querySelector("[data-editor-path]")).toBe(editor);
		expect(editor?.textContent).toContain("// draft");
	});

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
