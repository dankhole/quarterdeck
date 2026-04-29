import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardData, RuntimeProjectStateResponse, RuntimeTaskSessionSummary } from "../../../src/core";
import type { TerminalSessionManager } from "../../../src/terminal";
import { polishTaskDisplaySummary } from "../../../src/trpc";
import { createDefaultMockConfig } from "../../utilities/runtime-config-factory";

const LLM_ENV = {
	QUARTERDECK_LLM_BASE_URL: "https://llm.example.test",
	QUARTERDECK_LLM_API_KEY: "test-key",
	QUARTERDECK_LLM_MODEL: "bedrock/us.anthropic.claude-3-5-haiku-20241022-v1:0",
} as const;

const originalEnv = {
	QUARTERDECK_LLM_BASE_URL: process.env.QUARTERDECK_LLM_BASE_URL,
	QUARTERDECK_LLM_API_KEY: process.env.QUARTERDECK_LLM_API_KEY,
	QUARTERDECK_LLM_MODEL: process.env.QUARTERDECK_LLM_MODEL,
};

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		sessionLaunchPath: "/tmp/repo/.quarterdeck/worktrees/task-1",
		resumeSessionId: null,
		pid: 1234,
		startedAt: 100,
		updatedAt: 100,
		lastOutputAt: 100,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		stalledSince: null,
		warningMessage: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		conversationSummaries: [],
		displaySummary: null,
		displaySummaryGeneratedAt: null,
		...overrides,
	};
}

function createBoard(prompt: string): RuntimeBoardData {
	return {
		columns: [
			{
				id: "in_progress",
				title: "In Progress",
				cards: [
					{
						id: "task-1",
						title: null,
						prompt,
						baseRef: "main",
						createdAt: 100,
						updatedAt: 100,
					},
				],
			},
		],
		dependencies: [],
	};
}

function createProjectState(prompt = "Fix auth timeout bug"): RuntimeProjectStateResponse {
	return {
		repoPath: "/tmp/repo",
		statePath: "/tmp/repo/.quarterdeck/state.json",
		git: {
			currentBranch: "main",
			defaultBranch: "main",
			branches: ["main"],
		},
		board: createBoard(prompt),
		sessions: {},
		revision: 1,
	};
}

function createManager(summary: RuntimeTaskSessionSummary): {
	manager: TerminalSessionManager;
	setDisplaySummary: ReturnType<typeof vi.fn>;
	updateSummary: (patch: Partial<RuntimeTaskSessionSummary>) => void;
} {
	let currentSummary = { ...summary };
	const setDisplaySummary = vi.fn((taskId: string, text: string, generatedAt: number | null) => {
		currentSummary.taskId = taskId;
		currentSummary.displaySummary = text;
		currentSummary.displaySummaryGeneratedAt = generatedAt;
		return { ...currentSummary };
	});
	const manager = {
		store: {
			getSummary: vi.fn(() => ({ ...currentSummary })),
			setDisplaySummary,
		},
	} as unknown as TerminalSessionManager;
	return {
		manager,
		setDisplaySummary,
		updateSummary: (patch) => {
			currentSummary = { ...currentSummary, ...patch };
		},
	};
}

