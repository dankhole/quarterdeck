import { describe, expect, it } from "vitest";

import { isTaskBaseRefResolved, resolveGitChangesQueryProjectId } from "@/hooks/git/git-view";

describe("git view scope helpers", () => {
	it("treats home scope as resolved without a base ref", () => {
		expect(isTaskBaseRefResolved(null, null)).toBe(true);
		expect(
			resolveGitChangesQueryProjectId({
				currentProjectId: "project-1",
				taskId: null,
				baseRef: null,
				refMode: "base_derived",
			}),
		).toBe("project-1");
	});

	it("blocks base-derived task queries when the base ref is unresolved", () => {
		expect(isTaskBaseRefResolved("task-1", "")).toBe(false);
		expect(
			resolveGitChangesQueryProjectId({
				currentProjectId: "project-1",
				taskId: "task-1",
				baseRef: "",
				refMode: "base_derived",
			}),
		).toBeNull();
	});

	it("allows unresolved-base task compare queries once explicit refs are selected", () => {
		expect(
			resolveGitChangesQueryProjectId({
				currentProjectId: "project-1",
				taskId: "task-1",
				baseRef: "",
				refMode: "explicit_refs",
			}),
		).toBe("project-1");
	});
});
