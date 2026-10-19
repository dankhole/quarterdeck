import { execFile } from "node:child_process";
import { release } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLaunchEnvironment } from "../../src/launch-environment.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:os", () => ({ release: vi.fn() }));
const originalPlatform = process.platform;
const originalArch = process.arch;

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("SSH_CONNECTION", "");
	vi.stubEnv("SSH_TTY", "");
	vi.stubEnv("QUARTERDECK_DESKTOP_CHILD", "");
	Object.defineProperty(process, "platform", { value: "darwin" });
	Object.defineProperty(process, "arch", { value: "arm64" });
	vi.mocked(release).mockReturnValue("25.0.0");
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

describe("local graphical session detection", () => {
	it("requires an Aqua bootstrap session and bounds its OS probe", async () => {
		manager("Aqua\n");
		expect((await readLaunchEnvironment()).graphicalSession).toBe(true);
		expect(execFile).toHaveBeenCalledWith(
			"/bin/launchctl",
			["managername"],
			{ timeout: 2_000, maxBuffer: 1_024 },
			expect.any(Function),
		);
	});
	it.each(["Background", "StandardIO", "User"])("treats %s as headless", async (name) => {
		manager(name);
		expect((await readLaunchEnvironment()).graphicalSession).toBe(false);
	});
	it("falls back to headless on unavailable inspection", async () => {
		manager("", new Error("inspection unavailable"));
		expect((await readLaunchEnvironment()).graphicalSession).toBe(false);
	});
	it.each(["SSH_CONNECTION", "SSH_TTY", "QUARTERDECK_DESKTOP_CHILD"])(
		"does not invoke GUI inspection for %s",
		async (key) => {
			vi.stubEnv(key, "1");
			expect((await readLaunchEnvironment()).graphicalSession).toBe(false);
			expect(execFile).not.toHaveBeenCalled();
		},
	);
});
