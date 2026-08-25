import type { ChildProcess, ExecFileException } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { openTargetOnHost } from "../../src/server/browser";

describe("host browser launcher", () => {
	it("awaits the macOS open launcher exit before accepting the request", async () => {
		const launcherState: { complete?: (error: ExecFileException | null) => void } = {};
		const launchMacOpen = vi.fn(
			(_command: string, _args: string[], callback: (error: ExecFileException | null) => void) => {
				launcherState.complete = callback;
			},
		);
		const opened = openTargetOnHost("http://127.0.0.1:3500", {
			platform: "darwin",
			launchMacOpen,
		});
		let settled = false;
		void opened.finally(() => {
			settled = true;
		});

		await Promise.resolve();
		expect(settled).toBe(false);
		expect(launchMacOpen).toHaveBeenCalledWith("/usr/bin/open", ["http://127.0.0.1:3500"], expect.any(Function));

		launcherState.complete?.(null);
		await expect(opened).resolves.toBeUndefined();
	});

	it("surfaces a non-zero macOS launcher exit as a failure", async () => {
		const launcherError = Object.assign(new Error("open exited with code 1"), { code: 1 }) as ExecFileException;

		await expect(
			openTargetOnHost("http://127.0.0.1:3500", {
				platform: "darwin",
				launchMacOpen: (_command, _args, callback) => callback(launcherError),
			}),
		).rejects.toBe(launcherError);
	});

	it("keeps non-macOS launching on the portable opener", async () => {
		const openUrl = vi.fn(async () => ({}) as ChildProcess);

		await expect(
			openTargetOnHost("https://example.com", {
				platform: "linux",
				isBinaryAvailable: () => false,
				openUrl,
			}),
		).resolves.toBeUndefined();
		expect(openUrl).toHaveBeenCalledWith("https://example.com", undefined);
	});
});
