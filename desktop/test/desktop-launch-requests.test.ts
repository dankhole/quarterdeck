import { describe, expect, it, vi } from "vitest";
import type { DesktopLaunchRequest } from "../../src/shared/desktop-launch-contract.js";
import { DesktopLaunchRequests, desktopLaunchRefusal } from "../src/desktop-launch-requests.js";

const request: DesktopLaunchRequest = {
	schemaVersion: 1,
	version: "0.12.8",
	appPath: "/Applications/Quarterdeck.app",
	arch: "arm64",
	buildId: "build-current",
	appAsarSha256: "a".repeat(64),
	stateHome: "/private/tmp/state",
	projectPath: "/private/tmp/first",
};

describe("first and subsequent npm desktop launch requests", () => {
	it("waits for renderer admission on first launch and routes a later launch through the same sender", () => {
		const open = vi.fn(() => false);
		const launches = new DesktopLaunchRequests(request, open);
		expect(launches.accept(request)).toBeNull();
		expect(open).toHaveBeenLastCalledWith(request.projectPath);
		open.mockReturnValue(true);
		launches.deliver();
		const calls = open.mock.calls.length;
		launches.deliver();
		expect(open).toHaveBeenCalledTimes(calls);
		expect(launches.accept({ ...request, projectPath: "/private/tmp/second" })).toBeNull();
		expect(open).toHaveBeenLastCalledWith("/private/tmp/second");
	});
	it("does not let a refusal replace an already admitted pending request", () => {
		const open = vi.fn(() => false);
		const launches = new DesktopLaunchRequests(request, open);
		launches.accept(request);
		expect(launches.accept({ ...request, version: "0.12.9", projectPath: "/private/tmp/refused" })).toContain(
			"Quit the running app",
		);
		open.mockReturnValue(true);
		launches.deliver();
		expect(open).toHaveBeenLastCalledWith(request.projectPath);
	});
	it("refuses unsupported older frontends once without later navigating when capability appears", () => {
		const open = vi.fn((): boolean | "unsupported" => "unsupported");
		const refusal = vi.fn();
		const launches = new DesktopLaunchRequests(request, open, refusal);
		launches.accept(request);
		expect(refusal).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("project picker"));
		open.mockReturnValue(true);
		launches.deliver();
		expect(open).toHaveBeenCalledTimes(1);
	});
	it.each([
		{ version: "0.12.9" },
		{ stateHome: "/private/tmp/another-state" },
		{ appPath: "/another/Quarterdeck.app" },
		{ arch: "x64" as const },
		{ buildId: "same-version-rebuild" },
		{ appAsarSha256: "b".repeat(64) },
	])("refuses another package or profile identity without delivering its project", (change) => {
		const open = vi.fn(() => true);
		const launches = new DesktopLaunchRequests(request, open);
		expect(launches.accept({ ...request, ...change })).toContain("Quit");
		expect(open).not.toHaveBeenCalled();
	});
	it("rejects older unsupported apps and invalid envelopes with actionable guidance", () => {
		expect(desktopLaunchRefusal(request, null)).toContain("does not support npm launch requests");
		expect(desktopLaunchRefusal({ ...request, executable: "/bin/sh" }, request)).toContain("invalid");
	});
});
