import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDesktopLaunchAppIdentity } from "../src/desktop-launch-identity.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(protocolVersion: number | undefined = 1) {
	const root = await realpath(await mkdtemp("/tmp/quarterdeck-launch-identity-"));
	roots.push(root);
	const appPath = join(root, "Quarterdeck.app");
	const resources = join(appPath, "Contents", "Resources");
	const runtime = join(resources, "runtime");
	await mkdir(join(runtime, "bin"), { recursive: true });
	await mkdir(join(runtime, "dist"));
	await writeFile(join(runtime, "bin", "node"), "synthetic-node");
	await writeFile(join(runtime, "dist", "cli.js"), "synthetic-cli");
	await writeFile(
		join(runtime, "bundle-manifest.json"),
		JSON.stringify({
			desktopLaunchProtocolVersion: protocolVersion,
			platform: "darwin",
			arch: "arm64",
			version: "0.12.8",
			buildId: "build-current",
			sourceSha: "a".repeat(40),
		}),
	);
	const appAsar = join(resources, "app.asar");
	await writeFile(appAsar, "synthetic-app");
	return { appPath, appAsar, runtime };
}

describe("actual desktop package launch identity", () => {
	it("binds the package path, architecture, build and native bytes", async () => {
		const f = await fixture();
		const first = await readDesktopLaunchAppIdentity(f.appAsar, f.runtime, "0.12.8", "arm64", readFile);
		expect(first).toEqual({
			version: "0.12.8",
			arch: "arm64",
			appPath: f.appPath,
			buildId: "build-current",
			appAsarSha256: createHash("sha256").update("synthetic-app").digest("hex"),
		});
		await writeFile(f.appAsar, "same-version-new-shell");
		expect(
			(await readDesktopLaunchAppIdentity(f.appAsar, f.runtime, "0.12.8", "arm64", readFile)).appAsarSha256,
		).not.toBe(first.appAsarSha256);
	});
	it.each([undefined, 0, 2])("rejects missing or unsupported launch capability marker %s", async (protocolVersion) => {
		const f = await fixture(protocolVersion);
		if (protocolVersion === undefined) {
			await writeFile(
				join(f.runtime, "bundle-manifest.json"),
				JSON.stringify({
					platform: "darwin",
					arch: "arm64",
					version: "0.12.8",
					buildId: "old-build",
					sourceSha: "a".repeat(40),
				}),
			);
		}
		await expect(readDesktopLaunchAppIdentity(f.appAsar, f.runtime, "0.12.8", "arm64", readFile)).rejects.toThrow(
			"Runtime bundle identity",
		);
	});
	it("rejects a runtime architecture or version different from the app", async () => {
		const f = await fixture();
		await expect(readDesktopLaunchAppIdentity(f.appAsar, f.runtime, "0.12.9", "arm64", readFile)).rejects.toThrow(
			"Runtime bundle identity",
		);
		await expect(readDesktopLaunchAppIdentity(f.appAsar, f.runtime, "0.12.8", "x64", readFile)).rejects.toThrow(
			"Runtime bundle identity",
		);
	});
});
