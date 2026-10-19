import { chmod, mkdir } from "node:fs/promises";
import { beforeEach, expect, it, vi } from "vitest";

import { ensurePrivateDirectories } from "../../../src/core/private-directory";

vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), chmod: vi.fn() }));

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(mkdir).mockResolvedValue(undefined);
	vi.mocked(chmod).mockResolvedValue(undefined);
});

it.each(["mkdir", "chmod"] as const)("drains sibling %s work before returning a preparation failure", async (stage) => {
	const failure = Object.assign(new Error("synthetic blocked directory"), { code: "ENOTDIR" });
	let finishSibling: (() => void) | undefined;
	const sibling = new Promise<void>((resolve) => {
		finishSibling = resolve;
	});
	if (stage === "mkdir") {
		vi.mocked(mkdir)
			.mockRejectedValueOnce(failure)
			.mockImplementationOnce(async () => {
				await sibling;
				return undefined;
			});
	} else {
		vi.mocked(chmod)
			.mockRejectedValueOnce(failure)
			.mockImplementationOnce(async () => await sibling);
	}
	const runWindowsAclCommand = vi.fn(async () => ({ ok: true }));
	const preparation = ensurePrivateDirectories(["synthetic-root", "synthetic-descendant"], {
		platform: stage === "mkdir" ? "win32" : "linux",
		runWindowsAclCommand,
	});
	const result = preparation.catch((error: unknown) => error);
	let settled = false;
	void result.then(() => {
		settled = true;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	try {
		expect(settled).toBe(false);
		expect(runWindowsAclCommand).not.toHaveBeenCalled();
	} finally {
		finishSibling?.();
	}
	expect(await result).toBe(failure);
	expect(runWindowsAclCommand).not.toHaveBeenCalled();
});
