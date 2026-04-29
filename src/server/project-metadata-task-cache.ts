import type { RuntimeTaskWorktreeMetadata } from "../core";

export interface CachedTaskWorktreeMetadata {
	data: RuntimeTaskWorktreeMetadata;
	stateToken: string | null;
	baseRefCommit: string | null;
	originBaseRefCommit: string | null;
	lastKnownBranch: string | null;
}
