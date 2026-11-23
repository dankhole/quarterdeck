import { lstat, readFile, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { extractFile } from "@electron/asar";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { readBuildManifest } from "../../scripts/build-manifest.mjs";
import { verifyAppSignature } from "./app-signature.mjs";
import { readPairedBuildIdentity } from "./build-identity.mjs";
import { sha256File } from "./checksums.mjs";
import { desktopResourcePathsForPlatform } from "./desktop-resource-paths.mjs";
import { requireNativeDesktopTarget } from "./paths.mjs";
import { run } from "./process.mjs";
import { distributionModeFor, validateReleasePolicy } from "./release-policy.mjs";
import { validateRuntimeDependencyLinks } from "./runtime-resources.mjs";
import {
	verifyAdHocAppEntitlements,
	verifyDeveloperIdIdentity,
	verifySignedAppEntitlements,
} from "./signing-entitlements.mjs";
import { withExtractedWindowsArchive } from "./verify-windows-archive.mjs";
import { windowsPeArchitecture } from "./windows-pe.mjs";

const nativeSmoke = `
const pty = require('node-pty');
const token = 'quarterdeck-bundled-pty-ok';
let output = '';
const windows = process.platform === 'win32';
const shell = windows ? require('node:path').join(process.env.SystemRoot || 'C:\\\\Windows', 'System32', 'cmd.exe') : '/bin/sh';
const terminal = pty.spawn(shell, windows ? ['/d', '/s', '/c', 'node --version'] : ['-c', 'printf ' + token], {
  name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(),
  env: windows ? process.env : { PATH: '/usr/bin:/bin' }
});
const timer = setTimeout(() => { terminal.kill(); process.exit(1); }, 5000);
terminal.onData(data => { output += data; });
terminal.onExit(({exitCode}) => {
  clearTimeout(timer);
  // ConPTY's output worker needs disposal even after the shell exits.
  if (windows) terminal.destroy();
  if (exitCode !== 0 || !output.includes(windows ? process.version : token)) process.exit(1);
  console.log(token);
});
`;

// Exercise the Windows console boundary, not only xterm's parser. Fullscreen
// TUIs need the mode changes to reach the terminal and the encoded input to
// arrive unmodified at the child. Keep the child fixed and provider-free.
const windowsTerminalInputSmoke = String.raw`
const { spawn } = require('node-pty');
const enter = '\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h';
const leave = '\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1049l';
const input = '\x1b[<64;10;10M\x1b[<0;7;8M\x1b[<0;7;8m\x1b[200~first café 日本\rsecond line\x1b[201~';
const expectedHex = Buffer.from(input, 'utf8').toString('hex');
const ready = 'quarterdeck-windows-terminal-input-ready';
const token = 'quarterdeck-windows-terminal-input-ok';
const child = [
  'process.stdin.setRawMode(true);',
  'let received = "";',
  'process.stdin.on("data", (data) => {',
  '  received += data.toString("hex");',
  '  if (!' + JSON.stringify(expectedHex) + '.startsWith(received)) process.exit(2);',
  '  if (received === ' + JSON.stringify(expectedHex) + ') {',
  '    process.stdout.write(' + JSON.stringify(leave + token) + ', () => process.exit(0));',
  '  }',
  '});',
  'process.stdout.write(' + JSON.stringify(enter + ready) + ');',
].join('\n');
const terminal = spawn(process.execPath, ['-e', child], {
  name: 'xterm-256color', cols: 120, rows: 24, cwd: process.cwd(), env: process.env
});
let output = '';
let sent = false;
function fail(reason) {
  console.error('Windows terminal input smoke: ' + reason);
  terminal.destroy();
  process.exit(1);
}
function modesIn(text) {
  const modes = new Map();
  for (const [, params, state] of text.matchAll(/\x1b\[\?([0-9;]+)([hl])/g)) {
    for (const mode of params.split(';')) modes.set(mode, state);
  }
  return modes;
}
function sawModes(sequence, text) {
  const actual = modesIn(text);
  return [...modesIn(sequence)].every(([mode, state]) => actual.get(mode) === state);
}
const timer = setTimeout(() => fail('timed out waiting for console mode or input receipt'), 5000);
terminal.onData((data) => {
  output += data;
  if (sent || !output.includes(ready)) return;
  if (!sawModes(enter, output.slice(0, output.indexOf(ready)))) fail('missing fullscreen, mouse or paste modes');
  sent = true;
  terminal.write(input);
});
terminal.onExit(({exitCode}) => {
  clearTimeout(timer);
  if (exitCode !== 0 || !sent || !output.includes(token)) fail('mouse or Unicode paste bytes did not round-trip');
  if (!sawModes(leave, output.slice(output.indexOf(ready), output.indexOf(token)))) fail('missing mode reset');
  terminal.destroy();
  console.log(token);
});
`;

export async function verifyRuntime(runtimePath) {
	const manifest = JSON.parse(await readFile(join(runtimePath, "bundle-manifest.json"), "utf8"));
	requireNativeDesktopTarget(manifest.arch);
	if (
		manifest.schemaVersion !== 1 ||
		manifest.desktopLaunchProtocolVersion !== 1 ||
		manifest.platform !== process.platform
	)
		throw new Error("Unsupported desktop bundle manifest.");
	validateReleasePolicy(JSON.parse(await readFile(join(runtimePath, "release-policy.json"), "utf8")), manifest);
	await validateRuntimeDependencyLinks(runtimePath);
	const windows = process.platform === "win32";
	const nodeBin = join(runtimePath, "bin", windows ? "node.exe" : "node");
	if (!(await lstat(nodeBin)).isFile()) throw new Error("Bundled Node must be a real executable file.");
	const env = { ...process.env, ...(process.platform === "darwin" ? { PATH: "/usr/bin:/bin" } : {}) };
	delete env.NODE_PATH;
	delete env.NODE_OPTIONS;
	delete env.ELECTRON_RUN_AS_NODE;
	// Packaged candidates intentionally live outside the canonical installed app.
	// Enable only the native noncanonical probe path; these fixed --version/-p/-e
	// probes never load a desktop launch configuration or start an app/runtime.
	const wrappedNode = await lstat(join(runtimePath, "bin", "nodeHost")).catch((error) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	const canonicalWindowsRuntime = windows ? (await realpath(runtimePath)).toLowerCase() : null;
	if (
		canonicalWindowsRuntime &&
		["host/resources/runtime", "resources/runtime"].some(
			(relative) =>
				canonicalWindowsRuntime ===
				join(userInfo().homedir, "AppData/Local/Programs/Quarterdeck", relative).toLowerCase(),
		)
	)
		throw new Error("Verify a separate packaging candidate; installed Windows hosts require native admission.");
	if (windows) {
		// Exercise the same bare Node resolution used by npm agent shims.
		for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
		env.PATH = dirname(nodeBin);
	}
	if (wrappedNode) {
		if (!wrappedNode.isFile()) throw new Error("Bundled Node host must be a real executable file.");
		env.QUARTERDECK_DESKTOP_LAB_CONFIG = join(runtimePath, "packaging-verification-only.json");
	}
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
	const build = await readBuildManifest(join(runtimePath, "dist"));
	for (const key of ["version", "buildId", "sourceSha", "sourceDirty"]) {
		if (build[key] !== manifest[key]) throw new Error(`Bundled root build provenance differs: ${key}.`);
	}
	const ptyOutput = run(nodeBin, ["-e", nativeSmoke], options).stdout.trim();
	if (ptyOutput !== "quarterdeck-bundled-pty-ok") throw new Error("Bundled native PTY did not pass its smoke check.");
	if (windows) {
		const inputOutput = run(nodeBin, ["-e", windowsTerminalInputSmoke], {
			...options,
			stdio: ["ignore", "pipe", "inherit"],
		}).stdout.trim();
		if (inputOutput !== "quarterdeck-windows-terminal-input-ok")
			throw new Error("Bundled Windows PTY did not pass its terminal input smoke check.");
	}
	return manifest;
}

export async function verifyApp(appPath) {
	const windows = process.platform === "win32";
	if (!windows && !appPath.endsWith(".app")) throw new Error("Pass the packaged .app path.");
	if (!windows) verifyAppSignature(appPath);
	const resources = windows ? join(appPath, "host", "resources") : join(appPath, "Contents", "Resources");
	if (!(await lstat(join(resources, "app.asar"))).isFile())
		throw new Error("Desktop shell must be packaged in app.asar.");
	const runtimePath = join(resources, "runtime");
	if (!(await lstat(runtimePath)).isDirectory()) throw new Error("Bundled helper must be outside app.asar.");
	const manifest = await verifyRuntime(runtimePath);
	if (windows) {
		if (!["local", "windows-unsigned"].includes(distributionModeFor(manifest)))
			throw new Error("Invalid Windows desktop distribution.");
		for (const binary of [
			"Quarterdeck.exe",
			"host/Quarterdeck.exe",
			"host/resources/runtime/bin/node.exe",
			"host/resources/runtime/installation-admission.exe",
		]) {
			const path = join(appPath, binary);
			const info = await lstat(path);
			if (!info.isFile() || info.isSymbolicLink() || (await windowsPeArchitecture(path)) !== manifest.arch)
				throw new Error("Windows desktop binaries do not match the native target.");
		}
		const bootstrap = await sha256File(join(runtimePath, "installation-admission.exe"));
		if (
			(await sha256File(join(appPath, "Quarterdeck.exe"))) !== bootstrap ||
			(await sha256File(join(runtimePath, "bin", "node.exe"))) === bootstrap
		)
			throw new Error("Windows launcher must match admission and bundled Node must be a separate executable.");
		const shell = JSON.parse(extractFile(join(resources, "app.asar"), "package.json").toString("utf8"));
		if (shell.name !== "quarterdeck-desktop" || shell.version !== manifest.version)
			throw new Error("Windows shell and runtime product identities differ.");
	} else {
		for (const name of ["Quarterdeck", "QuarterdeckHost"]) {
			if (!(await lstat(join(appPath, "Contents/MacOS", name))).isFile())
				throw new Error(`Native admission requires the real ${name} executable.`);
		}
		if (!(await lstat(join(runtimePath, "installation-admission"))).isFile())
			throw new Error("Native admission installer helper must be a real executable.");
		const appVersion = run(
			"/usr/libexec/PlistBuddy",
			["-c", "Print :CFBundleShortVersionString", join(appPath, "Contents", "Info.plist")],
			{ encoding: "utf8", stdio: "pipe" },
		).stdout.trim();
		if (appVersion !== manifest.version) throw new Error("Desktop shell and runtime product versions differ.");
	}
	const wire = await getCurrentFuseWire(windows ? join(appPath, "host", "Quarterdeck.exe") : appPath);
	for (const [option, enabled] of [
		[FuseV1Options.RunAsNode, false],
		[FuseV1Options.EnableCookieEncryption, true],
		[FuseV1Options.EnableNodeOptionsEnvironmentVariable, false],
		[FuseV1Options.EnableNodeCliInspectArguments, distributionModeFor(manifest) === "local"],
		[FuseV1Options.EnableEmbeddedAsarIntegrityValidation, true],
		[FuseV1Options.OnlyLoadAppFromAsar, true],
		[FuseV1Options.GrantFileProtocolExtraPrivileges, false],
	]) {
		if (wire[option] !== (enabled ? FuseState.ENABLE : FuseState.DISABLE)) {
			throw new Error(`Packaged security fuse differs from its release policy: ${FuseV1Options[option]}.`);
		}
	}
	if (manifest.signedDistribution) {
		const signature = run("/usr/bin/codesign", ["--display", "--verbose=4", appPath], {
			encoding: "utf8",
			stdio: "pipe",
		}).stderr;
		verifyDeveloperIdIdentity(signature, manifest.expectedTeamId);
		await verifySignedAppEntitlements(appPath, manifest.expectedTeamId);
	} else if (distributionModeFor(manifest) === "ad-hoc") {
		await verifyAdHocAppEntitlements(appPath);
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

async function verifyManifestAppFiles(appPath, artifactManifest, platform) {
	const windows = platform === "win32";
	const resources = windows ? join(appPath, "host", "resources") : join(appPath, "Contents", "Resources");
	for (const required of desktopResourcePathsForPlatform(platform)) {
		if (!artifactManifest.checksums?.[required]) throw new Error(`Artifact manifest lacks checksum: ${required}.`);
	}
	for (const [file, expected] of Object.entries(artifactManifest.checksums)) {
		const path = await containedArtifactPath(resources, file);
		if ((await sha256File(path)) !== expected) throw new Error(`Packaged resource checksum mismatch: ${file}.`);
	}
	if (artifactManifest.nativeAdmission?.schemaVersion !== 1)
		throw new Error("Artifact manifest lacks native admission provenance.");
	for (const [field, name] of [
		["bootstrapSha256", windows ? "Quarterdeck.exe" : "Contents/MacOS/Quarterdeck"],
		["hostSha256", windows ? "host/Quarterdeck.exe" : "Contents/MacOS/QuarterdeckHost"],
	]) {
		if (artifactManifest.nativeAdmission[field] !== (await sha256File(join(appPath, name))))
			throw new Error(`Native admission checksum mismatch: ${name}.`);
	}
	const wire = await getCurrentFuseWire(windows ? join(appPath, "host", "Quarterdeck.exe") : appPath);
	for (const [name, index] of Object.entries(FuseV1Options).filter(([, value]) => typeof value === "number")) {
		if (artifactManifest.fuses?.[name] !== (wire[index] === FuseState.ENABLE)) {
			throw new Error(`Artifact security fuse record differs from the packaged app: ${name}.`);
		}
	}
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
	const windows = bundleManifest.platform === "win32";
	if (!Array.isArray(artifactManifest.artifacts)) throw new Error("Artifact manifest lacks distributable records.");
	if (!windows) await verifyManifestAppFiles(appPath, artifactManifest, bundleManifest.platform);
	if (windows && artifactManifest.artifacts.length !== 1)
		throw new Error("Windows artifact verification requires one Forge ZIP. Run make first (or use --app).");
	for (const artifact of artifactManifest.artifacts) {
		const path = await containedArtifactPath(outputRoot, artifact.path);
		const info = await lstat(path);
		if (!info.isFile() || info.size !== artifact.bytes || (await sha256File(path)) !== artifact.sha256) {
			throw new Error(`Distributable size or checksum mismatch: ${artifact.path}.`);
		}
		if (windows) {
			if (extname(artifact.path) !== ".zip") throw new Error("Expected a Windows Forge ZIP.");
			// Check recorded hashes on the extracted bytes once; run native smoke only on the loose app.
			await withExtractedWindowsArchive(path, (extracted) =>
				verifyManifestAppFiles(extracted, artifactManifest, bundleManifest.platform),
			);
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
	if (values.manifest && manifest.platform === "win32") {
		console.log("Verified Forge ZIP extraction with Quarterdeck's Windows installer decoder and manifest checksums.");
	}
	console.log(
		`Verified ${manifest.version} ${manifest.arch}: real bundled Node, matching browser/runtime build, and native PTY without system Node.`,
	);
}
