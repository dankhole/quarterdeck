import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectDesktopFakeReadiness } from "../../../scripts/agent-lab/desktop-fake-readiness";
import { readDesktopTaskSession } from "../../../scripts/agent-lab/desktop-session-evidence";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api/task-session";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(payload: unknown) {
	const root = await mkdtemp(join(tmpdir(), "desktop-session-evidence-"));
	roots.push(root);
	const project = join(root, "projects", "synthetic-project");
	await mkdir(project, { recursive: true });
	await writeFile(join(project, "sessions.json"), JSON.stringify(payload));
	return root;
}

function session() {
	return runtimeTaskSessionSummarySchema.parse({
		taskId: "task",
		agentId: "codex",
		sessionInstanceId: "launch",
		resumeSessionId: "agent-lab-task",
		state: "running",
		pid: 50002,
		startedAt: 1,
		updatedAt: 2,
		lastOutputAt: 2,
		reviewReason: null,
		exitCode: null,
		recentProviderHookOrderObservations: [
			{
				event: "activity",
				deliveryId: "22222222-2222-4222-8222-222222222222",
				occurredAt: 2,
				source: "codex",
				sessionInstanceId: "launch",
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

describe("desktop persisted session evidence", () => {
	it("reads the production flat task-keyed sessions file with its current native startup hook", async () => {
		const expected = session();
		const actual = await readDesktopTaskSession(await fixture({ task: expected }), "task");
		expect(actual).toEqual(expected);
		expect(actual && projectDesktopFakeReadiness(actual, "task")).toMatchObject({
			sessionInstanceId: "launch",
			pid: 50002,
		});
	});

	it("does not mistake the enclosing save payload for the persisted file", async () => {
		expect(await readDesktopTaskSession(await fixture({ sessions: { task: session() } }), "task")).toBeNull();
	});

	it.each([{ task: { ...session(), taskId: "other" } }, { task: { pid: 50002 } }, { other: session() }])(
		"rejects mismatched, invalid, or absent task summaries",
		async (payload) => {
			expect(await readDesktopTaskSession(await fixture(payload), "task")).toBeNull();
		},
	);

	it("keeps persisted session reads bounded", async () => {
		const root = await fixture({});
		await writeFile(join(root, "projects", "synthetic-project", "sessions.json"), "x".repeat(2 * 1024 * 1024 + 1));
		await expect(readDesktopTaskSession(root, "task")).rejects.toThrow("exceeds its bound");
	});
});
