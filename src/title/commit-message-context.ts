import type { RuntimeWorkdirFileStatus } from "../core";

export interface RuntimeCommitMessageFileContext {
	path: string;
	previousPath?: string;
	status: RuntimeWorkdirFileStatus;
	additions: number;
	deletions: number;
}

export interface RuntimeCommitMessageFileContentContext {
	path: string;
	content: string;
	truncated: boolean;
	omittedReason?: "binary" | "symlink" | "unreadable";
}

export interface RuntimeCommitMessageGenerationContext {
	taskTitle: string | null;
	taskContext: string | null;
	files: RuntimeCommitMessageFileContext[];
	diffText: string;
	untrackedFileContents: RuntimeCommitMessageFileContentContext[];
	untrackedContentOmittedCount: number;
}
