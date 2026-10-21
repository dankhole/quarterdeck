import { describe, expect, it } from "vitest";
import { validateDesktopNotificationSelection } from "../../../scripts/agent-lab/desktop-notifications";

describe("desktop notification scenario selection", () => {
	it("accepts the hidden fake task lane", () => {
		expect(() => validateDesktopNotificationSelection({})).not.toThrow();
	});
	it.each([
		{ includeAgent: false },
		{ showWindow: true },
		{ agentMode: "real-codex" as const },
		{ agentMode: "real-claude" as const },
		{ nativeExperience: true },
		{ performance: true },
		{ mainLoss: true },
		{ sessionRecovery: true },
		{ npmLaunch: true },
		{ manualShells: true },
	])("rejects an incompatible lane: %j", (options) => {
		expect(() => validateDesktopNotificationSelection(options)).toThrow("hidden fake task");
	});
});
