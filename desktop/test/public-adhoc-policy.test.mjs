import { FuseV1Options } from "@electron/fuses";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ commands: [], recorded: [] }));
vi.mock("../scripts/release-policy.mjs", () => ({
	releaseBuildSettings: () => ({
		distributionMode: "ad-hoc",
		signedDistribution: false,
		expectedTeamId: null,
		updateAuthority: "npm",
		channel: "stable",
	}),
}));
vi.mock("../scripts/process.mjs", () => ({ run: (...args) => state.commands.push(args) }));
vi.mock("../scripts/artifact-manifest.mjs", () => ({
	recordPackagedApp: async (...args) => state.recorded.push(args),
	recordMakeArtifacts: vi.fn(),
}));

import forgeConfig from "../forge.config.mjs";

describe("public ad-hoc packaging policy", () => {
	it("uses explicit ad-hoc Packager signing without identities, keychains, or notarization", () => {
		const sign = forgeConfig.packagerConfig.osxSign;
		expect(sign.identity).toBe("-");
		expect(sign.identityValidation).toBe(false);
		expect(sign).not.toHaveProperty("timestamp");
		expect(sign.continueOnError).toBe(false);
		expect(sign.optionsForFile("/app/Contents/MacOS/QuarterdeckHost").timestamp).toBe("none");
		expect(sign.ignore).toHaveLength(1);
		expect(sign.ignore[0]("/public/Quarterdeck.app/Contents/MacOS/Quarterdeck")).toBe(true);
		expect(sign.ignore[0]("/public/Quarterdeck.app/Contents/MacOS/QuarterdeckHost")).toBe(false);
		expect(sign.ignore[0]("/public/Quarterdeck.app")).toBe(false);
		expect(sign).not.toHaveProperty("keychain");
		expect(forgeConfig.packagerConfig).not.toHaveProperty("osxNotarize");
		expect(sign.preAutoEntitlements).toBe(false);
		expect(sign.preEmbedProvisioningProfile).toBe(false);
		expect(sign.optionsForFile("/app/Contents/MacOS/QuarterdeckHost").hardenedRuntime).toBe(false);
		expect(sign.optionsForFile("/app/Contents/MacOS/QuarterdeckHost").entitlements).toMatch(
			/library-entitlements\.plist$/u,
		);
	});
	it("disables public inspection and every other production attack-surface fuse", () => {
		const fuses = forgeConfig.plugins.find((plugin) => plugin.name === "fuses").fusesConfig;
		for (const name of [
			"RunAsNode",
			"EnableNodeOptionsEnvironmentVariable",
			"EnableNodeCliInspectArguments",
			"GrantFileProtocolExtraPrivileges",
		])
			expect(fuses[FuseV1Options[name]]).toBe(false);
		for (const name of ["EnableCookieEncryption", "EnableEmbeddedAsarIntegrityValidation", "OnlyLoadAppFromAsar"])
			expect(fuses[FuseV1Options[name]]).toBe(true);
	});
	it("preserves Packager's nested public signatures instead of deep-resigning them as local candidates", async () => {
		await forgeConfig.hooks.postPackage({}, { outputPaths: ["/public"], arch: process.arch });
		expect(state.commands).toEqual([]);
		expect(state.recorded).toEqual([["/public", process.arch]]);
	});
});
