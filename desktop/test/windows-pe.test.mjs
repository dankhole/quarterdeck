import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { desktopResourcePathsForPlatform } from "../scripts/desktop-resource-paths.mjs";
import { windowsPeArchitecture } from "../scripts/windows-pe.mjs";

const roots = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(machine) {
	const root = await mkdtemp(join(tmpdir(), "quarterdeck-pe-"));
	roots.push(root);
	const path = join(root, "candidate.exe");
	const bytes = Buffer.alloc(128);
	bytes.writeUInt16LE(0x5a4d, 0);
	bytes.writeUInt32LE(64, 60);
	bytes.writeUInt32LE(0x4550, 64);
	bytes.writeUInt16LE(machine, 68);
	await writeFile(path, bytes);
	return { path, bytes };
}
describe("Windows desktop artifact admission", () => {
	it.each([
		[0x8664, "x64"],
		[0xaa64, "arm64"],
	])("recognizes native PE machine %s", async (machine, arch) => {
		const { path } = await fixture(machine);
		expect(await windowsPeArchitecture(path)).toBe(arch);
	});
	it.each(["dos", "offset", "signature", "truncated", "ia32"])(
		"rejects unsupported or corrupt %s headers",
		async (kind) => {
			const { path, bytes } = await fixture(kind === "ia32" ? 0x14c : 0x8664);
			if (kind === "dos") bytes.writeUInt16LE(0, 0);
			if (kind === "offset") bytes.writeUInt32LE(0xffffffff, 60);
			if (kind === "signature") bytes.writeUInt32LE(0, 64);
			await writeFile(path, kind === "truncated" ? bytes.subarray(0, 67) : bytes);
			await expect(windowsPeArchitecture(path)).rejects.toThrow();
		},
	);
	it("uses Windows admission binaries while keeping shared resources and the macOS list", () => {
		const windows = desktopResourcePathsForPlatform("win32");
		const mac = desktopResourcePathsForPlatform("darwin");
		expect(windows).toContain("runtime/installation-admission.exe");
		expect(windows).toContain("runtime/bin/nodeHost.exe");
		expect(windows).not.toContain("runtime/bin/node");
		expect(mac).toContain("runtime/bin/node");
		expect(windows).toContain("runtime/dist/hooks.js");
		expect(() => desktopResourcePathsForPlatform("linux")).toThrow();
	});
});
