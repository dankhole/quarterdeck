import { open, readdir } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { desktopRoot } from "./paths.mjs";
import { run } from "./process.mjs";

const allowJit = "com.apple.security.cs.allow-jit";
const machOMagic = new Set([
	"feedface",
	"cefaedfe",
	"feedfacf",
	"cffaedfe",
	"cafebabe",
	"bebafeca",
	"cafebabf",
	"bfbafeca",
]);

export function entitlementClass(filePath) {
	if (filePath.endsWith("/Contents/Resources/runtime/bin/nodeHost")) return "runtime";
	if (/\/Contents\/MacOS\/QuarterdeckHost(?: Helper(?: \((?:GPU|Renderer|Plugin)\))?)?$/u.test(filePath))
		return "electron";
	return "library";
}

/** Let each known admission wrapper be signed when its containing .app is sealed. */
export function deferAdmissionExecutableToBundle(filePath) {
	const name = basename(filePath);
	const directory = dirname(filePath);
	return (
		/^Quarterdeck(?: Helper(?: \((?:GPU|Renderer|Plugin|Utility)\))?)?$/u.test(name) &&
		basename(directory) === "MacOS" &&
		basename(dirname(directory)) === "Contents" &&
		basename(dirname(dirname(directory))) === `${name}.app`
	);
}

// These Developer ID builds do not use Apple's App Sandbox. File, network,
// clipboard and native dialogs need no sandbox exceptions. V8 uses MAP_JIT;
// shipped, team-signed native modules need no library-validation exception.
export function signingOptionsForFile(filePath, distributionMode = "signed") {
	// Ad-hoc code has no Team ID: hardened library validation would reject its
	// own Electron Framework/native addons. Do not add broad entitlement grants.
	// The Developer ID lane retains hardened runtime and minimal JIT grants.
	const adhoc = distributionMode === "ad-hoc";
	return {
		hardenedRuntime: !adhoc,
		// osx-sign accepts timestamps here, not at the top level of its options.
		...(adhoc ? { timestamp: "none" } : {}),
		entitlements: join(desktopRoot, "assets", `${adhoc ? "library" : entitlementClass(filePath)}-entitlements.plist`),
	};
}

export function verifyEntitlementDictionary(filePath, dictionary, distributionMode = "signed") {
	if (!dictionary || typeof dictionary !== "object" || Array.isArray(dictionary)) {
		throw new Error("Signed code has malformed entitlements.");
	}
	const keys = Object.keys(dictionary);
	const needsJit = distributionMode !== "ad-hoc" && entitlementClass(filePath) !== "library";
	if (needsJit ? keys.length !== 1 || keys[0] !== allowJit || dictionary[allowJit] !== true : keys.length !== 0) {
		throw new Error(`Signed code entitlements differ from the minimal ${entitlementClass(filePath)} policy.`);
	}
}

export function verifyDeveloperIdIdentity(signature, expectedTeamId) {
	if (
		!signature.includes(`TeamIdentifier=${expectedTeamId}\n`) ||
		!/^Authority=Developer ID Application:/mu.test(signature) ||
		!/^CodeDirectory .*flags=0x[\da-f]+\([^\n]*runtime[^\n]*\)/mu.test(signature)
	) {
		throw new Error("Signed code lacks the expected Developer ID team and hardened runtime.");
	}
}

export function verifyAdHocIdentity(signature) {
	if (
		!/^Signature=adhoc$/mu.test(signature) ||
		!/^TeamIdentifier=not set$/mu.test(signature) ||
		/^Authority=/mu.test(signature) ||
		!/^CodeDirectory .*flags=0x[\da-f]+\([^\n]*adhoc[^\n]*\)/mu.test(signature) ||
		/^CodeDirectory .*\([^\n]*runtime[^\n]*\)/mu.test(signature)
	) {
		throw new Error(
			"Public ad-hoc code lacks its expected signature, claims an Apple identity, or enables incompatible hardened library validation.",
		);
	}
}

async function* executableFiles(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		// Framework aliases are permitted, but their real version is visited once.
		// Never follow a link out of the packaged application.
		if (entry.isDirectory()) yield* executableFiles(path);
		else if (entry.isFile()) {
			const file = await open(path, "r");
			try {
				const bytes = Buffer.alloc(4);
				const result = await file.read(bytes, 0, bytes.length, 0);
				if (result.bytesRead === bytes.length && machOMagic.has(bytes.toString("hex"))) yield path;
			} finally {
				await file.close();
			}
		}
	}
}

/** Audit the actual Mach-O signatures, not just configured plist sources. */
async function verifyAppEntitlements(appPath, verifyIdentity, runCommand, distributionMode) {
	const audited = [];
	for await (const path of executableFiles(appPath)) {
		runCommand("/usr/bin/codesign", ["--verify", "--strict", path], { stdio: "pipe" });
		const signature = runCommand("/usr/bin/codesign", ["--display", "--verbose=4", path], {
			encoding: "utf8",
			stdio: "pipe",
		}).stderr;
		verifyIdentity(signature);
		const xml = runCommand("/usr/bin/codesign", ["--display", "--entitlements", "-", "--xml", path], {
			encoding: "utf8",
			stdio: "pipe",
		}).stdout.trim();
		const entitlements = xml
			? JSON.parse(
					runCommand("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], {
						encoding: "utf8",
						stdio: "pipe",
						input: xml,
					}).stdout,
				)
			: {};
		verifyEntitlementDictionary(path, entitlements, distributionMode);
		audited.push(relative(appPath, path));
	}
	if (
		!audited.includes("Contents/Resources/runtime/bin/node") ||
		!audited.includes("Contents/Resources/runtime/bin/nodeHost") ||
		!audited.includes("Contents/Resources/runtime/installation-admission") ||
		!audited.includes("Contents/MacOS/Quarterdeck") ||
		!audited.includes("Contents/MacOS/QuarterdeckHost")
	) {
		throw new Error("Signed entitlement audit is missing the app or bundled Node executable.");
	}
	return audited;
}

export async function verifySignedAppEntitlements(appPath, expectedTeamId, runCommand = run) {
	return verifyAppEntitlements(
		appPath,
		(signature) => verifyDeveloperIdIdentity(signature, expectedTeamId),
		runCommand,
	);
}

export async function verifyAdHocAppEntitlements(appPath, runCommand = run) {
	return verifyAppEntitlements(appPath, verifyAdHocIdentity, runCommand, "ad-hoc");
}
