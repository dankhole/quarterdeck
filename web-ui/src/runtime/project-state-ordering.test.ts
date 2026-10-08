// @vitest-environment node

import { describe, expect, it } from "vitest";
import { createTestProjectStateResponse } from "@/test-utils/task-session-factory";
import { mergeProjectStateByRevision } from "./project-state-ordering";

describe("independent project state revisions", () => {
	it("accepts a location change without rolling back a newer board", () => {
		const current = createTestProjectStateResponse({ revision: 8, metadataRevision: 1, repoPath: "/old" });
		const incoming = createTestProjectStateResponse({ revision: 7, metadataRevision: 2, repoPath: "/new" });
		const result = mergeProjectStateByRevision(current, incoming);
		expect(result).toMatchObject({ revision: 8, metadataRevision: 2, repoPath: "/new" });
		expect(result.board).toBe(current.board);
		expect(result.sessions).toBe(current.sessions);
	});

	it("accepts a newer board without rolling back the project path or availability", () => {
		const current = createTestProjectStateResponse({
			revision: 8,
			metadataRevision: 2,
			repoPath: "/new",
			availability: { status: "unavailable", reason: "missing" },
		});
		const incoming = createTestProjectStateResponse({ revision: 9, metadataRevision: 1, repoPath: "/old" });
		const result = mergeProjectStateByRevision(current, incoming);
		expect(result).toMatchObject({
			revision: 9,
			metadataRevision: 2,
			repoPath: "/new",
			availability: current.availability,
		});
		expect(result.board).toBe(incoming.board);
	});
});
