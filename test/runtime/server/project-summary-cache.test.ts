import { describe, expect, it } from "vitest";

import type { RuntimeProjectSummary } from "../../../src/core";
import { ProjectSummaryCache } from "../../../src/server/project-summary-cache";

const key = {
	repoPath: "/repo",
	boardRevision: 3,
	metadataRevision: 1,
	availability: { status: "available" as const },
};
const summary = { id: "p", path: "/repo", name: "repo" } as RuntimeProjectSummary;

describe("ProjectSummaryCache", () => {
	it("serves a summary only while every derivation input is unchanged", () => {
		const cache = new ProjectSummaryCache();
		cache.set("p", key, summary);
		expect(cache.get("p", { ...key })).toBe(summary);
		expect(cache.get("p", { ...key, boardRevision: 4 })).toBeNull();
		expect(cache.get("p", { ...key, metadataRevision: 2 })).toBeNull();
		expect(cache.get("p", { ...key, repoPath: "/moved" })).toBeNull();
		expect(cache.get("p", { ...key, displayName: "Renamed" })).toBeNull();
		expect(cache.get("p", { ...key, availability: { status: "unavailable", reason: "missing" } })).toBeNull();
		cache.purge("p");
		expect(cache.get("p", key)).toBeNull();
	});

	it("can be disabled", () => {
		const cache = new ProjectSummaryCache(false);
		cache.set("p", key, summary);
		expect(cache.get("p", key)).toBeNull();
	});
});
