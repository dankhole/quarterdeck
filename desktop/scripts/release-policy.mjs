export const updateRepository = "dankhole/quarterdeck";

const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const previewVersion =
	/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-(?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*))*$/u;

export function normalizeValidationFeedBase(value) {
	if (typeof value !== "string" || value.length > 2048 || /[\s?#]/u.test(value)) {
		throw new Error("Validation feed must be a canonical HTTPS base without credentials, query, or fragment.");
	}
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Validation feed must be a canonical HTTPS base.");
	}
	if (url.hostname.replace(/\.+$/u, "") === "update.electronjs.org") {
		throw new Error("Validation updates require a controlled service separate from the production feed.");
	}
	const normalized = `${url.href.replace(/\/+$/u, "")}/`;
	if (url.protocol !== "https:" || url.username || url.password || `${value.replace(/\/+$/u, "")}/` !== normalized) {
		throw new Error("Validation feed must be a canonical HTTPS base without credentials, query, or fragment.");
	}
	return normalized;
}

// These are public build settings, embedded before signing. They express intent;
// a running application must also verify its actual signature and hardened fuses.
export function releaseBuildSettings(environment = process.env, version) {
	if (!stableVersion.test(version ?? "") && !previewVersion.test(version ?? "")) {
		throw new Error("Desktop release version must be stable or prerelease semver without build metadata.");
	}
	const signedDistribution = environment.QUARTERDECK_DESKTOP_SIGN === "1";
	const productionUpdatesEnabled = environment.QUARTERDECK_DESKTOP_PRODUCTION_UPDATES === "1";
	const validationFeedBase =
		environment.QUARTERDECK_DESKTOP_VALIDATION_FEED_BASE === undefined ||
		environment.QUARTERDECK_DESKTOP_VALIDATION_FEED_BASE === ""
			? null
			: normalizeValidationFeedBase(environment.QUARTERDECK_DESKTOP_VALIDATION_FEED_BASE);
	const expectedTeamId = signedDistribution ? environment.QUARTERDECK_DESKTOP_TEAM_ID : null;
	if (signedDistribution && !/^[A-Z0-9]{10}$/u.test(expectedTeamId ?? "")) {
		throw new Error("Signed desktop builds require a public QUARTERDECK_DESKTOP_TEAM_ID.");
	}
	if (productionUpdatesEnabled && !signedDistribution) {
		throw new Error("Production updates can only be embedded in an explicitly signed desktop build.");
	}
	if (validationFeedBase && (!signedDistribution || productionUpdatesEnabled || !stableVersion.test(version))) {
		throw new Error("Validation updates require an explicitly signed stable build and disabled production updates.");
	}
	if (productionUpdatesEnabled && !stableVersion.test(version)) {
		throw new Error("Preview desktop builds cannot enable production updates.");
	}
	const channel = validationFeedBase ? "validation" : stableVersion.test(version) ? "stable" : "preview";
	return { signedDistribution, expectedTeamId, productionUpdatesEnabled, channel, validationFeedBase };
}

export function createReleasePolicy(manifest, settings) {
	return {
		schemaVersion: 1,
		...settings,
		repository: updateRepository,
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
			QUARTERDECK_DESKTOP_PRODUCTION_UPDATES: manifest.productionUpdatesEnabled === true ? "1" : undefined,
			QUARTERDECK_DESKTOP_VALIDATION_FEED_BASE: manifest.validationFeedBase ?? undefined,
		},
		manifest.version,
	);
	if (
		policy.schemaVersion !== 1 ||
		policy.repository !== updateRepository ||
		policy.channel !== expected.channel ||
		(manifest.channel ?? expected.channel) !== expected.channel ||
		(policy.validationFeedBase ?? null) !== expected.validationFeedBase ||
		(manifest.validationFeedBase ?? null) !== expected.validationFeedBase ||
		policy.version !== manifest.version ||
		policy.sourceSha !== manifest.sourceSha ||
		policy.buildId !== manifest.buildId ||
		policy.arch !== manifest.arch ||
		policy.signedDistribution !== manifest.signedDistribution ||
		policy.expectedTeamId !== manifest.expectedTeamId ||
		policy.productionUpdatesEnabled !== manifest.productionUpdatesEnabled ||
		typeof policy.signedDistribution !== "boolean" ||
		typeof policy.productionUpdatesEnabled !== "boolean" ||
		(policy.signedDistribution
			? !/^[A-Z0-9]{10}$/u.test(policy.expectedTeamId ?? "")
			: policy.expectedTeamId !== null || policy.productionUpdatesEnabled)
	) {
		throw new Error("Embedded desktop release policy does not match its runtime build.");
	}
	return policy;
}
