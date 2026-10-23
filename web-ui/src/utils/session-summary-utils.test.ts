// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { createTestTaskSessionSummary } from "@/test-utils/task-session-factory";
import {
	mergeTaskSessionSummaryMap,
	reconcileAuthoritativeTaskSessionSummaryMap,
	selectNewestTaskSessionSummary,
} from "@/utils/session-summary-utils";

function createSessionSummary(taskId: string, updatedAt: number): RuntimeTaskSessionSummary {
	return createTestTaskSessionSummary({
		taskId,
		state: "running",
		agentId: "codex",
		sessionLaunchPath: "/tmp/project-a",
		startedAt: updatedAt - 10,
		updatedAt,
		lastOutputAt: updatedAt,
		lastHookAt: updatedAt,
	});
}

describe("selectNewestTaskSessionSummary", () => {
	it("returns the newer summary by updatedAt", () => {
		const older = createSessionSummary("task-1", 100);
		const newer = createSessionSummary("task-1", 200);

		expect(selectNewestTaskSessionSummary(older, newer)).toBe(newer);
		expect(selectNewestTaskSessionSummary(newer, older)).toBe(newer);
	});

	it("prefers the incoming summary when updatedAt ties", () => {
		const existing = createSessionSummary("task-1", 100);
		const incoming = {
			...createSessionSummary("task-1", 100),
			reviewReason: "hook" as const,
		};

		expect(selectNewestTaskSessionSummary(existing, incoming)).toBe(incoming);
	});
});

describe("mergeTaskSessionSummaryMap", () => {
	it("merges incoming summaries without dropping unrelated current tasks", () => {
		const current = {
			"task-1": createSessionSummary("task-1", 100),
			"task-2": createSessionSummary("task-2", 150),
		};

		const merged = mergeTaskSessionSummaryMap(current, [createSessionSummary("task-1", 200)]);

		expect(merged["task-1"]?.updatedAt).toBe(200);
		expect(merged["task-2"]?.updatedAt).toBe(150);
	});

	it("keeps the unrelated task's existing summary reference stable", () => {
		const task2Summary = createSessionSummary("task-2", 150);
		const current = {
			"task-1": createSessionSummary("task-1", 100),
			"task-2": task2Summary,
		};

		const merged = mergeTaskSessionSummaryMap(current, [createSessionSummary("task-1", 200)]);

		expect(merged["task-2"]).toBe(task2Summary);
	});

	it("returns the same map object when a content-identical duplicate ties on updatedAt", () => {
		const current = {
			"task-1": createSessionSummary("task-1", 100),
			"task-2": createSessionSummary("task-2", 150),
		};

		// Same taskId, same updatedAt, same content, but a distinct object
		// instance — the kind of duplicate a freshly parsed delta produces.
		const merged = mergeTaskSessionSummaryMap(current, [createSessionSummary("task-1", 100)]);

		expect(merged).toBe(current);
		expect(merged["task-1"]).toBe(current["task-1"]);
	});

	it("returns a new map object, and only replaces the changed entry, when a real change is merged", () => {
		const current = {
			"task-1": createSessionSummary("task-1", 100),
			"task-2": createSessionSummary("task-2", 150),
		};

		const merged = mergeTaskSessionSummaryMap(current, [createSessionSummary("task-1", 200)]);

		expect(merged).not.toBe(current);
		expect(merged["task-2"]).toBe(current["task-2"]);
	});
});

describe("reconcileAuthoritativeTaskSessionSummaryMap", () => {
	it("drops tasks missing from the incoming authoritative session set", () => {
		const reconciled = reconcileAuthoritativeTaskSessionSummaryMap(
			{
				"task-1": createSessionSummary("task-1", 100),
				"task-2": createSessionSummary("task-2", 150),
			},
			{
				"task-1": createSessionSummary("task-1", 200),
			},
		);

		expect(reconciled).toEqual({
			"task-1": createSessionSummary("task-1", 200),
		});
	});

	it("still keeps the newer overlapping summary when the authoritative update is stale", () => {
		const current = createSessionSummary("task-1", 200);
		const incoming = createSessionSummary("task-1", 100);

		const reconciled = reconcileAuthoritativeTaskSessionSummaryMap({ "task-1": current }, { "task-1": incoming });

		expect(reconciled["task-1"]).toBe(current);
	});

	it("returns the same map object when the authoritative set reconfirms unchanged tasks", () => {
		const current = {
			"task-1": createSessionSummary("task-1", 100),
			"task-2": createSessionSummary("task-2", 150),
		};
		// Distinct object instances with identical content and tied updatedAt —
		// the shape of a routine authoritative re-sync of unchanged tasks.
		const incoming = {
			"task-1": createSessionSummary("task-1", 100),
			"task-2": createSessionSummary("task-2", 150),
		};

		const reconciled = reconcileAuthoritativeTaskSessionSummaryMap(current, incoming);

		expect(reconciled).toBe(current);
	});

	it("only replaces the changed entry when one task in the authoritative set actually changed", () => {
		const task2Summary = createSessionSummary("task-2", 150);
		const current = {
			"task-1": createSessionSummary("task-1", 100),
			"task-2": task2Summary,
		};
		const incoming = {
			"task-1": createSessionSummary("task-1", 200),
			"task-2": createSessionSummary("task-2", 150),
		};

		const reconciled = reconcileAuthoritativeTaskSessionSummaryMap(current, incoming);

		expect(reconciled).not.toBe(current);
		expect(reconciled["task-1"]?.updatedAt).toBe(200);
		expect(reconciled["task-2"]).toBe(task2Summary);
	});
});
