import { describe, expect, it, vi } from "vitest";
import type {
	DesktopEnvironmentIntent,
	DesktopEnvironmentSnapshot,
} from "../../src/shared/desktop-environment-contract.js";
import {
	DESKTOP_ENVIRONMENT_INTENT_CHANNEL,
	DESKTOP_ENVIRONMENT_SNAPSHOT_CHANNEL,
} from "../src/desktop-ipc-channels.js";
import { createDesktopEnvironmentBridge } from "../src/preload-environment-bridge.js";

type Ipc = Parameters<typeof createDesktopEnvironmentBridge>[1];
const identity = { documentId: "document", runtimeGeneration: "generation" };
const snapshot: DesktopEnvironmentSnapshot = {
	ownership: "owned",
	source: "login-shell",
	failureReason: null,
	appliedDirectories: [],
	appliedImportLoginShellEnvironment: true,
	preferences: { importLoginShellEnvironment: true, extraExecutableDirectories: [] },
};
function fixture() {
	const invoke = vi.fn<Ipc["invoke"]>().mockResolvedValue(null);
	const ipc: Ipc = { invoke, on: vi.fn(), removeListener: vi.fn(), send: vi.fn() };
	const bridge = createDesktopEnvironmentBridge(
		{
			runtimeOrigin: "http://127.0.0.1:12345",
			runtimeGeneration: identity.runtimeGeneration,
			capabilities: { desktop: true, nativeDialogs: true, nativeNotifications: false },
		},
		ipc,
		identity.documentId,
	);
	return { invoke, bridge };
}

describe("optional environment preload namespace", () => {
	it("exposes a frozen separately versioned API and binds every call to document identity", async () => {
		const { bridge, invoke } = fixture();
		expect(Object.isFrozen(bridge)).toBe(true);
		expect(bridge.version).toBe(1);
		expect(Object.keys(bridge).sort()).toEqual(["getSnapshot", "request", "version"]);
		invoke.mockResolvedValueOnce({ ...identity, snapshot });
		expect(await bridge.getSnapshot()).toEqual(snapshot);
		expect(invoke).toHaveBeenLastCalledWith(DESKTOP_ENVIRONMENT_SNAPSHOT_CHANNEL, identity);
		const intent = { kind: "set-login-shell-import", enabled: false } as const;
		invoke.mockResolvedValueOnce({ ...identity, response: { outcome: "saved", snapshot } });
		expect(await bridge.request(intent)).toEqual({ outcome: "saved", snapshot });
		expect(invoke).toHaveBeenLastCalledWith(DESKTOP_ENVIRONMENT_INTENT_CHANNEL, { ...identity, intent });
	});

	it("rejects stale document/generation and malformed replies without exposing exception details", async () => {
		const { bridge, invoke } = fixture();
		for (const envelope of [
			{ ...identity, documentId: "stale", snapshot },
			{ ...identity, runtimeGeneration: "stale", snapshot },
			{ ...identity, snapshot: { ...snapshot, environment: { SECRET: "private" } } },
			{ ...identity, snapshot, private: "data" },
		]) {
			invoke.mockResolvedValueOnce(envelope);
			expect(await bridge.getSnapshot()).toBeNull();
		}
		invoke.mockResolvedValueOnce({ ...identity, documentId: "stale", response: { outcome: "saved", snapshot } });
		expect(await bridge.request({ kind: "refresh" })).toEqual({ outcome: "unavailable", snapshot: null });
		invoke.mockRejectedValueOnce(new Error("private native data"));
		expect(await bridge.getSnapshot()).toBeNull();
		invoke.mockRejectedValueOnce(new Error("private native data"));
		expect(await bridge.request({ kind: "refresh" })).toEqual({ outcome: "unavailable", snapshot: null });
	});

	it("never forwards arbitrary folder paths or environment edits", async () => {
		const { bridge, invoke } = fixture();
		for (const intent of [
			{ kind: "add-folders", paths: ["/private"] },
			{ kind: "set-login-shell-import", enabled: "yes" },
			{ kind: "exec", command: "env" },
		])
			expect(await bridge.request(intent as unknown as DesktopEnvironmentIntent)).toEqual({
				outcome: "unavailable",
				snapshot: null,
			});
		expect(invoke).not.toHaveBeenCalled();
	});
});
