import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MakerBase } from "@electron-forge/maker-base";
import { requireNativeMacTarget } from "./paths.mjs";

async function runTimed(stage, command, args) {
	console.log(`[desktop timing] dmg.${stage}: start`);
	const started = performance.now();
	let outcome = "failure";
	try {
		await new Promise((resolve, reject) => {
			const child = spawn(command, args, { stdio: "inherit" });
			child.once("error", reject);
			child.once("close", (code, signal) => {
				if (code === 0) resolve();
				else if (signal) reject(new Error(`${command} terminated by ${signal}.`));
				else reject(new Error(`${command} exited with code ${code ?? "unknown"}.`));
			});
		});
		outcome = "success";
	} finally {
		console.log(`[desktop timing] dmg.${stage}: ${outcome} (${Math.round(performance.now() - started)} ms)`);
	}
}

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
			await runTimed("ditto", "/usr/bin/ditto", [resolve(dir, `${appName}.app`), join(source, `${appName}.app`)]);
			await symlink("/Applications", join(source, "Applications"));
			const image = join(temporary, "image.dmg");
			await runTimed("create", "/usr/bin/hdiutil", [
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
			await runTimed("verify", "/usr/bin/hdiutil", ["verify", image]);
			await rename(image, output);
			return [output];
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}
}
