import { type FuseConfig, FuseState, FuseV1Options, FuseVersion } from "@electron/fuses";
import { describe, expect, it, vi } from "vitest";
import { type DesktopUpdateProofInput, verifyDesktopUpdateEligibility } from "../src/desktop-update-proof.js";

function fixture() {
	const input: DesktopUpdateProofInput = {
		appPath: "/synthetic/Quarterdeck.app",
		resourceRoot: "/synthetic/runtime",
		isPackaged: true,
		synthetic: false,
		platform: "darwin",
		bundle: { version: "0.12.8", sourceSha: "a".repeat(40), buildId: "build", arch: "arm64" },
	};
	const policy = {
		schemaVersion: 1,
		signedDistribution: true,
		expectedTeamId: "AB12345678",
		productionUpdatesEnabled: true,
		repository: "dankhole/quarterdeck",
		channel: "stable",
		...input.bundle,
	};
	const wire: FuseConfig<FuseState> = {
		version: FuseVersion.V1,
		[FuseV1Options.RunAsNode]: FuseState.DISABLE,
		[FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FuseState.DISABLE,
		[FuseV1Options.EnableNodeCliInspectArguments]: FuseState.DISABLE,
		[FuseV1Options.GrantFileProtocolExtraPrivileges]: FuseState.DISABLE,
		[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FuseState.ENABLE,
		[FuseV1Options.OnlyLoadAppFromAsar]: FuseState.ENABLE,
		[FuseV1Options.EnableCookieEncryption]: FuseState.ENABLE,
	};
	const services = {
		hasManagedInstallationReceipt: vi.fn(async () => false),
		readPolicy: vi.fn(async () => JSON.stringify(policy)),
		assessSignature: vi.fn(
			async () =>
				"Authority=Developer ID Application: Synthetic Developer (AB12345678)\nTeamIdentifier=AB12345678\nCodeDirectory v=20500 flags=0x10000(runtime) hashes=10\n",
		),
		readFuses: vi.fn(async () => wire),
	};
	return { input, policy, wire, services };
}

describe("verified signed updater policy", () => {
	it("disables signed feeds for npm-managed apps even when launched without npm arguments", async () => {
		const f = fixture();
		f.services.hasManagedInstallationReceipt.mockResolvedValue(true);
		expect(await verifyDesktopUpdateEligibility(f.input, f.services)).toEqual({
			enabled: false,
			reason: "npm_managed",
		});
		expect(f.services.hasManagedInstallationReceipt).toHaveBeenCalledExactlyOnceWith(f.input.appPath);
		expect(f.services.readPolicy).not.toHaveBeenCalled();
		expect(f.services.assessSignature).not.toHaveBeenCalled();
	});
	it("accepts a build-time validation channel only with the same real signature/fuse proof and production disabled", async () => {
		const f = fixture();
		Object.assign(f.policy, {
			channel: "validation",
			productionUpdatesEnabled: false,
			validationFeedBase: "https://updates.example/private/",
		});
		expect(await verifyDesktopUpdateEligibility(f.input, f.services)).toEqual({
			enabled: true,
			arch: "arm64",
			version: "0.12.8",
			validationFeedBase: "https://updates.example/private/",
		});
		expect(f.services.assessSignature).toHaveBeenCalledTimes(1);
		f.policy.productionUpdatesEnabled = true;
		expect(await verifyDesktopUpdateEligibility(f.input, f.services)).toEqual({ enabled: false, reason: "unsigned" });
	});
	it("rejects URL overrides on stable policy and insecure/credentialed validation feeds", async () => {
		for (const change of [
			{ validationFeedBase: "https://updates.example/" },
			{ channel: "validation", productionUpdatesEnabled: false, validationFeedBase: "http://updates.example/" },
			{
				channel: "validation",
				productionUpdatesEnabled: false,
				validationFeedBase: "https://user:password@updates.example/",
			},
		]) {
			const f = fixture();
			Object.assign(f.policy, change);
			expect(await verifyDesktopUpdateEligibility(f.input, f.services)).toEqual({
				enabled: false,
				reason: "unsigned",
			});
			expect(f.services.assessSignature).not.toHaveBeenCalled();
		}
	});
	it("enables only matching signed policy with OS-assessed identity and release fuses", async () => {
		const f = fixture();
		expect(await verifyDesktopUpdateEligibility(f.input, f.services)).toEqual({
			enabled: true,
			arch: "arm64",
			version: "0.12.8",
		});
		f.policy.productionUpdatesEnabled = false;
		expect(await verifyDesktopUpdateEligibility(f.input, f.services)).toEqual({
			enabled: false,
			reason: "production_feed_disabled",
		});
	});
	it("never inspects or enables a synthetic or development package", async () => {
		const f = fixture();
		expect(await verifyDesktopUpdateEligibility({ ...f.input, synthetic: true }, f.services)).toEqual({
			enabled: false,
			reason: "synthetic",
		});
		expect(await verifyDesktopUpdateEligibility({ ...f.input, isPackaged: false }, f.services)).toEqual({
			enabled: false,
			reason: "unsigned",
		});
		expect(f.services.assessSignature).not.toHaveBeenCalled();
	});
	it("rejects policy spoofing, source/version disagreement, and unsigned claims", async () => {
		for (const change of [
			{ signedDistribution: false },
			{ repository: "arbitrary/repo" },
			{ channel: "preview" },
			{ sourceSha: "b".repeat(40) },
			{ version: "0.0.0" },
			{ buildId: "other" },
		]) {
			const f = fixture();
			Object.assign(f.policy, change);
			expect(await verifyDesktopUpdateEligibility(f.input, f.services)).toEqual({
				enabled: false,
				reason: "unsigned",
			});
			expect(f.services.assessSignature).not.toHaveBeenCalled();
		}
	});
	it("does not trust a claimed team/signature without actual hardened Developer ID assessment", async () => {
		for (const signature of [
			"TeamIdentifier=OTHERTEAM1\nflags=0x10000(runtime)\n",
			"TeamIdentifier=AB12345678\nflags=0x0(none)\n",
			"Authority=Ad Hoc\nTeamIdentifier=AB12345678\nflags=0x10000(runtime)\n",
		]) {
			const f = fixture();
			f.services.assessSignature.mockResolvedValue(signature);
			expect(await verifyDesktopUpdateEligibility(f.input, f.services)).toEqual({
				enabled: false,
				reason: "unsigned",
			});
		}
		const f = fixture();
		f.services.assessSignature.mockRejectedValue(new Error("Gatekeeper rejection"));
		expect(await verifyDesktopUpdateEligibility(f.input, f.services)).toEqual({ enabled: false, reason: "unsigned" });
	});
	it("rejects inspection-enabled or missing fuse proof and unreadable metadata", async () => {
		const f = fixture();
		f.wire[FuseV1Options.EnableNodeCliInspectArguments] = FuseState.ENABLE;
		expect(await verifyDesktopUpdateEligibility(f.input, f.services)).toEqual({ enabled: false, reason: "unsigned" });
		delete f.wire[FuseV1Options.EnableNodeCliInspectArguments];
		expect(await verifyDesktopUpdateEligibility(f.input, f.services)).toEqual({ enabled: false, reason: "unsigned" });
		f.services.readPolicy.mockResolvedValue("malformed");
		expect(await verifyDesktopUpdateEligibility(f.input, f.services)).toEqual({ enabled: false, reason: "unsigned" });
	});
});
