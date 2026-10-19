import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	matchesProjectDirectoryIdentity,
	projectDirectoryIdentitySchema,
	readProjectDirectoryIdentity,
} from "../../src/fs/project-directory-identity";
import { createTempDir } from "../utilities/temp-dir";

describe("project directory identity", () => {
	const saved = { device: "10", inode: "20", darwinBirthtimeNs: "300" };

	it("matches Darwin inode and creation time across device-number changes", () => {
		expect(matchesProjectDirectoryIdentity(saved, { ...saved, device: "11" })).toBe(true);
	});

	it.each([
		{ ...saved, inode: "21" },
		{ ...saved, darwinBirthtimeNs: "301" },
		{ device: saved.device, inode: saved.inode },
	])("rejects changed or missing saved Darwin fingerprint evidence: %j", (observed) => {
		expect(matchesProjectDirectoryIdentity(saved, observed)).toBe(false);
	});

	it("retains exact device and inode matching for legacy identities", () => {
		const legacy = { device: saved.device, inode: saved.inode };
		expect(matchesProjectDirectoryIdentity(legacy, legacy)).toBe(true);
		expect(matchesProjectDirectoryIdentity(legacy, saved)).toBe(true);
		expect(matchesProjectDirectoryIdentity(legacy, { ...saved, device: "11" })).toBe(false);
		expect(matchesProjectDirectoryIdentity(legacy, { ...saved, inode: "21" })).toBe(false);
	});

	it.each(["1", "300", "9223372036854775808123"])("accepts positive creation-time evidence %s", (value) => {
		expect(projectDirectoryIdentitySchema.parse({ ...saved, darwinBirthtimeNs: value })).toEqual({
			...saved,
			darwinBirthtimeNs: value,
		});
	});

	it.each(["", "0", "-1", "01", "1.5", "unknown"])("rejects invalid creation-time evidence %j", (value) => {
		expect(projectDirectoryIdentitySchema.safeParse({ ...saved, darwinBirthtimeNs: value }).success).toBe(false);
	});

	it("accepts a legacy identity without creation-time evidence", () => {
		expect(projectDirectoryIdentitySchema.parse({ device: "10", inode: "20" })).toEqual({
			device: "10",
			inode: "20",
		});
	});

	it("captures a real directory identity that survives content edits and rename but rejects replacement", async () => {
		const root = createTempDir("quarterdeck-directory-identity-");
		try {
			const original = join(root.path, "original");
			const moved = join(root.path, "moved");
			await mkdir(original);
			const before = await readProjectDirectoryIdentity(original);
			const entry = await stat(original, { bigint: true });
			expect(before).toEqual({
				device: entry.dev.toString(),
				inode: entry.ino.toString(),
				...(process.platform === "darwin" && entry.birthtimeNs > 0n
					? { darwinBirthtimeNs: entry.birthtimeNs.toString() }
					: {}),
			});
			await writeFile(join(original, "content"), "synthetic first content");
			await writeFile(join(original, "content"), "synthetic changed content");
			expect(await readProjectDirectoryIdentity(original)).toEqual(before);
			await rename(original, moved);
			const afterRename = await readProjectDirectoryIdentity(moved);
			expect(afterRename).toEqual(before);
			expect(matchesProjectDirectoryIdentity(before, afterRename)).toBe(true);
			await mkdir(original);
			expect(matchesProjectDirectoryIdentity(before, await readProjectDirectoryIdentity(original))).toBe(false);
		} finally {
			root.cleanup();
		}
	});
});
