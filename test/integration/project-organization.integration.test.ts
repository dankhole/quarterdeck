import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getProjectsRootPath, loadProjectContext, removeProjectIndexEntry } from "../../src/state";
import {
	readProjectIndex,
	readProjectNavigationIndex,
	updateProjectOrganization,
} from "../../src/state/project-state-index";
import { createTempDir, withTemporaryHome } from "../utilities/temp-dir";

describe("project group persistence", () => {
	it("migrates on write, preserves groups through registration, and serializes conflicting edits", async () => {
		await withTemporaryHome(async () => {
			const a = createTempDir("groups-a-");
			const b = createTempDir("groups-b-");
			try {
				const first = await loadProjectContext(a.path, { folderOnly: true });
				expect((await readProjectNavigationIndex()).organization).toBeNull();
				const groupId = randomUUID();
				const created = await updateProjectOrganization({
					expectedRevision: 0,
					command: { type: "create", id: groupId, name: "Work", projectIds: [first.projectId] },
				});
				expect(created.ok).toBe(true);
				const beforeInvalidAdd = readFileSync(join(getProjectsRootPath(), "index.json"), "utf8");
				await expect(loadProjectContext(b.path, { folderOnly: true, groupId: "deleted-group" })).rejects.toThrow(
					"no longer exists",
				);
				expect(readFileSync(join(getProjectsRootPath(), "index.json"), "utf8")).toBe(beforeInvalidAdd);
				const second = await loadProjectContext(b.path, { folderOnly: true, groupId });
				const afterAdd = (await readProjectNavigationIndex()).organization;
				if (!afterAdd) throw new Error("Missing saved organization");
				expect(afterAdd.groups).toEqual([{ id: groupId, name: "Work" }]);
				expect(afterAdd.membership).toEqual({ [first.projectId]: groupId, [second.projectId]: groupId });
				expect(JSON.parse(readFileSync(join(getProjectsRootPath(), "index.json"), "utf8")).version).toBe(2);
				const edits = await Promise.all(
					["Team", "Personal"].map((name) =>
						updateProjectOrganization({
							expectedRevision: afterAdd.revision,
							command: { type: "rename", groupId, name },
						}),
					),
				);
				expect(edits.filter((result) => result.ok)).toHaveLength(1);
				expect(edits.filter((result) => !result.ok)).toHaveLength(1);
				await removeProjectIndexEntry(first.projectId);
				const afterRemove = (await readProjectNavigationIndex()).organization;
				if (!afterRemove) throw new Error("Missing saved organization");
				expect(afterRemove.membership[first.projectId]).toBeUndefined();
				expect(afterRemove.projectOrder).toEqual([second.projectId]);
				expect(afterRemove.id).toBe(afterAdd.id);
				const removed = await updateProjectOrganization({
					expectedRevision: afterRemove.revision,
					command: { type: "remove", groupId },
				});
				expect(removed.ok).toBe(true);
				expect((await readProjectNavigationIndex()).entries).toHaveLength(1);
			} finally {
				a.cleanup();
				b.cleanup();
			}
		});
	});
	it("rejects a malformed migrated index without overwriting it", async () => {
		await withTemporaryHome(async () => {
			const directory = createTempDir("invalid-groups-");
			try {
				await loadProjectContext(directory.path, { folderOnly: true });
				const path = join(getProjectsRootPath(), "index.json");
				const index = JSON.parse(readFileSync(path, "utf8"));
				index.version = 2;
				writeFileSync(path, JSON.stringify(index));
				await expect(readProjectIndex()).rejects.toThrow("Version 2 requires project organization metadata");
				expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(index);
			} finally {
				directory.cleanup();
			}
		});
	});
});
