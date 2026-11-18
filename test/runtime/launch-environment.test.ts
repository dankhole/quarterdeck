import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { release } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLaunchEnvironment } from "../../src/launch-environment.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:fs", () => ({ existsSync: vi.fn() }));
vi.mock("node:os", () => ({ release: vi.fn() }));
const originalPlatform = process.platform;
const originalArch = process.arch;

beforeEach(() => {
	vi.resetAllMocks();
	for (const key of [
		"QUARTERDECK_INSTALL_MODE",
		"SSH_CONNECTION",
		"SSH_TTY",
		"QUARTERDECK_DESKTOP_CHILD",
		"QUARTERDECK_AGENT_LAB",
	])
		vi.stubEnv(key, "");
	vi.stubEnv("CI", "false");
	Object.defineProperty(process, "platform", { value: "darwin" });
	Object.defineProperty(process, "arch", { value: "arm64" });
	vi.mocked(release).mockReturnValue("25.0.0");
	vi.mocked(existsSync).mockReturnValue(false);
});
afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform });
	Object.defineProperty(process, "arch", { value: originalArch });
	vi.unstubAllEnvs();
});

function manager(name: string, error: Error | null = null): void {
	vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
		if (typeof callback === "function") callback(error, name, "");
		return {} as ReturnType<typeof execFile>;
	});
}

describe("launch environment", () => {
	it("requires an Aqua session and bounds the OS probe", async () => {
		manager("Aqua\n");
		expect((await readLaunchEnvironment()).graphicalSession).toBe(true);
		expect(execFile).toHaveBeenCalledWith(
			"/bin/launchctl",
			["managername"],
			{ timeout: 2_000, maxBuffer: 1_024, windowsHide: true },
			expect.any(Function),
		);
	});
	it.each(["Background", "StandardIO", "User"])("does not treat %s as graphical", async (name) => {
		manager(name);
		expect((await readLaunchEnvironment()).graphicalSession).toBe(false);
	});
	it("does not claim a graphical session when inspection fails", async () => {
		manager("", new Error("unavailable"));
		expect((await readLaunchEnvironment()).graphicalSession).toBe(false);
	});
	it("ignores obsolete browser installation mode", async () => {
		manager("Aqua");
		vi.stubEnv("QUARTERDECK_INSTALL_MODE", "browser");
		expect((await readLaunchEnvironment()).graphicalSession).toBe(true);
	});
	it.each(["SSH_CONNECTION", "SSH_TTY", "QUARTERDECK_DESKTOP_CHILD", "CI"])(
		"does not probe GUI state with %s",
		async (key) => {
			vi.stubEnv(key, "1");
			expect((await readLaunchEnvironment()).graphicalSession).toBe(false);
			expect(execFile).not.toHaveBeenCalled();
		},
	);
	it("admits internal source execution only with source and checkout markers", async () => {
		vi.stubEnv("CI", "true");
		expect((await readLaunchEnvironment()).internalRuntimeAllowed).toBe(false);
		vi.mocked(existsSync).mockReturnValue(true);
		expect((await readLaunchEnvironment()).internalRuntimeAllowed).toBe(true);
		vi.mocked(existsSync).mockImplementation((path) => String(path).endsWith(".git"));
		expect((await readLaunchEnvironment()).internalRuntimeAllowed).toBe(false);
	});
	it("retains explicit isolated Agent Lab access on unsupported headless hosts", async () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		vi.stubEnv("QUARTERDECK_AGENT_LAB", "1");
		expect(await readLaunchEnvironment()).toMatchObject({ graphicalSession: false, internalRuntimeAllowed: true });
		expect(execFile).not.toHaveBeenCalled();
	});
});
