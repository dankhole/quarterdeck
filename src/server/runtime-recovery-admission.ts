import { readRuntimeBootIdentity } from "./runtime-boot-identity.js";
import { readPriorRuntimeOwnershipClaims } from "./runtime-ownership.js";
import { readAcknowledgedRuntimeRecoveryBoundary } from "./runtime-recovery-acknowledgement.js";
import {
	assertPriorRuntimeProcessCustody,
	assertSavedRuntimeProcessesAbsent,
	ordinaryRuntimeCustodyCleared,
	RuntimeRecoveryAdmissionError,
	readSavedRuntimeProcessEvidence,
	type SavedRuntimeProcessInspectionOptions,
} from "./runtime-recovery-evidence.js";

export {
	assertPriorRuntimeProcessCustody,
	type PriorRuntimeProcessCustody,
	RuntimeRecoveryAdmissionError,
} from "./runtime-recovery-evidence.js";

export interface RuntimeRecoveryAdmissionOptions extends SavedRuntimeProcessInspectionOptions {
	stateHome: string;
	/** Required by production admission; omitted only by isolated factories/tests. */
	currentGeneration?: string;
	bootIdentity?: string | null;
	readPriorClaims?: typeof readPriorRuntimeOwnershipClaims;
}

/**
 * Before pruning/replay/recovery, refuse unconfirmed custody and live saved roots.
 * User acknowledgement is scoped to its immutable prior observation boundary;
 * admission still reads all saved evidence and rechecks saved process absence.
 */
export async function assertRuntimeRecoveryAdmission(options: RuntimeRecoveryAdmissionOptions): Promise<void> {
	try {
		let custodyCleared = false;
		let acknowledgedBoundary: string | null = null;
		if (options.currentGeneration) {
			const currentBoot =
				options.bootIdentity === undefined ? await readRuntimeBootIdentity() : options.bootIdentity;
			const history = await (options.readPriorClaims ?? readPriorRuntimeOwnershipClaims)(
				options.stateHome,
				options.currentGeneration,
			);
			acknowledgedBoundary = await readAcknowledgedRuntimeRecoveryBoundary(
				options.stateHome,
				history.map((owner) => owner.claim),
				currentBoot,
			);
			assertPriorRuntimeProcessCustody(history, currentBoot, acknowledgedBoundary);
			custodyCleared = ordinaryRuntimeCustodyCleared(history, currentBoot, acknowledgedBoundary);
		}
		// Even clean-release/reboot proof must not swallow corrupt retained evidence.
		const evidence = await readSavedRuntimeProcessEvidence(options.stateHome);
		if (custodyCleared) return;
		if (options.currentGeneration && evidence.pids.size > 0 && !acknowledgedBoundary)
			throw new RuntimeRecoveryAdmissionError("unconfirmed_prior_custody");
		await assertSavedRuntimeProcessesAbsent(evidence, options);
	} catch (error) {
		if (error instanceof RuntimeRecoveryAdmissionError) throw error;
		throw new RuntimeRecoveryAdmissionError("unverifiable_evidence");
	}
}
