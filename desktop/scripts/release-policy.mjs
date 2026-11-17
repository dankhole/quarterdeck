export const releaseRepository = "dankhole/quarterdeck";

const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const previewVersion =
	/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-(?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*))*$/u;

/** Missing mode is supported only for legacy local/Developer ID bundles. */
export function distributionModeFor(manifest) {
	const mode =
		manifest.distributionMode === undefined
			? manifest.signedDistribution === true
				? "signed"
				: "local"
			: manifest.distributionMode;
	if (
		!["local", "ad-hoc", "signed", "windows-unsigned"].includes(mode) ||
		manifest.signedDistribution !== (mode === "signed") ||
		(mode !== "signed" && manifest.expectedTeamId !== null)
	) {
		throw new Error("Desktop distribution mode does not match its signing policy.");
	}
	return mode;
}

/** Embedded distribution provenance; npm is the only update authority in every build. */
export function releaseBuildSettings(environment = process.env, version, platform = process.platform) {
	if (!stableVersion.test(version ?? "") && !previewVersion.test(version ?? "")) {
		throw new Error("Desktop release version must be stable or prerelease semver without build metadata.");
	}
	if (environment.QUARTERDECK_DESKTOP_PRODUCTION_UPDATES || environment.QUARTERDECK_DESKTOP_VALIDATION_FEED_BASE) {
		throw new Error("Desktop update feeds are no longer supported; npm owns Quarterdeck updates.");
	}
	const selected = environment.QUARTERDECK_DESKTOP_DISTRIBUTION;
	if (selected && !["ad-hoc", "windows-unsigned"].includes(selected))
		throw new Error("Unknown desktop distribution selection.");
	if ((selected === "windows-unsigned" && platform !== "win32") || (selected === "ad-hoc" && platform === "win32"))
		throw new Error("Desktop distribution does not match its native platform.");
	const signedDistribution = environment.QUARTERDECK_DESKTOP_SIGN === "1";
	if (selected && signedDistribution) throw new Error("Ad-hoc and Developer ID signing cannot be selected together.");
	if (environment.QUARTERDECK_DESKTOP_NOTARIZE === "1" && !signedDistribution) {
		throw new Error("Notarization requires explicit Developer ID signing.");
	}
	if (platform === "win32" && signedDistribution)
		throw new Error("Developer ID signing is not a Windows distribution mode.");
	const distributionMode = signedDistribution ? "signed" : (selected ?? "local");
	const expectedTeamId = signedDistribution ? environment.QUARTERDECK_DESKTOP_TEAM_ID : null;
	if (signedDistribution && !/^[A-Z0-9]{10}$/u.test(expectedTeamId ?? "")) {
		throw new Error("Signed desktop builds require a public QUARTERDECK_DESKTOP_TEAM_ID.");
	}
	return {
		distributionMode,
		signedDistribution,
		expectedTeamId,
		updateAuthority: "npm",
		channel: stableVersion.test(version) ? "stable" : "preview",
	};
}

export function createReleasePolicy(manifest, settings) {
	return {
		schemaVersion: 1,
		...settings,
		repository: releaseRepository,
		version: manifest.version,
		sourceSha: manifest.sourceSha,
		buildId: manifest.buildId,
		arch: manifest.arch,
	};
}

export function validateReleasePolicy(policy, manifest) {
	const mode = distributionModeFor(manifest);
	const expected = releaseBuildSettings(
		{
			QUARTERDECK_DESKTOP_SIGN: mode === "signed" ? "1" : undefined,
			QUARTERDECK_DESKTOP_DISTRIBUTION: ["ad-hoc", "windows-unsigned"].includes(mode) ? mode : undefined,
			QUARTERDECK_DESKTOP_TEAM_ID: manifest.expectedTeamId,
		},
		manifest.version,
		manifest.platform,
	);
	if (
		policy.schemaVersion !== 1 ||
		policy.repository !== releaseRepository ||
		policy.version !== manifest.version ||
		policy.sourceSha !== manifest.sourceSha ||
		policy.buildId !== manifest.buildId ||
		policy.arch !== manifest.arch ||
		distributionModeFor(policy) !== mode ||
		Object.entries(expected).some(
			([key, value]) => key !== "distributionMode" && (policy[key] !== value || manifest[key] !== value),
		) ||
		[policy, manifest].some((value) =>
			["productionUpdatesEnabled", "validationFeedBase"].some((key) => Object.hasOwn(value, key)),
		)
	)
		throw new Error("Embedded desktop release policy does not match its runtime build.");
	return policy;
}
