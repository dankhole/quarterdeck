import { afterAll, describe, expect, it, vi } from "vitest";

const preload = vi.hoisted(() => {
	vi.stubGlobal("window", { location: new URL("app://quarterdeck/project-1?surface=compare") });
	return {
		expose: vi.fn(),
		sendSync: vi.fn().mockReturnValue({
			role: "compare",
			documentId: "compare-document",
			bootstrap: {
				runtimeOrigin: "http://127.0.0.1:12345",
				runtimeGeneration: "generation-1",
				capabilities: { desktop: true, nativeDialogs: false, nativeNotifications: false },
			},
		}),
	};
});
vi.mock("electron", () => ({
	contextBridge: { exposeInMainWorld: preload.expose },
	ipcRenderer: { sendSync: preload.sendSync },
}));

import "../src/preload.js";

const exposed = [...preload.expose.mock.calls];
const requests = [...preload.sendSync.mock.calls];
afterAll(() => vi.unstubAllGlobals());

describe("Compare preload entry", () => {
	it("exposes only the bootstrap namespace, without native commands, updates, environment or window creation", () => {
		expect(requests).toHaveLength(1);
		expect(exposed).toHaveLength(1);
		const [namespace, bridge] = exposed[0];
		expect(namespace).toBe("quarterdeckDesktop");
		expect(Object.getOwnPropertyNames(bridge).sort()).toEqual(["bootstrap", "version"]);
		expect(bridge.bootstrap.runtimeGeneration).toBe("generation-1");
	});
});
