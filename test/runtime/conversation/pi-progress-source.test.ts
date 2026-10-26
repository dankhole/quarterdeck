import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPiProgressSource } from "../../../src/conversation/pi-progress-source";
import { createTempDir } from "../../utilities/temp-dir";

vi.mock("node:fs/promises", { spy: true });

describe("Pi exact source nonblocking admission", () => {
	afterEach(() => vi.restoreAllMocks());
	it.skipIf(process.platform === "win32")("rejects a FIFO swapped in after lstat without blocking open", async () => {
		const temporary = createTempDir("pi-progress-fifo-");
		const sourcePath = join(temporary.path, "history.jsonl");
		await fs.writeFile(sourcePath, "{}\n");
		const open = fs.open;
		const intercepted = vi.spyOn(fs, "open").mockImplementationOnce(async (path, flags, mode) => {
			// Assert the safety property before creating a FIFO: a regression must
			// fail this test, not leave a blocked open in Vitest's worker pool.
			expect(typeof flags).toBe("number");
			expect(typeof flags === "number" && (flags & constants.O_NONBLOCK) !== 0).toBe(true);
			await fs.unlink(sourcePath);
			execFileSync("mkfifo", [sourcePath]);
			return await open(path, flags, mode);
		});
		try {
			expect(
				await openPiProgressSource({
					providerId: "pi",
					providerSessionId: "session",
					sessionInstanceId: "launch",
					sourcePath,
				}),
			).toBeNull();
			expect(intercepted).toHaveBeenCalled();
		} finally {
			await temporary.cleanupAsync();
		}
	});
});
