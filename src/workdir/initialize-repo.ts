import { runGit } from "./git-utils";

const USER_GIT_ACTION_OPTIONS = { timeoutClass: "userAction" } as const;

interface InitializeRepoResult {
	ok: boolean;
	error: string | null;
}

export async function initializeGitRepository(projectPath: string): Promise<InitializeRepoResult> {
	const result = await runGit(projectPath, ["init"], USER_GIT_ACTION_OPTIONS);
	if (!result.ok) {
		return {
			ok: false,
			error: result.error ?? "Failed to initialize git repository.",
		};
	}

	return ensureInitialCommit(projectPath);
}

export async function ensureInitialCommit(projectPath: string): Promise<InitializeRepoResult> {
	const headCheck = await runGit(projectPath, ["rev-parse", "--verify", "HEAD"], USER_GIT_ACTION_OPTIONS);
	if (headCheck.ok) {
		return { ok: true, error: null };
	}

	const addResult = await runGit(projectPath, ["add", "-A"], USER_GIT_ACTION_OPTIONS);
	if (!addResult.ok) {
		return {
			ok: false,
			error: addResult.error ?? "Failed to stage files for initial commit.",
		};
	}

	const commitResult = await runGit(
		projectPath,
		["commit", "--allow-empty", "-m", "Initial commit through Quarterdeck"],
		USER_GIT_ACTION_OPTIONS,
	);

	if (!commitResult.ok) {
		return {
			ok: false,
			error: commitResult.error ?? "Failed to create initial commit.",
		};
	}

	return { ok: true, error: null };
}
