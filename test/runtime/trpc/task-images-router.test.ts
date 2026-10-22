import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TRPCError } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProjectBoardCommandService } from "../../../src/state/project-board-command-service";
import { loadProjectContext } from "../../../src/state/project-state";
import { getProjectBoardPath, getProjectDirectoryPath } from "../../../src/state/project-state-utils";
import type { RuntimeTrpcContext } from "../../../src/trpc/app-router-context";
import { taskImagesRouter } from "../../../src/trpc/task-images-router";
import { createTempDir } from "../../utilities/temp-dir";

const originalStateHome = process.env.QUARTERDECK_STATE_HOME;
let fixture: ReturnType<typeof createTempDir>;

function sha256(content: string): string {
	return createHash("sha256").update(Buffer.from(content)).digest("hex");
}

async function addProject(name: string): Promise<{ projectId: string; projectPath: string }> {
	const projectPath = join(fixture.path, name);
	mkdirSync(projectPath);
	const context = await loadProjectContext(projectPath, { folderOnly: true });
	return { projectId: context.projectId, projectPath: context.repoPath };
}

function callerFor(scope: { projectId: string; projectPath: string }) {
	const runProjectOperation: RuntimeTrpcContext["runProjectOperation"] = async (_scope, operation) =>
		await operation();
	return taskImagesRouter.createCaller({
		requestedProjectId: scope.projectId,
		projectScope: scope,
		runProjectOperation,
	} as unknown as RuntimeTrpcContext);
}

beforeEach(() => {
	fixture = createTempDir("quarterdeck-task-images-router-");
	process.env.QUARTERDECK_STATE_HOME = join(fixture.path, "state");
});

afterEach(() => {
	fixture.cleanup();
	if (originalStateHome === undefined) delete process.env.QUARTERDECK_STATE_HOME;
	else process.env.QUARTERDECK_STATE_HOME = originalStateHome;
});

describe("taskImages.get", () => {
	it("reads stored blobs only from the requesting project and returns null when absent", async () => {
		const owner = await addProject("owner");
		const other = await addProject("other");
		await new ProjectBoardCommandService({ getAuthoritativeSessions: () => ({}) }).execute(owner, {
			commandId: "create",
			expectedRevision: 0,
			command: {
				kind: "create_task",
				columnId: "review",
				taskId: "task-a",
				prompt: "Prompt",
				images: [{ id: "img", mimeType: "image/png", data: Buffer.from("owned-bytes").toString("base64") }],
				baseRef: "main",
				createdAt: 1,
			},
		});
		const hash = sha256("owned-bytes");

		await expect(callerFor(owner).get({ sha256: hash })).resolves.toEqual({
			sha256: hash,
			data: Buffer.from("owned-bytes").toString("base64"),
		});
		await expect(callerFor(other).get({ sha256: hash })).resolves.toBeNull();
		await expect(callerFor(owner).get({ sha256: sha256("never stored") })).resolves.toBeNull();
	});

	it("rejects malformed hashes before touching the filesystem", async () => {
		const owner = await addProject("owner");
		for (const sha of ["../board.json", "A".repeat(64), "a".repeat(63)]) {
			await expect(callerFor(owner).get({ sha256: sha })).rejects.toSatisfy(
				(error: unknown) => error instanceof TRPCError && error.code === "BAD_REQUEST",
			);
		}
	});

	it("serves a legacy inline image before its blob has been stored", async () => {
		const legacy = await addProject("legacy");
		const data = Buffer.from("legacy-inline-bytes").toString("base64");
		mkdirSync(getProjectDirectoryPath(legacy.projectId), { recursive: true });
		writeFileSync(
			getProjectBoardPath(legacy.projectId),
			JSON.stringify({
				columns: [
					{
						id: "review",
						title: "Review",
						cards: [
							{
								id: "legacy",
								title: null,
								prompt: "Legacy",
								images: [{ id: "img", mimeType: "image/png", data }],
								baseRef: "main",
								createdAt: 1,
								updatedAt: 1,
							},
						],
					},
				],
			}),
		);

		await expect(callerFor(legacy).get({ sha256: sha256("legacy-inline-bytes") })).resolves.toEqual({
			sha256: sha256("legacy-inline-bytes"),
			data,
		});
	});
});
