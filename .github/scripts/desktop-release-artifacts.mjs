import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const sourcePattern = /^[a-f0-9]{40}$/u;

export async function checksum(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

export function artifactNames(version, arch) {
	if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(version)) throw new Error("Invalid release version.");
	if (!["arm64", "x64"].includes(arch)) throw new Error("Unsupported release architecture.");
	return ["dmg", "zip"].map((extension) => `Quarterdeck-${version}-darwin-${arch}.${extension}`);
}

export async function validateRelease(directory, version, sourceSha) {
	if (!sourcePattern.test(sourceSha)) throw new Error("Release source must be an exact commit SHA.");
	const production = /^\d+\.\d+\.\d+$/u.test(version);
	const files = [];
	let first;
	for (const arch of ["arm64", "x64"]) {
		const manifestName = `artifact-manifest-darwin-${arch}.json`;
		const manifestPath = join(directory, manifestName);
		if (!(await lstat(manifestPath)).isFile()) throw new Error("Manifest must be a real file.");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		if (
			manifest.schemaVersion !== 1 ||
			manifest.platform !== "darwin" ||
			manifest.arch !== arch ||
			manifest.version !== version ||
			manifest.sourceSha !== sourceSha ||
			manifest.distribution !== "signed-notarized"
		)
			throw new Error(`Release identity mismatch: ${arch}.`);
		if (manifest.sourceDirty !== false) throw new Error(`Dirty source tree: ${arch}.`);
		if (
			manifest.signedDistribution !== true ||
			typeof manifest.expectedTeamId !== "string" ||
			!/^[A-Z0-9]{10}$/u.test(manifest.expectedTeamId)
		)
			throw new Error(`Missing signed policy identity: ${arch}.`);
		if (
			manifest.channel !== (production ? "stable" : "preview") ||
			manifest.validationFeedBase !== null ||
			manifest.productionUpdatesEnabled !== production
		)
			throw new Error(`Public release requires the matching stable/preview update policy: ${arch}.`);
		for (const [name, expected] of Object.entries({
			RunAsNode: false,
			EnableNodeOptionsEnvironmentVariable: false,
			EnableNodeCliInspectArguments: false,
			EnableCookieEncryption: true,
			EnableEmbeddedAsarIntegrityValidation: true,
			OnlyLoadAppFromAsar: true,
			GrantFileProtocolExtraPrivileges: false,
		})) {
			if (manifest.fuses?.[name] !== expected) throw new Error(`Unsafe ${name} fuse: ${arch}.`);
		}
		for (const field of ["buildId", "electronVersion", "nodeVersion", "nodeAbi", "minimumMacOSVersion"]) {
			if (typeof manifest[field] !== "string" || !manifest[field]) throw new Error(`Missing ${field}: ${arch}.`);
		}
		if (!sha256Pattern.test(manifest.runtimeLockSha256) || !sha256Pattern.test(manifest.nodeArchive?.sha256))
			throw new Error(`Missing dependency provenance: ${arch}.`);
		for (const resource of [
			"app.asar",
			"runtime/bin/node",
			"runtime/dist/cli.js",
			"runtime/dist/web-ui/index.html",
			"runtime/bundle-manifest.json",
			"runtime/release-policy.json",
		]) {
			if (!sha256Pattern.test(manifest.checksums?.[resource]))
				throw new Error(`Missing resource checksum: ${arch}.`);
		}
		if (first) {
			for (const field of [
				"electronVersion",
				"nodeVersion",
				"nodeAbi",
				"minimumMacOSVersion",
				"runtimeLockSha256",
				"expectedTeamId",
			]) {
				if (manifest[field] !== first[field]) throw new Error(`Architecture ${field} mismatch.`);
			}
		}
		first = manifest;
		const expected = artifactNames(version, arch);
		if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== expected.length)
			throw new Error(`Incomplete artifact set: ${arch}.`);
		for (const name of expected) {
			const artifact = manifest.artifacts.find((entry) => entry.path === name);
			if (!artifact || basename(artifact.path) !== artifact.path || !sha256Pattern.test(artifact.sha256))
				throw new Error(`Invalid artifact: ${name}.`);
			const path = join(directory, name);
			const metadata = await lstat(path);
			if (
				!metadata.isFile() ||
				metadata.size !== artifact.bytes ||
				metadata.size === 0 ||
				(await checksum(path)) !== artifact.sha256
			)
				throw new Error(`Artifact checksum/size mismatch: ${name}.`);
			files.push(path);
		}
		files.push(manifestPath);
	}
	return files;
}

async function finalize(arch, sourceSha, directory) {
	if (!sourcePattern.test(sourceSha)) throw new Error("Release source must be an exact commit SHA.");
	const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
	const out = join(root, "desktop", "out");
	const manifestName = `artifact-manifest-darwin-${arch}.json`;
	const manifest = JSON.parse(await readFile(join(out, manifestName), "utf8"));
	if (manifest.sourceSha !== sourceSha || manifest.arch !== arch)
		throw new Error("Packaged source identity mismatch.");
	const names = artifactNames(manifest.version, arch);
	const resources = join(out, `Quarterdeck-darwin-${arch}`, "Quarterdeck.app", "Contents", "Resources");
	for (const file of Object.keys(manifest.checksums)) manifest.checksums[file] = await checksum(join(resources, file));
	manifest.artifacts = await Promise.all(
		names.map(async (name) => {
			const path = join(directory, name);
			return { path: name, bytes: (await lstat(path)).size, sha256: await checksum(path) };
		}),
	);
	manifest.distribution = "signed-notarized";
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, manifestName), `${JSON.stringify(manifest, null, "\t")}\n`);
}

async function main() {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			dir: { type: "string" },
			version: { type: "string" },
			sha: { type: "string" },
			arch: { type: "string" },
			list: { type: "string" },
		},
	});
	if (positionals.length !== 1 || !values.dir || !values.sha)
		throw new Error("Pass finalize|validate --dir <payload> --sha <commit>.");
	if (positionals[0] === "finalize") {
		await finalize(values.arch, values.sha, resolve(values.dir));
		return;
	}
	if (positionals[0] !== "validate" || !values.version) throw new Error("Validation requires --version.");
	const files = await validateRelease(resolve(values.dir), values.version, values.sha);
	const sums = join(resolve(values.dir), "SHA256SUMS");
	await writeFile(
		sums,
		(await Promise.all(files.map(async (path) => `${await checksum(path)}  ${basename(path)}`))).join("\n") + "\n",
	);
	if (values.list) await writeFile(values.list, [...files, sums].join("\n") + "\n");
	console.log(`Verified complete desktop release ${values.version} from ${values.sha}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
