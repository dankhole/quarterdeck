import { describe, expect, it } from "vitest";

import { projectRouter } from "../../../src/trpc/project-procedures";

describe("project board mutation procedures", () => {
	it("exposes command submission without exposing whole-board persistence", () => {
		const procedureNames = Object.keys(projectRouter._def.procedures);

		expect(procedureNames).toContain("applyBoardCommands");
		expect(procedureNames).not.toContain("saveState");
	});
});
