import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { readPairedBuildIdentity } from "./build-identity.mjs";
import { sha256File } from "./checksums.mjs";
import { requireNativeMacTarget } from "./paths.mjs";
import { run } from "./process.mjs";
import { validateReleasePolicy } from "./release-policy.mjs";
import { validateRuntimeDependencyLinks } from "./runtime-resources.mjs";
import { verifyDeveloperIdIdentity, verifySignedAppEntitlements } from "./signing-entitlements.mjs";

const nativeSmoke = `
const pty = require('node-pty');
const token = 'quarterdeck-bundled-pty-ok';
let output = '';
const terminal = pty.spawn('/bin/sh', ['-c', 'printf ' + token], {
  name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(),
  env: { PATH: '/usr/bin:/bin' }
});
const timer = setTimeout(() => { terminal.kill(); process.exit(1); }, 5000);
terminal.onData(data => { output += data; });
terminal.onExit(({exitCode}) => {
  clearTimeout(timer);
  if (exitCode !== 0 || !output.includes(token)) process.exit(1);
  console.log(token);
});
`;

export async function verifyRuntime(runtimePath) {
	const manifest = JSON.parse(await readFile(join(runtimePath, "bundle-manifest.json"), "utf8"));
	requireNativeMacTarget(manifest.arch);
	if (manifest.schemaVersion !== 1 || manifest.desktopLaunchProtocolVersion !== 1 || manifest.platform !== "darwin")
		throw new Error("Unsupported desktop bundle manifest.");
	validateReleasePolicy(JSON.parse(await readFile(join(runtimePath, "release-policy.json"), "utf8")), manifest);
	await validateRuntimeDependencyLinks(runtimePath);
	const nodeBin = join(runtimePath, "bin", "node");
	if (!(await lstat(nodeBin)).isFile()) throw new Error("Bundled Node must be a real executable file.");
	const env = { ...process.env, PATH: "/usr/bin:/bin" };
	delete env.NODE_PATH;
	delete env.NODE_OPTIONS;
	delete env.ELECTRON_RUN_AS_NODE;
	const options = { cwd: runtimePath, env, encoding: "utf8", stdio: "pipe", timeout: 10_000 };
	const nodeInfo = JSON.parse(
		run(
			nodeBin,
			["-p", "JSON.stringify({version:process.versions.node,abi:process.versions.modules,arch:process.arch})"],
			options,
		).stdout,
	);
	if (
		nodeInfo.version !== manifest.nodeVersion ||
		nodeInfo.abi !== manifest.nodeAbi ||
		nodeInfo.arch !== manifest.arch
	)
		throw new Error("Bundled Node does not match its manifest.");
	const runtimePackage = JSON.parse(await readFile(join(runtimePath, "package.json"), "utf8"));
	if (runtimePackage.version !== manifest.version)
		throw new Error("Runtime package version differs from the bundle manifest.");
	const version = run(nodeBin, [join(runtimePath, "dist", "cli.js"), "--version"], options).stdout.trim();
	if (version !== manifest.version) throw new Error("Bundled CLI version does not match its manifest.");
	if ((await readPairedBuildIdentity(join(runtimePath, "dist"))) !== manifest.buildId)
		throw new Error("Bundled runtime and browser build identities differ.");
	const ptyOutput = run(nodeBin, ["-e", nativeSmoke], options).stdout.trim();
	if (ptyOutput !== "quarterdeck-bundled-pty-ok") throw new Error("Bundled native PTY did not pass its smoke check.");
	return manifest;
}

