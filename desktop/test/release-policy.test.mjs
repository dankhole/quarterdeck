import { describe, expect, it } from "vitest";
import { createReleasePolicy, releaseBuildSettings, validateReleasePolicy } from "../scripts/release-policy.mjs";

const signed = { QUARTERDECK_DESKTOP_SIGN: "1", QUARTERDECK_DESKTOP_TEAM_ID: "AB12345678" };
function bundle(settings, version = "0.12.8") {
	return {
		schemaVersion: 1,
		...settings,
		version,
		sourceSha: "a".repeat(40),
		buildId: "synthetic-build",
		arch: "arm64",
	};
}

describe("build-time installation provenance", () => {
	it("uses npm authority for signed, unsigned, stable, and preview artifacts", () => {
		for (const environment of [{}, signed]) {
			for (const version of ["0.12.8", "0.12.8-rc.1"]) {
				const settings = releaseBuildSettings(environment, version);
				expect(settings).toEqual({
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
