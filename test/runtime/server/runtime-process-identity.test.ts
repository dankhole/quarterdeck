import { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRuntimeHostIdentity } from "../../../src/server/runtime-process-identity";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

const originalPlatform = process.platform;
afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform });
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("runtime machine identity", () => {
	it("hashes the Windows registry identity with a bounded probe that needs no PowerShell module discovery", async () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		vi.stubEnv("SystemRoot", "C:\\Windows");
		vi.mocked(execFile).mockImplementation((_file, _args, _options, callback) => {
			if (typeof callback === "function") callback(null, " A1234567-1234-1234-1234-123456789ABC\r\n", "");
			return {} as ReturnType<typeof execFile>;
		});

		const identity = await readRuntimeHostIdentity();
		expect(identity).toBe("win32:sha256:dfa38d8830f16f83741943b3b924a0661231a1c784cbb78cd6387cb8527d50e1");
		expect(await readRuntimeHostIdentity()).toBe(identity);
		expect(execFile).toHaveBeenCalledTimes(1);
		expect(execFile).toHaveBeenCalledWith(
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				expect.stringContaining(
					"[Microsoft.Win32.Registry]::GetValue('HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography','MachineGuid',$null)",
				),
			],
			expect.objectContaining({ timeout: 5_000, maxBuffer: 65_536, windowsHide: true }),
			expect.any(Function),
		);
	});
});
