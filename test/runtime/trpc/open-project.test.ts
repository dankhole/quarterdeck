import { describe, expect, it, vi } from "vitest";

import { handleOpenProject } from "../../../src/trpc/handlers/open-project";

const scope = { projectId: "project-1", projectPath: "/repo" };

describe("handleOpenProject", () => {
	it("delegates a typed target and server-owned project path to the host integration boundary", async () => {
		const openProject = vi.fn(async () => ({ ok: true as const, outcome: "native" as const }));

		const response = await handleOpenProject(scope, { targetId: "vscode" }, { hostIntegrations: { openProject } });

		expect(response).toEqual({ ok: true, outcome: "native" });
		expect(openProject).toHaveBeenCalledWith("vscode", "/repo", { projectId: "project-1" });
	});

	it("maps host capability rejection to a typed response", async () => {
		const openProject = vi.fn(async () => ({
			ok: false as const,
			reason: "native_ui_unavailable" as const,
			error: "Native UI is unavailable.",
		}));
		const response = await handleOpenProject(scope, { targetId: "finder" }, { hostIntegrations: { openProject } });

		expect(response).toMatchObject({
			ok: false,
			reason: "native_ui_unavailable",
		});
	});
});
