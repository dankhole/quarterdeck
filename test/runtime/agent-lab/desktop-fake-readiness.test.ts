import { describe, expect, it } from "vitest";

import {
	assertDesktopFakeProcessOwnership,
	projectDesktopFakeReadiness,
	projectDesktopFakeReadinessDiagnostic,
} from "../../../scripts/agent-lab/desktop-fake-readiness";
import type { DesktopLabProcess } from "../../../scripts/agent-lab/desktop-types";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api/task-session";

function session() {
	return runtimeTaskSessionSummarySchema.parse({
		taskId: "task",
		agentId: "codex",
		sessionInstanceId: "current-launch",
		resumeSessionId: "agent-lab-task",
		state: "awaiting_review",
		pid: 50002,
		startedAt: 1,
		updatedAt: 2,
		lastOutputAt: 2,
		reviewReason: null,
		exitCode: null,
		latestHookActivity: { finalMessage: "private content", transcriptPath: "/private/session" },
		recentProviderHookOrderObservations: [
			{
				event: "activity",
				deliveryId: "22222222-2222-4222-8222-222222222222",
				occurredAt: 2,
				source: "codex",
				sessionInstanceId: "current-launch",
				providerSessionId: "agent-lab-task",
				hookEventName: "SessionStart",
				notificationType: null,
				turnId: null,
				promptId: null,
				toolUseId: null,
				elicitationId: null,
				toolName: null,
			},
		],
	});
}

const helper: DesktopLabProcess = { pid: 50000, parentPid: 49999, startedAt: "helper birth", command: "owned helper" };
const child: DesktopLabProcess = { pid: 50001, parentPid: 50000, startedAt: "shell birth", command: "shell" };
const agent: DesktopLabProcess = { pid: 50002, parentPid: 50001, startedAt: "agent birth", command: "fake agent" };

describe("packaged fake-agent readiness", () => {
	it("retains typed hook and process identities for diagnosis without activity or transcript content", () => {
		const diagnostic = projectDesktopFakeReadinessDiagnostic(session());
		expect(diagnostic).toMatchObject({
			taskId: "task",
			pid: agent.pid,
			sessionInstanceId: "current-launch",
			hooks: [{ hookEventName: "SessionStart" }],
		});
		expect(JSON.stringify(diagnostic)).not.toContain("private");
		expect(JSON.stringify(diagnostic)).not.toContain("finalMessage");
		expect(JSON.stringify(diagnostic)).not.toContain("transcriptPath");
	});

	it("uses current-launch startup metadata without asserting work or exposing content", () => {
		const ready = projectDesktopFakeReadiness(session(), "task");
		expect(ready).toMatchObject({ taskId: "task", pid: agent.pid, sessionInstanceId: "current-launch" });
		expect(JSON.stringify(ready)).not.toContain("private");
		expect(JSON.stringify(ready)).not.toContain("state");
	});

	it.each([
		{ taskId: "other-task" },
		{ agentId: "claude" as const },
		{ sessionInstanceId: null },
		{ resumeSessionId: "other-provider-session" },
		{ pid: null },
		{ pid: 0 },
	])("rejects a missing or mismatched launch identity: %j", (change) => {
		expect(projectDesktopFakeReadiness({ ...session(), ...change }, "task")).toBeNull();
	});

	it.each([
		{ sessionInstanceId: "old-launch" },
		{ source: "claude" as const },
		{ event: "to_in_progress" as const },
		{ hookEventName: "Stop" },
		{ providerSessionId: "other-provider-session" },
	])("rejects a historical or unrelated hook: %j", (change) => {
		const summary = session();
		const hook = summary.recentProviderHookOrderObservations[0];
		if (!hook) throw new Error("Missing test hook.");
		expect(
			projectDesktopFakeReadiness(
				{ ...summary, recentProviderHookOrderObservations: [{ ...hook, ...change }] },
				"task",
			),
		).toBeNull();
	});

	it("requires a live descendant of the exact captured helper", () => {
		expect(assertDesktopFakeProcessOwnership(agent.pid, helper, [helper, child, agent])).toEqual(agent);
		expect(() => assertDesktopFakeProcessOwnership(agent.pid, helper, [helper, agent])).toThrow("descendant");
		expect(() => assertDesktopFakeProcessOwnership(helper.pid, helper, [helper, child, agent])).toThrow("descendant");
		expect(() => assertDesktopFakeProcessOwnership(agent.pid, helper, [child, agent])).toThrow("helper identity");
		expect(() =>
			assertDesktopFakeProcessOwnership(agent.pid, helper, [{ ...helper, startedAt: "reused PID" }, child, agent]),
		).toThrow("helper identity");
		expect(() =>
			assertDesktopFakeProcessOwnership(agent.pid, helper, [{ ...helper, command: "different argv" }, child, agent]),
		).toThrow("helper identity");
	});
});
