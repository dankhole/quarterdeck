import { randomUUID } from "node:crypto";
import { link, lstat, open, readdir, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { type RuntimeOwnershipClaim, runtimeOwnershipClaimSchema } from "../core/api/runtime-management.js";
import { ensurePrivateDirectory } from "../core/private-directory.js";
import { readRuntimeBootIdentity } from "./runtime-boot-identity.js";
import {
	RuntimeOwnershipError,
	type RuntimeOwnershipLease,
	readPriorRuntimeOwnershipClaims,
} from "./runtime-ownership.js";
import {
	assertPriorRuntimeProcessCustody,
	assertSavedRuntimeProcessesAbsent,
	bootIdentityKind,
	ordinaryRuntimeCustodyCleared,
	RuntimeRecoveryAdmissionError,
	readSavedRuntimeProcessEvidence,
	type SavedRuntimeProcessInspectionOptions,
} from "./runtime-recovery-evidence.js";

const MAX_RECEIPT_BYTES = 16_384;
const MAX_RECEIPTS = 100_000;
const acknowledgementSchema = z
	.object({
		version: z.literal(1),
		kind: z.literal("user_confirmed_prior_processes_stopped"),
		boundaryClaim: runtimeOwnershipClaimSchema,
		bootIdentity: z.string().min(1).max(512),
		acknowledgedAt: z.string().datetime(),
	})
	.strict();

function receiptDirectory(home: string): string {
	return join(home, "runtime-ownership", "recovery-acknowledged");
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readReceipt(path: string, boundary: RuntimeOwnershipClaim): Promise<string> {
	const stat = await lstat(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECEIPT_BYTES)
		throw new Error("Invalid recovery acknowledgement file.");
	const receipt = acknowledgementSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
	if (
		boundary.purpose !== "maintenance" ||
		JSON.stringify(receipt.boundaryClaim) !== JSON.stringify(runtimeOwnershipClaimSchema.parse(boundary)) ||
		!bootIdentityKind(receipt.bootIdentity) ||
		receipt.bootIdentity !== boundary.bootIdentity
	)
		throw new Error("Recovery acknowledgement does not match its immutable claim.");
	return receipt.bootIdentity;
}

/**
 * A receipt acknowledges all predecessors of its exact maintenance claim.
 * It never claims that shutdown drained, nor authorizes a newer generation.
 * Every retained receipt is validated, including receipts from a different boot.
 */
export async function readAcknowledgedRuntimeRecoveryBoundary(
	stateHome: string,
	history: readonly RuntimeOwnershipClaim[],
	currentBootIdentity: string | null,
): Promise<string | null> {
	const directory = receiptDirectory(stateHome);
	let entries: string[];
	try {
		const stat = await lstat(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid acknowledgement directory.");
		entries = await readdir(directory);
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
	if (entries.length > MAX_RECEIPTS) throw new Error("Recovery acknowledgements exceed their bounded size.");
	const byGeneration = new Map(history.map((claim, index) => [claim.generation, { claim, index }]));
	let latest = -1;
	for (const entry of entries) {
		if (entry.startsWith(".")) continue;
		const boundary = byGeneration.get(entry.endsWith(".json") ? entry.slice(0, -5) : "");
		if (!boundary) throw new Error("Recovery acknowledgement has no reachable claim.");
		const boot = await readReceipt(join(directory, entry), boundary.claim);
		if (boot === currentBootIdentity) latest = Math.max(latest, boundary.index);
	}
	return history[latest]?.generation ?? null;
}

export interface RuntimeRecoveryInspection {
	recoveryRequired: boolean;
}

export interface RuntimeRecoveryAcknowledgementOptions extends SavedRuntimeProcessInspectionOptions {
	readBootIdentity?: () => Promise<string | null>;
}

function assertMaintenanceLease(lease: RuntimeOwnershipLease): RuntimeOwnershipClaim {
	lease.assertCurrent();
	const claim = lease.getClaim();
	if (claim.purpose !== "maintenance")
		throw new RuntimeOwnershipError(
			"maintenance_busy",
			"Recovery acknowledgement requires an exclusive maintenance lease.",
		);
	return claim;
}

async function verifiedCurrentBoot(
	claim: RuntimeOwnershipClaim,
	options: RuntimeRecoveryAcknowledgementOptions,
): Promise<string> {
	const currentBoot = await (options.readBootIdentity ?? readRuntimeBootIdentity)();
	if (!currentBoot || !bootIdentityKind(currentBoot) || currentBoot !== claim.bootIdentity)
		throw new RuntimeRecoveryAdmissionError("boot_identity_unavailable");
	return currentBoot;
}

/** Read-only preflight under the same lifetime admission used by runtime launch. */
export async function inspectRuntimeRecovery(
	lease: RuntimeOwnershipLease,
	options: RuntimeRecoveryAcknowledgementOptions = {},
): Promise<RuntimeRecoveryInspection> {
	try {
		const claim = assertMaintenanceLease(lease);
		const boot = await verifiedCurrentBoot(claim, options);
		const history = await readPriorRuntimeOwnershipClaims(lease.canonicalStateHome, lease.generation);
		const boundary = await readAcknowledgedRuntimeRecoveryBoundary(
			lease.canonicalStateHome,
			[...history.map((owner) => owner.claim), claim],
			boot,
		);
		const evidence = await readSavedRuntimeProcessEvidence(lease.canonicalStateHome);
		let recoveryRequired = false;
		const priorBoundary = boundary === claim.generation ? claim.previousGeneration : boundary;
		try {
			assertPriorRuntimeProcessCustody(history, boot, priorBoundary);
		} catch (error) {
			if (!(error instanceof RuntimeRecoveryAdmissionError) || error.reason !== "unconfirmed_prior_custody")
				throw error;
			recoveryRequired = true;
		}
		const ordinaryCleared = ordinaryRuntimeCustodyCleared(history, boot, priorBoundary);
		if (evidence.pids.size > 0 && !ordinaryCleared && !boundary) recoveryRequired = true;
		if (!ordinaryCleared || recoveryRequired) await assertSavedRuntimeProcessesAbsent(evidence, options);
		lease.assertCurrent();
		return { recoveryRequired };
	} catch (error) {
		if (error instanceof RuntimeRecoveryAdmissionError || error instanceof RuntimeOwnershipError) throw error;
		throw new RuntimeRecoveryAdmissionError("unverifiable_evidence");
	}
}

async function syncDirectory(path: string): Promise<void> {
	if (process.platform === "win32") return;
	const directory = await open(path, "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

/** Called only for explicit user acknowledgement of detached descendant uncertainty. */
export async function acknowledgeRuntimeRecovery(
	lease: RuntimeOwnershipLease,
	options: RuntimeRecoveryAcknowledgementOptions = {},
): Promise<void> {
	try {
		const inspection = await inspectRuntimeRecovery(lease, options);
		if (!inspection.recoveryRequired) return;
		const claim = assertMaintenanceLease(lease);
		const directory = receiptDirectory(lease.canonicalStateHome);
		try {
			const stat = await lstat(directory);
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid acknowledgement directory.");
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
		await ensurePrivateDirectory(directory);
		await syncDirectory(dirname(directory));
		const temporary = join(directory, `.${randomUUID()}.tmp`);
		try {
			const boot = await verifiedCurrentBoot(claim, options);
			const file = await open(temporary, "wx", 0o600);
			try {
				const receipt = acknowledgementSchema.parse({
					version: 1,
					kind: "user_confirmed_prior_processes_stopped",
					boundaryClaim: claim,
					bootIdentity: boot,
					acknowledgedAt: new Date().toISOString(),
				});
				await file.writeFile(`${JSON.stringify(receipt)}\n`, "utf8");
				await file.sync();
			} finally {
				await file.close();
			}
			// Re-read saved evidence and query again after preparation. An earlier
			// successful inspection cannot dismiss a root that appeared since then.
			lease.assertCurrent();
			await assertSavedRuntimeProcessesAbsent(
				await readSavedRuntimeProcessEvidence(lease.canonicalStateHome),
				options,
			);
			await verifiedCurrentBoot(claim, options);
			lease.assertCurrent();
			const path = join(directory, `${claim.generation}.json`);
			try {
				await link(temporary, path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				await readReceipt(path, claim);
			}
			await syncDirectory(directory);
			lease.assertCurrent();
		} finally {
			await unlink(temporary).catch(() => undefined);
		}
	} catch (error) {
		if (error instanceof RuntimeRecoveryAdmissionError || error instanceof RuntimeOwnershipError) throw error;
		throw new RuntimeRecoveryAdmissionError("unverifiable_evidence");
	}
}
