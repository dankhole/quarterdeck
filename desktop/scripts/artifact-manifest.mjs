import { readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { sha256File } from "./checksums.mjs";
import { desktopResourcePathsForPlatform } from "./desktop-resource-paths.mjs";
import { desktopRoot } from "./paths.mjs";
import { verifyApp } from "./verify-artifact.mjs";

export { sha256File } from "./checksums.mjs";

export async function recordPackagedApp(outputPath, arch) {
	const windows = process.platform === "win32";
	const appPath = windows ? outputPath : join(outputPath, "Quarterdeck.app");
	const manifest = await verifyApp(appPath);
	if (manifest.arch !== arch) throw new Error("Packaged app architecture differs from Forge target.");
	const resources = windows ? join(appPath, "resources") : join(appPath, "Contents", "Resources");
	const files = desktopResourcePathsForPlatform(manifest.platform);
	const checksums = Object.fromEntries(
		await Promise.all(files.map(async (file) => [file, await sha256File(join(resources, file))])),
	);
	const wire = await getCurrentFuseWire(windows ? join(appPath, "QuarterdeckHost.exe") : appPath);
	const fuses = Object.fromEntries(
		Object.entries(FuseV1Options)
			.filter(([, value]) => typeof value === "number")
			.map(([name, index]) => [name, wire[index] === FuseState.ENABLE]),
	);
	const artifactManifest = {
		...manifest,
		distribution:
			manifest.distributionMode === "windows-unsigned"
				? "windows-unsigned-prototype-unverified"
				: manifest.distributionMode === "ad-hoc"
					? "ad-hoc-prototype-unverified"
					: manifest.signedDistribution
						? "signed-prototype-unverified"
						: "unsigned-prototype",
		fuses,
		appPath: relative(join(desktopRoot, "out"), appPath),
		checksums,
		nativeAdmission: {
			schemaVersion: 1,
			bootstrapSha256: await sha256File(join(appPath, windows ? "Quarterdeck.exe" : "Contents/MacOS/Quarterdeck")),
			hostSha256: await sha256File(
				join(appPath, windows ? "QuarterdeckHost.exe" : "Contents/MacOS/QuarterdeckHost"),
			),
		},
		artifacts: [],
	};
	await writeFile(
		join(desktopRoot, "out", `artifact-manifest-${manifest.platform}-${arch}.json`),
		`${JSON.stringify(artifactManifest, null, "\t")}\n`,
	);
}

export async function recordMakeArtifacts(results) {
	for (const arch of new Set(results.map((result) => result.arch))) {
		const platform = results.find((result) => result.arch === arch)?.platform;
		const path = join(desktopRoot, "out", `artifact-manifest-${platform}-${arch}.json`);
		const manifest = JSON.parse(await readFile(path, "utf8"));
		const artifacts = results.filter((result) => result.arch === arch).flatMap((result) => result.artifacts);
		manifest.artifacts = await Promise.all(
			artifacts.map(async (file) => ({
				path: relative(join(desktopRoot, "out"), file),
				bytes: (await stat(file)).size,
				sha256: await sha256File(file),
			})),
		);
		await writeFile(path, `${JSON.stringify(manifest, null, "\t")}\n`);
	}
	return results;
}