function stubLlmResponse(text: string): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async () => {
		return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function createLlmResponse(text: string): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("polishTaskDisplaySummary", () => {
	beforeEach(() => {
		process.env.QUARTERDECK_LLM_BASE_URL = LLM_ENV.QUARTERDECK_LLM_BASE_URL;
		process.env.QUARTERDECK_LLM_API_KEY = LLM_ENV.QUARTERDECK_LLM_API_KEY;
		process.env.QUARTERDECK_LLM_MODEL = LLM_ENV.QUARTERDECK_LLM_MODEL;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it("does nothing when LLM summary polish is disabled", async () => {
		const fetchMock = stubLlmResponse("Polished auth timeout");
		const { manager, setDisplaySummary } = createManager(createSummary());

		const result = await polishTaskDisplaySummary({
			projectScope: { projectId: "project-1", projectPath: "/tmp/repo" },
			taskId: "task-1",
			reason: "test",
			deps: {
				config: { loadScopedRuntimeConfig: vi.fn(async () => createDefaultMockConfig()) },
				getScopedTerminalManager: vi.fn(async () => manager),
				loadProjectState: vi.fn(async () => createProjectState()),
			},
		});

		expect(result).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(setDisplaySummary).not.toHaveBeenCalled();
	});

	it("polishes the initial prompt when no conversation summaries exist", async () => {
		stubLlmResponse("Polished auth timeout");
		const { manager, setDisplaySummary } = createManager(createSummary());

		const result = await polishTaskDisplaySummary({
			projectScope: { projectId: "project-1", projectPath: "/tmp/repo" },
			taskId: "task-1",
			reason: "task-started",
			promptOverride: "Fix auth timeout bug",
			deps: {
				config: {
					loadScopedRuntimeConfig: vi.fn(async () => createDefaultMockConfig({ llmSummaryPolishEnabled: true })),
				},
				getScopedTerminalManager: vi.fn(async () => manager),
				loadProjectState: vi.fn(async () => createProjectState()),
				now: () => 1234,
			},
		});

		expect(result).toBe("Polished auth timeout");
		expect(setDisplaySummary).toHaveBeenCalledWith("task-1", "Polished auth timeout", 1234);
	});

	it("skips generation when the stored LLM summary is newer than the source", async () => {
		const fetchMock = stubLlmResponse("Polished auth timeout");
		const { manager, setDisplaySummary } = createManager(
			createSummary({
				conversationSummaries: [{ text: "Fixed auth timeout", capturedAt: 100, sessionIndex: 0 }],
				displaySummary: "Fixed auth timeout",
				displaySummaryGeneratedAt: 200,
			}),
		);

		const result = await polishTaskDisplaySummary({
			projectScope: { projectId: "project-1", projectPath: "/tmp/repo" },
			taskId: "task-1",
			reason: "hook.to_review",
			deps: {
				config: {
					loadScopedRuntimeConfig: vi.fn(async () => createDefaultMockConfig({ llmSummaryPolishEnabled: true })),
				},
				getScopedTerminalManager: vi.fn(async () => manager),
				loadProjectState: vi.fn(async () => createProjectState()),
			},
		});

		expect(result).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(setDisplaySummary).not.toHaveBeenCalled();
	});

	it("regenerates when a newer conversation summary arrives", async () => {
		stubLlmResponse("Polished review summary");
		const { manager, setDisplaySummary } = createManager(
			createSummary({
				conversationSummaries: [{ text: "Finished review changes", capturedAt: 300, sessionIndex: 0 }],
				displaySummary: "Old summary",
				displaySummaryGeneratedAt: 200,
			}),
		);

		const result = await polishTaskDisplaySummary({
			projectScope: { projectId: "project-1", projectPath: "/tmp/repo" },
			taskId: "task-1",
			reason: "hook.to_review",
			deps: {
				config: {
					loadScopedRuntimeConfig: vi.fn(async () => createDefaultMockConfig({ llmSummaryPolishEnabled: true })),
				},
				getScopedTerminalManager: vi.fn(async () => manager),
				loadProjectState: vi.fn(async () => createProjectState()),
				now: () => 400,
			},
		});

		expect(result).toBe("Polished review summary");
		expect(setDisplaySummary).toHaveBeenCalledWith("task-1", "Polished review summary", 400);
	});

	it("uses newer final message text even when older conversation summaries exist", async () => {
		const fetchMock = stubLlmResponse("Polished final message");
		const { manager, setDisplaySummary } = createManager(
			createSummary({
				conversationSummaries: [{ text: "Older review summary", capturedAt: 100, sessionIndex: 0 }],
				displaySummary: "Older review summary",
				displaySummaryGeneratedAt: 200,
				lastHookAt: 300,
				latestHookActivity: {
					activityText: null,
					toolName: null,
					toolInputSummary: null,
					finalMessage: "New final message text",
					hookEventName: "Stop",
					notificationType: null,
					source: "codex",
					conversationSummaryText: null,
				},
			}),
		);

		const result = await polishTaskDisplaySummary({
			projectScope: { projectId: "project-1", projectPath: "/tmp/repo" },
			taskId: "task-1",
			reason: "hook.to_review",
			deps: {
				config: {
					loadScopedRuntimeConfig: vi.fn(async () => createDefaultMockConfig({ llmSummaryPolishEnabled: true })),
				},
				getScopedTerminalManager: vi.fn(async () => manager),
				loadProjectState: vi.fn(async () => createProjectState()),
				now: () => 400,
			},
		});

		const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
			messages: Array<{ role: string; content: string }>;
		};
		const userPrompt = body.messages.find((message) => message.role === "user")?.content ?? "";
		expect(userPrompt).toContain("Most recent agent summary:\nNew final message text");
		expect(result).toBe("Polished final message");
		expect(setDisplaySummary).toHaveBeenCalledWith("task-1", "Polished final message", 400);
	});

	it("discards stale in-flight polish and reruns a pending request with the newer source", async () => {
		let resolveFirstResponse: (response: Response) => void = () => {
			throw new Error("First LLM response resolver was not initialized.");
		};
		const firstResponse = new Promise<Response>((resolve) => {
			resolveFirstResponse = resolve;
		});
		const fetchMock = vi
			.fn()
			.mockReturnValueOnce(firstResponse)
			.mockResolvedValueOnce(createLlmResponse("Polished conversation summary"));
		vi.stubGlobal("fetch", fetchMock);
		const { manager, setDisplaySummary, updateSummary } = createManager(createSummary());
		const deps = {
			config: {
				loadScopedRuntimeConfig: vi.fn(async () => createDefaultMockConfig({ llmSummaryPolishEnabled: true })),
			},
			getScopedTerminalManager: vi.fn(async () => manager),
			loadProjectState: vi.fn(async () => createProjectState()),
			scheduleBackgroundTask: (task: () => void) => task(),
			now: vi.fn(() => 500),
		};

		const firstPolish = polishTaskDisplaySummary({
			projectScope: { projectId: "project-1", projectPath: "/tmp/repo" },
			taskId: "task-1",
			reason: "task-started",
			promptOverride: "Fix auth timeout bug",
			deps,
		});
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

		updateSummary({
			conversationSummaries: [{ text: "Finished auth timeout fix", capturedAt: 300, sessionIndex: 0 }],
			displaySummary: "Finished auth timeout fix",
			displaySummaryGeneratedAt: null,
		});

		const duplicateResult = await polishTaskDisplaySummary({
			projectScope: { projectId: "project-1", projectPath: "/tmp/repo" },
			taskId: "task-1",
			reason: "hook.to_review",
			deps,
		});
		expect(duplicateResult).toBeNull();

		resolveFirstResponse(createLlmResponse("Stale prompt summary"));
		const firstResult = await firstPolish;
		expect(firstResult).toBeNull();

		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		await vi.waitFor(() =>
			expect(setDisplaySummary).toHaveBeenCalledWith("task-1", "Polished conversation summary", 500),
		);
		expect(setDisplaySummary).not.toHaveBeenCalledWith("task-1", "Stale prompt summary", 500);
	});
});
