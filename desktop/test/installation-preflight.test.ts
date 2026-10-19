import { describe, expect, it, vi } from "vitest";
import type { DesktopInstallation } from "../../src/desktop-install/index.js";
import { preflightDesktopInstallation } from "../src/installation-preflight.js";

const installation: DesktopInstallation = {
	appPath: "/synthetic/Applications/Quarterdeck.app",
	version: "0.12.8",
	arch: "arm64",
	source: "local",
	installId: "installed",
	buildId: "build-local",
	appAsarSha256: "a".repeat(64),
	receiptPath: "/synthetic/installation/receipt.json",
	cleanupPending: false,
	owner: {
		kind: "link",
		prefix: "/synthetic/npm",
		packageSlot: "/synthetic/npm/lib/node_modules/quarterdeck",
		packageRoot: "/synthetic/checkout",
		identity: {
			schemaVersion: 1,
			version: "0.12.8",
			buildId: "build-local",
			sourceSha: "a".repeat(40),
			sourceDirty: false,
		},
	},
};
const input = { appPath: installation.appPath, version: installation.version, synthetic: false };

describe("desktop installation admission", () => {
	it("requires native admission before inspecting the recorded owner and installed pair", async () => {
		const admission = { fd: 198, path: "/synthetic/installation/admission.lock" };
		const calls: string[] = [];
		const validateAdmission = vi.fn(async () => {
			calls.push("admission");
			return admission;
		});
		const validateInstallation = vi.fn(async () => {
			calls.push("owner");
			return installation;
		});
		expect(await preflightDesktopInstallation(input, { validateAdmission, validateInstallation })).toEqual({
			installation,
			admission,
		});
		expect(calls).toEqual(["admission", "owner"]);
		expect(validateAdmission).toHaveBeenCalledExactlyOnceWith({ appPath: input.appPath, synthetic: false });
		expect(validateInstallation).toHaveBeenCalledExactlyOnceWith({
			appPath: input.appPath,
			version: input.version,
		});
	});

	it("refuses moved or unadmitted bundles before owner inspection", async () => {
		const validateInstallation = vi.fn(async () => installation);
		const failure = new Error("Open the installed app or repair installation.");
		await expect(
			preflightDesktopInstallation(input, {
				validateAdmission: async () => {
					throw failure;
				},
				validateInstallation,
			}),
		).rejects.toBe(failure);
		expect(validateInstallation).not.toHaveBeenCalled();
	});

	it("never admits an ordinary app without a lifetime native descriptor", async () => {
		const validateInstallation = vi.fn(async () => installation);
		await expect(
			preflightDesktopInstallation(input, { validateAdmission: async () => null, validateInstallation }),
		).rejects.toMatchObject({ code: "incomplete_installation" });
		expect(validateInstallation).not.toHaveBeenCalled();
	});

	it("preserves missing-owner and pairing failures for the repair surface", async () => {
		const failure = new Error("The recorded npm package changed. Run its desktop install command.");
		await expect(
			preflightDesktopInstallation(input, {
				validateAdmission: async () => ({ fd: 198, path: "/synthetic/installation/admission.lock" }),
				validateInstallation: async () => {
					throw failure;
				},
			}),
		).rejects.toBe(failure);
	});

	it("allows only the admission validator's explicit noncanonical synthetic exemption", async () => {
		const validateInstallation = vi.fn(async () => installation);
		expect(
			await preflightDesktopInstallation(
				{ ...input, synthetic: true },
				{ validateAdmission: async () => null, validateInstallation },
			),
		).toEqual({ installation: null, admission: null });
		expect(validateInstallation).not.toHaveBeenCalled();
		await preflightDesktopInstallation(
			{ ...input, synthetic: true },
			{
				validateAdmission: async () => ({ fd: 198, path: "/synthetic/installation/admission.lock" }),
				validateInstallation,
			},
		);
		expect(validateInstallation).toHaveBeenCalledOnce();
	});
});
