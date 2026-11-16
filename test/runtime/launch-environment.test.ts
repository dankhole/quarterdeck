import { execFile } from "node:child_process";
import { release } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usesDesktopLaunchDefault } from "../../src/distribution-policy.js";
import { readLaunchEnvironment } from "../../src/launch-environment.js";
import { resolveLaunchPolicy } from "../../src/launch-policy.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:os", () => ({ release: vi.fn() }));
vi.mock("../../src/distribution-policy.js", () => ({ usesDesktopLaunchDefault: vi.fn() }));
const originalPlatform = process.platform;
const originalArch = process.arch;

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("CI", "false");
	vi.stubEnv("QUARTERDECK_INSTALL_MODE", "");
	vi.stubEnv("SSH_CONNECTION", "");
	vi.mocked(usesDesktopLaunchDefault).mockResolvedValue(true);
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
	it("reads release and prefix preference only after verifying a GUI session", async () => {
		manager("Aqua");
		expect((await readLaunchEnvironment()).desktopDefault).toBe(true);
		expect(usesDesktopLaunchDefault).toHaveBeenCalledOnce();
	});
	it("keeps a headless install on the runtime path and later GUI launch on explicit desktop validation", async () => {
		const plain = { runtimeFlags: false, noOpen: false };
		manager("Background");
		expect(resolveLaunchPolicy(plain, await readLaunchEnvironment())).toEqual({
			mode: "runtime",
			openBrowser: false,
		});
		expect(usesDesktopLaunchDefault).not.toHaveBeenCalled();
		// No browser preference was saved by the headless install. On a later GUI
		// launch the existing desktop launcher validates the app or requires repair.
		manager("Aqua");
		expect(resolveLaunchPolicy(plain, await readLaunchEnvironment())).toEqual({
			mode: "desktop",
			openBrowser: false,
		});
	});
	it("honors a per-invocation browser opt-out without consulting installation defaults", async () => {
		manager("Aqua");
		vi.stubEnv("QUARTERDECK_INSTALL_MODE", "browser");
		expect((await readLaunchEnvironment()).desktopDefault).toBe(false);
		expect(usesDesktopLaunchDefault).not.toHaveBeenCalled();
	});
	it.each(["SSH_CONNECTION", "SSH_TTY", "QUARTERDECK_DESKTOP_CHILD", "CI"])(
		"does not invoke GUI inspection for %s",
		async (key) => {
			vi.stubEnv(key, "1");
			expect((await readLaunchEnvironment()).graphicalSession).toBe(false);
			expect(execFile).not.toHaveBeenCalled();
		},
	);
});
