import { rm } from "node:fs/promises";

const RECURSIVE_REMOVE_MAX_RETRIES = 10;
const RECURSIVE_REMOVE_RETRY_DELAY_MS = 100;

/** Removes a directory tree while tolerating bounded transient Windows handle races. */
export async function removeDirectoryWithRetries(path: string, options: { force?: boolean } = {}): Promise<void> {
	await rm(path, {
		recursive: true,
		force: options.force ?? true,
		maxRetries: RECURSIVE_REMOVE_MAX_RETRIES,
		retryDelay: RECURSIVE_REMOVE_RETRY_DELAY_MS,
	});
}
