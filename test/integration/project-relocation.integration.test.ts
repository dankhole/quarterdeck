import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { RuntimeBoardData } from "../../src/core";
import * as gitUtils from "../../src/workdir/git-utils";
import {
	applyProjectRelocation,
	beginProjectRelocation,
	finalizeProjectRelocation,
	prepareProjectRelocation,
	readProjectDirectoryIdentity,
	readProjectRelocationJournal,
	recoverProjectRelocation,
} from "../../src/workdir/project-relocation";
import { resolveRenamedProjectPath } from "../../src/workdir/project-relocation-paths";
import { assertTaskWorktreeRegistration } from "../../src/workdir/task-worktree-identity";
import {
	archiveTaskWorktreeForTrash,
	getTaskWorktreePath,
	purgeTaskWorkspaceForDelete,
} from "../../src/workdir/task-worktree-lifecycle";
import { findTaskPatch } from "../../src/workdir/task-worktree-patch";
import { commitAll, initGitRepository, runGit } from "../utilities/git-env";
import { createTempDir, withTemporaryHome } from "../utilities/temp-dir";

function boardWithTask(path?: string): RuntimeBoardData {
	return {
		columns: [
			{
				id: "review",
				title: "Review",
				cards: [
					{
						id: "task-relocation",
						title: "Retained task",
						prompt: "Synthetic relocation",
						baseRef: "HEAD",
						createdAt: 1,
						updatedAt: 1,
						useWorktree: true,
						...(path ? { workingDirectory: path } : {}),
					},
				],
			},
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "trash", title: "Trash", cards: [] },
		],
	};
}

async function withFixture(run: (root: string, repoPath: string) => Promise<void>): Promise<void> {
	await withTemporaryHome(async () => {
		const { path, cleanup } = createTempDir("quarterdeck-project-relocation-");
		const root = realpathSync.native(path);
		try {
			const repoPath = join(root, "repository");
			mkdirSync(repoPath);
			initGitRepository(repoPath);
			writeFileSync(join(repoPath, "tracked.txt"), "original\n");
			commitAll(repoPath, "initial");
			await run(root, repoPath);
		} finally {
			cleanup();
		}
	});
}

function createWorktree(repoPath: string): string {
	const worktreePath = getTaskWorktreePath(repoPath, "task-relocation");
	mkdirSync(worktreePath, { recursive: true });
	runGit(repoPath, ["worktree", "add", "--detach", worktreePath]);
	writeFileSync(join(worktreePath, "tracked.txt"), "task progress\n");
	writeFileSync(join(worktreePath, "untracked.txt"), "untracked progress\n");
	return realpathSync.native(worktreePath);
}

