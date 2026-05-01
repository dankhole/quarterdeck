import { describe, expect, it, vi } from "vitest";

import {
	applyRuntimeMutationEffects,
	createBoardStateSavedEffects,
	createGitMetadataRefreshEffects,
	createHookTransitionEffects,
	createLogLevelBroadcastEffects,
	createTaskBaseRefUpdatedEffects,
} from "../../../src/trpc/runtime-mutation-effects";

describe("runtime mutation effects", () => {
	it("delivers board-save effects in order", async () => {
		const broadcaster = {
			broadcastRuntimeProjectStateUpdated: vi.fn(async () => undefined),
			broadcastRuntimeProjectNotificationsUpdated: vi.fn(async () => undefined),
			broadcastRuntimeProjectsUpdated: vi.fn(async () => undefined),
		};

		await applyRuntimeMutationEffects(
			broadcaster,
			createBoardStateSavedEffects({
				projectId: "project-1",
				projectPath: "/tmp/repo",
			}),
		);

		expect(broadcaster.broadcastRuntimeProjectStateUpdated).toHaveBeenCalledWith("project-1", "/tmp/repo");
		expect(broadcaster.broadcastRuntimeProjectNotificationsUpdated).toHaveBeenCalledWith("project-1");
		expect(broadcaster.broadcastRuntimeProjectsUpdated).toHaveBeenCalledWith("project-1");
		expect(broadcaster.broadcastRuntimeProjectStateUpdated.mock.invocationCallOrder[0]).toBeLessThan(
			broadcaster.broadcastRuntimeProjectNotificationsUpdated.mock.invocationCallOrder[0],
		);
		expect(broadcaster.broadcastRuntimeProjectNotificationsUpdated.mock.invocationCallOrder[0]).toBeLessThan(
			broadcaster.broadcastRuntimeProjectsUpdated.mock.invocationCallOrder[0],
		);
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
