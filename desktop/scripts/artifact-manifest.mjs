import { readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { sha256File } from "./checksums.mjs";
import { desktopRoot } from "./paths.mjs";
import { verifyApp } from "./verify-artifact.mjs";

export { sha256File } from "./checksums.mjs";

export async function recordPackagedApp(outputPath, arch) {
	const appPath = join(outputPath, "Quarterdeck.app");
	const manifest = await verifyApp(appPath);
	if (manifest.arch !== arch) throw new Error("Packaged app architecture differs from Forge target.");
	const resources = join(appPath, "Contents", "Resources");
	const files = [
		"app.asar",
		"runtime/bin/node",
		"runtime/dist/cli.js",
		"runtime/dist/web-ui/index.html",
		"runtime/bundle-manifest.json",
		"runtime/release-policy.json",
	];
	const checksums = Object.fromEntries(
		await Promise.all(files.map(async (file) => [file, await sha256File(join(resources, file))])),
	);
	const wire = await getCurrentFuseWire(appPath);
	const fuses = Object.fromEntries(
		Object.entries(FuseV1Options)
			.filter(([, value]) => typeof value === "number")
			.map(([name, index]) => [name, wire[index] === FuseState.ENABLE]),
	);
	const artifactManifest = {
		...manifest,
		distribution: manifest.signedDistribution ? "signed-prototype-unverified" : "unsigned-prototype",
		fuses,
		appPath: relative(join(desktopRoot, "out"), appPath),
		checksums,
		artifacts: [],
	};
	await writeFile(
		join(desktopRoot, "out", `artifact-manifest-darwin-${arch}.json`),
		`${JSON.stringify(artifactManifest, null, "\t")}\n`,
	);
}

export async function recordMakeArtifacts(results) {
	for (const arch of new Set(results.map((result) => result.arch))) {
		const path = join(desktopRoot, "out", `artifact-manifest-darwin-${arch}.json`);
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
