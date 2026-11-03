import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceEditorActionContext } from "@/components/editor/source-editor-context";
import type { CodeNavigationResponse } from "@/runtime/types";
import { type UseCodeNavigationOptions, type UseCodeNavigationResult, useCodeNavigation } from "./use-code-navigation";

const { definition, references, hover, showAppToast } = vi.hoisted(() => ({
	definition: vi.fn(),
	references: vi.fn(),
	hover: vi.fn(),
	showAppToast: vi.fn(),
}));
vi.mock("@/components/app-toaster", () => ({ showAppToast }));
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
		source: { path: context.path, content: context.content, eligibility: "eligible" },
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
		showAppToast.mockReset();
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
		expect(showAppToast).not.toHaveBeenCalled();
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
		await render({ ...options, source: { ...options.source!, content: "new draft" } });
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
		expect(showAppToast).toHaveBeenCalledExactlyOnceWith({
			intent: "danger",
			message: "Go to Definition: Enable Code Navigation in Settings and configure an installed language server.",
		});
	});
	it("rejects a stale action context before dispatching its old content", async () => {
		const options = createOptions();
		await render({ ...options, source: { ...options.source!, content: "new draft" } });
		await act(async () => current.actions[0]!.onSelect(context));
		expect(definition).not.toHaveBeenCalled();
		expect(showAppToast).not.toHaveBeenCalled();
	});
	it("toasts a missing server configuration only after the user requests navigation", async () => {
		const options = createOptions();
		await render({ ...options, config: { ...options.config!, lspServers: [] } });
		expect(showAppToast).not.toHaveBeenCalled();
		await act(async () => current.actions[0]!.onSelect(context));
		expect(definition).not.toHaveBeenCalled();
		expect(current.result).toMatchObject({
			status: "unavailable",
			message: expect.stringContaining("No enabled language server"),
		});
		expect(showAppToast).toHaveBeenCalledExactlyOnceWith({
			intent: "danger",
			message:
				"Go to Definition: No enabled language server matches this file. Add or enable one in Settings → Code Navigation.",
		});
	});
	it.each(["read-only", "incomplete"] as const)(
		"rejects a pending result after source admission becomes %s",
		async (eligibility) => {
			let resolve!: (response: CodeNavigationResponse) => void;
			definition.mockReturnValue(
				new Promise<CodeNavigationResponse>((done) => {
					resolve = done;
				}),
			);
			const options = createOptions();
			await render(options);
			await act(async () => current.actions[0]!.onSelect(context));
			await render({ ...options, source: { ...options.source!, eligibility } });
			await act(async () => resolve({ status: "ok", documentVersion: 12, locations: [], truncated: false }));
			expect(current.result).toBeNull();
		},
	);
	describe.each([
		["definition", "Go to Definition"],
		["references", "Find References"],
		["hover", "Show Type Information"],
	] as const)("%s notifications", (operation, label) => {
		it.each(["unavailable", "error", "rejected"] as const)(
			"toasts %s requests and retains the inline explanation",
			async (failure) => {
				const request = { definition, references, hover }[operation];
				const message =
					failure === "unavailable"
						? "Could not find typescript-language-server. Configure its executable in Settings."
						: "Language server request failed.";
				if (failure === "rejected") request.mockRejectedValue(new Error(message));
				else request.mockResolvedValue({ status: failure, documentVersion: 12, message });
				await render(createOptions());
				await act(async () =>
					current.actions.find((action) => action.id === `code-navigation-${operation}`)!.onSelect(context),
				);
				expect(current.result).toMatchObject({
					status: failure === "unavailable" ? "unavailable" : "error",
					operation,
					message,
				});
				expect(showAppToast).toHaveBeenCalledExactlyOnceWith({ intent: "danger", message: `${label}: ${message}` });
			},
		);
		it("does not toast an empty successful response", async () => {
			const request = { definition, references, hover }[operation];
			request.mockResolvedValue({
				status: "ok",
				documentVersion: 12,
				locations: [],
				truncated: false,
				contents: "",
			});
			await render(createOptions());
			await act(async () =>
				current.actions.find((action) => action.id === `code-navigation-${operation}`)!.onSelect(context),
			);
			expect(current.result?.status).toBe(operation === "hover" ? "hover" : "locations");
			expect(showAppToast).not.toHaveBeenCalled();
		});
	});

	describe.each(["unavailable", "error", "rejected"] as const)("stale %s responses", (failure) => {
		it.each(
			(["scope", "content", "config", "dismiss", "unmount", "newer-request", "document-version"] as const).filter(
				(change) => change !== "document-version" || failure !== "rejected",
			),
		)("does not toast after %s invalidates the request", async (change) => {
			let resolve!: (response: CodeNavigationResponse) => void;
			let reject!: (reason: Error) => void;
			definition.mockReturnValueOnce(
				new Promise<CodeNavigationResponse>((done, fail) => {
					resolve = done;
					reject = fail;
				}),
			);
			const options = createOptions();
			await render(options);
			await act(async () => current.actions[0]!.onSelect(context));
			if (change === "scope") await render({ ...options, scopeKey: "other-task", scope: { taskId: "other-task" } });
			else if (change === "content")
				await render({ ...options, source: { ...options.source!, content: "new draft" } });
			else if (change === "config")
				await render({ ...options, config: { ...options.config!, codeNavigationEnabled: false } });
			else if (change === "dismiss") await act(async () => current.dismiss());
			else if (change === "unmount") await act(async () => root.render(null));
			else if (change === "newer-request") {
				references.mockResolvedValue({ status: "ok", documentVersion: 12, locations: [], truncated: false });
				await act(async () => current.actions[1]!.onSelect(context));
			}
			await act(async () => {
				if (failure === "rejected") reject(new Error("Old request failed."));
				else
					resolve({
						status: failure,
						documentVersion: change === "document-version" ? 11 : 12,
						message: "Old request failed.",
					});
			});
			expect(showAppToast).not.toHaveBeenCalled();
			expect(current.result?.status).not.toBe("error");
			expect(current.result?.status).not.toBe("unavailable");
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
		await render({ ...options, source: { ...options.source!, path: "src/target.ts", content: "target" } });
		expect(current.result).toMatchObject({ status: "locations", sourcePath: "src/example.ts" });
		await render({ ...options, scopeKey: "other-project" });
		expect(current.result).toBeNull();
	});
});
