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
	it("notifies when a seeded Review task gains an approval wait, without replaying metadata updates", () => {
		const policy = new DesktopNotificationPolicy();
		policy.seed(["first"], { first: [review] }, {});
		policy.setOwned(true);
		const waiting = {
			...review,
			outstandingInteraction: createTestTaskOutstandingInteraction({ kind: "permission" }),
		};
		policy.applyDelta("first", 1, [waiting], [], false, 0);
		expect(policy.flush(500, preferences, background)).toMatchObject([{ eventType: "permission" }]);
		policy.applyDelta("first", 2, [{ ...waiting, updatedAt: 1_000 }], [], false, 600);
		expect(policy.flush(1_100, preferences, background)).toEqual([]);
	});

	it.each(["resumed", "answered", "interrupted", "removed", "project removed", "lease lost"] as const)(
		"cancels a pending approval after %s before its settle deadline",
		(reason) => {
			const policy = new DesktopNotificationPolicy();
			policy.seed(["first"], { first: [running] }, {});
			policy.setOwned(true);
			const interaction = createTestTaskOutstandingInteraction({ kind: "permission" });
			policy.applyDelta("first", 1, [{ ...review, outstandingInteraction: interaction }], [], false, 0);
			if (reason === "lease lost") policy.setOwned(false);
			else if (reason === "project removed") policy.pruneProjects([]);
			else if (reason === "removed") policy.applyDelta("first", 2, [], ["task"], false, 100);
			else
				policy.applyDelta(
					"first",
					2,
					[
						reason === "resumed"
							? running
							: reason === "answered"
								? { ...review, outstandingInteraction: { ...interaction, status: "response_submitted" } }
								: { ...review, reviewReason: "interrupted" },
					],
					[],
					false,
					100,
				);
			expect(policy.flush(500, preferences, background)).toEqual([]);
		},
	);

	it("does not transfer pending sounds across presentation ownership changes", () => {
		const policy = new DesktopNotificationPolicy();
		policy.seed(["first"], { first: [running] }, {});
		policy.setOwned(true);
		policy.applyDelta("first", 1, [review], [], false, 0);
		policy.setOwned(false);
		policy.setOwned(true);
		expect(policy.flush(500, preferences, background)).toEqual([]);
		policy.applyDelta("first", 2, [running], [], false, 600);
		policy.applyDelta("first", 3, [{ ...review, lastHookAt: 700 }], [], false, 700);
		expect(policy.flush(1_200, preferences, background)).toHaveLength(1);
	});

	it("scopes suppression by project even when task IDs collide, and honors current focus at flush", () => {
		const suppressed = { ...preferences, suppressCurrentProject: { permission: true, review: true, failure: true } };
		for (const focused of [true, false]) {
			const policy = new DesktopNotificationPolicy();
			policy.seed(["first", "second"], { first: [running], second: [running] }, {});
			policy.setOwned(true);
			policy.applyDelta("first", 1, [review], [], false, 0);
			policy.applyDelta("second", 1, [review], [], false, 0);
			const events = policy.flush(500, suppressed, { focused, currentProjectId: "first" });
			expect(events.map((event) => event.projectId)).toEqual(focused ? ["second"] : ["first", "second"]);
		}
	});

	it("delivers failure immediately and consumes edges suppressed by preferences at flush", () => {
		const policy = new DesktopNotificationPolicy();
		policy.seed(["first"], { first: [running] }, {});
		policy.setOwned(true);
		policy.applyDelta("first", 1, [{ ...review, reviewReason: "error" }], [], false, 0);
		expect(policy.nextDeadline()).toBe(0);
		expect(policy.flush(0, preferences, background)).toMatchObject([{ eventType: "failure" }]);
		policy.applyDelta("first", 2, [running], [], false, 100);
		policy.applyDelta("first", 3, [{ ...review, lastHookAt: 200 }], [], false, 200);
		expect(policy.flush(700, { ...preferences, enabled: false }, background)).toEqual([]);
		expect(policy.flush(800, preferences, background)).toEqual([]);
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
