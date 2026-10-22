import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { linkTaskImageBlobs } from "../../../src/state/task-image-store";
import { createTempDir } from "../../utilities/temp-dir";

const { linkMock } = vi.hoisted(() => ({ linkMock: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof FsPromises>();
	return { ...actual, link: linkMock };
});

let fixture: ReturnType<typeof createTempDir>;

beforeEach(() => {
	fixture = createTempDir("quarterdeck-task-image-link-");
	linkMock.mockReset();
});

afterEach(() => {
	fixture.cleanup();
});

describe("task image blob linking fallback", () => {
	it.each(["EXDEV", "EPERM"])("copies blobs when hard links fail with %s", async (code) => {
		const bytes = Buffer.from(`fallback-${code}`);
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const source = join(fixture.path, "source");
		const target = join(fixture.path, "target");
		mkdirSync(source);
		writeFileSync(join(source, sha256), bytes);
		linkMock.mockRejectedValue(Object.assign(new Error("link unavailable"), { code }));

		expect(await linkTaskImageBlobs(source, target, { verifySource: true })).toBe(1);
		expect(linkMock).toHaveBeenCalledTimes(1);
		expect(readFileSync(join(target, sha256))).toEqual(bytes);
		if (process.platform !== "win32") {
			expect(statSync(join(target, sha256)).ino).not.toBe(statSync(join(source, sha256)).ino);
		}
	});

	it("propagates unexpected link failures", async () => {
		const bytes = Buffer.from("unexpected");
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const source = join(fixture.path, "source");
		mkdirSync(source);
		writeFileSync(join(source, sha256), bytes);
		linkMock.mockRejectedValue(Object.assign(new Error("io failure"), { code: "EIO" }));

		await expect(linkTaskImageBlobs(source, join(fixture.path, "target"))).rejects.toThrow("io failure");
	});
});
