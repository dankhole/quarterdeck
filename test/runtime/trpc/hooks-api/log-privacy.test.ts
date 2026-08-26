import { afterEach, describe, expect, it, vi } from "vitest";

import { _resetLoggerForTests, type RuntimeDiagnosticLogSink, setRuntimeDiagnosticLogSink } from "../../../../src/core";
import { createMockManager, createSummary, createTestApi } from "./_helpers";

type LogCandidate = Parameters<RuntimeDiagnosticLogSink["recordLog"]>[0];

afterEach(() => {
	_resetLoggerForTests();
	vi.restoreAllMocks();
});

describe("createHooksApi — content-safe logging", () => {
	it("logs provider correlation identities as presence metadata instead of raw values", async () => {
		const candidates: LogCandidate[] = [];
		setRuntimeDiagnosticLogSink({ recordLog: (candidate) => candidates.push(candidate) });
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running", agentId: "claude" })),
		});
		const api = createTestApi(manager);

		await expect(
			api.ingest({
				taskId: "task-1",
				projectId: "project-1",
				event: "activity",
				metadata: {
					source: "claude",
					hookEventName: "PreToolUse",
					sessionId: "sentinel-private-provider-session",
					sessionInstanceId: "sentinel-private-session-instance",
					turnId: "sentinel-private-turn",
					promptId: "sentinel-private-prompt",
					toolUseId: "sentinel-private-tool",
					elicitationId: "sentinel-private-elicitation",
					providerAgentId: "sentinel-private-background-agent",
				},
			}),
		).resolves.toEqual({ ok: true });

		const serialized = JSON.stringify(candidates);
		expect(serialized).not.toContain("sentinel-private");
		expect(candidates).toContainEqual(
			expect.objectContaining({
				tag: "hooks",
				message: "Hook ingest received",
				data: expect.objectContaining({
					hasSessionId: true,
					hasSessionInstanceId: true,
					hasTurnId: true,
					hasPromptId: true,
					hasToolUseId: true,
					hasElicitationId: true,
					hasProviderAgentId: true,
				}),
			}),
		);
	});

	it("keeps hook persistence failures out of logs while returning the actionable error", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const candidates: LogCandidate[] = [];
		setRuntimeDiagnosticLogSink({ recordLog: (candidate) => candidates.push(candidate) });
		const manager = createMockManager({
			getSummary: vi.fn(() => createSummary({ state: "running", agentId: "codex" })),
		});
		const api = createTestApi(manager, {
			persistSessionState: vi.fn(async () => {
				throw new Error("sentinel-private-persistence-failure");
			}),
		});

		await expect(
			api.ingest({
				taskId: "task-1",
				projectId: "project-1",
				event: "to_review",
				metadata: { source: "codex", hookEventName: "Stop" },
			}),
		).resolves.toEqual({ ok: false, error: "sentinel-private-persistence-failure" });

		expect(JSON.stringify(candidates)).not.toContain("sentinel-private");
		expect(candidates).toContainEqual(
			expect.objectContaining({
				tag: "hooks",
				message: "Hook ingest crashed",
				data: { errorClass: "Error" },
			}),
		);
	});
});
