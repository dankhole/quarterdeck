import { describe, expect, it, vi } from "vitest";

import {
	applyRuntimeMutationEffects,
	createBoardCommandCommittedEffects,
	createGitMetadataRefreshEffects,
	createHookTransitionEffects,
	createLogLevelBroadcastEffects,
	createTaskBaseRefUpdatedEffects,
} from "../../../src/trpc/runtime-mutation-effects";

describe("runtime mutation effects", () => {
	it("delivers command follow-up effects without duplicating authoritative state publication", async () => {
		const broadcaster = {
			broadcastRuntimeProjectNotificationsUpdated: vi.fn(async () => undefined),
			broadcastRuntimeProjectsUpdated: vi.fn(async () => undefined),
		};

		await applyRuntimeMutationEffects(
			broadcaster,
			createBoardCommandCommittedEffects({
				projectId: "project-1",
				projectPath: "/tmp/repo",
			}),
		);

		expect(broadcaster.broadcastRuntimeProjectNotificationsUpdated).toHaveBeenCalledWith("project-1");
		expect(broadcaster.broadcastRuntimeProjectsUpdated).not.toHaveBeenCalled();
	});

	it("dedupes repeated git metadata refresh effects", async () => {
		const broadcaster = {
			requestTaskRefresh: vi.fn(),
		};

		await applyRuntimeMutationEffects(broadcaster, [
			...createGitMetadataRefreshEffects({ projectId: "project-1" }, { taskId: "task-1" }),
			...createGitMetadataRefreshEffects({ projectId: "project-1" }, { taskId: "task-1" }),
		]);

		expect(broadcaster.requestTaskRefresh).toHaveBeenCalledTimes(1);
		expect(broadcaster.requestTaskRefresh).toHaveBeenCalledWith("project-1", "task-1");
	});

	it("can refresh task and home git metadata for shared-checkout task operations", async () => {
		const broadcaster = {
			requestTaskRefresh: vi.fn(),
			requestHomeRefresh: vi.fn(),
		};

		await applyRuntimeMutationEffects(
			broadcaster,
			createGitMetadataRefreshEffects({ projectId: "project-1" }, { taskId: "task-1" }, { includeHome: true }),
		);

		expect(broadcaster.requestTaskRefresh).toHaveBeenCalledWith("project-1", "task-1");
		expect(broadcaster.requestHomeRefresh).toHaveBeenCalledWith("project-1");
	});

	it("maps review hook transitions to project-state and ready-for-review effects", async () => {
		expect(
			createHookTransitionEffects({
				projectId: "project-1",
				projectPath: "/tmp/repo",
				taskId: "task-1",
				event: "to_review",
			}),
		).toEqual([
			{
				type: "project_state_updated",
				projectId: "project-1",
				projectPath: "/tmp/repo",
			},
			{
				type: "task_ready_for_review",
				projectId: "project-1",
				taskId: "task-1",
			},
		]);
	});

	it("does not emit ready-for-review effects for hook error reviews", async () => {
		expect(
			createHookTransitionEffects({
				projectId: "project-1",
				projectPath: "/tmp/repo",
				taskId: "task-1",
				event: "to_review",
				reviewReason: "error",
			}),
		).toEqual([
			{
				type: "project_state_updated",
				projectId: "project-1",
				projectPath: "/tmp/repo",
			},
		]);
	});

	it("does not emit ready-for-review effects for attention reviews", async () => {
		expect(
			createHookTransitionEffects({
				projectId: "project-1",
				projectPath: "/tmp/repo",
				taskId: "task-1",
				event: "to_review",
				reviewReason: "attention",
			}),
		).toEqual([
			{
				type: "project_state_updated",
				projectId: "project-1",
				projectPath: "/tmp/repo",
			},
		]);
	});

	it("delivers lightweight task base-ref sync effects", async () => {
		const broadcaster = {
			broadcastTaskBaseRefUpdated: vi.fn(),
		};

		await applyRuntimeMutationEffects(
			broadcaster,
			createTaskBaseRefUpdatedEffects({
				projectId: "project-1",
				taskId: "task-1",
				baseRef: "origin/main",
			}),
		);

		expect(broadcaster.broadcastTaskBaseRefUpdated).toHaveBeenCalledWith("project-1", "task-1", "origin/main");
	});

	it("delivers config/debug effects through the same effect layer", async () => {
		const broadcaster = {
			broadcastLogLevel: vi.fn(),
		};

		await applyRuntimeMutationEffects(broadcaster, createLogLevelBroadcastEffects("debug"));

		expect(broadcaster.broadcastLogLevel).toHaveBeenCalledWith("debug");
	});
});
