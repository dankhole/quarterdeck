import { describe, expect, it, vi } from "vitest";

import { resolveWindowsTaskkillPath, terminateProcessTree } from "../../scripts/process-tree.mjs";

describe("script process-tree termination", () => {
	it("resolves taskkill from a case-insensitive SystemRoot without PATH lookup", () => {
		expect(resolveWindowsTaskkillPath({ systemroot: "D:\\Windows" })).toBe(
			"D:\\Windows\\System32\\taskkill.exe",
		);
	});

	it("terminates the full Windows PID tree with hidden taskkill", () => {
		const execFile = vi.fn((_command, _args, _options, callback) => callback(null));
		const callback = vi.fn();

		terminateProcessTree(4321, "SIGKILL", callback, {
			platform: "win32",
			env: { WINDIR: "C:\\Windows" },
			execFile,
		});

		expect(execFile).toHaveBeenCalledWith(
			"C:\\Windows\\System32\\taskkill.exe",
			["/pid", "4321", "/T", "/F"],
			{ timeout: 10_000, windowsHide: true },
			expect.any(Function),
		);
		expect(callback).toHaveBeenCalledWith(undefined);
	});
});
