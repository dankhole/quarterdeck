// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { ProjectOrganization, RuntimeProjectSummary } from "@/runtime/types";
import { moveProjectOneStep, projectDropCommand, projectSections } from "./project-groups";

const projects: RuntimeProjectSummary[] = ["a", "b", "c"].map((id) => ({
	id,
	name: id,
	path: `/tmp/${id}`,
	boardRevision: 0,
	taskCounts: { in_progress: 0, review: 0, trash: 0 },
}));
const organization: ProjectOrganization = {
	id: "index",
	revision: 1,
	groups: [{ id: "g", name: "Work" }],
	membership: { a: "g", c: "g" },
	projectOrder: ["c", "b", "a"],
};
describe("grouped project navigation", () => {
	it("renders every project exactly once, retaining group order and flat defaults", () => {
		expect(
			projectSections(projects, organization).map((group) => group.projects.map((project) => project.id)),
		).toEqual([["c", "a"], ["b"]]);
		expect(projectSections(projects, null)[0]?.projects).toEqual(projects);
	});
	it("resolves collapsed headers, insertions, ungrouped and group ordering", () => {
		const sections = projectSections(projects, organization);
		expect(projectDropCommand("project:b", "section:g", sections)).toEqual({
			type: "move",
			projectIds: ["b"],
			groupId: "g",
			beforeProjectId: null,
		});
		expect(projectDropCommand("project:b", "before:a", sections)?.type).toBe("move");
		expect(projectDropCommand("project:a", "before:a", sections)).toBeNull();
		expect(projectDropCommand("project:a", "end:ungrouped", sections)).toMatchObject({ groupId: null });
		expect(projectDropCommand("group:g", "section:ungrouped", sections)).toMatchObject({
			type: "reorder_group",
			beforeGroupId: null,
		});
		expect(projectDropCommand("group:g", "before:a", sections)).toBeNull();
	});
	it("moves a group after a lower target or before a higher target", () => {
		const sections = projectSections(projects, {
			...organization,
			groups: [
				{ id: "g", name: "Work" },
				{ id: "p", name: "Personal" },
				{ id: "t", name: "Tools" },
			],
		});
		expect(projectDropCommand("group:g", "section:p", sections)).toMatchObject({ beforeGroupId: "t" });
		expect(projectDropCommand("group:t", "section:g", sections)).toMatchObject({ beforeGroupId: "g" });
	});

	it("keyboard menu ordering uses a destination outside the moved selection", () => {
		const section = projectSections(projects, organization)[0]!;
		expect(moveProjectOneStep(section, "c", 1)).toMatchObject({ beforeProjectId: null });
		expect(moveProjectOneStep(section, "a", -1)).toMatchObject({ beforeProjectId: "c" });
		expect(moveProjectOneStep(section, "c", -1)).toBeNull();
	});
});
