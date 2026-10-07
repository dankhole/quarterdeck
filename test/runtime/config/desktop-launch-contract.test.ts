import { describe, expect, it } from "vitest";
import {
	DESKTOP_LAUNCH_ARGUMENT,
	type DesktopLaunchRequest,
	readDesktopLaunchRequest,
	serializeDesktopLaunchRequest,
} from "../../../src/shared/desktop-launch-contract.js";

const request: DesktopLaunchRequest = {
	schemaVersion: 1,
	version: "0.12.8",
	appPath: "/Applications/Quarterdeck.app",
	arch: "arm64",
	buildId: "build-current",
	appAsarSha256: "a".repeat(64),
	stateHome: "/private/tmp/state",
	projectPath: "/private/tmp/project with spaces",
};

describe("bounded npm desktop launch contract", () => {
	it("round-trips the one typed option without interpreting path text as shell commands", () => {
		const value = { ...request, projectPath: "/private/tmp/$(touch unwanted) `literal`" };
		expect(
			readDesktopLaunchRequest([
				"Quarterdeck",
				"--native-option",
				DESKTOP_LAUNCH_ARGUMENT,
				serializeDesktopLaunchRequest(value),
			]),
		).toEqual(value);
		expect(readDesktopLaunchRequest(["Quarterdeck"])).toBeNull();
	});
	it("accepts a focus-only request without a project path", () => {
		const { projectPath: _project, ...focus } = request;
		expect(readDesktopLaunchRequest([DESKTOP_LAUNCH_ARGUMENT, serializeDesktopLaunchRequest(focus)])).toEqual(focus);
	});
	it.each([
		[DESKTOP_LAUNCH_ARGUMENT],
		[DESKTOP_LAUNCH_ARGUMENT, "malformed"],
		[DESKTOP_LAUNCH_ARGUMENT, "{}"],
		[DESKTOP_LAUNCH_ARGUMENT, "x".repeat(16_385)],
		[DESKTOP_LAUNCH_ARGUMENT, JSON.stringify(request), DESKTOP_LAUNCH_ARGUMENT, JSON.stringify(request)],
	])("rejects malformed, missing, duplicate, and oversized requests", (...args) => {
		expect(() => readDesktopLaunchRequest(args)).toThrow("launch request is invalid");
	});
	it.each([
		{ schemaVersion: 2 },
		{ arch: "ia32" },
		{ appAsarSha256: "not-a-digest" },
		{ stateHome: "relative" },
		{ projectPath: "/project\ncontrol" },
		{ command: "/bin/sh" },
		{ environment: { PATH: "/override" } },
	])("rejects unsupported identity and unbounded effects", (change) => {
		expect(() =>
			readDesktopLaunchRequest([DESKTOP_LAUNCH_ARGUMENT, JSON.stringify({ ...request, ...change })]),
		).toThrow("launch request is invalid");
	});
});
