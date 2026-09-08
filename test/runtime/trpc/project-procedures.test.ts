import { describe, expect, it, vi } from "vitest";

import type { RuntimeTrpcContext } from "../../../src/trpc/app-router-context";
import { projectRouter } from "../../../src/trpc/project-procedures";

describe("project board mutation procedures", () => {
	it("routes explicit regeneration through the shared scoped title service", async () => {
		const scope = { projectId: "project-1", projectPath: "/project" };
		const regenerateTaskTitle = vi.fn(async () => ({ ok: true, title: "Search and Recommendation UX" }));
		const caller = projectRouter.createCaller({
			requestedProjectId: scope.projectId,
			projectScope: scope,
			projectApi: { regenerateTaskTitle },
		} as unknown as RuntimeTrpcContext);
		await expect(caller.regenerateTaskTitle({ taskId: "task-1" })).resolves.toEqual({
			ok: true,
			title: "Search and Recommendation UX",
		});
		expect(regenerateTaskTitle).toHaveBeenCalledExactlyOnceWith(scope, "task-1");
	});
	it("exposes command submission without exposing whole-board persistence", () => {
		const procedureNames = Object.keys(projectRouter._def.procedures);

		expect(procedureNames).toContain("applyBoardCommands");
		expect(procedureNames).not.toContain("saveState");
	});
});
