import { describe, expect, it } from "vitest";

import { isWindowsSafePathComponent } from "../../src/core";
import { ensureProjectEntry, findProjectEntry } from "../../src/state/project-state-index";

describe("Windows project index identity", () => {
	it("reuses one project entry for case and separator aliases", () => {
		const existingEntry = { projectId: "repo", repoPath: "C:\\Projects\\Repo" };
		const index: Parameters<typeof ensureProjectEntry>[0] = {
			version: 1,
			entries: { repo: existingEntry },
			repoPathToId: { [existingEntry.repoPath]: existingEntry.projectId },
			projectOrder: [existingEntry.projectId],
		};

		const ensured = ensureProjectEntry(index, "c:/projects/repo/", "win32");

		expect(ensured).toEqual({ index, entry: existingEntry, changed: false });
		expect(findProjectEntry(index, "c:/PROJECTS/REPO", "win32")).toBe(existingEntry);
	});

	it("generates bounded non-reserved state directory names", () => {
		const emptyIndex: Parameters<typeof ensureProjectEntry>[0] = {
			version: 1,
			entries: {},
			repoPathToId: {},
			projectOrder: [],
		};
		const reserved = ensureProjectEntry(emptyIndex, "C:\\Repos\\con-", "win32");
		expect(reserved.entry.projectId).toBe("project-con");
		expect(isWindowsSafePathComponent(reserved.entry.projectId)).toBe(true);

		const longName = "a".repeat(300);
		const bounded = ensureProjectEntry(emptyIndex, `C:\\Repos\\${longName}`, "win32");
		expect(bounded.entry.projectId.length).toBeLessThanOrEqual(80);
		expect(isWindowsSafePathComponent(bounded.entry.projectId)).toBe(true);
	});
});
