import { QUARTERDECK_RUNTIME_PROTOCOL_VERSION } from "@runtime-contract";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as authoritativeState from "@/hooks/project/project-sync";
import type { RuntimeStateStreamTransportCallbacks } from "@/runtime/runtime-state-stream-transport";
import type { RuntimeProjectStateResponse, RuntimeStateStreamSnapshotMessage } from "@/runtime/types";
import { getProjectMetadataProjectId, getProjectPath } from "@/stores/project-metadata-store";
import { createTestProjectStateResponse } from "@/test-utils/task-session-factory";
import type { CompareWindowTarget } from "../../../../src/shared/compare-window-contract";
import type { CompareWindowContext } from "./compare-window-state";
import { useCompareWindowState } from "./use-compare-window-state";

const fetchState = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/project-state-query", () => ({ fetchProjectState: fetchState }));
vi.mock("@/diagnostics", () => ({ handleBrowserDiagnosticsStreamMessage: () => false, recordBrowserEvent: vi.fn() }));
let callbacks: RuntimeStateStreamTransportCallbacks;
vi.mock("@/runtime/runtime-state-stream-transport", () => ({
	startRuntimeStateStreamTransport: (_projectId: string | null, handlers: RuntimeStateStreamTransportCallbacks) => {
		callbacks = handlers;
		return { acceptCurrentConnection: vi.fn(), switchProject: vi.fn(), dispose: vi.fn() };
	},
}));

const target: CompareWindowTarget = {
	projectId: "p1",
	taskId: null,
	sourceRef: "main",
	targetRef: "main",
	includeUncommitted: true,
	threeDotDiff: true,
};

function snapshot(): RuntimeStateStreamSnapshotMessage {
	return {
		type: "snapshot",
		runtimeBuildId: "test",
		runtimeProtocolVersion: QUARTERDECK_RUNTIME_PROTOCOL_VERSION,
		currentProjectId: "p1",
		projects: [
			{
				id: "p1",
				name: "Pinned",
				path: "/repo/p1",
				boardRevision: 1,
				taskCounts: { in_progress: 0, review: 0, trash: 0 },
			},
		],
		projectState: null,
		projectMetadata: null,
	};
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((accept, fail) => {
		resolve = accept;
		reject = fail;
	});
	return { promise, resolve, reject };
}

describe("Compare initial authoritative hydration", () => {
	let root: Root;
	let context: CompareWindowContext;
	let read: ReturnType<typeof deferred<RuntimeProjectStateResponse>>;
	beforeEach(async () => {
		vi.clearAllMocks();
		sessionStorage.clear();
		read = deferred();
		fetchState.mockReturnValue(read.promise);
		root = createRoot(document.createElement("div"));
		function Harness(): null {
			context = useCompareWindowState(target);
			return null;
		}
		await act(async () => root.render(<Harness />));
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		vi.restoreAllMocks();
	});

	it("fetches an omitted initial board and atomically applies it without waiting for a streamed board or Git metadata", async () => {
		const apply = vi.spyOn(authoritativeState, "applyAuthoritativeProjectState");
		await act(async () => callbacks.onMessage(snapshot()));
		expect(context.status).toBe("loading");
		expect(fetchState).toHaveBeenCalledExactlyOnceWith("p1");
		const state = createTestProjectStateResponse({ repoPath: "/repo/p1", revision: 7 });
		await act(async () => read.resolve(state));
		expect(context).toMatchObject({ status: "ready", project: { id: "p1" }, task: null, rootPath: "/repo/p1" });
		expect(apply).toHaveBeenCalledWith(
			expect.objectContaining({ currentProjectId: "p1", incomingProjectState: state }),
		);
		expect(getProjectPath()).toBe("/repo/p1");
	});

	it("shows an initial read failure rather than spinning forever", async () => {
		await act(async () => callbacks.onMessage(snapshot()));
		await act(async () => read.reject(new Error("Project read failed")));
		expect(context).toEqual({
			status: "error",
			message: "Could not load the captured project's state: Project read failed",
		});
	});

	it("does not let a slow initial read roll back a newer streamed board or location", async () => {
		await act(async () => callbacks.onMessage(snapshot()));
		await act(async () =>
			callbacks.onMessage({
				type: "project_state_updated",
				projectId: "p1",
				projectState: createTestProjectStateResponse({ revision: 9, metadataRevision: 2, repoPath: "/repo/new" }),
			}),
		);
		expect(context.status).toBe("ready");
		expect(getProjectPath()).toBe("/repo/new");
		await act(async () =>
			read.resolve(createTestProjectStateResponse({ revision: 1, metadataRevision: 1, repoPath: "/repo/old" })),
		);
		expect(getProjectPath()).toBe("/repo/new");
	});

	it("fences an initial response after the runtime selects a different project", async () => {
		await act(async () => callbacks.onMessage(snapshot()));
		await act(async () =>
			callbacks.onMessage({
				...snapshot(),
				currentProjectId: "p2",
				projects: [{ ...snapshot().projects[0]!, id: "p2", path: "/repo/p2" }],
			}),
		);
		await act(async () => read.resolve(createTestProjectStateResponse({ repoPath: "/repo/stale" })));
		expect(context.status).toBe("error");
		expect(getProjectPath()).toBeNull();
	});

	it("discards a response after unmount without restoring the retired metadata scope", async () => {
		await act(async () => callbacks.onMessage(snapshot()));
		await act(async () => root.unmount());
		await act(async () => read.resolve(createTestProjectStateResponse({ repoPath: "/repo/stale" })));
		expect(getProjectMetadataProjectId()).toBeNull();
		expect(getProjectPath()).toBeNull();
	});
});
