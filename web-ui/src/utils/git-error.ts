/**
 * Parse verbose git error messages for user-facing display.
 *
 * The `runGit` helper (git-utils.ts) wraps failures in a verbose format:
 *
 *   Failed to run Git Command:
 *    Command:
 *    git switch my-branch failed
 *    error: Your local changes to the following files would be overwritten...
 *
 * {@link parseGitErrorForDisplay} strips that boilerplate so only the actual
 * git stderr reaches the user.
 *
 * This is called automatically by `showAppToast` / `notifyError` in
 * app-toaster.ts — you should NOT need to call it manually. If you're adding
 * a new git operation, route errors through showAppToast({ intent: "danger" })
 * and the parsing happens for free.
 */
const RUN_GIT_PREFIX_RE = /^Failed to run Git Command:\s*\n\s*Command:\s*\n\s*git .+ failed\s*\n\s*/;

export function parseGitErrorForDisplay(error: string): string {
	const stripped = error.replace(RUN_GIT_PREFIX_RE, "").trim();
	return stripped || error;
}
