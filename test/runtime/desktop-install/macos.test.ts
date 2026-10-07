import type { ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopInstallationError } from "../../../src/desktop-install/errors.js";
import type { DesktopInstallCommandResult } from "../../../src/desktop-install/types.js";

const childProcessMocks = vi.hoisted(() => ({
	execFile: vi.fn(),
	execute:
		vi.fn<
			(command: string, args: readonly string[], options: ExecFileOptions) => Promise<DesktopInstallCommandResult>
		>(),
}));

vi.mock("node:child_process", () => ({
	execFile: Object.assign(childProcessMocks.execFile, { [promisify.custom]: childProcessMocks.execute }),
}));

import { runDesktopInstallCommand } from "../../../src/desktop-install/macos.js";

beforeEach(() => {
	childProcessMocks.execFile.mockReset();
	childProcessMocks.execute.mockReset();
});

function processFailure(fields: Record<string, unknown>): Error {
	return Object.assign(new Error("SYNTHETIC_PRIVATE_MESSAGE"), {
		cmd: "/private/SYNTHETIC_PRIVATE_COMMAND --SYNTHETIC_PRIVATE_ARGUMENT",
		stdout: "SYNTHETIC_PRIVATE_STDOUT",
		stderr: "SYNTHETIC_PRIVATE_STDERR",
		...fields,
	});
}

describe("content-safe macOS installer command failures", () => {
	it.each([
		["/usr/bin/codesign", "--verify", "signature verification"],
		["/usr/bin/codesign", "--display", "signing identity inspection"],
		["/usr/sbin/spctl", "--assess", "Gatekeeper assessment"],
		["/usr/bin/plutil", "-convert", "app metadata inspection"],
		["/usr/bin/lipo", "-archs", "native architecture inspection"],
		["/usr/bin/ditto", "/private/SYNTHETIC_PRIVATE_SOURCE", "app copy"],
		["/usr/bin/hdiutil", "attach", "DMG mount"],
		["/usr/bin/hdiutil", "detach", "DMG unmount"],
		["/private/SYNTHETIC_PRIVATE_COMMAND", "SYNTHETIC_PRIVATE_ARGUMENT", "desktop artifact operation"],
	])("retains a fixed operation label for %s %s", async (command, argument, operation) => {
		childProcessMocks.execute.mockRejectedValueOnce(processFailure({ code: 3 }));
		const error = await runDesktopInstallCommand(command, [argument, "/private/SYNTHETIC_PRIVATE_PATH"]).catch(
			(failure: unknown) => failure,
		);
		expect(error).toBeInstanceOf(DesktopInstallationError);
		expect(error).toMatchObject({
			code: "command_failed",
			message: `macOS ${operation} failed (exit 3). The existing installation was retained.`,
		});
	});

	it.each([
		[{ code: null, killed: true, signal: "SIGTERM" }, "timeout"],
		[{ code: "ETIMEDOUT" }, "timeout"],
		[{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGTERM" }, "output limit"],
		[{ code: null, signal: "SIGKILL" }, "signal termination"],
		[{ code: "ENOENT" }, "command unavailable"],
		[{ code: "EACCES" }, "permission denied"],
		[{ code: 999_999 }, "execution failure"],
		[{ code: "SYNTHETIC_PRIVATE_CODE" }, "execution failure"],
	])("bounds process failure metadata to %s", async (fields, category) => {
		childProcessMocks.execute.mockRejectedValueOnce(processFailure(fields));
		const error = await runDesktopInstallCommand("/usr/bin/ditto", ["/private/SYNTHETIC_PRIVATE_PATH"]).catch(
			(failure: unknown) => failure,
		);
		expect(error).toMatchObject({
			code: "command_failed",
			message: `macOS app copy failed (${category}). The existing installation was retained.`,
		});
	});

	it("retains successful output and the existing bounded execution options", async () => {
		const output = { stdout: "valid metadata", stderr: "valid signature metadata" };
		childProcessMocks.execute.mockResolvedValueOnce(output);
		await expect(runDesktopInstallCommand("/usr/bin/plutil", ["-convert", "json"])).resolves.toEqual(output);
		const options = childProcessMocks.execute.mock.calls[0]?.[2];
		expect({
			encoding: options?.encoding,
			timeout: options?.timeout,
			maxBuffer: options?.maxBuffer,
			path: options?.env?.PATH,
			shell: options?.shell,
		}).toEqual({
			encoding: "utf8",
			timeout: 180_000,
			maxBuffer: 256 * 1024,
			path: "/usr/bin:/bin:/usr/sbin:/sbin",
			shell: undefined,
		});
	});
});
