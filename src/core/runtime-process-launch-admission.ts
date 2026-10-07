interface RuntimeProcessLaunchAdmission {
	beforeSpawn: () => void;
}

let admission: RuntimeProcessLaunchAdmission | null = null;

/** Production composition keeps this installed after lease release to fence late launches.
 * The disposer is only for isolated tests or abandoned pre-runtime composition. */
export function installRuntimeProcessLaunchAdmission(options: RuntimeProcessLaunchAdmission): () => void {
	if (admission) throw new Error("Runtime process launch admission is already installed.");
	const installed = { beforeSpawn: options.beforeSpawn };
	admission = installed;
	return () => {
		if (admission === installed) admission = null;
	};
}

/** Every actual launch revalidates the lease and durably marks custody before creating a child. */
export function assertRuntimeProcessLaunchAdmission(): void {
	const result: unknown = admission?.beforeSpawn();
	if (result !== undefined) throw new Error("Runtime process launch admission must complete synchronously.");
}
