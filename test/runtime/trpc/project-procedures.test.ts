import { describe, expect, it, vi } from "vitest";

import type { RuntimeTrpcContext } from "../../../src/trpc/app-router-context";
import { savedProjectProcedure, t } from "../../../src/trpc/app-router-init";
import { projectRouter } from "../../../src/trpc/project-procedures";

describe("project board mutation procedures", () => {
	it("routes explicit regeneration through the shared scoped title service", async () => {
		const scope = { projectId: "project-1", projectPath: "/project" };
		const regenerateTaskTitle = vi.fn(async () => ({ ok: true, title: "Search and Recommendation UX" }));
		const admit: RuntimeTrpcContext["runProjectOperation"] = async (_scope, operation) => await operation();
		const runProjectOperation = vi.fn(admit);
		const caller = projectRouter.createCaller({
			requestedProjectId: scope.projectId,
			projectScope: scope,
			runProjectOperation,
			projectApi: { regenerateTaskTitle },
		} as unknown as RuntimeTrpcContext);
		await expect(caller.regenerateTaskTitle({ taskId: "task-1" })).resolves.toEqual({
			ok: true,
			title: "Search and Recommendation UX",
		});
		expect(regenerateTaskTitle).toHaveBeenCalledExactlyOnceWith(scope, "task-1");
		expect(runProjectOperation).toHaveBeenCalledExactlyOnceWith(scope, expect.any(Function));
	});
	it("does not execute a project procedure when admission rejects the stale scope", async () => {
		const scope = { projectId: "project-1", projectPath: "/old-location" };
		const regenerateTaskTitle = vi.fn();
		const caller = projectRouter.createCaller({
			requestedProjectId: scope.projectId,
			projectScope: scope,
			runProjectOperation: async () => {
				throw new Error("The project folder changed.");
			},
			projectApi: { regenerateTaskTitle },
		} as unknown as RuntimeTrpcContext);
		await expect(caller.regenerateTaskTitle({ taskId: "task-1" })).rejects.toThrow("project folder changed");
		expect(regenerateTaskTitle).not.toHaveBeenCalled();
	});
	it("admits saved state reads even when the folder is unavailable", async () => {
		const scope = { projectId: "project-1", projectPath: "/offline" };
		const admit: RuntimeTrpcContext["runProjectOperation"] = async (_scope, operation) => await operation();
		const runProjectOperation = vi.fn(admit);
		const caller = t.router({ saved: savedProjectProcedure.query(() => "saved board") }).createCaller({
			requestedProjectId: scope.projectId,
			projectScope: scope,
			runProjectOperation,
		} as unknown as RuntimeTrpcContext);
		await expect(caller.saved()).resolves.toBe("saved board");
		expect(runProjectOperation).toHaveBeenCalledExactlyOnceWith(scope, expect.any(Function), {
			allowUnavailable: true,
		});
	});
	it("exposes command submission without exposing whole-board persistence", () => {
		const procedureNames = Object.keys(projectRouter._def.procedures);

		expect(procedureNames).toContain("applyBoardCommands");
		expect(procedureNames).not.toContain("saveState");
	});
});
