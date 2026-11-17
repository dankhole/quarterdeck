import { join } from "node:path";
import { z } from "zod";
import { desktopBuildIdentitySchema } from "../shared/desktop-installation-contract.js";
import { DesktopInstallationError } from "./errors.js";
import { readDesktopJson } from "./files.js";
import { desktopBundleDistributionMode, validateDesktopBundleMetadata } from "./metadata.js";
import type { DesktopInstallationArchitecture } from "./types.js";

/** Shared app/runtime provenance validation; platform-specific binary checks stay with each inspector. */
export async function readDesktopBundleIdentity(
	resources: string,
	version: string,
	arch: DesktopInstallationArchitecture,
	platform: "darwin" | "win32",
) {
	const bundle = validateDesktopBundleMetadata(
		await readDesktopJson(join(resources, "runtime/bundle-manifest.json")),
		version,
		arch,
		platform,
	);
	const runtimeIdentity = desktopBuildIdentitySchema.safeParse(
		await readDesktopJson(join(resources, "runtime/dist/build-manifest.json"), 4096),
	);
	if (
		!runtimeIdentity.success ||
		runtimeIdentity.data.version !== bundle.version ||
		runtimeIdentity.data.buildId !== bundle.buildId ||
		runtimeIdentity.data.sourceSha !== bundle.sourceSha ||
		runtimeIdentity.data.sourceDirty !== bundle.sourceDirty
	)
		throw new DesktopInstallationError(
			"invalid_artifact",
			"The bundled runtime build identity differs from its app.",
		);
	const policyResult = z
		.record(z.string(), z.unknown())
		.safeParse(await readDesktopJson(join(resources, "runtime/release-policy.json")));
	if (
		!policyResult.success ||
		policyResult.data.schemaVersion !== 1 ||
		policyResult.data.repository !== "dankhole/quarterdeck"
	) {
		throw new DesktopInstallationError("invalid_artifact", "The app's embedded release policy is invalid.");
	}
	const policy = policyResult.data;
	const policyMode = policy.distributionMode ?? (policy.signedDistribution ? "signed" : "local");
	if (policyMode !== desktopBundleDistributionMode(bundle))
		throw new DesktopInstallationError(
			"invalid_artifact",
			"The app's embedded distribution mode differs from its runtime identity.",
		);
	for (const field of [
		"version",
		"arch",
		"buildId",
		"sourceSha",
		"signedDistribution",
		"expectedTeamId",
		"updateAuthority",
		"channel",
	] as const) {
		if (!(field in policy) || policy[field] !== bundle[field]) {
			throw new DesktopInstallationError(
				"invalid_artifact",
				"The app's embedded policy does not match its runtime identity.",
			);
		}
	}
	return bundle;
}
