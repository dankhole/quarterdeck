import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeNavigationResponse } from "@/runtime/types";
import { createDiffActionContext, DIFF_OLD_SIDE_UNAVAILABLE } from "./diff-code-navigation";
import { createReviewDocument, type ReviewDocument } from "./review-document";
import {
	type DiffCodeNavigationOptions,
	type UseDiffCodeNavigationResult,
	useDiffCodeNavigation,
} from "./use-diff-code-navigation";

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

const documentSnapshot = () =>
	createReviewDocument(
		{
			repository: { projectId: "p", taskId: "t" },
			revisions: { kind: "compare", base: "HEAD", head: "WORKTREE", headSource: "live-worktree" },
		},
		{ path: "a.ts" },
		{ kind: "text", oldText: "old", newText: "target()" },
	);
const createOptions = (): DiffCodeNavigationOptions => ({
	projectId: "p",
	scope: { taskId: "t" },
	config: { codeNavigationEnabled: true, lspServers: CONFIG_DEFAULTS.lspServers },
});

describe("useDiffCodeNavigation", () => {
	let root: Root;
	let container: HTMLDivElement;
	let current: UseDiffCodeNavigationResult;
	let priorAct: boolean | undefined;
	function Harness({ snapshot, options }: { snapshot: ReviewDocument; options: DiffCodeNavigationOptions }) {
		current = useDiffCodeNavigation(snapshot, options);
		return null;
	}
	async function render(snapshot = documentSnapshot(), options = createOptions()) {
		await act(async () => root.render(<Harness snapshot={snapshot} options={options} />));
	}
	async function run(index = 0, snapshot = documentSnapshot()) {
		await act(async () =>
			current.select(current.actions[index]!, {
				context: createDiffActionContext(snapshot, 1, 3, current.documentVersion),
				unavailableReason: null,
			}),
		);
	}
	beforeEach(() => {
		priorAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
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
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = priorAct;
	});
	it.each([0, 1, 2])(
		"reuses shared request orchestration for operation %s with complete new-side content",
		async (index) => {
			const request = [definition, references, hover][index]!;
			request.mockImplementation(async (input) => ({
				status: "ok",
				documentVersion: input.documentVersion,
				locations: [],
				truncated: false,
				contents: "type",
			}));
			await render();
			await run(index);
			expect(request).toHaveBeenCalledWith(
				expect.objectContaining({
					taskId: "t",
					path: "a.ts",
					content: "target()",
					position: { line: 0, character: 3 },
				}),
			);
			expect(current.result?.status).toBe(index === 2 ? "hover" : "locations");
			expect(showAppToast).not.toHaveBeenCalled();
		},
	);
	it("explains old sides, historical snapshots, and disabled config without sending requests", async () => {
		await render();
		expect(showAppToast).not.toHaveBeenCalled();
		await act(async () =>
			current.select(current.actions[0]!, { context: null, unavailableReason: DIFF_OLD_SIDE_UNAVAILABLE }),
		);
		expect(current.result).toMatchObject({ status: "unavailable", message: expect.stringContaining("old/base") });
		expect(showAppToast).toHaveBeenLastCalledWith({
			intent: "danger",
			message: `Go to Definition: ${DIFF_OLD_SIDE_UNAVAILABLE}`,
		});
		const historical: ReviewDocument = {
			...documentSnapshot(),
			revisions: { ...documentSnapshot().revisions, head: "main", headSource: "revision" },
		};
		await render(historical);
		await run(0, historical);
		expect(current.result).toMatchObject({ status: "unavailable", message: expect.stringContaining("historical") });
		expect(showAppToast).toHaveBeenLastCalledWith({
			intent: "danger",
			message: expect.stringMatching(/^Go to Definition: .*historical/),
		});
		await render(documentSnapshot(), { ...createOptions(), config: null });
		await run();
		expect(current.result).toMatchObject({
			status: "unavailable",
			message: expect.stringContaining("Enable Code Navigation"),
		});
		expect(definition).not.toHaveBeenCalled();
		expect(showAppToast).toHaveBeenCalledTimes(3);
	});
	it.each(["content", "oldContent", "scope", "config", "revisions"])(
		"rejects pending and completed results when %s changes",
		async (change) => {
			let resolve!: (response: CodeNavigationResponse) => void;
			definition.mockReturnValue(
				new Promise<CodeNavigationResponse>((done) => {
					resolve = done;
				}),
			);
			const snapshot = documentSnapshot();
			const options = createOptions();
			await render(snapshot, options);
			await run();
			const version = current.documentVersion;
			const nextDocument =
				change === "content"
					? { ...snapshot, content: { kind: "text" as const, oldText: "old", newText: "updated()" } }
					: change === "oldContent"
						? { ...snapshot, content: { kind: "text" as const, oldText: "other base", newText: "target()" } }
						: change === "revisions"
							? { ...snapshot, key: "other-base" }
							: snapshot;
			const nextOptions =
				change === "scope"
					? { ...options, scope: { taskId: "other" } }
					: change === "config"
						? { ...options, config: { ...options.config!, codeNavigationEnabled: false } }
						: options;
			await render(nextDocument, nextOptions);
			await act(async () => resolve({ status: "ok", documentVersion: version, locations: [], truncated: false }));
			expect(current.result).toBeNull();
			// Also clear a completed result, not only late promises.
			definition.mockImplementation(async (input) => ({
				status: "ok",
				documentVersion: input.documentVersion,
				locations: [],
				truncated: false,
			}));
			await render(snapshot, options);
			await run();
			expect(current.result?.status).toBe("locations");
			await render(nextDocument, nextOptions);
			expect(current.result).toBeNull();
		},
	);
	it.each(["pending", "completed", "denied"] as const)(
		"retains %s results and source version when unrelated settings change",
		async (phase) => {
			let resolve!: (response: CodeNavigationResponse) => void;
			definition.mockReturnValue(
				new Promise<CodeNavigationResponse>((done) => {
					resolve = done;
				}),
			);
			const options = {
				...createOptions(),
				config: { ...createOptions().config!, audibleNotificationVolume: 0.2 },
			};
			await render(documentSnapshot(), options);
			if (phase === "denied") {
				await act(async () =>
					current.select(current.actions[0]!, { context: null, unavailableReason: DIFF_OLD_SIDE_UNAVAILABLE }),
				);
			} else {
				await run();
				if (phase === "completed")
					await act(async () =>
						resolve({ status: "ok", documentVersion: current.documentVersion, locations: [], truncated: false }),
					);
			}
			const version = current.documentVersion;
			const result = current.result;
			const nextOptions = {
				...options,
				config: { ...options.config, audibleNotificationVolume: 0.8 },
			};
			await render(documentSnapshot(), nextOptions);
			expect(current.documentVersion).toBe(version);
			expect(current.result).toBe(result);
			if (phase === "pending") {
				await act(async () => resolve({ status: "ok", documentVersion: version, locations: [], truncated: false }));
				expect(current.result?.status).toBe("locations");
			}
		},
	);
	it.each(["enabled", "servers"] as const)(
		"invalidates pending, completed, and denied results when navigation %s change",
		async (setting) => {
			for (const phase of ["pending", "completed", "denied"] as const) {
				let resolve!: (response: CodeNavigationResponse) => void;
				definition.mockReturnValue(
					new Promise<CodeNavigationResponse>((done) => {
						resolve = done;
					}),
				);
				const options = createOptions();
				await render(documentSnapshot(), options);
				if (phase === "denied") {
					await act(async () =>
						current.select(current.actions[0]!, { context: null, unavailableReason: DIFF_OLD_SIDE_UNAVAILABLE }),
					);
				} else {
					await run();
					if (phase === "completed")
						await act(async () =>
							resolve({
								status: "ok",
								documentVersion: current.documentVersion,
								locations: [],
								truncated: false,
							}),
						);
				}
				const version = current.documentVersion;
				const config =
					setting === "enabled"
						? { ...options.config!, codeNavigationEnabled: false }
						: {
								...options.config!,
								lspServers: options.config!.lspServers.map((server) => ({
									...server,
									command: "other-server",
								})),
							};
				await render(documentSnapshot(), { ...options, config });
				expect(current.documentVersion).toBeGreaterThan(version);
				expect(current.result).toBeNull();
				if (phase === "pending") {
					await act(async () =>
						resolve({ status: "ok", documentVersion: version, locations: [], truncated: false }),
					);
					expect(current.result).toBeNull();
				}
			}
		},
	);
	it("rejects an open menu's stale source context", async () => {
		await render();
		const target = {
			context: createDiffActionContext(documentSnapshot(), 1, 3, current.documentVersion),
			unavailableReason: null,
		};
		await render({ ...documentSnapshot(), content: { kind: "text", oldText: "old", newText: "updated()" } });
		await act(async () => current.select(current.actions[0]!, target));
		expect(definition).not.toHaveBeenCalled();
		expect(showAppToast).not.toHaveBeenCalled();
	});
	it("ignores completion after unmount", async () => {
		let resolve!: (response: CodeNavigationResponse) => void;
		definition.mockReturnValue(
			new Promise<CodeNavigationResponse>((done) => {
				resolve = done;
			}),
		);
		await render();
		await run();
		const version = current.documentVersion;
		await act(async () => root.render(null));
		await act(async () => resolve({ status: "ok", documentVersion: version, locations: [], truncated: false }));
		expect(current.result?.status).toBe("busy");
	});
});