export async function verifyApp(appPath) {
	if (!appPath.endsWith(".app")) throw new Error("Pass the packaged .app path.");
	const resources = join(appPath, "Contents", "Resources");
	if (!(await lstat(join(resources, "app.asar"))).isFile())
		throw new Error("Desktop shell must be packaged in app.asar.");
	const runtimePath = join(resources, "runtime");
	if (!(await lstat(runtimePath)).isDirectory()) throw new Error("Bundled helper must be outside app.asar.");
	const manifest = await verifyRuntime(runtimePath);
	const appVersion = run(
		"/usr/libexec/PlistBuddy",
		["-c", "Print :CFBundleShortVersionString", join(appPath, "Contents", "Info.plist")],
		{ encoding: "utf8", stdio: "pipe" },
	).stdout.trim();
	if (appVersion !== manifest.version) throw new Error("Desktop shell and runtime product versions differ.");
	const wire = await getCurrentFuseWire(appPath);
	for (const [option, enabled] of [
		[FuseV1Options.RunAsNode, false],
		[FuseV1Options.EnableCookieEncryption, true],
		[FuseV1Options.EnableNodeOptionsEnvironmentVariable, false],
		[FuseV1Options.EnableNodeCliInspectArguments, !manifest.signedDistribution],
		[FuseV1Options.EnableEmbeddedAsarIntegrityValidation, true],
		[FuseV1Options.OnlyLoadAppFromAsar, true],
		[FuseV1Options.GrantFileProtocolExtraPrivileges, false],
	]) {
		if (wire[option] !== (enabled ? FuseState.ENABLE : FuseState.DISABLE)) {
			throw new Error(`Packaged security fuse differs from its release policy: ${FuseV1Options[option]}.`);
		}
	}
	if (manifest.signedDistribution) {
		run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "pipe" });
		const signature = run("/usr/bin/codesign", ["--display", "--verbose=4", appPath], {
			encoding: "utf8",
			stdio: "pipe",
		}).stderr;
		verifyDeveloperIdIdentity(signature, manifest.expectedTeamId);
		await verifySignedAppEntitlements(appPath, manifest.expectedTeamId);
	}
	return manifest;
}

async function containedArtifactPath(directory, path) {
	if (typeof path !== "string" || isAbsolute(path))
		throw new Error("Artifact paths must be relative to the manifest.");
	const root = await realpath(directory);
	const target = resolve(root, path);
	if (!target.startsWith(`${root}${sep}`)) throw new Error("Artifact path escapes the manifest directory.");
	const canonical = await realpath(target);
	if (!canonical.startsWith(`${root}${sep}`)) throw new Error("Artifact symlink escapes the manifest directory.");
	return canonical;
}

export async function verifyArtifactManifest(manifestPath) {
	const artifactManifest = JSON.parse(await readFile(manifestPath, "utf8"));
	const outputRoot = dirname(manifestPath);
	const appPath = await containedArtifactPath(outputRoot, artifactManifest.appPath);
	const bundleManifest = await verifyApp(appPath);
	for (const key of Object.keys(bundleManifest)) {
		if (JSON.stringify(artifactManifest[key]) !== JSON.stringify(bundleManifest[key])) {
			throw new Error(`Artifact provenance differs from its packaged runtime: ${key}.`);
		}
	}
	const resources = join(appPath, "Contents", "Resources");
	for (const required of [
		"app.asar",
		"runtime/bin/node",
		"runtime/dist/cli.js",
		"runtime/dist/web-ui/index.html",
		"runtime/bundle-manifest.json",
		"runtime/release-policy.json",
	]) {
		if (!artifactManifest.checksums?.[required]) throw new Error(`Artifact manifest lacks checksum: ${required}.`);
	}
	for (const [file, expected] of Object.entries(artifactManifest.checksums)) {
		const path = await containedArtifactPath(resources, file);
		if ((await sha256File(path)) !== expected) throw new Error(`Packaged resource checksum mismatch: ${file}.`);
	}
	const wire = await getCurrentFuseWire(appPath);
	for (const [name, index] of Object.entries(FuseV1Options).filter(([, value]) => typeof value === "number")) {
		if (artifactManifest.fuses?.[name] !== (wire[index] === FuseState.ENABLE)) {
			throw new Error(`Artifact security fuse record differs from the packaged app: ${name}.`);
		}
	}
	if (!Array.isArray(artifactManifest.artifacts)) throw new Error("Artifact manifest lacks distributable records.");
	for (const artifact of artifactManifest.artifacts) {
		const path = await containedArtifactPath(outputRoot, artifact.path);
		const info = await lstat(path);
		if (!info.isFile() || info.size !== artifact.bytes || (await sha256File(path)) !== artifact.sha256) {
			throw new Error(`Distributable size or checksum mismatch: ${artifact.path}.`);
		}
	}
	return artifactManifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const { values } = parseArgs({
		options: { app: { type: "string" }, runtime: { type: "string" }, manifest: { type: "string" } },
	});
	if ([values.app, values.runtime, values.manifest].filter(Boolean).length !== 1) {
		throw new Error("Pass exactly one of --app, --runtime, or --manifest.");
	}
	const manifest = values.manifest
		? await verifyArtifactManifest(resolve(values.manifest))
		: values.app
			? await verifyApp(resolve(values.app))
			: await verifyRuntime(resolve(values.runtime));
	console.log(
		`Verified ${manifest.version} ${manifest.arch}: real bundled Node, matching browser/runtime build, and native PTY without system Node.`,
	);
}
