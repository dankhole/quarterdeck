import { QUARTERDECK_RUNTIME_PROTOCOL_VERSION } from "@runtime-contract";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialBoardData } from "@/data/board-data";
import * as boardCache from "@/runtime/project-board-cache";
import * as preloadCache from "@/runtime/project-preload-cache";
import * as runtimeConfigInvalidation from "@/runtime/runtime-config-invalidation";
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
		boardCache.clearProjectBoardCache();
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

	it("invalidates runtime config on the first snapshot and after a genuine reconnect, but not on an in-between snapshot", async () => {
		const invalidateConfig = vi.spyOn(runtimeConfigInvalidation, "invalidateRuntimeConfig");

		await act(async () => callbacks.onMessage(snapshot()));
		expect(invalidateConfig).toHaveBeenCalledTimes(1);

		// A second snapshot on the same connection (e.g. a deliberate project
		// switch reconnect) must not re-invalidate — nothing proves global
		// config changed just because the project did.
		await act(async () => callbacks.onMessage(snapshot()));
		expect(invalidateConfig).toHaveBeenCalledTimes(1);

		// A genuine disconnect/reconnect may have missed a config change while offline.
		await act(async () => callbacks.onDisconnected("Runtime stream disconnected."));
		await act(async () => callbacks.onMessage(snapshot()));
		expect(invalidateConfig).toHaveBeenCalledTimes(2);
	});

	it("retains the board cache across an availability flip in either direction but refreshes preload", async () => {
		const invalidatePreload = vi.spyOn(preloadCache, "invalidateProjectPreload");
		boardCache.stashProjectBoard("p3", {
			board: createInitialBoardData(),
			sessions: {},
			authoritativeRevision: 1,
			projectPath: "/same/folder",
			projectGit: null,
			metadataRevision: 1,
			availability: { status: "available" },
		});
		const project = {
			id: "p3",
			name: "AirLockAndroid",
			path: "/same/folder",
			metadataRevision: 1,
			boardRevision: 1,
			taskCounts: { in_progress: 0, review: 0, trash: 0 },
			availability: { status: "available" as const },
		};
		await act(async () => callbacks.onMessage(snapshot({ projects: [project] })));

		// A flap to unavailable at the same path must not evict the retained board.
		await act(async () =>
			state.applyProjectManagementResult({
				...project,
				metadataRevision: 2,
				availability: { status: "unavailable", reason: "not_git_repository" },
			}),
		);
		expect(invalidatePreload).toHaveBeenCalledWith("p3");
		expect(boardCache.restoreProjectBoard("p3")).not.toBeNull();

		invalidatePreload.mockClear();

		// Recovering back to available must also keep the cache, not just the initial flip.
		await act(async () =>
			state.applyProjectManagementResult({
				...project,
				metadataRevision: 3,
				availability: { status: "available" },
			}),
		);
		expect(invalidatePreload).toHaveBeenCalledWith("p3");
		expect(boardCache.restoreProjectBoard("p3")).not.toBeNull();
	});

	it.each([undefined, QUARTERDECK_RUNTIME_PROTOCOL_VERSION - 1, QUARTERDECK_RUNTIME_PROTOCOL_VERSION + 1])(
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
