import { discoverRuntimeDiagnosticInstances } from "../diagnostics/runtime-instance";

/** A local project gate cannot drain work owned by another runtime sharing this state home. */
export async function assertProjectRelocationRuntimeIsExclusive(runtimeInstanceId: string): Promise<void> {
	const instances = await discoverRuntimeDiagnosticInstances();
	const otherRuntime = instances.find(
		({ descriptor, pidAlive }) =>
			descriptor.processKind !== "desktop" &&
			descriptor.runtimeInstanceId !== runtimeInstanceId &&
			pidAlive &&
			(descriptor.status === "starting" || descriptor.status === "ready" || descriptor.status === "stopping"),
	);
	if (otherRuntime) {
		throw new Error(
			"Another Quarterdeck runtime is using the same saved state. Stop the other runtime before changing a project folder.",
		);
	}
}
