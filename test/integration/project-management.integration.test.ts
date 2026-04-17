import { existsSync, mkdirSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type {
	RuntimeProjectAddResponse,
	RuntimeProjectRemoveResponse,
	RuntimeProjectsResponse,
	RuntimeStateStreamProjectsMessage,
	RuntimeStateStreamSnapshotMessage,
} from "../../src/core";
import { initGitRepository } from "../utilities/git-env";
import { getAvailablePort, startQuarterdeckServer } from "../utilities/integration-server";
import { connectRuntimeStream, type RuntimeStreamClient } from "../utilities/runtime-stream-client";
import { createTempDir } from "../utilities/temp-dir";
import { requestJson } from "../utilities/trpc-request";

describe.sequential("project management integration", () => {
	it("requires explicit confirmation before initializing git for a non-git added project", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-project-add-git-confirm-");
		const { path: tempRoot, cleanup: cleanupRoot } = createTempDir("quarterdeck-project-add-git-confirm-");

		const projectAPath = join(tempRoot, "project-a");
		const nonGitPath = join(tempRoot, "non-git-project");
		mkdirSync(projectAPath, { recursive: true });
		mkdirSync(nonGitPath, { recursive: true });
		initGitRepository(projectAPath);

		const port = await getAvailablePort();
		const server = await startQuarterdeckServer({
			cwd: projectAPath,
			homeDir: tempHome,
			port,
		});

		let projectAId: string | null = null;
		try {
			const runtimeUrl = new URL(server.runtimeUrl);
			projectAId = decodeURIComponent(runtimeUrl.pathname.slice(1));
			expect(projectAId).not.toBe("");

			const addWithoutInitResponse = await requestJson<RuntimeProjectAddResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.add",
				type: "mutation",
				projectId: projectAId,
				payload: {
					path: nonGitPath,
				},
			});
			expect(addWithoutInitResponse.status).toBe(200);
			expect(addWithoutInitResponse.payload.ok).toBe(false);
			expect(addWithoutInitResponse.payload.requiresGitInitialization).toBe(true);
			expect(existsSync(join(nonGitPath, ".git"))).toBe(false);

			const projectsAfterDeclinedInit = await requestJson<RuntimeProjectsResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.list",
				type: "query",
				projectId: projectAId,
			});
			expect(projectsAfterDeclinedInit.status).toBe(200);
			expect(projectsAfterDeclinedInit.payload.projects).toHaveLength(1);

			const addWithInitResponse = await requestJson<RuntimeProjectAddResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.add",
				type: "mutation",
				projectId: projectAId,
				payload: {
					path: nonGitPath,
					initializeGit: true,
				},
			});
			expect(addWithInitResponse.status).toBe(200);
			expect(addWithInitResponse.payload.ok).toBe(true);
			expect(addWithInitResponse.payload.project).not.toBeNull();
			expect(existsSync(join(nonGitPath, ".git"))).toBe(true);
		} finally {
			await server.stop();
			cleanupRoot();
			cleanupHome();
		}
	}, 45_000);

	it("falls back to remaining project when removing the active project", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-home-remove-");
		const { path: tempRoot, cleanup: cleanupRoot } = createTempDir("quarterdeck-projects-remove-");

		const projectAPath = join(tempRoot, "project-a");
		const projectBPath = join(tempRoot, "project-b");
		mkdirSync(projectAPath, { recursive: true });
		mkdirSync(projectBPath, { recursive: true });
		initGitRepository(projectAPath);
		initGitRepository(projectBPath);

		const port = await getAvailablePort();
		const server = await startQuarterdeckServer({
			cwd: projectAPath,
			homeDir: tempHome,
			port,
		});

		let streamA: RuntimeStreamClient | null = null;
		let streamB: RuntimeStreamClient | null = null;

		try {
			const runtimeUrl = new URL(server.runtimeUrl);
			const projectAId = decodeURIComponent(runtimeUrl.pathname.slice(1));
			expect(projectAId).not.toBe("");
			const expectedProjectBPath = await realpath(projectBPath).catch(() => resolve(projectBPath));

			const addProjectResponse = await requestJson<RuntimeProjectAddResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.add",
				type: "mutation",
				projectId: projectAId,
				payload: {
					path: projectBPath,
				},
			});
			expect(addProjectResponse.status).toBe(200);
			expect(addProjectResponse.payload.ok).toBe(true);
			const projectBId = addProjectResponse.payload.project?.id ?? null;
			expect(projectBId).not.toBeNull();
			if (!projectBId) {
				throw new Error("Missing project id for added project.");
			}

			streamA = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?projectId=${encodeURIComponent(projectAId)}`,
			);
			const initialSnapshot = (await streamA.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(initialSnapshot.currentProjectId).toBe(projectAId);

			const removeResponse = await requestJson<RuntimeProjectRemoveResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.remove",
				type: "mutation",
				projectId: projectAId,
				payload: {
					projectId: projectAId,
				},
			});
			expect(removeResponse.status).toBe(200);
			expect(removeResponse.payload.ok).toBe(true);

			const projectsUpdated = (await streamA.waitForMessage(
				(message): message is RuntimeStateStreamProjectsMessage =>
					message.type === "projects_updated" && message.currentProjectId === projectBId,
			)) as RuntimeStateStreamProjectsMessage;
			expect(projectsUpdated.currentProjectId).toBe(projectBId);
			expect(projectsUpdated.projects.map((project) => project.id)).toEqual([projectBId]);

			streamB = await connectRuntimeStream(
				`ws://127.0.0.1:${port}/api/runtime/ws?projectId=${encodeURIComponent(projectBId)}`,
			);
			const fallbackSnapshot = (await streamB.waitForMessage(
				(message): message is RuntimeStateStreamSnapshotMessage => message.type === "snapshot",
			)) as RuntimeStateStreamSnapshotMessage;
			expect(fallbackSnapshot.currentProjectId).toBe(projectBId);
			expect(fallbackSnapshot.projectState?.repoPath).toBe(expectedProjectBPath);

			const projectsAfterRemoval = await requestJson<RuntimeProjectsResponse>({
				baseUrl: `http://127.0.0.1:${port}`,
				procedure: "projects.list",
				type: "query",
				projectId: projectBId,
			});
			expect(projectsAfterRemoval.status).toBe(200);
			expect(projectsAfterRemoval.payload.currentProjectId).toBe(projectBId);
			expect(projectsAfterRemoval.payload.projects.map((project) => project.id)).toEqual([projectBId]);
		} finally {
			if (streamA) {
				await streamA.close();
			}
			if (streamB) {
				await streamB.close();
			}
			await server.stop();
			cleanupRoot();
			cleanupHome();
		}
	}, 30_000);
});
