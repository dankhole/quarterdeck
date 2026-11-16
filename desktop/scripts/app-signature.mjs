import { run } from "./process.mjs";

/** Reseal local bundles only; preserve Packager's public ad-hoc/Developer ID signatures. */
export function finalizeLocalAppSignature(appPath, hasPackagerSignature, runCommand = run) {
	if (hasPackagerSignature) return;
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
	// This fixed read-only invocation accepts no signing credentials. Preserve its
	// nested-path failure diagnostics without exposing stderr from arbitrary tools.
	runCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
		stdio: ["ignore", "ignore", "inherit"],
	});
}
