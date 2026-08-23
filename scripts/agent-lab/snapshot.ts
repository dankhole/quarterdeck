import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { promisify } from "node:util";

import type { AgentLabManifest, AgentLabSnapshotResult } from "./types";

const execFileAsync = promisify(execFile);
const MAX_STATE_FILE_BYTES = 2 * 1024 * 1024;

function sanitizeLabel(label: string): string {
	const sanitized = label
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 50);
	return sanitized || "snapshot";
}

async function copyJsonState(sourceRoot: string, destinationRoot: string, currentPath = sourceRoot): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await readdir(currentPath, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const sourcePath = join(currentPath, entry.name);
		if (entry.isDirectory()) {
			await copyJsonState(sourceRoot, destinationRoot, sourcePath);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".json")) {
			continue;
		}
		const fileStats = await stat(sourcePath);
		if (fileStats.size > MAX_STATE_FILE_BYTES) {
			continue;
		}
		const destinationPath = join(destinationRoot, relative(sourceRoot, sourcePath));
		await mkdir(dirname(destinationPath), { recursive: true });
		await writeFile(destinationPath, await readFile(sourcePath));
	}
}

async function captureGitCommand(projectPath: string, destinationPath: string, args: string[]): Promise<void> {
	try {
		const result = await execFileAsync("git", args, {
			cwd: projectPath,
			encoding: "utf8",
			env: {
				PATH: process.env.PATH,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_TERMINAL_PROMPT: "0",
			},
			maxBuffer: 5 * 1024 * 1024,
		});
		await writeFile(destinationPath, `${result.stdout}${result.stderr}`, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await writeFile(destinationPath, `[agent-lab snapshot failed]\n${message}\n`, "utf8");
	}
}

async function captureTaskWorktreeGitState(manifest: AgentLabManifest, snapshotPath: string): Promise<void> {
	const worktreesRoot = join(manifest.statePath, "worktrees");
	let entries: Dirent[];
	try {
		entries = await readdir(worktreesRoot, { withFileTypes: true });
	} catch {
		return;
	}

	await Promise.all(
		entries
			.filter((entry) => entry.isDirectory())
			.map(async (entry) => {
				const projectPath = join(worktreesRoot, entry.name, "project");
				const destinationPath = join(snapshotPath, "task-worktrees", entry.name);
				await mkdir(destinationPath, { recursive: true });
				await Promise.all([
					captureGitCommand(projectPath, join(destinationPath, "git-status.txt"), [
						"status",
						"--short",
						"--branch",
					]),
					captureGitCommand(projectPath, join(destinationPath, "git-diff.patch"), ["diff", "--no-ext-diff"]),
					captureGitCommand(projectPath, join(destinationPath, "git-diff-cached.patch"), [
						"diff",
						"--cached",
						"--no-ext-diff",
					]),
				]);
			}),
	);
}

export async function captureAgentLabSnapshot(
	manifest: AgentLabManifest,
	requestedLabel: string,
): Promise<AgentLabSnapshotResult> {
	const createdAt = new Date().toISOString();
	const timestamp = createdAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
	const label = sanitizeLabel(requestedLabel);
	const snapshotPath = join(manifest.artifactDir, "snapshots", `${timestamp}-${label}`);
	const stateDestination = join(snapshotPath, "state");
	await mkdir(snapshotPath, { recursive: true });
	await copyJsonState(manifest.statePath, stateDestination);
	await writeFile(join(snapshotPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	await Promise.all([
		captureGitCommand(manifest.projectPath, join(snapshotPath, "git-status.txt"), ["status", "--short", "--branch"]),
		captureGitCommand(manifest.projectPath, join(snapshotPath, "git-log.txt"), [
			"log",
			"-n",
			"10",
			"--oneline",
			"--decorate",
		]),
		captureGitCommand(manifest.projectPath, join(snapshotPath, "git-diff.patch"), ["diff", "--no-ext-diff"]),
		captureGitCommand(manifest.projectPath, join(snapshotPath, "git-diff-cached.patch"), [
			"diff",
			"--cached",
			"--no-ext-diff",
		]),
		captureTaskWorktreeGitState(manifest, snapshotPath),
	]);
	await writeFile(
		join(snapshotPath, "snapshot.json"),
		`${JSON.stringify({ label, createdAt, runId: manifest.runId, stateDirectory: basename(stateDestination) }, null, 2)}\n`,
		"utf8",
	);
	return { label, path: snapshotPath, createdAt };
}
