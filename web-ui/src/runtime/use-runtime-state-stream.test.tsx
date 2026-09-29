import { QUARTERDECK_RUNTIME_PROTOCOL_VERSION } from "@runtime-contract";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("runtime stream protocol admission", () => {
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
