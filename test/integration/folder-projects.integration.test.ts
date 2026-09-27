import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
	RuntimeProjectAddResponse,
	RuntimeProjectStateResponse,
	RuntimeProjectsResponse,
	RuntimeTaskRepositoryInfoResponse,
	RuntimeWorkdirTextSearchResponse,
} from "../../src/core";
import { initGitRepository, runGit } from "../utilities/git-env";
import { getAvailablePort, startQuarterdeckServer } from "../utilities/integration-server";
import { createTempDir } from "../utilities/temp-dir";
import { requestJson } from "../utilities/trpc-request";

describe("folder projects", { concurrent: false }, () => {
	it("keeps a parent board without Git and creates independent child repositories", async () => {
		const home = createTempDir("quarterdeck-folder-home-");
		const root = createTempDir("quarterdeck-folder-project-");
		initGitRepository(root.path);
		runGit(root.path, ["commit", "--allow-empty", "-m", "fixture"]);
		const parentHead = runGit(root.path, ["rev-parse", "HEAD"]);
		const child = join(root.path, "child");
		const plain = join(root.path, "plain");
		mkdirSync(child);
		mkdirSync(plain);
		writeFileSync(join(plain, "notes.txt"), "folder search needle\n");
		const port = await getAvailablePort();
		const server = await startQuarterdeckServer({ cwd: root.path, homeDir: home.path, port });
		const baseUrl = `http://127.0.0.1:${port}`;
		const parentId = decodeURIComponent(new URL(server.runtimeUrl).pathname.slice(1));
		const add = async (path: string, folderOnly?: boolean, initializeGit?: boolean) =>
			(
				await requestJson<RuntimeProjectAddResponse>({
					baseUrl,
					projectId: parentId,
					procedure: "projects.add",
					type: "mutation",
					payload: { path, folderOnly, initializeGit },
				})
			).payload;
		try {
			// An ancestor repository never silently substitutes its project for the selected child.
			expect(await add(child)).toMatchObject({ ok: false, requiresGitInitialization: true });
			expect(existsSync(join(child, ".git"))).toBe(false);
			const converted = await add(root.path, true);
			expect(converted).toMatchObject({ ok: true, project: { id: parentId, folderOnly: true } });
			expect(runGit(root.path, ["rev-parse", "HEAD"])).toBe(parentHead);
			const independent = await add(child, false, true);
			expect(independent.ok).toBe(true);
			expect(independent.project?.id).not.toBe(parentId);
			expect(runGit(child, ["rev-parse", "--show-toplevel"]).trim()).toBe(await realpath(child));
			const folder = await add(plain, true);
			expect(folder.ok).toBe(true);
			expect(existsSync(join(plain, ".git"))).toBe(false);
			if (!folder.project) throw new Error("Expected folder project");
			const folderId = folder.project.id;
			const state = await requestJson<RuntimeProjectStateResponse>({
				baseUrl,
				projectId: folderId,
				procedure: "project.getState",
				type: "query",
			});
			expect(state.payload.git).toEqual({
				folderOnly: true,
				currentBranch: null,
				defaultBranch: null,
				branches: [],
			});
			const seeded = await requestJson({
				baseUrl,
				projectId: folderId,
				procedure: "project.applyBoardCommands",
				type: "mutation",
				payload: {
					commandId: "seed-folder-tasks",
					expectedRevision: state.payload.revision,
					commands: [
						{
							kind: "create_task",
							columnId: "review",
							taskId: "branchless",
							prompt: "Folder task",
							baseRef: "",
							useWorktree: false,
							createdAt: 1,
						},
						{
							kind: "create_task",
							columnId: "review",
							taskId: "preserved",
							prompt: "Existing ref",
							baseRef: "kept-ref",
							useWorktree: false,
							createdAt: 2,
						},
					],
				},
			});
			expect(seeded.status).toBe(200);
			const git = await requestJson({
				baseUrl,
				projectId: parentId,
				procedure: "project.getGitRefs",
				type: "query",
				payload: null,
			});
			expect(git.status).toBe(400);
			const text = await requestJson<RuntimeWorkdirTextSearchResponse>({
				baseUrl,
				projectId: folderId,
				procedure: "project.searchText",
				type: "query",
				payload: { query: "needle" },
			});
			expect(text.payload.files).toMatchObject([{ path: "notes.txt", matches: [{ line: 1 }] }]);
			const context = await requestJson<RuntimeTaskRepositoryInfoResponse>({
				baseUrl,
				projectId: folderId,
				procedure: "project.getTaskContext",
				type: "query",
				payload: { taskId: "folder-task", baseRef: "" },
			});
			expect(context.payload).toMatchObject({ path: await realpath(plain), exists: true, branch: null });
			const projects = await requestJson<RuntimeProjectsResponse>({
				baseUrl,
				procedure: "projects.list",
				type: "query",
			});
			expect(projects.payload.projects).toHaveLength(3);
			// Reopening the folder preserves its mode; switching back keeps its identity.
			expect(await add(plain)).toMatchObject({ ok: true, project: { id: folderId, folderOnly: true } });
			expect(await add(root.path, false)).toMatchObject({ ok: true, project: { id: parentId } });
			expect(await add(plain, false, true)).toMatchObject({ ok: true, project: { id: folderId } });
			const enabled = await requestJson<RuntimeProjectStateResponse>({
				baseUrl,
				projectId: folderId,
				procedure: "project.getState",
				type: "query",
			});
			const cards = enabled.payload.board.columns.flatMap((column) => column.cards);
			const branchless = cards.find((card) => card.id === "branchless");
			expect(branchless).toMatchObject({
				baseRef: enabled.payload.git.currentBranch,
				useWorktree: false,
				prompt: "Folder task",
			});
			expect(cards.find((card) => card.id === "preserved")?.baseRef).toBe("kept-ref");
			expect(enabled.payload.revision).toBeGreaterThan(state.payload.revision);
			for (const procedure of ["project.getTaskContext", "project.getChanges"]) {
				const response = await requestJson({
					baseUrl,
					projectId: folderId,
					procedure,
					type: "query",
					payload: { taskId: "branchless", baseRef: branchless?.baseRef },
				});
				expect(response.status).toBe(200);
			}
			expect(readFileSync(join(plain, "notes.txt"), "utf8")).toContain("needle");
			expect(runGit(root.path, ["rev-parse", "HEAD"])).toBe(parentHead);
		} finally {
			await server.stop();
			root.cleanup();
			home.cleanup();
		}
	}, 45_000);
});
