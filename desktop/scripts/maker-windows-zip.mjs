import { mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { MakerBase } from "@electron-forge/maker-base";
import { run } from "./process.mjs";

export class MakerWindowsZip extends MakerBase {
	name = "zip";
	defaultPlatforms = ["win32"];

	isSupportedOnCurrentPlatform() {
		return process.platform === "win32";
	}

	async make({ dir, makeDir, packageJSON, targetArch }) {
		const output = resolve(makeDir, "zip", "win32", targetArch, `${basename(dir)}-${packageJSON.version}.zip`);
		await this.ensureFile(output);
		const temporary = await mkdtemp(join(makeDir, ".windows-zip-"));
		try {
			const archive = join(temporary, "app.zip");
			const entries = (await readdir(dir)).sort();
			// Windows PowerShell's .NET ZIP creator fails on long descendant paths.
			// Use the same system bsdtar as runtime staging. List root entries so
			// the installer sees plain relative paths without a leading "./".
			const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
			run(tar, ["-a", "-cf", archive, "-C", dir, "--", ...entries]);
			await rename(archive, output);
			return [output];
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}
}
