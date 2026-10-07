import { open, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
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
	if (filePath.endsWith("/Contents/Resources/runtime/bin/node")) return "runtime";
	if (filePath.endsWith(".app") || /\/Contents\/MacOS\/[^/]+$/u.test(filePath)) return "electron";
	return "library";
}

// These Developer ID builds do not use Apple's App Sandbox. File, network,
// clipboard and native dialogs need no sandbox exceptions. V8 uses MAP_JIT;
// shipped, team-signed native modules need no library-validation exception.
export function signingOptionsForFile(filePath) {
	return {
		hardenedRuntime: true,
		entitlements: join(desktopRoot, "assets", `${entitlementClass(filePath)}-entitlements.plist`),
	};
}

export function verifyEntitlementDictionary(filePath, dictionary) {
	if (!dictionary || typeof dictionary !== "object" || Array.isArray(dictionary)) {
		throw new Error("Signed code has malformed entitlements.");
	}
	const keys = Object.keys(dictionary);
	const needsJit = entitlementClass(filePath) !== "library";
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

/** Audit the actual signed Mach-O files, not just the configured plist sources. */
export async function verifySignedAppEntitlements(appPath, expectedTeamId, runCommand = run) {
	const audited = [];
	for await (const path of executableFiles(appPath)) {
		runCommand("/usr/bin/codesign", ["--verify", "--strict", path], { stdio: "pipe" });
		const signature = runCommand("/usr/bin/codesign", ["--display", "--verbose=4", path], {
			encoding: "utf8",
			stdio: "pipe",
		}).stderr;
		verifyDeveloperIdIdentity(signature, expectedTeamId);
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
		verifyEntitlementDictionary(path, entitlements);
		audited.push(relative(appPath, path));
	}
	if (
		!audited.includes("Contents/Resources/runtime/bin/node") ||
		!audited.some((path) => /^Contents\/MacOS\/[^/]+$/u.test(path))
	) {
		throw new Error("Signed entitlement audit is missing the app or bundled Node executable.");
	}
	return audited;
}
