import { expect, it } from "vitest";
import type { RuntimeTaskLifecycleResult } from "../../src/core";
import { clearTrashTasks } from "../../src/server/clear-trash";

it("limits concurrent lifecycle intents and continues after one child throws", async () => {
	let active = 0;
	let maximum = 0;
	const seen: string[] = [];
	const scope = { projectId: "original", projectPath: "/synthetic" };
	const request = {
		operationId: "bulk",
		expectedRevision: 4,
		tasks: Array.from({ length: 12 }, (_, i) => ({ taskId: `task-${i}`, taskCreatedAt: i })),
	};
	const result = await clearTrashTasks(scope, request, async (capturedScope, command) => {
		expect(capturedScope).toBe(scope);
		seen.push(command.operationId);
		active += 1;
		maximum = Math.max(maximum, active);
		await new Promise((resolve) => setTimeout(resolve, 1));
		active -= 1;
		throw new Error("Synthetic failure");
	});
	expect(maximum).toBe(4);
	expect(result).toHaveLength(12);
	expect(result.every((entry) => !entry.ok && entry.outcomeCode === "internal_error")).toBe(true);
	const replayIds: string[] = [];
	await clearTrashTasks(scope, request, async (_scope, command): Promise<RuntimeTaskLifecycleResult> => {
		replayIds.push(command.operationId);
		throw new Error("Synthetic failure");
	});
	expect(replayIds).toEqual(seen);
});
