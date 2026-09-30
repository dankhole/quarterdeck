import type { RuntimeProjectStateResponse } from "@/runtime/types";

/** Board writes and project naming/location observations have independent clocks. */
export function mergeProjectStateByRevision(
	current: RuntimeProjectStateResponse | null,
	incoming: RuntimeProjectStateResponse,
): RuntimeProjectStateResponse {
	if (!current) return incoming;
	if (incoming.revision < current.revision && (incoming.metadataRevision ?? 0) <= (current.metadataRevision ?? 0))
		return current;
	const state = incoming.revision < current.revision ? current : incoming;
	const metadata = (incoming.metadataRevision ?? 0) < (current.metadataRevision ?? 0) ? current : incoming;
	if (state === metadata) return state;
	return {
		...state,
		repoPath: metadata.repoPath,
		git: metadata.git,
		metadataRevision: metadata.metadataRevision,
		availability: metadata.availability,
	};
}
