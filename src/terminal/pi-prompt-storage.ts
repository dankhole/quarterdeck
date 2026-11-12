import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDirectory } from "../core/private-directory.js";
import { getRuntimeHomePath } from "../core/runtime-state-home.js";
import {
	assertRuntimeWriteAdmission,
	RuntimeWriteAdmissionError,
	withRuntimeWriteOperation,
} from "../state/runtime-write-admission.js";

/** Creates an empty, owner-only launch directory before any prompt content is written. */
export async function createPiPromptDirectory(): Promise<string> {
	try {
		const stateHome = getRuntimeHomePath();
		return await withRuntimeWriteOperation([stateHome], async () => {
			assertRuntimeWriteAdmission(stateHome);
			await mkdir(stateHome, { recursive: true, mode: 0o700 });
			const root = join(await realpath(stateHome), "pi-prompts");
			return await withRuntimeWriteOperation([root], async () => {
				assertRuntimeWriteAdmission(root);
				try {
					await mkdir(root, { mode: 0o700 });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				}
				// The shared privacy helper follows existing links. Reject one before
				// invoking it so protected storage cannot escape this state home.
				const entry = await lstat(root);
				if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Invalid Pi prompt storage root.");
				assertRuntimeWriteAdmission(root);
				await ensurePrivateDirectory(root);
				assertRuntimeWriteAdmission(root);
				const directory = await mkdtemp(join(root, "launch-"));
				try {
					assertRuntimeWriteAdmission(directory);
					await ensurePrivateDirectory(directory);
					assertRuntimeWriteAdmission(directory);
					return directory;
				} catch (error) {
					// Compensate inside this admitted operation, even after lease loss:
					// this exact empty child has never been handed to a prompt writer.
					await rm(directory, { recursive: true, force: true }).catch(() => undefined);
					throw error;
				}
			});
		});
	} catch (error) {
		if (error instanceof RuntimeWriteAdmissionError) throw error;
		throw new Error(
			"Could not prepare private Pi prompt storage. Check access to the Quarterdeck state home and retry.",
		);
	}
}

/**
 * Only the exclusively admitted runtime may call this, after recovery admission
 * has proved prior processes are gone and before new task launches can start.
 */
export async function cleanupAbandonedPiPromptFiles(stateHome = getRuntimeHomePath()): Promise<void> {
	try {
		const root = join(await realpath(stateHome), "pi-prompts");
		await withRuntimeWriteOperation([root], async () => {
			assertRuntimeWriteAdmission(root);
			// rm unlinks a root/descendant symlink instead of following its target.
			await rm(root, { recursive: true, force: true });
		});
	} catch (error) {
		if (error instanceof RuntimeWriteAdmissionError) throw error;
		// Do not attach filesystem errors: they can contain private prompt paths.
		throw new Error(
			"Could not remove abandoned private Pi prompt files. Check access to pi-prompts in the Quarterdeck state home, then restart Quarterdeck.",
		);
	}
}
