import { describe, expect, it } from "vitest";
import {
	createReleasePolicy,
	distributionModeFor,
	releaseBuildSettings as nativeReleaseBuildSettings,
	validateReleasePolicy,
} from "../scripts/release-policy.mjs";

const releaseBuildSettings = (environment, version) => nativeReleaseBuildSettings(environment, version, "darwin");

const signed = { QUARTERDECK_DESKTOP_SIGN: "1", QUARTERDECK_DESKTOP_TEAM_ID: "AB12345678" };
const adhoc = { QUARTERDECK_DESKTOP_DISTRIBUTION: "ad-hoc" };
function bundle(settings, version = "0.12.8") {
	return {
		schemaVersion: 1,
		platform: "darwin",
		...settings,
		version,
		sourceSha: "a".repeat(40),
		buildId: "synthetic-build",
		arch: "arm64",
	};
}

describe("build-time installation provenance", () => {
	it("binds unsigned Windows distribution to its native platform and production policy", () => {
		const environment = { QUARTERDECK_DESKTOP_DISTRIBUTION: "windows-unsigned" };
		const settings = nativeReleaseBuildSettings(environment, "0.12.8", "win32");
		const manifest = { ...bundle(settings), platform: "win32" };
		expect(validateReleasePolicy(createReleasePolicy(manifest, settings), manifest).distributionMode).toBe(
			"windows-unsigned",
		);
		expect(() => nativeReleaseBuildSettings(environment, "0.12.8", "darwin")).toThrow("platform");
		expect(() => nativeReleaseBuildSettings(adhoc, "0.12.8", "win32")).toThrow("platform");
	});
	it("uses npm authority for local, public ad-hoc, signed, stable, and preview artifacts", () => {
		for (const environment of [{}, adhoc, signed]) {
			for (const version of ["0.12.8", "0.12.8-rc.1"]) {
				const settings = releaseBuildSettings(environment, version);
				expect(settings).toEqual({
					distributionMode: environment === signed ? "signed" : environment === adhoc ? "ad-hoc" : "local",
					signedDistribution: environment === signed,
					expectedTeamId: environment === signed ? signed.QUARTERDECK_DESKTOP_TEAM_ID : null,
					updateAuthority: "npm",
					channel: version.includes("-") ? "preview" : "stable",
				});
				const manifest = bundle(settings, version);
				const policy = createReleasePolicy(manifest, settings);
				expect(validateReleasePolicy(policy, manifest)).toEqual(policy);
			}
		}
	});
	it("rejects unknown, contradictory, or notarized ad-hoc selections", () => {
		for (const environment of [
			{ QUARTERDECK_DESKTOP_DISTRIBUTION: "unsigned" },
			{ ...adhoc, ...signed },
			{ ...adhoc, QUARTERDECK_DESKTOP_NOTARIZE: "1" },
		])
			expect(() => releaseBuildSettings(environment, "0.12.8")).toThrow();
	});
	it("infers absent mode only for legacy local and signed bundles", () => {
		for (const environment of [{}, signed]) {
			const manifest = bundle(releaseBuildSettings(environment, "0.12.8"));
			const policy = createReleasePolicy(manifest, releaseBuildSettings(environment, "0.12.8"));
			delete manifest.distributionMode;
			delete policy.distributionMode;
			expect(distributionModeFor(manifest)).toBe(environment === signed ? "signed" : "local");
			expect(validateReleasePolicy(policy, manifest)).toEqual(policy);
		}
		const manifest = bundle(releaseBuildSettings(adhoc, "0.12.8"));
		const policy = createReleasePolicy(manifest, releaseBuildSettings(adhoc, "0.12.8"));
		for (const change of [
			{ distributionMode: "local" },
			{ distributionMode: "signed" },
			{ distributionMode: "other" },
			{ signedDistribution: true },
			{ expectedTeamId: "AB12345678" },
		]) {
			expect(() => validateReleasePolicy({ ...policy, ...change }, manifest)).toThrow();
		}
		delete policy.distributionMode;
		expect(() => validateReleasePolicy(policy, manifest)).toThrow();
	});
	it("requires explicit valid signing team identity", () => {
		for (const team of [undefined, "", "invalid", "ab12345678"])
			expect(() => releaseBuildSettings({ ...signed, QUARTERDECK_DESKTOP_TEAM_ID: team }, "0.12.8")).toThrow(
				"TEAM_ID",
			);
	});
	it("rejects obsolete feed opt-ins rather than silently accepting an updater build", () => {
		for (const change of [
			{ QUARTERDECK_DESKTOP_PRODUCTION_UPDATES: "1" },
			{ QUARTERDECK_DESKTOP_VALIDATION_FEED_BASE: "https://updates.example/" },
		])
			expect(() => releaseBuildSettings({ ...signed, ...change }, "0.12.8")).toThrow("npm owns");
	});
	it("rejects invalid versions", () => {
		for (const version of ["01.2.3", "1.2", "1.2.3+local", "1.2.3-01", "1.2.3-", "v1.2.3"])
			expect(() => releaseBuildSettings(signed, version)).toThrow("version");
	});
	it("binds identity, signing, channel, and npm authority to both manifest and signed policy", () => {
		const settings = releaseBuildSettings(signed, "0.12.8");
		const manifest = bundle(settings);
		const policy = createReleasePolicy(manifest, settings);
		for (const change of [
			{ sourceSha: "b".repeat(40) },
			{ buildId: "other" },
			{ arch: "x64" },
			{ version: "0.12.9" },
			{ repository: "another/repository" },
			{ signedDistribution: false },
			{ distributionMode: "ad-hoc" },
			{ expectedTeamId: "XY98765432" },
			{ channel: "validation" },
			{ updateAuthority: "electron" },
			{ productionUpdatesEnabled: false },
			{ validationFeedBase: null },
		])
			expect(() => validateReleasePolicy({ ...policy, ...change }, manifest)).toThrow("does not match");
		for (const change of [
			{ updateAuthority: "electron" },
			{ channel: "preview" },
			{ productionUpdatesEnabled: false },
		])
			expect(() => validateReleasePolicy(policy, { ...manifest, ...change })).toThrow("does not match");
	});
});
