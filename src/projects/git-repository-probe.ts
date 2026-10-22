import { realpath } from "node:fs/promises";

import { areFileSystemPathsEqual } from "../core/path-comparison";
import {
	type GitCommandErrorCode,
	type GitCommandFailureKind,
	isIndeterminateGitCommandFailure,
	runGit,
} from "../workdir/git-utils";

/** Beyond a failed git command itself, the probe's own root check can report these definitive "no" outcomes. */
type GitRepositoryProbeOwnFailureKind = "empty_root" | "root_mismatch" | "root_unreadable";

export interface GitRepositoryProbeFailure {
	failureKind: GitCommandFailureKind | GitRepositoryProbeOwnFailureKind;
	errorCode: GitCommandErrorCode | null;
	exitCode: number | null;
	terminatedBySignal: boolean;
}

export interface GitRepositoryProbeOptions {
	onFailure?: (failure: GitRepositoryProbeFailure) => void;
}

/** `indeterminate` means the probe never produced Git's own answer and proves nothing about the repository. */
export type GitRepositoryProbeResult = "repository" | "not_repository" | "indeterminate";

/** Probe details stay with the runtime observer; command output and paths never enter diagnostics. */
export async function probeGitRepository(
	path: string,
	options: GitRepositoryProbeOptions = {},
): Promise<GitRepositoryProbeResult> {
	const fail = (failure: GitRepositoryProbeFailure): GitRepositoryProbeResult => {
		try {
			options.onFailure?.(failure);
		} catch {
			// Diagnostics must not change filesystem admission.
		}
		// The probe's own root-check outcomes never ran a git command and are always
		// a definitive "no"; only a failure shaped like a `runGit` failure goes to
		// the shared command classifier.
		if (
			failure.failureKind === "empty_root" ||
			failure.failureKind === "root_mismatch" ||
			failure.failureKind === "root_unreadable"
		) {
			return "not_repository";
		}
		return isIndeterminateGitCommandFailure({
			failureKind: failure.failureKind,
			errorCode: failure.errorCode,
			terminatedBySignal: failure.terminatedBySignal,
		})
			? "indeterminate"
			: "not_repository";
	};
	const result = await runGit(path, ["rev-parse", "--show-toplevel"], { timeoutClass: "sync" });
	if (!result.ok) {
		return fail({
			failureKind: result.failureKind ?? "command_failed",
			errorCode: result.errorCode ?? null,
			exitCode: result.exitCode,
			terminatedBySignal: result.terminatedBySignal === true,
		});
	}
	if (!result.stdout.trim())
		return fail({ failureKind: "empty_root", errorCode: null, exitCode: 0, terminatedBySignal: false });
	try {
		const [projectPath, gitRoot] = await Promise.all([realpath(path), realpath(result.stdout.trim())]);
		return areFileSystemPathsEqual(projectPath, gitRoot)
			? "repository"
			: fail({ failureKind: "root_mismatch", errorCode: null, exitCode: 0, terminatedBySignal: false });
	} catch {
		return fail({ failureKind: "root_unreadable", errorCode: null, exitCode: 0, terminatedBySignal: false });
	}
}

/** Boolean wrapper for callers that only admit on a confirmed repository; indeterminate is conservatively false. */
export async function hasGitRepository(path: string, options: GitRepositoryProbeOptions = {}): Promise<boolean> {
	return (await probeGitRepository(path, options)) === "repository";
}
