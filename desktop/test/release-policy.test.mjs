import { describe, expect, it } from "vitest";
import {
	createReleasePolicy,
	normalizeValidationFeedBase,
	releaseBuildSettings,
	validateReleasePolicy,
} from "../scripts/release-policy.mjs";

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

describe("signed build-time update policy", () => {
	it("keeps unsigned and signed stable candidates off the production feed by default", () => {
		for (const environment of [{}, signed, { ...signed, QUARTERDECK_DESKTOP_VALIDATION_FEED_BASE: "" }]) {
			const settings = releaseBuildSettings(environment, "0.12.8");
			expect(settings.channel).toBe("stable");
			expect(settings.productionUpdatesEnabled).toBe(false);
			expect(settings.validationFeedBase).toBeNull();
			const manifest = bundle(settings);
			expect(validateReleasePolicy(createReleasePolicy(manifest, settings), manifest).channel).toBe("stable");
		}
	});
	it("embeds an approved protected production setting only in stable signed builds", () => {
		const environment = { ...signed, QUARTERDECK_DESKTOP_PRODUCTION_UPDATES: "1" };
		const settings = releaseBuildSettings(environment, "0.12.8");
		expect(settings.productionUpdatesEnabled).toBe(true);
		expect(settings.channel).toBe("stable");
		expect(() => releaseBuildSettings({ QUARTERDECK_DESKTOP_PRODUCTION_UPDATES: "1" }, "0.12.8")).toThrow();
		expect(() => releaseBuildSettings(environment, "0.12.8-rc.1")).toThrow("Preview");
	});
	it("records preview policy explicitly and disallows invalid or metadata versions", () => {
		const settings = releaseBuildSettings(signed, "0.12.8-rc.1");
		const manifest = bundle(settings, "0.12.8-rc.1");
		expect(validateReleasePolicy(createReleasePolicy(manifest, settings), manifest).channel).toBe("preview");
		for (const version of ["01.2.3", "1.2", "1.2.3+local", "1.2.3-01", "1.2.3-", "v1.2.3"]) {
			expect(() => releaseBuildSettings(signed, version)).toThrow("version");
		}
	});
	it("embeds canonical controlled HTTPS validation policy before signing", () => {
		const settings = releaseBuildSettings(
			{ ...signed, QUARTERDECK_DESKTOP_VALIDATION_FEED_BASE: "https://updates.example.test/controlled///" },
			"0.12.8",
		);
		expect(settings).toMatchObject({
			channel: "validation",
			validationFeedBase: "https://updates.example.test/controlled/",
			productionUpdatesEnabled: false,
		});
		const manifest = bundle(settings);
		const policy = createReleasePolicy(manifest, settings);
		expect(validateReleasePolicy(policy, manifest)).toEqual(policy);
		for (const change of [
			{ channel: "stable" },
			{ validationFeedBase: "https://other.example.test/" },
			{ productionUpdatesEnabled: true },
		]) {
			expect(() => validateReleasePolicy({ ...policy, ...change }, manifest)).toThrow();
		}
	});
	it("rejects unsigned, production-enabled, or prerelease validation builds", () => {
		for (const [environment, version] of [
			[{ QUARTERDECK_DESKTOP_VALIDATION_FEED_BASE: "https://updates.example.test/" }, "0.12.8"],
			[
				{
					...signed,
					QUARTERDECK_DESKTOP_VALIDATION_FEED_BASE: "https://updates.example.test/",
					QUARTERDECK_DESKTOP_PRODUCTION_UPDATES: "1",
				},
				"0.12.8",
			],
			[{ ...signed, QUARTERDECK_DESKTOP_VALIDATION_FEED_BASE: "https://updates.example.test/" }, "0.12.8-rc.1"],
		]) {
			expect(() => releaseBuildSettings(environment, version)).toThrow("Validation");
		}
	});
	it("rejects credential-bearing, noncanonical, or non-HTTPS validation endpoints", () => {
		expect(normalizeValidationFeedBase("https://updates.example.test")).toBe("https://updates.example.test/");
		for (const value of [
			"",
			"http://updates.example.test/",
			"https://user:secret@updates.example.test/",
			"https://updates.example.test/?token=synthetic",
			"https://updates.example.test/?",
			"https://updates.example.test/#",
			" https://updates.example.test/",
			"https://UPDATES.example.test/",
			"https://updates.example.test:443/",
			"https://updates.example.test/a/../b",
			"https://updates.example.test/with space",
			"https://updates.example.test/with\ncontrol",
		]) {
			expect(() => normalizeValidationFeedBase(value)).toThrow();
		}
	});
	it("keeps controlled validation off every production-service path", () => {
		for (const value of [
			"https://update.electronjs.org/",
			"https://update.electronjs.org/arbitrary/path/",
			"https://update.electronjs.org./controlled/",
			"https://update.electronjs.org..:8443/controlled/",
		]) {
			expect(() => normalizeValidationFeedBase(value)).toThrow("separate from the production feed");
			expect(() =>
				releaseBuildSettings({ ...signed, QUARTERDECK_DESKTOP_VALIDATION_FEED_BASE: value }, "0.12.8"),
			).toThrow("separate from the production feed");
		}
	});
});
