import { run } from "./process.mjs";

/** Seal the finished local bundle after Packager's plist, rename, and integrity mutations. */
export function finalizeLocalAppSignature(appPath, signedDistribution, runCommand = run) {
	if (signedDistribution) return;
	runCommand(
		"/usr/bin/codesign",
		[
			"--sign",
			"-",
			"--force",
			"--deep",
			// Derive the identifier and requirements from Quarterdeck's final bundle,
			// rather than retaining the upstream Electron identity.
			"--preserve-metadata=entitlements,flags,runtime",
			appPath,
		],
		{ stdio: "pipe" },
	);
}

/** A local ad-hoc signature must be valid too; macOS uses it for filesystem consent. */
export function verifyAppSignature(appPath, runCommand = run) {
	runCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "pipe" });
}
