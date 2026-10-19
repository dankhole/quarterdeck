export const releaseRepository = "dankhole/quarterdeck";

const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const previewVersion =
	/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-(?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*))*$/u;

/** Embedded distribution provenance; npm is the only update authority in every build. */
export function releaseBuildSettings(environment = process.env, version) {
	if (!stableVersion.test(version ?? "") && !previewVersion.test(version ?? "")) {
		throw new Error("Desktop release version must be stable or prerelease semver without build metadata.");
	}
	if (environment.QUARTERDECK_DESKTOP_PRODUCTION_UPDATES || environment.QUARTERDECK_DESKTOP_VALIDATION_FEED_BASE) {
		throw new Error("Desktop update feeds are no longer supported; npm owns Quarterdeck updates.");
	}
	const signedDistribution = environment.QUARTERDECK_DESKTOP_SIGN === "1";
	const expectedTeamId = signedDistribution ? environment.QUARTERDECK_DESKTOP_TEAM_ID : null;
	if (signedDistribution && !/^[A-Z0-9]{10}$/u.test(expectedTeamId ?? "")) {
		throw new Error("Signed desktop builds require a public QUARTERDECK_DESKTOP_TEAM_ID.");
	}
	return {
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
	const expected = releaseBuildSettings(
		{
			QUARTERDECK_DESKTOP_SIGN: manifest.signedDistribution === true ? "1" : undefined,
			QUARTERDECK_DESKTOP_TEAM_ID: manifest.expectedTeamId,
		},
		manifest.version,
	);
	if (
		policy.schemaVersion !== 1 ||
		policy.repository !== releaseRepository ||
		policy.version !== manifest.version ||
		policy.sourceSha !== manifest.sourceSha ||
		policy.buildId !== manifest.buildId ||
		policy.arch !== manifest.arch ||
		Object.entries(expected).some(([key, value]) => policy[key] !== value || manifest[key] !== value) ||
		[policy, manifest].some((value) =>
			["productionUpdatesEnabled", "validationFeedBase"].some((key) => Object.hasOwn(value, key)),
		)
	)
		throw new Error("Embedded desktop release policy does not match its runtime build.");
	return policy;
}
