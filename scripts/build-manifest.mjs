import { spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

const uuid = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu;
const version = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-zA-Z.-]+)?$/u;

/** Release identity belongs to the root build, not the later packaging checkout. */
export function readSourceIdentity(repoRoot, execute = spawnSync) {
	const git = (args) => {
		const result = execute("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
		if (result.error || result.status !== 0) throw new Error("Could not determine the build's Git source identity.");
		return result.stdout.trim();
	};
	const sourceSha = git(["rev-parse", "HEAD"]);
	if (!/^[\da-f]{40}$/u.test(sourceSha)) throw new Error("The build requires an exact Git source SHA.");
	return { sourceSha, sourceDirty: git(["status", "--porcelain"]) !== "" };
}

export function validateBuildManifest(manifest) {
	if (
		!manifest ||
		manifest.schemaVersion !== 1 ||
		typeof manifest.version !== "string" ||
		!version.test(manifest.version ?? "") ||
		typeof manifest.buildId !== "string" ||
		!uuid.test(manifest.buildId ?? "") ||
		typeof manifest.sourceSha !== "string" ||
		!/^[\da-f]{40}$/u.test(manifest.sourceSha ?? "") ||
		typeof manifest.sourceDirty !== "boolean"
	) {
		throw new Error("Missing or invalid root build provenance. Run the root `npm run build` again.");
	}
	return manifest;
}

export async function readBuildManifest(distPath) {
	const path = join(distPath, "build-manifest.json");
	const info = await lstat(path);
	if (!info.isFile() || info.size > 16 * 1024) throw new Error("Root build provenance must be a bounded real file.");
	return validateBuildManifest(JSON.parse(await readFile(path, "utf8")));
}
