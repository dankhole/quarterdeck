import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectMetadataReporting } from "./use-project-metadata-reporting";

const report = vi.hoisted(() =>
	vi.fn<(projectId: string, input: { taskId: string | null } | { isDocumentVisible: boolean }) => Promise<void>>(),
);
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: (projectId: string) => ({
		project: {
			setFocusedTask: { mutate: (input: { taskId: string | null }) => report(projectId, input) },
			setDocumentVisible: { mutate: (input: { isDocumentVisible: boolean }) => report(projectId, input) },
		},
	}),
}));

type ReportingInput = Parameters<typeof useProjectMetadataReporting>[0];
function Harness(props: ReportingInput): null {
	useProjectMetadataReporting(props);
	return null;
}

describe("useProjectMetadataReporting", () => {
	let root: Root;
	beforeEach(() => {
		report.mockReset().mockResolvedValue(undefined);
		root = createRoot(document.createElement("div"));
	});
	afterEach(async () => {
		await act(async () => root.unmount());
	});
	const render = async (overrides: Partial<ReportingInput> = {}) => {
		await act(async () =>
			root.render(
				<Harness currentProjectId="first" selectedTaskId="task" isDocumentVisible enabled {...overrides} />,
			),
		);
	};

	it.each([null, "missing"])("does not report or clean up an unadmitted project %s", async (currentProjectId) => {
		await render({ currentProjectId, enabled: currentProjectId === null });
		await act(async () => root.render(null));
		expect(report).not.toHaveBeenCalled();
	});

	it("waits through loading and an unavailable snapshot, then reports the recovered project", async () => {
		await render({ selectedTaskId: null, isDocumentVisible: false, enabled: false });
		await render({ enabled: false });
		expect(report).not.toHaveBeenCalled();
		await render();
		expect(report.mock.calls).toEqual([
			["first", { taskId: "task" }],
			["first", { isDocumentVisible: true }],
		]);
	});

	it("suppresses reports while unavailable and resumes both endpoints after same-ID recovery", async () => {
		await render();
		report.mockClear();
		await render({ enabled: false, selectedTaskId: null, isDocumentVisible: false });
		expect(report).not.toHaveBeenCalled();
		await render({ selectedTaskId: "resumed" });
		await act(async () => root.render(null));
		expect(report.mock.calls).toEqual([
			["first", { taskId: "resumed" }],
			["first", { isDocumentVisible: true }],
			["first", { taskId: null }],
			["first", { isDocumentVisible: false }],
		]);
	});

	it("does not clean up a previous project after it becomes unavailable", async () => {
		await render();
		await render({ enabled: false });
		report.mockClear();
		await render({ currentProjectId: "second" });
		expect(report.mock.calls).toEqual([
			["second", { taskId: "task" }],
			["second", { isDocumentVisible: true }],
		]);
	});

	it.each([false, true])(
		"cleans the available previous project before the next project's enabled=%s effects",
		async (enabled) => {
			await render();
			report.mockClear();
			await render({ currentProjectId: "second", enabled });
			expect(report.mock.calls).toEqual([
				["first", { taskId: null }],
				["first", { isDocumentVisible: false }],
				...(enabled
					? [
							["second", { taskId: "task" }],
							["second", { isDocumentVisible: true }],
						]
					: []),
			]);
		},
	);

	it("reports only the endpoint whose value changed", async () => {
		await render();
		report.mockClear();
		await render({ selectedTaskId: "other-task" });
		expect(report.mock.calls).toEqual([["first", { taskId: "other-task" }]]);
		report.mockClear();
		await render({ selectedTaskId: "other-task", isDocumentVisible: false });
		expect(report.mock.calls).toEqual([["first", { isDocumentVisible: false }]]);
	});
});
