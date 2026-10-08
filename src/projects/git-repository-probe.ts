import { realpath } from "node:fs/promises";

import { areFileSystemPathsEqual } from "../core/path-comparison";
import { type GitCommandErrorCode, type GitCommandFailureKind, runGit } from "../workdir/git-utils";

export interface GitRepositoryProbeFailure {
	failureKind: GitCommandFailureKind | "empty_root" | "root_mismatch" | "root_unreadable";
	errorCode: GitCommandErrorCode | null;
	exitCode: number | null;
}

export interface GitRepositoryProbeOptions {
	onFailure?: (failure: GitRepositoryProbeFailure) => void;
}

/** Probe details stay with the runtime observer; command output and paths never enter diagnostics. */
export async function hasGitRepository(path: string, options: GitRepositoryProbeOptions = {}): Promise<boolean> {
	const fail = (failure: GitRepositoryProbeFailure): false => {
		try {
			options.onFailure?.(failure);
		} catch {
			// Diagnostics must not change filesystem admission.
		}
		return false;
	};
	const result = await runGit(path, ["rev-parse", "--show-toplevel"], { timeoutClass: "sync" });
	if (!result.ok) {
		return fail({
			failureKind: result.failureKind ?? "command_failed",
			errorCode: result.errorCode ?? null,
			exitCode: result.exitCode,
		});
	}
	if (!result.stdout.trim()) return fail({ failureKind: "empty_root", errorCode: null, exitCode: 0 });
	try {
		const [projectPath, gitRoot] = await Promise.all([realpath(path), realpath(result.stdout.trim())]);
		return (
			areFileSystemPathsEqual(projectPath, gitRoot) ||
			fail({ failureKind: "root_mismatch", errorCode: null, exitCode: 0 })
		);
	} catch {
		return fail({ failureKind: "root_unreadable", errorCode: null, exitCode: 0 });
	}
}
