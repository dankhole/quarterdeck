import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
	execFile:
		vi.fn<
			(
				executable: string,
				args: string[],
				options: { encoding: string; maxBuffer: number; env: NodeJS.ProcessEnv; windowsHide: boolean },
				callback: (error: Error | null, stdout: string) => void,
			) => { pid: number; kill: () => boolean }
		>(),
	terminate: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: probe.execFile }));
vi.mock("../../../src/core/process-termination.js", () => ({ terminateProcessForTimeout: probe.terminate }));

import {
	queryWindowsProcessTreeSnapshot,
	runWindowsProcessSnapshot,
	WINDOWS_PROCESS_SNAPSHOT_SCRIPT,
} from "../../../src/core/windows-process-snapshot.js";
import { resolveWindowsPowerShellPath } from "../../../src/core/windows-system-paths.js";

describe("Windows process snapshot leaf", () => {
	beforeEach(() => vi.clearAllMocks());
	afterEach(() => vi.useRealTimers());

	it("uses a fixed absolute noninteractive query and sends PIDs only through environment data", async () => {
		let complete: ((error: Error | null, stdout: string) => void) | undefined;
		probe.execFile.mockImplementation((_executable, _args, _options, callback) => {
			complete = callback;
			return { pid: 123, kill: () => true };
		});
		const result = runWindowsProcessSnapshot([456], true);
		const invocation = probe.execFile.mock.calls[0];
		expect(invocation?.[0]).toBe(resolveWindowsPowerShellPath());
		expect(invocation?.[1].slice(0, 6)).toEqual([
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-EncodedCommand",
		]);
		expect(Buffer.from(invocation?.[1][6] ?? "", "base64").toString("utf16le")).toBe(WINDOWS_PROCESS_SNAPSHOT_SCRIPT);
		expect(invocation?.[2].env.QUARTERDECK_PROCESS_IDENTITY_PIDS).toBe("[456]");
		expect(invocation?.[2].env.QUARTERDECK_PROCESS_SNAPSHOT_ALL).toBe("1");
		expect(invocation?.[2].maxBuffer).toBe(4 * 1024 * 1024);
		expect(invocation?.[2].windowsHide).toBe(true);
		complete?.(null, "[]");
		await expect(result).resolves.toEqual({ ok: true, stdout: "[]" });
	});

	it("bounds the query using the existing exact helper-process timeout policy", async () => {
		vi.useFakeTimers();
		const child = { pid: 123, kill: () => true };
		let complete: ((error: Error | null, stdout: string) => void) | undefined;
		probe.execFile.mockImplementation((_executable, _args, _options, callback) => {
			complete = callback;
			return child;
		});
		const result = runWindowsProcessSnapshot([], true, 1_500);
		await vi.advanceTimersByTimeAsync(1_499);
		expect(probe.terminate).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(probe.terminate).toHaveBeenCalledWith(child);
		complete?.(new Error("synthetic timeout"), "");
		await expect(result).resolves.toEqual({ ok: false, stdout: "" });
	});

	it("preserves unknown birth identities so callers cannot authorize a kill", async () => {
		const runSnapshot = vi.fn(async () => ({
			ok: true,
			stdout: JSON.stringify([
				{ pid: 200, parentPid: 100, creationTime: "638920000000000200" },
				{ pid: 100, parentPid: 1, creationTime: null },
			]),
		}));
		await expect(queryWindowsProcessTreeSnapshot(runSnapshot)).resolves.toEqual([
			{ pid: 200, parentPid: 100, creationTime: "638920000000000200" },
			{ pid: 100, parentPid: 1, creationTime: null },
		]);
		expect(runSnapshot).toHaveBeenCalledWith([], true, 1_500);
	});

	it.each([{ pid: -1, parentPid: 1 }, { pid: 123, parentPid: -1 }, { pid: 123 }])(
		"rejects incomplete forests instead of silently hiding descendants",
		async (row) => {
			await expect(
				queryWindowsProcessTreeSnapshot(async () => ({ ok: true, stdout: JSON.stringify([row]) })),
			).rejects.toThrow("incomplete process tree");
		},
	);

	it("fails closed without exposing query output", async () => {
		await expect(
			queryWindowsProcessTreeSnapshot(async () => ({ ok: false, stdout: "synthetic-secret" })),
		).rejects.toThrow("Could not query Windows process trees.");
	});
});
