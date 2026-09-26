import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

import { createGitProcessEnv } from "../core/git-process-env";
import { terminateProcessTree } from "../core/process-termination";
import { resolveWindowsPowerShellPath } from "../core/windows-system-paths";
import { lockedFileSystem } from "../fs/locked-file-system";
import { isNodeError } from "../fs/node-error";
import { getGitStdout } from "./git-utils";
import { assertTaskWorktreeRegistration } from "./task-worktree-identity";
import { withTaskWorktreeOperationLock, withTaskWorktreeSetupLock } from "./task-worktree-setup-lock";
import {
	cleanupLegacyDependencySymlinks,
	copyIncludedIgnoredPathsIntoWorktree,
	initializeSubmodulesIfNeeded,
} from "./task-worktree-symlinks";

const setupStateSchema = z.object({
	version: z.literal(1),
	status: z.enum(["pending", "running", "succeeded", "failed"]),
});
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_LOG_BYTES = 64 * 1024;
export type WorktreeSetupProgress = (phase: "running" | "succeeded" | "failed") => Promise<void>;

async function setupDirectory(worktreePath: string): Promise<string> {
	await assertTaskWorktreeRegistration(worktreePath);
	return resolve(worktreePath, await getGitStdout(["rev-parse", "--git-dir"], worktreePath));
}

async function writeState(directory: string, status: z.infer<typeof setupStateSchema>["status"]): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(join(directory, "quarterdeck-setup.json"), { version: 1, status });
}

/** Called under the repository creation lock, before a new worktree is made available. */
export async function initializeTaskWorktreeSetup(worktreePath: string): Promise<void> {
	await writeState(await setupDirectory(worktreePath), "pending");
}

export function worktreeSetupCommand(
	script: string,
	platform: NodeJS.Platform = process.platform,
): {
	binary: string;
	args: string[];
} {
	if (platform === "win32") {
		const source = `$ErrorActionPreference = 'Stop'\n${script}\nif ($LASTEXITCODE) { exit $LASTEXITCODE }`;
		return {
			binary: resolveWindowsPowerShellPath(),
			args: [
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-EncodedCommand",
				Buffer.from(source, "utf16le").toString("base64"),
			],
		};
	}
	return { binary: "/bin/sh", args: ["-e", "-c", script] };
}

/** Output remains in a bounded, private worktree-admin log, never in runtime diagnostics. */
export async function runWorktreeSetupScript(options: {
	worktreePath: string;
	script: string;
	logPath: string;
	timeoutMs?: number;
}): Promise<void> {
	const command = worktreeSetupCommand(options.script);
	let output = Buffer.alloc(0);
	let failure: Error | null = null;
	await new Promise<void>((done) => {
		const child = spawn(command.binary, command.args, {
			cwd: options.worktreePath,
			env: createGitProcessEnv(),
			detached: process.platform !== "win32",
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const terminate = () => {
			if (child.pid) terminateProcessTree(child.pid, "SIGKILL");
		};
		process.once("exit", terminate);
		const timeout = setTimeout(() => {
			failure = new Error("Worktree setup timed out.");
			terminate();
		}, options.timeoutMs ?? SETUP_TIMEOUT_MS);
		const collect = (chunk: Buffer) => {
			output = Buffer.concat([output, chunk]).subarray(-MAX_LOG_BYTES);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.on("error", () => {
			failure = new Error("Worktree setup could not start its shell.");
		});
		child.once("exit", terminate);
		child.once("close", (code, signal) => {
			clearTimeout(timeout);
			process.removeListener("exit", terminate);
			if (!failure && code !== 0)
				failure = new Error(`Worktree setup failed (${signal ? `signal ${signal}` : `exit ${code}`}).`);
			done();
		});
	});
	await lockedFileSystem.writeTextFileAtomic(options.logPath, output.toString("utf8"), { mode: 0o600 });
	if (failure) throw failure;
}

/** Existing legacy worktrees have no marker and never acquire a new creation-time script. */
export async function finishTaskWorktreeSetup(options: {
	repoPath: string;
	worktreePath: string;
	script: string;
	newWorktree?: boolean;
	retrySetup?: boolean;
	onSetupProgress?: WorktreeSetupProgress;
}): Promise<void> {
	await withTaskWorktreeOperationLock(options.repoPath, options.worktreePath, async () => {
		// Recheck registration after acquiring ownership: removal may have won the lock.
		const directory = await setupDirectory(options.worktreePath);
		await cleanupLegacyDependencySymlinks(options.worktreePath);
		let state: z.infer<typeof setupStateSchema>;
		try {
			state = setupStateSchema.parse(JSON.parse(await readFile(join(directory, "quarterdeck-setup.json"), "utf8")));
		} catch (error) {
			if (isNodeError(error, "ENOENT")) return;
			throw new Error(
				"Worktree setup state is unreadable. Task files were preserved; repair the setup state before retrying.",
			);
		}
		if (state.status === "succeeded") return;
		if (!options.retrySetup && !(options.newWorktree && state.status === "pending")) {
			throw new Error(
				"Worktree setup did not complete. Start or restart the task explicitly to retry setup. Task files were preserved.",
			);
		}
		await writeState(directory, "running");
		try {
			await withTaskWorktreeSetupLock(options.repoPath, () => initializeSubmodulesIfNeeded(options.worktreePath));
			await copyIncludedIgnoredPathsIntoWorktree(options.repoPath, options.worktreePath);
			if (options.script.trim()) {
				await options.onSetupProgress?.("running");
				await runWorktreeSetupScript({
					worktreePath: options.worktreePath,
					script: options.script,
					logPath: join(directory, "quarterdeck-setup.log"),
				});
			}
			await writeState(directory, "succeeded");
		} catch (error) {
			await writeState(directory, "failed");
			await options.onSetupProgress?.("failed");
			const message = error instanceof Error ? error.message : "Worktree setup failed.";
			throw new Error(
				`${message} Start or restart the task to retry. Task files were preserved. Script output: ${join(directory, "quarterdeck-setup.log")}`,
			);
		}
		await options.onSetupProgress?.("succeeded");
	});
}
