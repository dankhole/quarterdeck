import { mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createTempDir(prefix = "quarterdeck-test-"): {
	path: string;
	cleanup: () => void;
	cleanupAsync: () => Promise<void>;
} {
	const path = mkdtempSync(join(tmpdir(), prefix));
	return {
		path,
		cleanup: () =>
			rmSync(path, {
				recursive: true,
				force: true,
				maxRetries: 15,
				retryDelay: 300,
			}),
		// Process-backed fixtures must let pending native handle closes run on
		// Windows. Synchronous deletion retries block that event-loop progress.
		cleanupAsync: () => rm(path, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 }),
	};
}

export async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("quarterdeck-home-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const previousStateHome = process.env.QUARTERDECK_STATE_HOME;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	process.env.QUARTERDECK_STATE_HOME = join(tempHome, ".quarterdeck");
	try {
		return await run();
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		if (previousStateHome === undefined) {
			delete process.env.QUARTERDECK_STATE_HOME;
		} else {
			process.env.QUARTERDECK_STATE_HOME = previousStateHome;
		}
		cleanup();
	}
}
