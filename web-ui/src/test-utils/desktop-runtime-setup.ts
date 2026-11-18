import { vi } from "vitest";
import type * as RuntimeEnvironmentModule from "@/runtime/runtime-environment";

// Shared renderer tests mount components without Electron. Keep the production resolver strict;
// tests that supply a real preload (including invalid ones) still exercise its validation.
vi.mock("@/runtime/runtime-environment", async (importOriginal) => {
	const actual = await importOriginal<typeof RuntimeEnvironmentModule>();
	const getRuntimeEnvironment = (): RuntimeEnvironmentModule.RuntimeEnvironment =>
		typeof window !== "undefined" && (window.location.protocol === "app:" || window.quarterdeckDesktop !== undefined)
			? actual.resolveRuntimeEnvironment(window.location, window.quarterdeckDesktop)
			: actual.resolveRuntimeEnvironment(
					{ protocol: "app:", host: "quarterdeck" },
					{
						version: 1,
						bootstrap: {
							runtimeOrigin: "http://127.0.0.1:54321",
							runtimeGeneration: "test-generation",
							capabilities: { desktop: true, nativeDialogs: true, nativeNotifications: true },
						},
					},
				);
	return {
		...actual,
		getRuntimeEnvironment,
		getRuntimeWebSocketUrl: (path: RuntimeEnvironmentModule.RuntimeWebSocketPath): URL => {
			const url = new URL(path, getRuntimeEnvironment().runtimeOrigin);
			url.protocol = "ws:";
			return url;
		},
	};
});
