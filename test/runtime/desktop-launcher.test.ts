import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDesktopInstallation } from "../../src/desktop-install/index.js";
import { launchDesktop } from "../../src/desktop-launcher.js";
import { resolveCanonicalRuntimeStateHome } from "../../src/server/runtime-ownership.js";
import { hasGitRepository } from "../../src/server/runtime-startup-paths.js";
import { readDesktopLaunchRequest } from "../../src/shared/desktop-launch-contract.js";
import { isUnderWorktreesHome } from "../../src/state/project-state-utils.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:fs/promises", () => ({ realpath: vi.fn() }));
vi.mock("../../src/desktop-install/index.js", () => ({ ensureDesktopInstallation: vi.fn() }));
vi.mock("../../src/server/runtime-ownership.js", () => ({ resolveCanonicalRuntimeStateHome: vi.fn() }));
vi.mock("../../src/server/runtime-startup-paths.js", () => ({ hasGitRepository: vi.fn() }));
vi.mock("../../src/state/project-state-utils.js", () => ({ isUnderWorktreesHome: vi.fn() }));

const platform = process.platform;
const installation = {
	appPath: "/synthetic/Quarterdeck Ω.app",
	version: "0.12.8",
	arch: "arm64" as const,
	source: "local" as const,
	installId: "synthetic-install",
	buildId: "synthetic-build",
	appAsarSha256: "a".repeat(64),
	receiptPath: "/synthetic/managed-installation.json",
};

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("QUARTERDECK_DESKTOP_CHILD", "");
	Object.defineProperty(process, "platform", { value: "darwin" });
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.mocked(realpath).mockResolvedValue("/synthetic/repo $() ' Ω");
	vi.mocked(resolveCanonicalRuntimeStateHome).mockResolvedValue("/synthetic/canonical state");
	vi.mocked(hasGitRepository).mockResolvedValue(true);
	vi.mocked(isUnderWorktreesHome).mockReturnValue(false);
	vi.mocked(ensureDesktopInstallation).mockResolvedValue(installation);
	vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
		if (typeof callback === "function") callback(null, "", "");
		return {} as ReturnType<typeof execFile>;
	});
});

afterEach(() => {
	Object.defineProperty(process, "platform", { value: platform });
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("optional desktop launch", () => {
	it("passes the selected immutable app and canonical project/state as data through LaunchServices", async () => {
		await launchDesktop("0.12.8");
		expect(ensureDesktopInstallation).toHaveBeenCalledWith({ version: "0.12.8", onProgress: expect.any(Function) });
		const call = vi.mocked(execFile).mock.calls[0];
		expect(call?.[0]).toBe("/usr/bin/open");
		const args = call?.[1];
		expect(Array.isArray(args)).toBe(true);
		if (!Array.isArray(args)) throw new Error("Missing launch arguments");
		expect(args.slice(0, 5)).toEqual(["-n", "-a", installation.appPath, "--args", "--quarterdeck-launch"]);
		expect(readDesktopLaunchRequest(args)).toEqual({
			schemaVersion: 1,
			version: installation.version,
			appPath: installation.appPath,
			arch: installation.arch,
			buildId: installation.buildId,
			appAsarSha256: installation.appAsarSha256,
			stateHome: "/synthetic/canonical state",
			projectPath: "/synthetic/repo $() ' Ω",
		});
		expect(console.log).toHaveBeenCalledWith(expect.stringContaining("launch requested"));
	});
	it.each(["outside Git", "managed worktree"])("does not open a project for %s", async (kind) => {
		vi.mocked(hasGitRepository).mockResolvedValue(kind !== "outside Git");
		vi.mocked(isUnderWorktreesHome).mockReturnValue(kind === "managed worktree");
		await launchDesktop("0.12.8");
		const args = vi.mocked(execFile).mock.calls[0]?.[1];
		if (!Array.isArray(args)) throw new Error("Missing launch arguments");
		expect(readDesktopLaunchRequest(args)?.projectPath).toBeUndefined();
	});
	it("rejects unsupported hosts before filesystem, download or launch effects", async () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		await expect(launchDesktop("0.12.8")).rejects.toThrow("--browser");
		expect(resolveCanonicalRuntimeStateHome).not.toHaveBeenCalled();
		expect(ensureDesktopInstallation).not.toHaveBeenCalled();
		expect(execFile).not.toHaveBeenCalled();
	});
	it("does not recurse from a desktop helper", async () => {
		vi.stubEnv("QUARTERDECK_DESKTOP_CHILD", "1");
		await expect(launchDesktop("0.12.8")).rejects.toThrow("helper");
		expect(ensureDesktopInstallation).not.toHaveBeenCalled();
	});
	it("does not launch after failed installation or validation", async () => {
		vi.mocked(ensureDesktopInstallation).mockRejectedValue(new Error("Release unavailable"));
		await expect(launchDesktop("0.12.8")).rejects.toThrow("Release unavailable");
		expect(execFile).not.toHaveBeenCalled();
	});
	it("rejects failed LaunchServices requests without printing launch success", async () => {
		vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
			if (typeof callback === "function") callback(new Error("LaunchServices failed"), "", "");
			return {} as ReturnType<typeof execFile>;
		});
		await expect(launchDesktop("0.12.8")).rejects.toThrow("LaunchServices failed");
		expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("launch requested"));
	});
});
