import { mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MakerBase } from "@electron-forge/maker-base";
import { requireNativeMacTarget } from "./paths.mjs";
import { run } from "./process.mjs";

/** Native installation container; signing and notarization remain release gates. */
export class MakerDMG extends MakerBase {
	name = "dmg";
	defaultPlatforms = ["darwin"];
	requiredExternalBinaries = ["/usr/bin/ditto", "/usr/bin/hdiutil"];

	isSupportedOnCurrentPlatform() {
		return process.platform === "darwin";
	}

	async make({ dir, makeDir, appName, packageJSON, targetArch }) {
		requireNativeMacTarget(targetArch);
		const outputDirectory = resolve(makeDir, "dmg", targetArch);
		const output = join(
			outputDirectory,
			`${this.config.name || `${appName}-${packageJSON.version}-${targetArch}`}.dmg`,
		);
		await mkdir(outputDirectory, { recursive: true });
		const temporary = await mkdtemp(join(outputDirectory, ".dmg-"));
		try {
			const source = join(temporary, "source");
			await mkdir(source);
			// ditto preserves signed bundle metadata, executable modes, and framework symlinks.
			run("/usr/bin/ditto", [resolve(dir, `${appName}.app`), join(source, `${appName}.app`)]);
			await symlink("/Applications", join(source, "Applications"));
			const image = join(temporary, "image.dmg");
			run("/usr/bin/hdiutil", [
				"create",
				"-srcfolder",
				source,
				"-volname",
				appName,
				"-fs",
				"HFS+",
				"-format",
				"ULFO",
				image,
			]);
			run("/usr/bin/hdiutil", ["verify", image]);
			await rename(image, output);
			return [output];
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}
}
