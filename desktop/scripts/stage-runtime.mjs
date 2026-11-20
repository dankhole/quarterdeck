import { createHash } from "node:crypto";
import { chmod, copyFile, cp, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readBuildManifest, readSourceIdentity } from "../../scripts/build-manifest.mjs";
import { readPairedBuildIdentity } from "./build-identity.mjs";
import { prepareRuntimePty } from "./native-runtime.mjs";
import { desktopRoot, repoRoot, requireNativeDesktopTarget, stagedRuntimePath } from "./paths.mjs";
import { run } from "./process.mjs";
import { createReleasePolicy, releaseBuildSettings } from "./release-policy.mjs";

async function downloadNode(desktopPackage, arch) {
	const { nodeVersion, nodeArchives, windowsNodeArchives } = desktopPackage.quarterdeckDesktop;
	const windows = process.platform === "win32";
	const expectedSha256 = (windows ? windowsNodeArchives : nodeArchives)?.[arch];
	if (!/^[a-f0-9]{64}$/u.test(expectedSha256 ?? "")) throw new Error("No pinned Node archive for this native target.");
	const filename = `node-v${nodeVersion}-${windows ? "win" : "darwin"}-${arch}.${windows ? "zip" : "tar.gz"}`;
	const cache = join(desktopRoot, ".cache", "node");
	const archive = join(cache, filename);
	await mkdir(cache, { recursive: true });
	let bytes;
	try {
		bytes = await readFile(archive);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	if (!bytes) {
		const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${filename}`);
		if (!response.ok) throw new Error(`Node archive download returned HTTP ${response.status}.`);
		bytes = Buffer.from(await response.arrayBuffer());
	}
	if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
		throw new Error(`Official Node archive checksum mismatch for ${filename}.`);
	}
	await writeFile(archive, bytes);
	return { archive, filename, nodeVersion, sha256: expectedSha256 };
}

export async function stageRuntime(arch = process.arch) {
	requireNativeDesktopTarget(arch);
	const [desktopPackage, runtimePackage, runtimeLock] = await Promise.all([
		readFile(join(desktopRoot, "package.json"), "utf8").then(JSON.parse),
		readFile(join(repoRoot, "package.json"), "utf8").then(JSON.parse),
		readFile(join(repoRoot, "package-lock.json")),
	]);
	if (desktopPackage.version !== runtimePackage.version) throw new Error("Desktop and runtime versions differ.");
	const releaseSettings = releaseBuildSettings(process.env, desktopPackage.version);
	const distPath = join(repoRoot, "dist");
	if ((await lstat(distPath)).isSymbolicLink()) throw new Error("Refusing to stage a symlinked runtime build.");
	const buildId = await readPairedBuildIdentity(distPath);
	const build = await readBuildManifest(distPath);
	const currentSource = readSourceIdentity(repoRoot);
	if (
		build.buildId !== buildId ||
		build.version !== runtimePackage.version ||
		build.sourceSha !== currentSource.sourceSha
	)
		throw new Error("Root build provenance differs from the paired build or packaging checkout. Rebuild first.");
	// Ad-hoc candidates can exercise production fuses/signatures in a dirty
	// worktree. Their dirty provenance still blocks finalization and publication.
	if (releaseSettings.signedDistribution && (build.sourceDirty || currentSource.sourceDirty))
		throw new Error("Signed distribution requires a clean root build and packaging checkout.");
	const runtimePath = stagedRuntimePath(arch);
	const { archive, filename, nodeVersion, sha256 } = await downloadNode(desktopPackage, arch);
	await rm(runtimePath, { recursive: true, force: true });
	await mkdir(join(runtimePath, "bin"), { recursive: true });
	const extraction = join(desktopRoot, ".cache", "node", `extract-${arch}`);
	await rm(extraction, { recursive: true, force: true });
	await mkdir(extraction, { recursive: true });
	const windows = process.platform === "win32";
	const tar = windows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "/usr/bin/tar";
	run(tar, ["-xf", archive, "-C", extraction, "--strip-components", "1"]);
	const nodeBin = join(runtimePath, "bin", windows ? "node.exe" : "node");
	await copyFile(windows ? join(extraction, "node.exe") : join(extraction, "bin", "node"), nodeBin);
	await copyFile(join(extraction, "LICENSE"), join(runtimePath, "NODE-LICENSE"));
	await chmod(nodeBin, 0o755);
	const nodeInfo = JSON.parse(
		run(
			nodeBin,
			[
				"-p",
				"JSON.stringify({version:process.versions.node,abi:process.versions.modules,arch:process.arch,platform:process.platform})",
			],
			{ encoding: "utf8", stdio: "pipe" },
		).stdout,
	);
	if (nodeInfo.version !== nodeVersion || nodeInfo.arch !== arch || nodeInfo.platform !== process.platform) {
		throw new Error("Downloaded Node binary does not match the pinned version and native target.");
	}
	await cp(distPath, join(runtimePath, "dist"), { recursive: true });
	await copyFile(join(repoRoot, "LICENSE"), join(runtimePath, "LICENSE"));
	// The root lock is authoritative. Install a fresh tree rather than copying
	// development modules, symlink targets, or Electron-rebuilt native binaries.
	await writeFile(
		join(runtimePath, "package.json"),
		`${JSON.stringify({ ...runtimePackage, scripts: {} }, null, "\t")}\n`,
	);
	await writeFile(join(runtimePath, "package-lock.json"), runtimeLock);
	const npmCli = process.env.npm_execpath;
	if (!npmCli?.endsWith("npm-cli.js"))
		throw new Error("Run staging through `npm --prefix desktop run stage` so the pinned helper can invoke npm.");
	const env = {
		...process.env,
		PATH: `${join(runtimePath, "bin")}${delimiter}${process.env.PATH ?? ""}`,
		npm_config_cache: join(desktopRoot, ".cache", "npm"),
	};
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.npm_config_runtime;
	delete env.npm_config_target;
	delete env.npm_config_disturl;
	run(nodeBin, [npmCli, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: runtimePath, env });
	if (windows) {
		// Quarterdeck always supplies the resolved Claude executable to the SDK.
		// Its optional fallback executable adds hundreds of MB to every app verification.
		await rm(join(runtimePath, "node_modules", "@anthropic-ai", `claude-agent-sdk-win32-${arch}`), {
			recursive: true,
			force: true,
		});
	}
	prepareRuntimePty({ runtimePath, nodeBin, nodeVersion, arch, env });
	// Keep native runtime products without node-gyp's Python symlink and
	// generated build files containing machine-local toolchain paths.
	const nativeBuildPath = join(runtimePath, "node_modules", "node-pty", "build");
	for (const entry of await readdir(nativeBuildPath)) {
		if (entry !== "Release") await rm(join(nativeBuildPath, entry), { recursive: true, force: true });
	}
	await rm(join(runtimePath, "package-lock.json"));
	const manifest = {
		schemaVersion: 1,
		desktopLaunchProtocolVersion: 1,
		...releaseSettings,
		version: runtimePackage.version,
		sourceSha: build.sourceSha,
		sourceDirty: build.sourceDirty || currentSource.sourceDirty,
		buildId,
		platform: process.platform,
		arch,
		electronVersion: desktopPackage.devDependencies.electron,
		nodeVersion,
		nodeAbi: nodeInfo.abi,
		...(windows ? {} : { minimumMacOSVersion: desktopPackage.quarterdeckDesktop.minimumMacOSVersion }),
		nodeArchive: { filename, sha256 },
		runtimeLockSha256: createHash("sha256").update(runtimeLock).digest("hex"),
	};
	await writeFile(join(runtimePath, "bundle-manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	await writeFile(
		join(runtimePath, "release-policy.json"),
		`${JSON.stringify(createReleasePolicy(manifest, releaseSettings), null, "\t")}\n`,
	);
	await rm(extraction, { recursive: true, force: true });
	console.log(
		`Staged Quarterdeck ${manifest.version} ${arch} with Node ${nodeVersion} ABI ${manifest.nodeAbi}, build ${buildId}.`,
	);
	return runtimePath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const { values } = parseArgs({ options: { arch: { type: "string", default: process.arch } } });
	await stageRuntime(values.arch);
}
