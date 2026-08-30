import { describe, expect, it, vi } from "vitest";

import {
	CodexAppServerClient,
	CodexAppServerJsonlFramer,
	type CodexAppServerTransport,
} from "../../../src/execution/codex-app-server-client";

class FakeTransport implements CodexAppServerTransport {
	readonly pid = 4242;
	readonly writes: unknown[] = [];
	private readonly messageListeners = new Set<(message: unknown) => void>();
	private readonly exitListeners = new Set<
		(event: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
	>();
	private exited = false;

	write(message: unknown): void {
		this.writes.push(message);
	}

	onMessage(listener: (message: unknown) => void): () => void {
		this.messageListeners.add(listener);
		return () => this.messageListeners.delete(listener);
	}

	onExit(listener: (event: { exitCode: number | null; signal: NodeJS.Signals | null }) => void): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	requestStop(): void {
		this.exit();
	}

	async waitForExit(): Promise<boolean> {
		return this.exited;
	}

	emit(message: unknown): void {
		for (const listener of this.messageListeners) listener(message);
	}

	exit(): void {
		if (this.exited) return;
		this.exited = true;
		for (const listener of this.exitListeners) listener({ exitCode: 0, signal: null });
	}
}

function requestAt(transport: FakeTransport, index: number): { id: number; method: string; params: unknown } {
	return transport.writes[index] as { id: number; method: string; params: unknown };
}

function turn(id: string, status: "completed" | "interrupted" | "failed" | "inProgress") {
	return {
		id,
		status,
		startedAt: 1,
		completedAt: status === "inProgress" ? null : 2,
		durationMs: status === "inProgress" ? null : 1,
		error: null,
		items: [],
		itemsView: "summary",
	};
}

describe("CodexAppServerClient", () => {
	it("frames fragmented JSONL and rejects an oversized provider message", () => {
		const framer = new CodexAppServerJsonlFramer(16);
		expect(framer.push(Buffer.from('{"id":'))).toEqual({ lines: [], overflow: false });
		const completed = framer.push(Buffer.from("1}\n"));
		expect(completed.overflow).toBe(false);
		expect(completed.lines.map((line) => line.toString("utf8"))).toEqual(['{"id":1}']);
		expect(framer.push(Buffer.alloc(17, 97))).toEqual({ lines: [], overflow: true });
	});

	it("performs the required initialize handshake before other requests", async () => {
		const transport = new FakeTransport();
		const client = new CodexAppServerClient(transport, { clientVersion: "0.12.3", clientInstanceId: "client-1" });
		const initialized = client.initialize();
		const request = requestAt(transport, 0);
		expect(request).toMatchObject({
			method: "initialize",
			params: {
				clientInfo: { name: "quarterdeck", version: "0.12.3" },
				capabilities: { experimentalApi: true, requestAttestation: false },
			},
		});
		transport.emit({
			id: request.id,
			result: { userAgent: "codex/0.149.1", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" },
		});
		await expect(initialized).resolves.toEqual({ codexHome: "/tmp/codex", userAgent: "codex/0.149.1" });
		expect(transport.writes[1]).toEqual({ method: "initialized" });
	});

	it("does not miss a completion notification that races ahead of the turn/start response", async () => {
		const transport = new FakeTransport();
		const client = new CodexAppServerClient(transport, { clientVersion: "0.12.3" });
		const started = client.startTurn({
			threadId: "thread-1",
			clientUserMessageId: "message-1",
			text: "synthetic",
			cwd: "/tmp/project",
			model: "gpt-test",
			serviceTier: null,
			effort: "high",
			approvalPolicy: "never",
			approvalsReviewer: "user",
			permissions: null,
			sandboxPolicy: {
				type: "workspaceWrite",
				writableRoots: ["/tmp/project"],
				networkAccess: false,
				excludeTmpdirEnvVar: false,
				excludeSlashTmp: false,
			},
			runtimeWorkspaceRoots: ["/tmp/project"],
		});
		const request = requestAt(transport, 0);
		transport.emit({ method: "turn/completed", params: { threadId: "thread-1", turn: turn("turn-1", "completed") } });
		transport.emit({ id: request.id, result: { turn: turn("turn-1", "inProgress") } });
		const response = await started;
		expect(response.status).toBe("inProgress");
		await expect(client.waitForTurnCompletion("turn-1", 10)).resolves.toMatchObject({
			id: "turn-1",
			status: "completed",
		});
	});

	it("waits for the matching turn/started notification before sending an immediate interrupt", async () => {
		const transport = new FakeTransport();
		const client = new CodexAppServerClient(transport, { clientVersion: "0.12.3" });
		const started = client.startTurn({
			threadId: "thread-1",
			clientUserMessageId: "message-interrupt-race",
			text: "synthetic",
			cwd: "/tmp/project",
			model: "gpt-test",
			serviceTier: null,
			effort: "high",
			approvalPolicy: "never",
			approvalsReviewer: "user",
			permissions: null,
			sandboxPolicy: { type: "readOnly", networkAccess: false },
			runtimeWorkspaceRoots: ["/tmp/project"],
		});
		const startRequest = requestAt(transport, 0);
		transport.emit({ id: startRequest.id, result: { turn: turn("turn-race", "inProgress") } });
		await expect(started).resolves.toMatchObject({ id: "turn-race", status: "inProgress" });

		const interrupted = client.interruptTurn("thread-1", "turn-race", 100);
		await Promise.resolve();
		expect(transport.writes).toHaveLength(1);

		transport.emit({
			method: "turn/started",
			params: { threadId: "thread-1", turn: turn("turn-race", "inProgress") },
		});
		await vi.waitFor(() => expect(transport.writes).toHaveLength(2));
		const interruptRequest = requestAt(transport, 1);
		expect(interruptRequest).toMatchObject({
			method: "turn/interrupt",
			params: { threadId: "thread-1", turnId: "turn-race" },
		});
		transport.emit({ id: interruptRequest.id, result: {} });
		await expect(interrupted).resolves.toBeNull();
	});

	it("does not send an interrupt when the matching turn completes before turn/started", async () => {
		const transport = new FakeTransport();
		const client = new CodexAppServerClient(transport, { clientVersion: "0.12.3" });
		const interrupted = client.interruptTurn("thread-1", "turn-completed-race", 100);
		transport.emit({
			method: "turn/completed",
			params: { threadId: "thread-1", turn: turn("turn-completed-race", "completed") },
		});
		await expect(interrupted).resolves.toMatchObject({ id: "turn-completed-race", status: "completed" });
		expect(transport.writes).toHaveLength(0);
	});

	it("does not send a stale interrupt when completion follows turn/started before the waiter continues", async () => {
		const transport = new FakeTransport();
		const client = new CodexAppServerClient(transport, { clientVersion: "0.12.3" });
		const interrupted = client.interruptTurn("thread-1", "turn-started-completed-race", 100);
		transport.emit({
			method: "turn/started",
			params: { threadId: "thread-1", turn: turn("turn-started-completed-race", "inProgress") },
		});
		transport.emit({
			method: "turn/completed",
			params: { threadId: "thread-1", turn: turn("turn-started-completed-race", "completed") },
		});
		await expect(interrupted).resolves.toMatchObject({ id: "turn-started-completed-race", status: "completed" });
		expect(transport.writes).toHaveLength(0);
	});

	it("uses the resumed permission profile and preserves server-owned workspace roots", async () => {
		const transport = new FakeTransport();
		const client = new CodexAppServerClient(transport, { clientVersion: "0.12.3" });
		const started = client.startTurn({
			threadId: "thread-1",
			clientUserMessageId: "message-2",
			text: "synthetic",
			cwd: "/tmp/project",
			model: "gpt-test",
			serviceTier: null,
			effort: "high",
			approvalPolicy: "on-request",
			approvalsReviewer: "user",
			permissions: ":workspace",
			sandboxPolicy: null,
			runtimeWorkspaceRoots: ["/tmp/project", "/tmp/shared"],
		});
		const request = requestAt(transport, 0);
		expect(request).toMatchObject({
			method: "turn/start",
			params: {
				threadId: "thread-1",
				permissions: ":workspace",
				runtimeWorkspaceRoots: ["/tmp/project", "/tmp/shared"],
			},
		});
		expect(request.params).not.toHaveProperty("sandboxPolicy");
		transport.emit({ id: request.id, result: { turn: turn("turn-2", "completed") } });
		await expect(started).resolves.toMatchObject({ id: "turn-2", status: "completed" });
	});

	it("exposes server-owned callback identities and fails unsupported callbacks closed", () => {
		const transport = new FakeTransport();
		const client = new CodexAppServerClient(transport, {
			clientVersion: "0.12.3",
			clientInstanceId: "client-instance",
		});
		const requested: string[] = [];
		const resolved: string[] = [];
		client.onInteractionRequested((interaction) => requested.push(interaction.interactionId));
		client.onInteractionResolved((interaction) => resolved.push(interaction.interactionId));
		transport.emit({
			id: 77,
			method: "item/tool/requestUserInput",
			params: {
				threadId: "thread-1",
				turnId: "turn-1",
				itemId: "item-1",
				questions: [
					{
						id: "question-1",
						header: "Synthetic header",
						question: "Synthetic question?",
						options: [{ label: "Option A", description: "Synthetic description" }],
					},
				],
				isBlocking: true,
				autoResolutionMs: null,
			},
		});
		expect(client.listPendingInteractions()).toEqual([
			{
				interactionId: "client-instance:number:77",
				method: "item/tool/requestUserInput",
				threadId: "thread-1",
				turnId: "turn-1",
				itemId: "item-1",
				kind: "question",
				questionIds: ["question-1"],
				allowedApprovalDecisions: null,
				promptText: "Synthetic header\nSynthetic question?",
				optionLabels: ["Option A"],
				createdAt: expect.any(Number),
			},
		]);
		expect(requested).toEqual(["client-instance:number:77"]);
		expect(client.respondToInteraction("client-instance:number:77", { answers: {} })).toBe(true);
		expect(transport.writes[0]).toEqual({ id: 77, result: { answers: {} } });
		expect(resolved).toEqual(["client-instance:number:77"]);

		transport.emit({ id: 78, method: "account/chatgptAuthTokens/refresh", params: {} });
		expect(transport.writes[1]).toEqual({
			id: 78,
			error: { code: -32601, message: "Quarterdeck does not support this app-server callback." },
		});

		transport.emit({
			id: 79,
			method: "item/commandExecution/requestApproval",
			params: {
				threadId: "thread-1",
				turnId: "turn-1",
				itemId: "item-2",
				startedAtMs: 1,
				environmentId: null,
				availableDecisions: [
					"accept",
					"decline",
					{ acceptWithExecpolicyAmendment: { proposedExecpolicyAmendment: [] } },
				],
			},
		});
		expect(client.listPendingInteractions()).toEqual([
			expect.objectContaining({
				interactionId: "client-instance:number:79",
				kind: "approval",
				itemId: "item-2",
				allowedApprovalDecisions: ["accept", "decline"],
				optionLabels: ["accept", "decline"],
				promptText: null,
			}),
		]);

		transport.emit({
			id: 80,
			method: "item/tool/requestUserInput",
			params: { threadId: "thread-1", turnId: "turn-1" },
		});
		expect(transport.writes[2]).toEqual({
			id: 80,
			error: { code: -32602, message: "Invalid callback identity." },
		});

		transport.emit({
			method: "serverRequest/resolved",
			params: { threadId: "thread-1", requestId: 79 },
		});
		expect(client.listPendingInteractions()).toEqual([]);
		expect(resolved).toEqual(["client-instance:number:77", "client-instance:number:79"]);

		transport.emit({
			id: 81,
			method: "item/tool/requestUserInput",
			params: {
				threadId: "thread-1",
				turnId: "turn-1",
				itemId: "item-3",
				questions: Array.from({ length: 65 }, (_, index) => ({
					id: `question-${index}`,
					header: "Synthetic",
					question: "Synthetic",
					isOther: false,
					isSecret: false,
					options: null,
				})),
				isBlocking: true,
				autoResolutionMs: null,
			},
		});
		expect(transport.writes[3]).toEqual({
			id: 81,
			error: { code: -32602, message: "Invalid callback identity." },
		});
	});

	it("bounds retained MCP elicitation presentation by UTF-8 bytes", () => {
		const transport = new FakeTransport();
		const client = new CodexAppServerClient(transport, {
			clientVersion: "0.12.3",
			clientInstanceId: "bounded-presentation",
		});
		transport.emit({
			id: 82,
			method: "mcpServer/elicitation/request",
			params: {
				threadId: "thread-1",
				turnId: "turn-1",
				serverName: "synthetic-server",
				mode: "form",
				_meta: null,
				message: "🙂".repeat(8_000),
				requestedSchema: {},
			},
		});

		const interaction = client.listPendingInteractions()[0];
		expect(interaction).toMatchObject({
			interactionId: "bounded-presentation:number:82",
			kind: "elicitation",
		});
		expect(Buffer.byteLength(interaction?.promptText ?? "", "utf8")).toBeLessThanOrEqual(16 * 1024);
	});

	it("bounds pending provider callbacks and rejects duplicate connection identities", () => {
		const transport = new FakeTransport();
		const client = new CodexAppServerClient(transport, {
			clientVersion: "0.12.3",
			clientInstanceId: "bounded-client",
		});
		const callback = (id: number) => ({
			id,
			method: "item/tool/requestUserInput",
			params: {
				threadId: "thread-1",
				turnId: "turn-1",
				itemId: `item-${id}`,
				questions: [],
				isBlocking: true,
				autoResolutionMs: null,
			},
		});

		transport.emit(callback(1));
		transport.emit(callback(1));
		expect(transport.writes[0]).toEqual({
			id: 1,
			error: { code: -32600, message: "Duplicate callback identity." },
		});
		for (let id = 2; id <= 128; id += 1) transport.emit(callback(id));
		transport.emit(callback(129));
		expect(client.listPendingInteractions()).toHaveLength(128);
		expect(transport.writes[1]).toEqual({
			id: 129,
			error: { code: -32000, message: "Too many pending app-server callbacks." },
		});
	});

	it("rejects a provider callback identity that the interaction API cannot address", () => {
		const transport = new FakeTransport();
		const client = new CodexAppServerClient(transport, {
			clientVersion: "0.12.3",
			clientInstanceId: "bounded-client",
		});
		const oversizedRequestId = "x".repeat(513);
		transport.emit({
			id: oversizedRequestId,
			method: "item/tool/requestUserInput",
			params: {
				threadId: "thread-1",
				turnId: "turn-1",
				itemId: "item-oversized-id",
				questions: [],
				isBlocking: true,
				autoResolutionMs: null,
			},
		});

		expect(client.listPendingInteractions()).toEqual([]);
		expect(transport.writes).toEqual([
			{
				id: oversizedRequestId,
				error: { code: -32602, message: "Invalid callback identity." },
			},
		]);
	});

	it("ignores malformed turn notifications without throwing", () => {
		const transport = new FakeTransport();
		new CodexAppServerClient(transport, { clientVersion: "0.12.3" });

		expect(() => transport.emit({ method: "turn/completed", params: { threadId: "thread-1" } })).not.toThrow();
	});

	it("notifies an exit listener registered after the transport has exited", async () => {
		const transport = new FakeTransport();
		const client = new CodexAppServerClient(transport, { clientVersion: "0.12.3" });
		transport.exit();
		let observed = false;
		client.onExit(() => {
			observed = true;
		});
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		expect(observed).toBe(true);
	});
});