describe("project folder relocation", { concurrent: false }, () => {
	it("renames the root, repairs exact worktrees, and archives the original physical checkout", async () => {
		await withFixture(async (_root, repoPath) => {
			const worktreePath = createWorktree(repoPath);
			const plan = await prepareProjectRelocation({
				projectId: "retained-id",
				oldPath: repoPath,
				destination: { kind: "rename", folderName: "renamed" },
				projects: [],
				board: boardWithTask(),
			});
			expect(plan.taskWorkingDirectories["task-relocation"]).toBe(worktreePath);
			await applyProjectRelocation(plan);
			expect(existsSync(repoPath)).toBe(false);
			await assertTaskWorktreeRegistration(worktreePath);
			expect(readFileSync(join(worktreePath, "tracked.txt"), "utf8")).toBe("task progress\n");
			expect(readFileSync(join(worktreePath, "untracked.txt"), "utf8")).toBe("untracked progress\n");
			expect(await readProjectRelocationJournal(plan.projectId)).toMatchObject({
				phase: "filesystem_applied",
				newPath: plan.newPath,
			});
			const archived = await archiveTaskWorktreeForTrash({
				repoPath: plan.newPath,
				taskId: "task-relocation",
				existingPath: worktreePath,
			});
			expect(archived).toEqual({ ok: true, removed: true });
			expect(await findTaskPatch("task-relocation")).not.toBeNull();
			await finalizeProjectRelocation(plan);
			expect(await readProjectRelocationJournal(plan.projectId)).toBeNull();
		});
	});

	it("locates an externally renamed parent with inode identity and preserved dirty worktrees", async () => {
		await withFixture(async (root, repoPath) => {
			const worktreePath = createWorktree(repoPath);
			const identity = await readProjectDirectoryIdentity(repoPath);
			const newParent = join(root, "moved-parent");
			mkdirSync(newParent);
			const newPath = join(newParent, "repository");
			renameSync(repoPath, newPath);
			const plan = await prepareProjectRelocation({
				projectId: "retained-id",
				oldPath: repoPath,
				directoryIdentity: identity,
				destination: { kind: "locate", path: newPath },
				projects: [],
				board: boardWithTask(worktreePath),
			});
			await applyProjectRelocation(plan);
			await assertTaskWorktreeRegistration(worktreePath);
			expect(plan.taskWorkingDirectories["task-relocation"]).toBe(worktreePath);
			expect(runGit(worktreePath, ["status", "--porcelain"])).toContain("untracked.txt");
			// Legacy cleanup callers must find the old label even without a supplied persisted path.
			expect(await purgeTaskWorkspaceForDelete({ repoPath: newPath, taskId: "task-relocation" })).toEqual({
				ok: true,
				removed: true,
			});
		});
	});

	it.each([false, true])("explicitly locates a folder after directory identity changes (moved: %s)", async (moved) => {
		await withFixture(async (root, repoPath) => {
			const worktreePath = createWorktree(repoPath);
			const board = boardWithTask(worktreePath);
			const retainedBoard = structuredClone(board);
			const newPath = moved ? join(root, "moved-repository") : repoPath;
			if (moved) renameSync(repoPath, newPath);
			const currentIdentity = await readProjectDirectoryIdentity(newPath);
			const previousIdentity = {
				device: (BigInt(currentIdentity.device) + 1n).toString(),
				inode: (BigInt(currentIdentity.inode) + 1n).toString(),
			};
			const plan = await prepareProjectRelocation({
				projectId: "retained-id",
				oldPath: repoPath,
				directoryIdentity: previousIdentity,
				destination: { kind: "locate", path: newPath },
				projects: [],
				board,
			});
			expect(plan.projectId).toBe("retained-id");
			expect(plan.directoryIdentity).toEqual(currentIdentity);
			expect(plan.taskWorkingDirectories["task-relocation"]).toBe(worktreePath);
			await applyProjectRelocation(plan);
			await assertTaskWorktreeRegistration(worktreePath);
			expect(board).toEqual(retainedBoard);
			expect(readFileSync(join(worktreePath, "tracked.txt"), "utf8")).toBe("task progress\n");
			expect(readFileSync(join(worktreePath, "untracked.txt"), "utf8")).toBe("untracked progress\n");
			expect(await readProjectRelocationJournal(plan.projectId)).toMatchObject({
				directoryIdentity: currentIdentity,
			});
		});
	});

	it("recovers a crash after disk rename but before the filesystem checkpoint", async () => {
		await withFixture(async (_root, repoPath) => {
			const worktreePath = createWorktree(repoPath);
			const plan = await prepareProjectRelocation({
				projectId: "retained-id",
				oldPath: repoPath,
				destination: { kind: "rename", folderName: "renamed" },
				projects: [],
				board: boardWithTask(worktreePath),
			});
			await beginProjectRelocation(plan);
			renameSync(repoPath, plan.newPath);
			const journal = await readProjectRelocationJournal(plan.projectId);
			if (!journal) throw new Error("Missing recovery record");
			expect(journal.phase).toBe("prepared");
			await recoverProjectRelocation(journal);
			await recoverProjectRelocation(journal);
			await assertTaskWorktreeRegistration(worktreePath);
			expect(readFileSync(join(worktreePath, "untracked.txt"), "utf8")).toBe("untracked progress\n");
		});
	});

	it.each([false, true])(
		"rejects an unrelated Git root when its task worktree belongs to the original repository (saved identity: %s)",
		async (savedIdentity) => {
			await withFixture(async (root, repoPath) => {
				const worktreePath = createWorktree(repoPath);
				const directoryIdentity = savedIdentity ? await readProjectDirectoryIdentity(repoPath) : undefined;
				const candidate = join(root, "unrelated");
				mkdirSync(candidate);
				initGitRepository(candidate);
				writeFileSync(join(candidate, "tracked.txt"), "original\n");
				commitAll(candidate, "initial");
				renameSync(repoPath, join(root, "actual-moved-repository"));
				await expect(
					prepareProjectRelocation({
						projectId: "retained-id",
						oldPath: repoPath,
						directoryIdentity,
						destination: { kind: "locate", path: candidate },
						projects: [],
						board: boardWithTask(worktreePath),
					}),
				).rejects.toThrow("registration cannot be verified");
				expect(readFileSync(join(worktreePath, "untracked.txt"), "utf8")).toBe("untracked progress\n");
			});
		},
	);

	it("rejects known identity mismatches and existing or registered destinations before journaling", async () => {
		await withFixture(async (root, repoPath) => {
			const candidate = join(root, "other");
			mkdirSync(candidate);
			const otherIdentity = await readProjectDirectoryIdentity(candidate);
			const base = {
				projectId: "retained-id",
				oldPath: repoPath,
				projects: [],
				board: boardWithTask(),
				folderOnly: true,
			};
			await expect(
				prepareProjectRelocation({ ...base, destination: { kind: "rename", folderName: "other" } }),
			).rejects.toThrow("already exists");
			await expect(
				prepareProjectRelocation({
					...base,
					directoryIdentity: otherIdentity,
					destination: { kind: "rename", folderName: "renamed" },
				}),
			).rejects.toThrow("directory identity");
			await expect(
				prepareProjectRelocation({
					...base,
					destination: { kind: "rename", folderName: "renamed" },
					projects: [{ projectId: "other-id", repoPath: join(repoPath, "nested") }],
				}),
			).rejects.toThrow("contains another registered project");
			renameSync(repoPath, join(root, "original-moved"));
			await expect(
				prepareProjectRelocation({
					...base,
					destination: { kind: "locate", path: candidate },
					projects: [{ projectId: "other-id", repoPath: candidate }],
				}),
			).rejects.toThrow("already registered");
			expect(await readProjectRelocationJournal(base.projectId)).toBeNull();
		});
	});

	it("actually renames the directory entry for a case-only change", async () => {
		await withFixture(async (root, repoPath) => {
			const plan = await prepareProjectRelocation({
				projectId: "retained-id",
				oldPath: repoPath,
				destination: { kind: "rename", folderName: "Repository" },
				projects: [],
				board: boardWithTask(),
				folderOnly: true,
			});
			await applyProjectRelocation(plan);
			expect(realpathSync.native(plan.newPath)).toBe(join(realpathSync.native(root), "Repository"));
			await recoverProjectRelocation(plan);
		});
	});

	it("retains a recovery journal and all files when Git repair fails after disk rename", async () => {
		await withFixture(async (_root, repoPath) => {
			const worktreePath = createWorktree(repoPath);
			const plan = await prepareProjectRelocation({
				projectId: "retained-id",
				oldPath: repoPath,
				destination: { kind: "rename", folderName: "renamed" },
				projects: [],
				board: boardWithTask(worktreePath),
			});
			const actualRunGit = gitUtils.runGit;
			const failure = vi.spyOn(gitUtils, "runGit").mockImplementation(async (cwd, args, options) =>
				args[0] === "worktree" && args[1] === "repair"
					? {
							ok: false,
							stdout: "",
							stderr: "synthetic repair failure",
							output: "",
							error: "synthetic repair failure",
							exitCode: 1,
							timedOut: false,
						}
					: await actualRunGit(cwd, args, options),
			);
			try {
				await expect(applyProjectRelocation(plan)).rejects.toThrow("could not repair");
			} finally {
				failure.mockRestore();
			}
			expect(existsSync(plan.newPath)).toBe(true);
			expect(existsSync(plan.oldPath)).toBe(false);
			expect(await readProjectRelocationJournal(plan.projectId)).toMatchObject({ phase: "prepared" });
			expect(readFileSync(join(worktreePath, "untracked.txt"), "utf8")).toBe("untracked progress\n");
			await recoverProjectRelocation(plan);
			await assertTaskWorktreeRegistration(worktreePath);
		});
	});

	it("rejects a changed worktree backlink without modifying its dirty files", async () => {
		await withFixture(async (root, repoPath) => {
			const worktreePath = createWorktree(repoPath);
			const gitDirectory = readFileSync(join(worktreePath, ".git"), "utf8").trim().slice("gitdir: ".length);
			writeFileSync(join(gitDirectory, "gitdir"), join(root, "another-checkout", ".git"));
			await expect(
				prepareProjectRelocation({
					projectId: "retained-id",
					oldPath: repoPath,
					destination: { kind: "rename", folderName: "renamed" },
					projects: [],
					board: boardWithTask(worktreePath),
				}),
			).rejects.toThrow("registration cannot be verified");
			expect(existsSync(repoPath)).toBe(true);
			expect(readFileSync(join(worktreePath, "untracked.txt"), "utf8")).toBe("untracked progress\n");
		});
	});

	it("preserves a destination created after validation", async () => {
		await withFixture(async (_root, repoPath) => {
			const plan = await prepareProjectRelocation({
				projectId: "retained-id",
				oldPath: repoPath,
				destination: { kind: "rename", folderName: "renamed" },
				projects: [],
				board: boardWithTask(),
			});
			mkdirSync(plan.newPath);
			writeFileSync(join(plan.newPath, "other-work.txt"), "preserve\n");
			await expect(applyProjectRelocation(plan)).rejects.toThrow("destination changed");
			expect(existsSync(repoPath)).toBe(true);
			expect(readFileSync(join(plan.newPath, "other-work.txt"), "utf8")).toBe("preserve\n");
		});
	});

	it("rebases shared folder tasks at directory boundaries without requiring Git", async () => {
		await withFixture(async (root, _repoPath) => {
			const oldPath = join(root, "folder");
			mkdirSync(oldPath);
			const board = boardWithTask(oldPath);
			const card = board.columns[0]?.cards[0];
			if (!card) throw new Error("Missing test card");
			card.useWorktree = false;
			board.columns[0]?.cards.push({ ...card, id: "sibling", workingDirectory: `${oldPath}-sibling` });
			const plan = await prepareProjectRelocation({
				projectId: "retained-id",
				oldPath,
				folderOnly: true,
				destination: { kind: "rename", folderName: "renamed" },
				projects: [],
				board,
			});
			expect(plan.taskWorkingDirectories).toEqual({
				"task-relocation": join(root, "renamed"),
				sibling: `${oldPath}-sibling`,
			});
			await applyProjectRelocation(plan);
			expect(existsSync(plan.newPath)).toBe(true);
		});
	});

	it.each(["..", "parent/child", "parent\\child", " name", "NUL", "name."])(
		"rejects unsafe Windows folder name %s",
		(folderName) => {
			expect(() => resolveRenamedProjectPath("C:\\projects\\repo", folderName, "win32")).toThrow(
				"valid folder name",
			);
		},
	);
});
