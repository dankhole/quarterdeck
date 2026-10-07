import { cp, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyRuntimeResource, validateRuntimeDependencyLinks } from "../scripts/runtime-resources.mjs";

let root;
let runtimePath;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "quarterdeck-runtime-resource-test-"));
	runtimePath = join(root, "stage", "runtime");
	await mkdir(join(runtimePath, "node_modules", ".bin"), { recursive: true });
	await mkdir(join(runtimePath, "node_modules", "typescript", "bin"), { recursive: true });
	await writeFile(join(runtimePath, "node_modules", "typescript", "bin", "tsc"), "synthetic compiler");
	await symlink("../typescript/bin/tsc", join(runtimePath, "node_modules", ".bin", "tsc"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("self-contained runtime resource copying", () => {
	it("reproduces Packager's default absolute-link copy and rejects it", async () => {
		const copy = join(root, "default-copy", "runtime");
		// This is @electron/packager20.3.0's installed extraResource copy configuration.
		await cp(runtimePath, copy, { recursive: true });
		expect(await readlink(join(copy, "node_modules", ".bin", "tsc"))).toBe(
			join(runtimePath, "node_modules", "typescript", "bin", "tsc"),
		);
		await expect(validateRuntimeDependencyLinks(copy)).rejects.toThrow("must be relative");
	});

	it("copies outside ASAR and preserves relative executable links after the source disappears", async () => {
		const buildPath = join(root, "package", "Electron.app", "Contents", "Resources", "app");
		await mkdir(buildPath, { recursive: true });
		await copyRuntimeResource(runtimePath, buildPath);
		const copiedRuntime = join(dirname(buildPath), "runtime");
		const link = join(copiedRuntime, "node_modules", ".bin", "tsc");
		expect(await readlink(link)).toBe("../typescript/bin/tsc");
		expect(await readlink(join(runtimePath, "node_modules", ".bin", "tsc"))).toBe("../typescript/bin/tsc");
		await rm(runtimePath, { recursive: true });
		expect(await realpath(link)).toBe(
			await realpath(join(copiedRuntime, "node_modules", "typescript", "bin", "tsc")),
		);
		expect(await readFile(link, "utf8")).toBe("synthetic compiler");
		await expect(validateRuntimeDependencyLinks(copiedRuntime)).resolves.toBeUndefined();
	});

	it("does not overwrite an occupied runtime destination", async () => {
		const buildPath = join(root, "package", "Resources", "app");
		const occupiedRuntime = join(dirname(buildPath), "runtime");
		await mkdir(join(occupiedRuntime, "node_modules", ".bin"), { recursive: true });
		await mkdir(join(occupiedRuntime, "node_modules", "typescript", "bin"), { recursive: true });
		const existingFile = join(occupiedRuntime, "node_modules", "typescript", "bin", "tsc");
		await writeFile(existingFile, "existing destination");
		await expect(copyRuntimeResource(runtimePath, buildPath)).rejects.toThrow();
		expect(await readFile(existingFile, "utf8")).toBe("existing destination");
	});

	it.each(["absolute", "external", "dangling", "directory"])("rejects invalid npm aliases: %s", async (kind) => {
		const link = join(runtimePath, "node_modules", ".bin", "bad");
		if (kind === "absolute") await symlink(join(runtimePath, "node_modules", "typescript", "bin", "tsc"), link);
		else if (kind === "external") {
			await writeFile(join(runtimePath, "outside-modules"), "external");
			await symlink("../../outside-modules", link);
		} else if (kind === "dangling") await symlink("../missing", link);
		else await symlink("../typescript", link);
		const buildPath = join(root, "package", "Resources", "app");
		await expect(copyRuntimeResource(runtimePath, buildPath)).rejects.toThrow();
		await expect(lstat(join(dirname(buildPath), "runtime"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects other dependency symlinks and a .bin directory alias", async () => {
		await symlink("typescript", join(runtimePath, "node_modules", "aliased-package"));
		await expect(validateRuntimeDependencyLinks(runtimePath)).rejects.toThrow("outside an npm .bin");
		await rm(join(runtimePath, "node_modules", "aliased-package"));
		await rm(join(runtimePath, "node_modules", ".bin"), { recursive: true });
		await symlink("typescript/bin", join(runtimePath, "node_modules", ".bin"));
		await expect(validateRuntimeDependencyLinks(runtimePath)).rejects.toThrow("outside an npm .bin");
	});
});
