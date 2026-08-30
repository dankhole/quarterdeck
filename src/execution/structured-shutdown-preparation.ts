export interface StructuredShutdownPreparationDependencies {
	stopReconciliation: () => void;
	waitForReconciliation: () => Promise<void>;
	stopOwners: () => Promise<void>;
}

/**
 * Preserve the policy from the first shutdown request across every later close
 * step. Crash simulation must quiesce server reconciliation without explicitly
 * stopping provider processes; normal shutdown must stop every structured owner.
 */
export function createStructuredShutdownPreparation(
	dependencies: StructuredShutdownPreparationDependencies,
): (options?: { skipSessionCleanup?: boolean }) => Promise<void> {
	let preparation: Promise<void> | null = null;
	return (options = {}) => {
		preparation ??= (async () => {
			dependencies.stopReconciliation();
			await dependencies.waitForReconciliation();
			if (!options.skipSessionCleanup) await dependencies.stopOwners();
		})();
		return preparation;
	};
}
