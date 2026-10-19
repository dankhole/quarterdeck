import { spawnSync } from "node:child_process";
import { chmod, copyFile, lstat, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { desktopRoot } from "./paths.mjs";

/** Call after fuse mutation and before the final app signature. */
async function installNativeAdmission(appPath, testHome) {
	const executable = join(appPath, "Contents", "MacOS", "Quarterdeck");
	const host = join(appPath, "Contents", "MacOS", "QuarterdeckHost");
	const source = join(desktopRoot, "native", "installation-admission.c");
	const output = join(appPath, "Contents", "MacOS", ".QuarterdeckAdmission");
	const args = ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=13.0"];
	if (testHome !== undefined) args.push(`-DQUARTERDECK_ADMISSION_TEST_HOME=${JSON.stringify(testHome)}`);
	const result = spawnSync("/usr/bin/clang", [...args, source, "-o", output], {
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error("The native installation admission bootstrap could not be built.");
	try {
		await lstat(host);
		if (testHome === undefined) throw new Error("Native admission was already installed in this candidate.");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		await rename(executable, host);
	}
	await rename(output, executable);
	const entries = [
		"Contents/Resources/runtime/bin/node",
		...["", " (GPU)", " (Renderer)", " (Plugin)", " (Utility)"].map(
			(suffix) => `Contents/Frameworks/Quarterdeck Helper${suffix}.app/Contents/MacOS/Quarterdeck Helper${suffix}`,
		),
		"Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler",
	];
	for (const relative of entries) {
		const entry = join(appPath, relative);
		const name = basename(entry);
		const entryHost = name.startsWith("Quarterdeck Helper")
			? join(dirname(entry), name.replace(/^Quarterdeck/u, "QuarterdeckHost"))
			: `${entry}Host`;
		try {
			await lstat(entry);
		} catch (error) {
			if (error.code === "ENOENT") continue;
			throw error;
		}
		try {
			await lstat(entryHost);
			if (testHome === undefined) throw new Error("Native helper admission was already installed.");
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			await rename(entry, entryHost);
		}
		await copyFile(executable, entry);
		await chmod(entry, 0o755);
	}
	// Keep a resource copy available for verified installer lock-server execution.
	await copyFile(executable, join(appPath, "Contents", "Resources", "runtime", "installation-admission"));
	await chmod(executable, 0o755);
}

export async function installDesktopNativeAdmission(appPath) {
	return installNativeAdmission(appPath);
}

/** Synthetic copied app only. The constant cannot be changed by a production process environment. */
export async function installSyntheticDesktopNativeAdmission(appPath, testHome) {
	if (!testHome || !appPath.startsWith(`${testHome}/Applications/`) || !testHome.includes("/.cache/test-results/"))
		throw new Error("Synthetic native admission must use an isolated worktree test-results home.");
	return installNativeAdmission(appPath, testHome);
}
