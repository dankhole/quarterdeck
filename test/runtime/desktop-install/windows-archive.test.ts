import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractWindowsDesktopArchive } from "../../../src/desktop-install/windows-archive.js";
import { zipFixture } from "../../utilities/zip-fixture.js";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "quarterdeck-windows-zip-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});
async function extract(entries: Parameters<typeof zipFixture>[0]) {
	const archive = join(root, "candidate.zip"),
		output = join(root, "app");
	await writeFile(archive, zipFixture(entries));
	await extractWindowsDesktopArchive(archive, output);
	return output;
}
describe("bounded Windows release extraction", () => {
	it("preserves nested Unicode files as ordinary private files", async () => {
		const output = await extract([{ name: "resources/项目/a.txt", data: Buffer.from("synthetic release") }]);
		expect(await readFile(join(output, "resources/项目/a.txt"), "utf8")).toBe("synthetic release");
	});
	it.each([
		"../escape",
		"/absolute",
		"C:/absolute",
		"resources/a:stream",
		"resources/NUL.txt",
		"resources/a.",
		"resources/a ",
		"resources\\alias",
	])("refuses unsafe entry %s", async (name) => {
		await expect(extract([{ name, data: Buffer.from("no") }])).rejects.toThrow();
	});
	it("refuses links and case aliases before replacing an existing file", async () => {
		await expect(extract([{ name: "link", attributes: (0o120777 << 16) >>> 0 }])).rejects.toThrow();
		await rm(join(root, "app"), { recursive: true, force: true });
		await expect(
			extract([
				{ name: "Same", data: Buffer.from("first") },
				{ name: "same", data: Buffer.from("second") },
			]),
		).rejects.toThrow();
		expect(await readFile(join(root, "app/Same"), "utf8")).toBe("first");
	});
	it("refuses inconsistent expanded byte counts", async () => {
		await expect(extract([{ name: "bomb", data: Buffer.from("small"), declaredSize: 0xffffffff }])).rejects.toThrow();
	});
});
