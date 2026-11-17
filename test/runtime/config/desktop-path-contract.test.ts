import { describe, expect, it } from "vitest";
import { desktopInstallationOwnerSchema } from "../../../src/shared/desktop-installation-contract.js";
import {
	DESKTOP_LAUNCH_ARGUMENT,
	readDesktopLaunchRequest,
	serializeDesktopLaunchRequest,
} from "../../../src/shared/desktop-launch-contract.js";
import { desktopAbsolutePathSchema } from "../../../src/shared/desktop-path-contract.js";

describe("desktop filesystem wire paths", () => {
	it.each([
		"/Users/synthetic/Applications/Quarterdeck.app",
		"C:\\Users\\Synthetic User\\Quarterdeck",
		"D:/项目/app",
		"\\\\server\\share\\project",
	])("accepts absolute path %s", (path) => {
		expect(desktopAbsolutePathSchema.parse(path)).toBe(path);
	});
	it.each([
		"",
		"relative",
		"C:relative",
		"\\rooted",
		"\\\\server",
		"\\\\?\\C:\\app",
		"\\\\.\\pipe\\app",
		"/bad\npath",
		"C:\\bad\0path",
	])("rejects ambiguous or control path %s", (path) => {
		expect(desktopAbsolutePathSchema.safeParse(path).success).toBe(false);
	});
	it("round trips a Windows launch and validates its npm owner", () => {
		const request = {
			schemaVersion: 1 as const,
			version: "0.12.16",
			arch: "x64" as const,
			appPath: "C:\\Users\\Synthetic User\\AppData\\Local\\Programs\\Quarterdeck",
			stateHome: "C:\\Users\\Synthetic User\\.quarterdeck",
			projectPath: "D:\\项目\\test",
			buildId: "synthetic-build",
			appAsarSha256: "a".repeat(64),
		};
		expect(readDesktopLaunchRequest([DESKTOP_LAUNCH_ARGUMENT, serializeDesktopLaunchRequest(request)])).toEqual(
			request,
		);
		expect(
			desktopInstallationOwnerSchema.safeParse({
				kind: "npm",
				prefix: "C:\\npm",
				packageSlot: "C:\\npm\\node_modules\\quarterdeck",
				packageRoot: "C:\\npm\\node_modules\\quarterdeck",
				identity: {
					schemaVersion: 1,
					version: "0.12.16",
					buildId: "11111111-1111-4111-8111-111111111111",
					sourceSha: "a".repeat(40),
					sourceDirty: false,
				},
			}).success,
		).toBe(true);
	});
});
