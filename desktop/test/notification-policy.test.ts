import { describe, expect, it } from "vitest";
import type { RuntimeNotificationPreferences } from "../../src/core/api/notification-presentation.js";
import {
	createTestTaskOutstandingInteraction,
	createTestTaskSessionSummary,
} from "../../test/utilities/task-session-factory.js";
import { DesktopNotificationPolicy } from "../src/notification-policy.js";

const preferences: RuntimeNotificationPreferences = {
	enabled: true,
	volume: 0.5,
	events: { permission: true, review: true, failure: true },
	onlyWhenHidden: false,
	suppressCurrentProject: { permission: false, review: false, failure: false },
};
const background = { focused: false, currentProjectId: "first" };
const running = createTestTaskSessionSummary({
	taskId: "task",
	state: "running",
	pid: 123,
	startedAt: 1,
	sessionInstanceId: "session",
});
const review = {
	...running,
	state: "awaiting_review" as const,
	reviewReason: "hook" as const,
	lastHookAt: 2,
	updatedAt: 2,
};

describe("native authoritative notification policy", () => {
	it("silently seeds and notifies hidden-window all-project edges once across replay/reconnect", () => {
		const policy = new DesktopNotificationPolicy();
		policy.seed(["first", "second"], { first: [review], second: [running] }, { first: 1, second: 1 });
		policy.setOwned(true);
		expect(policy.flush(0, preferences, background)).toEqual([]);
		policy.applyDelta("second", 2, [review], [], false, 100);
		expect(policy.flush(599, preferences, background)).toEqual([]);
		const events = policy.flush(600, preferences, background);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ projectId: "second", taskId: "task", eventType: "review" });
		policy.applyDelta("second", 2, [review], [], false, 700);
		expect(policy.flush(1_000, preferences, background)).toEqual([]);
		policy.setOwned(false);
		policy.seed(["second"], { second: [running] }, { second: 1 });
		policy.setOwned(true);
		policy.applyDelta("second", 2, [review], [], false, 1_100);
		expect(policy.flush(1_600, preferences, background)).toEqual([]);
	});
	it("upgrades a settling review to permission and rejects stale deltas", () => {
		const policy = new DesktopNotificationPolicy();
		policy.seed(["first"], { first: [running] }, { first: 5 });
		policy.setOwned(true);
		policy.applyDelta("first", 4, [review], [], false, 0);
		expect(policy.nextDeadline()).toBeNull();
		policy.applyDelta("first", 6, [review], [], false, 10);
		const permission = {
			...review,
			outstandingInteraction: createTestTaskOutstandingInteraction({ kind: "permission" }),
		};
		policy.applyDelta("first", 7, [permission], [], false, 100);
		expect(policy.flush(510, preferences, background)).toMatchObject([{ eventType: "permission" }]);
		expect(policy.badgeCount()).toBe(1);
	});
	it("honors master/events/foreground suppression and consumes suppressed edges", () => {
		for (const settings of [
			{ ...preferences, enabled: false },
			{ ...preferences, onlyWhenHidden: true },
			{ ...preferences, events: { ...preferences.events, review: false } },
			{ ...preferences, suppressCurrentProject: { ...preferences.suppressCurrentProject, review: true } },
		]) {
			const policy = new DesktopNotificationPolicy();
			policy.seed(["first"], { first: [running] }, {});
			policy.setOwned(true);
			policy.applyDelta("first", 1, [review], [], false, 0);
			expect(policy.flush(500, settings, { focused: true, currentProjectId: "first" })).toEqual([]);
			expect(policy.flush(600, preferences, background)).toEqual([]);
		}
	});
	it("does not present without a lease and revalidates click targets after deletions", () => {
		const policy = new DesktopNotificationPolicy();
		policy.seed(["first"], { first: [running] }, {});
		policy.applyDelta("first", 1, [review], [], false, 0);
		expect(policy.flush(500, preferences, background)).toEqual([]);
		policy.setOwned(true);
		expect(policy.resolveTarget("first", "task")).toEqual({ projectId: "first", taskId: "task" });
		policy.applyDelta("first", 2, [], ["task"], false, 600);
		expect(policy.resolveTarget("first", "task")).toEqual({ projectId: "first", taskId: null });
		policy.pruneProjects([]);
		expect(policy.resolveTarget("first", "task")).toEqual({ projectId: null, taskId: null });
		expect(policy.badgeCount()).toBe(0);
	});
});
