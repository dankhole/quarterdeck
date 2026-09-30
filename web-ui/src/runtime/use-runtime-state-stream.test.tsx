import { QUARTERDECK_RUNTIME_PROTOCOL_VERSION } from "@runtime-contract";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as boardCache from "@/runtime/project-board-cache";
import * as preloadCache from "@/runtime/project-preload-cache";
import { resolveRuntimeProtocolCompatibility } from "@/runtime/runtime-protocol-compatibility";
import type { RuntimeStateStreamTransportCallbacks } from "@/runtime/runtime-state-stream-transport";
import type { RuntimeStateStreamSnapshotMessage } from "@/runtime/types";
import { type UseRuntimeStateStreamResult, useRuntimeStateStream } from "@/runtime/use-runtime-state-stream";

const transport = vi.hoisted(() => ({
	acceptCurrentConnection: vi.fn(),
	switchProject: vi.fn(),
	dispose: vi.fn(),
}));
let callbacks: RuntimeStateStreamTransportCallbacks;
vi.mock("@/runtime/runtime-state-stream-transport", () => ({
	startRuntimeStateStreamTransport: (_projectId: string | null, handlers: RuntimeStateStreamTransportCallbacks) => {
		callbacks = handlers;
		return transport;
	},
}));
vi.mock("@/diagnostics", () => ({
	handleBrowserDiagnosticsStreamMessage: () => false,
	recordBrowserEvent: vi.fn(),
}));

describe("runtime state stream", () => {
	let root: Root;
	let state: UseRuntimeStateStreamResult;

	beforeEach(async () => {
		vi.clearAllMocks();
		sessionStorage.clear();
		root = createRoot(document.createElement("div"));
		function Harness() {
			state = useRuntimeStateStream(null);
			return null;
		}
		await act(async () => root.render(<Harness />));
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		vi.restoreAllMocks();
	});

	function snapshot(overrides: Partial<RuntimeStateStreamSnapshotMessage> = {}): RuntimeStateStreamSnapshotMessage {
		return {
			type: "snapshot",
			runtimeBuildId: "different-production-build",
			runtimeProtocolVersion: QUARTERDECK_RUNTIME_PROTOCOL_VERSION,
			currentProjectId: null,
			projects: [],
			projectState: null,
			projectMetadata: null,
			...overrides,
		};
	}

	it("accepts different builds with the same protocol and applies their snapshot", async () => {
		await act(async () => callbacks.onMessage(snapshot()));
		expect(transport.acceptCurrentConnection).toHaveBeenCalledOnce();
		expect(transport.dispose).not.toHaveBeenCalled();
		expect(state.hasReceivedSnapshot).toBe(true);
		expect(state.streamError).toBeNull();
	});

	it("invalidates inactive project caches after a metadata change and keeps its identity", async () => {
		const invalidateBoard = vi.spyOn(boardCache, "invalidateProjectBoardCache");
		const invalidatePreload = vi.spyOn(preloadCache, "invalidateProjectPreload");
		const project = {
			id: "p2",
			name: "Old folder",
			path: "/old/folder",
			metadataRevision: 1,
			boardRevision: 3,
			taskCounts: { in_progress: 0, review: 4, trash: 0 },
		};
		await act(async () => callbacks.onMessage(snapshot({ projects: [project] })));
		await act(async () =>
			state.applyProjectManagementResult({
				...project,
				path: "/new/folder",
				name: "New folder",
				metadataRevision: 2,
			}),
		);
		expect(state.projects[0]?.id).toBe("p2");
		expect(state.projects[0]?.path).toBe("/new/folder");
		expect(state.currentProjectId).toBeNull();
		expect(invalidateBoard).toHaveBeenCalledWith("p2");
		expect(invalidatePreload).toHaveBeenCalledWith("p2");
		invalidateBoard.mockClear();
		invalidatePreload.mockClear();
		await act(async () => state.applyProjectManagementResult({ ...project, name: "Stale result" }));
		expect(state.projects[0]?.path).toBe("/new/folder");
		expect(invalidateBoard).not.toHaveBeenCalled();
		expect(invalidatePreload).not.toHaveBeenCalled();
	});

	it.each([undefined, QUARTERDECK_RUNTIME_PROTOCOL_VERSION + 1])(
		"blocks protocol %s before accepting or applying state even when build IDs match",
		async (runtimeProtocolVersion) => {
			// Simulate the document after its one automatic reload.
			expect(
				resolveRuntimeProtocolCompatibility(
					runtimeProtocolVersion,
					QUARTERDECK_RUNTIME_PROTOCOL_VERSION,
					() => sessionStorage,
				),
			).toBe("reload");
			await act(async () =>
				callbacks.onMessage(snapshot({ runtimeBuildId: __QUARTERDECK_BUILD_ID__, runtimeProtocolVersion })),
			);
			expect(transport.acceptCurrentConnection).not.toHaveBeenCalled();
			expect(transport.dispose).toHaveBeenCalledOnce();
			expect(state.hasReceivedSnapshot).toBe(false);
			expect(state.isRuntimeDisconnected).toBe(true);
			expect(state.streamError).toContain("Restart Quarterdeck");
		},
	);
});
