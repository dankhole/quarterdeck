import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { FuseState, FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { canonicalDesktopValidationFeedBase } from "./desktop-update-feed.js";
import { type DesktopUpdateEligibility, desktopUpdateEligibility } from "./desktop-updates.js";

const execFileAsync = promisify(execFile);
export interface DesktopUpdateProofInput {
	appPath: string;
	resourceRoot: string;
	isPackaged: boolean;
	synthetic: boolean;
	platform: NodeJS.Platform;
	bundle: { version: string; sourceSha: string; buildId: string; arch: string };
}

interface ProofServices {
	hasManagedInstallationReceipt: (appPath: string) => Promise<boolean>;
	readPolicy: (path: string) => Promise<string>;
	assessSignature: (appPath: string) => Promise<string>;
	readFuses: typeof getCurrentFuseWire;
}

const services: ProofServices = {
	hasManagedInstallationReceipt: hasManagedDesktopInstallationReceipt,
	readPolicy: (path) => readFile(path, "utf8"),
	assessSignature: async (appPath) => {
		const options = { timeout: 15_000, maxBuffer: 64 * 1024 };
		await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], options);
		await execFileAsync("/usr/sbin/spctl", ["--assess", "--type", "execute", appPath], options);
		const result = await execFileAsync("/usr/bin/codesign", ["-dv", "--verbose=4", appPath], options);
		return result.stderr;
	},
	readFuses: getCurrentFuseWire,
};

/** An npm receipt only disables updates. Corrupt or unreadable markers also fail closed. */
export async function hasManagedDesktopInstallationReceipt(appPath: string): Promise<boolean> {
	try {
		await lstat(join(dirname(await realpath(appPath)), "managed-installation.json"));
		return true;
	} catch (error: unknown) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}

/** Signed policy is only a claim until the OS verifies its enclosing app and current fuse bytes. */
export async function verifyDesktopUpdateEligibility(
	input: DesktopUpdateProofInput,
	proof: ProofServices = services,
): Promise<DesktopUpdateEligibility> {
	if (input.synthetic) return { enabled: false, reason: "synthetic" };
	if (!input.isPackaged) return { enabled: false, reason: "unsigned" };
	if (input.platform !== "darwin") return { enabled: false, reason: "unsupported" };
	try {
		if (await proof.hasManagedInstallationReceipt(input.appPath)) return { enabled: false, reason: "npm_managed" };
		const value: unknown = JSON.parse(await proof.readPolicy(join(input.resourceRoot, "release-policy.json")));
		if (!value || typeof value !== "object") return { enabled: false, reason: "unsigned" };
		const policy = value as Record<string, unknown>;
		if (
			policy.schemaVersion !== 1 ||
			policy.signedDistribution !== true ||
			policy.repository !== "dankhole/quarterdeck" ||
			(policy.channel !== "stable" && policy.channel !== "validation") ||
			typeof policy.expectedTeamId !== "string" ||
			!/^[A-Z0-9]{10}$/u.test(policy.expectedTeamId) ||
			policy.version !== input.bundle.version ||
			policy.arch !== input.bundle.arch ||
			policy.sourceSha !== input.bundle.sourceSha ||
			policy.buildId !== input.bundle.buildId ||
			!/^([a-f0-9]{40})$/u.test(input.bundle.sourceSha) ||
			!input.bundle.buildId
		)
			return { enabled: false, reason: "unsigned" };
		const validationFeedBase =
			policy.channel === "validation" ? canonicalDesktopValidationFeedBase(policy.validationFeedBase) : null;
		if (
			typeof policy.productionUpdatesEnabled !== "boolean" ||
			(policy.channel === "validation" && (!validationFeedBase || policy.productionUpdatesEnabled)) ||
			(policy.channel === "stable" && policy.validationFeedBase != null)
		)
			return { enabled: false, reason: "unsigned" };
		const signature = await proof.assessSignature(input.appPath);
		const team = /^TeamIdentifier=(.+)$/mu.exec(signature)?.[1];
		const hardened = /^.*flags=.*\bruntime\b.*$/mu.test(signature);
		const developerId = /^Authority=Developer ID Application:/mu.test(signature);
		if (team !== policy.expectedTeamId || !hardened || !developerId) return { enabled: false, reason: "unsigned" };
		const wire = await proof.readFuses(input.appPath);
		for (const option of [
			FuseV1Options.RunAsNode,
			FuseV1Options.EnableNodeOptionsEnvironmentVariable,
			FuseV1Options.EnableNodeCliInspectArguments,
			FuseV1Options.GrantFileProtocolExtraPrivileges,
		]) {
			if (wire[option] !== FuseState.DISABLE) return { enabled: false, reason: "unsigned" };
		}
		for (const option of [
			FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
			FuseV1Options.OnlyLoadAppFromAsar,
			FuseV1Options.EnableCookieEncryption,
		]) {
			if (wire[option] !== FuseState.ENABLE) return { enabled: false, reason: "unsigned" };
		}
		return desktopUpdateEligibility({
			isPackaged: input.isPackaged,
			synthetic: input.synthetic,
			platform: input.platform,
			arch: input.bundle.arch,
			version: input.bundle.version,
			signed: true,
			hardened,
			productionFeedEnabled: policy.productionUpdatesEnabled === true,
			...(validationFeedBase ? { validationFeedBase } : {}),
		});
	} catch {
		// Missing proof, failed OS assessment, invalid bytes, and deadlines all fail closed.
		return { enabled: false, reason: "unsigned" };
	}
}
