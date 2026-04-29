export type { BaseRefWorktreeMetadata } from "./project-metadata-base-ref";
export type { ProjectMetadataEntry, ProjectMetadataPollIntervals } from "./project-metadata-entry";
export {
	areProjectMetadataEqual,
	buildProjectMetadataSnapshot,
	createEmptyProjectMetadata,
	createProjectEntry,
	PROJECT_METADATA_POLL_INTERVALS,
} from "./project-metadata-entry";
export type { CachedHomeGitMetadata } from "./project-metadata-home";
export { loadHomeGitMetadata } from "./project-metadata-home";
export type { CachedPathWorktreeMetadata } from "./project-metadata-path-loader";
export { loadPathWorktreeMetadata } from "./project-metadata-path-loader";
export type {
	ResolvedTaskWorktreeMetadataInput,
	ResolvedTaskWorktreePath,
	TrackedTaskWorktree,
} from "./project-metadata-paths";
export {
	collectTrackedTasks,
	resolveTaskWorktreeMetadataInput,
	resolveTaskWorktreePath,
} from "./project-metadata-paths";
export type {
	CachedTaskWorktreeMetadata,
	LoadedTaskWorktreeMetadata,
} from "./project-metadata-task-projection";
export {
	loadTaskWorktreeMetadata,
	loadTaskWorktreeMetadataBatch,
	projectTaskWorktreeMetadata,
} from "./project-metadata-task-projection";
