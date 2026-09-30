import { describe, expect, it } from "vitest";
import type { ProjectOrganization } from "../../src/core/api/project-organization";
import { applyProjectOrganizationCommand } from "../../src/core/project-organization";

const initial: ProjectOrganization = {
	id: "index",
	revision: 2,
	groups: [
		{ id: "work", name: "Work" },
		{ id: "tools", name: "Tools" },
	],
	membership: { a: "work", b: "tools", c: "work" },
	projectOrder: ["a", "b", "c", "d"],
};
describe("project organization", () => {
	it("moves in canonical relative order, preserves other members, and leaves input untouched", () => {
		const next = applyProjectOrganizationCommand(initial, {
			type: "move",
			projectIds: ["c", "a"],
			groupId: "tools",
			beforeProjectId: "b",
		});
		expect(next.projectOrder).toEqual(["a", "c", "b", "d"]);
		expect(next.membership).toEqual({ a: "tools", b: "tools", c: "tools" });
		expect(initial.membership.a).toBe("work");
		expect(next.revision).toBe(3);
	});
	it("appends a removed group's projects after existing ungrouped projects", () => {
		const next = applyProjectOrganizationCommand(initial, { type: "remove", groupId: "work" });
		expect(next.groups.map((group) => group.id)).toEqual(["tools"]);
		expect(next.projectOrder.filter((id) => !next.membership[id])).toEqual(["d", "a", "c"]);
		expect(next.projectOrder).toHaveLength(4);
	});
	it("creates a group and assigns selected projects atomically", () => {
		const next = applyProjectOrganizationCommand(initial, {
			type: "create",
			id: "personal",
			name: " Personal ",
			projectIds: ["d", "b"],
		});
		expect(next.groups[2]?.name).toBe("Personal");
		expect(next.projectOrder.filter((id) => next.membership[id] === "personal")).toEqual(["b", "d"]);
	});
	it("rejects duplicate, reserved, empty names and stale destinations", () => {
		for (const name of [" work ", "Ungrouped", "  "]) {
			expect(() =>
				applyProjectOrganizationCommand(initial, { type: "create", id: "new", name, projectIds: [] }),
			).toThrow();
		}
		expect(() =>
			applyProjectOrganizationCommand(initial, {
				type: "move",
				projectIds: ["gone"],
				groupId: "work",
				beforeProjectId: null,
			}),
		).toThrow("no longer exists");
		expect(() =>
			applyProjectOrganizationCommand(initial, {
				type: "move",
				projectIds: ["a"],
				groupId: "work",
				beforeProjectId: "b",
			}),
		).toThrow("destination changed");
		expect(() =>
			applyProjectOrganizationCommand(initial, { type: "rename", groupId: "gone", name: "Hello" }),
		).toThrow("no longer exists");
	});
	it("reorders groups without changing project membership or relative project order", () => {
		const next = applyProjectOrganizationCommand(initial, {
			type: "reorder_group",
			groupId: "tools",
			beforeGroupId: "work",
		});
		expect(next.groups.map((group) => group.id)).toEqual(["tools", "work"]);
		expect(next.projectOrder).toEqual(initial.projectOrder);
		expect(next.membership).toEqual(initial.membership);
	});
});
