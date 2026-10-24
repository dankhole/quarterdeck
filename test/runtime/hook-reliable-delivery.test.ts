import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHookIngestRequest } from "../../src/commands/hook-metadata.js";
import type { RuntimeHookIngestRequest } from "../../src/core/api/task-session.js";
import {
	abandonPublishedHook,
	CODEX_INTERRUPT_TOTAL_TIMEOUT_MS,
	deliverPublishedHook,
	ingestHookRequest,
	publishReliableHook,
} from "../../src/hook-reliable-delivery.js";
import * as outbox from "../../src/hook-transition-outbox-core.js";
import { postHookRuntimeJson } from "../../src/hooks-runtime-http.js";

vi.mock("../../src/hooks-runtime-http.js", { spy: true });
vi.mock("../../src/hook-transition-outbox-core.js", { spy: true });

let stateHome: string;
const delivery = { id: "00000000-0000-4000-8000-000000000001", occurredAt: 100 };
function request(): RuntimeHookIngestRequest {
	return {
		taskId: "task-1",
		projectId: "project-1",
		event: "to_review",
		metadata: {
			source: "pi",
			sessionInstanceId: "launch-1",
			sessionId: "session-1",
			promptId: "run-1",
			hookEventName: "AgentSettled",
			finalMessage: "# Reply\n\n- preserved indentation\n  nested",
			activityText: "private activity",
			transcriptPath: "/private/transcript.jsonl",
		},
		delivery: { ...delivery },
	};
}
async function record() {
	return JSON.parse(await readFile(outbox.getOutboxRecordPath(delivery.id), "utf8"));
}

beforeEach(async () => {
	stateHome = await mkdtemp(join(tmpdir(), "quarterdeck-reliable-delivery-"));
	vi.stubEnv("QUARTERDECK_STATE_HOME", stateHome);
	vi.mocked(postHookRuntimeJson).mockResolvedValue({
		status: 200,
		body: JSON.stringify({ result: { data: { ok: true } } }),
	});
});

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(stateHome, { recursive: true, force: true });
});

describe("in-process reliable hook publication and delivery", () => {
	it("captures UUID/time during normalization and retains them through delayed publication", async () => {
		const capturedAt = Date.now();
		const captured = buildHookIngestRequest({
			event: "to_in_progress",
			identity: { taskId: "task-1", projectId: "project-1", sessionInstanceId: "launch-1" },
			flagMetadata: { source: "pi", hookEventName: "AgentStart", promptId: "run-1" },
			payload: null,
		});
		expect(captured.delivery?.occurredAt).toBeGreaterThanOrEqual(capturedAt);
		expect(captured.delivery?.id).toMatch(/^[0-9a-f-]{36}$/u);
		const originalDelivery = { ...captured.delivery };
		const publication = await publishReliableHook(captured);
		expect(publication.request.delivery).toEqual(originalDelivery);
		expect(postHookRuntimeJson).not.toHaveBeenCalled();
		await deliverPublishedHook(publication);
		expect(JSON.parse(vi.mocked(postHookRuntimeJson).mock.calls[0]?.[1] ?? "{}").delivery).toEqual(originalDelivery);
	});

	it("publishes before network, snapshots caller identity/reply, and removes only on acknowledgement", async () => {
		const input = request();
		const publicationPromise = publishReliableHook(input);
		if (input.metadata) input.metadata.promptId = "later-run";
		if (input.delivery) input.delivery.occurredAt = 999;
		const publication = await publicationPromise;
		expect(Object.isFrozen(publication.request)).toBe(true);
		expect(Object.isFrozen(publication.request.metadata)).toBe(true);
		expect(Object.isFrozen(publication.request.delivery)).toBe(true);
		expect(postHookRuntimeJson).not.toHaveBeenCalled();
		expect(await record()).toMatchObject({ request: { delivery, metadata: { promptId: "run-1" } } });
		vi.mocked(postHookRuntimeJson).mockImplementationOnce(async (_url, raw) => {
			expect(await record()).toMatchObject({ request: { delivery } });
			expect(JSON.parse(raw)).toMatchObject({
				metadata: { promptId: "run-1", activityText: "private activity" },
				delivery,
			});
			return { status: 200, body: '{"result":{"data":{"ok":true}}}' };
		});
		await expect(deliverPublishedHook(publication)).resolves.toEqual({ status: "acknowledged" });
		await expect(stat(outbox.getOutboxRecordPath(delivery.id))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("sends only the normalized request envelope, not CLI payload extras", async () => {
		const input = { ...request(), payload: { private: "provider payload" } };
		await ingestHookRequest(input);
		const raw = vi.mocked(postHookRuntimeJson).mock.calls[0]?.[1] ?? "";
		expect(raw).not.toContain("provider payload");
		expect(JSON.parse(raw)).toEqual(request());
	});

	it("preserves existing bounded private reply policy and strips unrelated content", async () => {
		const input = request();
		await publishReliableHook(input);
		const raw = await readFile(outbox.getOutboxRecordPath(delivery.id), "utf8");
		expect(raw).not.toContain("private activity");
		expect(raw).not.toContain("transcript.jsonl");
		if (process.platform !== "win32") {
			expect((await record()).request.metadata.finalMessage).toBe(input.metadata?.finalMessage);
			expect((await stat(outbox.getOutboxRecordPath(delivery.id))).mode & 0o777).toBe(0o600);
			expect((await stat(outbox.getOutboxDirectoryPath())).mode & 0o777).toBe(0o700);
		} else {
			// No runtime-prepared private-directory capability in this fixture.
			expect((await record()).request.metadata.finalMessage).toBeUndefined();
		}
	});

	it("rejects unsupported or failed local publication without claiming durability or sending", async () => {
		await expect(publishReliableHook({ ...request(), delivery: undefined })).rejects.toThrow("captured delivery");
		await expect(publishReliableHook({ ...request(), metadata: { source: "pi" } })).rejects.toThrow("replayable");
		const blocked = join(stateHome, "not-a-directory");
		await writeFile(blocked, "synthetic");
		vi.stubEnv("QUARTERDECK_STATE_HOME", blocked);
		await expect(publishReliableHook(request())).rejects.toThrow();
		expect(postHookRuntimeJson).not.toHaveBeenCalled();
	});

	it("retries the identical envelope and abandons rejected delivery for replay", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const publication = await publishReliableHook(request());
		vi.mocked(postHookRuntimeJson).mockResolvedValue({ status: 200, body: '{"result":{"data":{"ok":false}}}' });
		await expect(deliverPublishedHook(publication)).resolves.toMatchObject({ status: "deferred" });
		const calls = vi.mocked(postHookRuntimeJson).mock.calls;
		expect(calls).toHaveLength(2);
		expect(calls[0]?.[1]).toBe(calls[1]?.[1]);
		expect(await record()).toMatchObject({ abandonedAt: expect.any(Number), request: { delivery } });
		expect(stderr).not.toHaveBeenCalled();
	});

	it("keeps opt-in diagnostics content-free even when the server failure includes private content", async () => {
		const publication = await publishReliableHook(request());
		const onDiagnostic = vi.fn();
		vi.mocked(postHookRuntimeJson).mockResolvedValue({
			status: 200,
			body: JSON.stringify({ result: { data: { ok: false, error: "private reply" } } }),
		});
		await expect(deliverPublishedHook(publication, { onDiagnostic })).resolves.toMatchObject({ status: "deferred" });
		expect(onDiagnostic).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(onDiagnostic.mock.calls)).not.toMatch(/private|Reply|run-1|session-1|launch-1/u);
	});

	it("aborts an in-flight attempt without waiting for its retry budget, retaining published records", async () => {
		const publication = await publishReliableHook(request());
		const controller = new AbortController();
		let markStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		vi.mocked(postHookRuntimeJson).mockImplementationOnce(
			(_url, _raw, signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					markStarted();
				}),
		);
		const pending = deliverPublishedHook(publication, { signal: controller.signal });
		await started;
		controller.abort(new Error("synthetic shutdown"));
		await expect(pending).resolves.toMatchObject({ status: "deferred" });
		expect(postHookRuntimeJson).toHaveBeenCalledOnce();
		expect(vi.mocked(postHookRuntimeJson).mock.calls[0]?.[2].aborted).toBe(true);
		expect(await record()).toMatchObject({ abandonedAt: expect.any(Number) });
	});

	it("aborts retry backoff without starting another request", async () => {
		const publication = await publishReliableHook(request());
		const controller = new AbortController();
		vi.mocked(postHookRuntimeJson).mockResolvedValue({ status: 200, body: '{"result":{"data":{"ok":false}}}' });
		let markRetry: () => void = () => {};
		const retrying = new Promise<void>((resolve) => {
			markRetry = resolve;
		});
		const pending = deliverPublishedHook(publication, { signal: controller.signal, onDiagnostic: markRetry });
		await retrying;
		controller.abort();
		await expect(pending).resolves.toMatchObject({ status: "deferred" });
		expect(postHookRuntimeJson).toHaveBeenCalledOnce();
		expect(await record()).toMatchObject({ abandonedAt: expect.any(Number) });
	});

	it("abandons queued handles and already-aborted delivery without making a network request", async () => {
		const publication = await publishReliableHook(request());
		await abandonPublishedHook(publication);
		const controller = new AbortController();
		controller.abort();
		await expect(deliverPublishedHook(publication, { signal: controller.signal })).resolves.toMatchObject({
			status: "deferred",
		});
		expect(postHookRuntimeJson).not.toHaveBeenCalled();
		expect(await record()).toMatchObject({ abandonedAt: expect.any(Number), request: { delivery } });
	});

	it("finishes acknowledgement safely when shutdown aborts during cleanup", async () => {
		const publication = await publishReliableHook(request());
		const controller = new AbortController();
		const acknowledge = outbox.acknowledgeHookTransition;
		vi.mocked(outbox.acknowledgeHookTransition).mockImplementationOnce(async (id) => {
			controller.abort(new Error("shutdown after network acknowledgement"));
			await acknowledge(id);
		});
		await expect(deliverPublishedHook(publication, { signal: controller.signal })).resolves.toEqual({
			status: "acknowledged",
		});
		await expect(stat(outbox.getOutboxRecordPath(delivery.id))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("keeps a recovery copy and reports storage failures during ack and abandon", async () => {
		const publication = await publishReliableHook(request());
		const error = new Error("synthetic ack failure");
		const abandonError = new Error("synthetic abandon failure");
		vi.mocked(outbox.acknowledgeHookTransition).mockRejectedValueOnce(error);
		vi.mocked(outbox.abandonHookTransition).mockRejectedValueOnce(abandonError);
		await expect(deliverPublishedHook(publication)).resolves.toEqual({ status: "deferred", error, abandonError });
		expect(await record()).toMatchObject({ request: { delivery } });
	});

	it("limits Codex Interrupt HTTP to 2400ms, leaving 600ms native startup/publication headroom", async () => {
		const input = request();
		input.metadata = { source: "codex", hookEventName: "Interrupt", sessionInstanceId: "launch-1", turnId: "turn-1" };
		const publication = await publishReliableHook(input);
		vi.useFakeTimers();
		vi.mocked(postHookRuntimeJson).mockImplementation(
			(_url, _raw, signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		);
		const startedAt = Date.now();
		const pending = deliverPublishedHook(publication);
		await vi.advanceTimersByTimeAsync(CODEX_INTERRUPT_TOTAL_TIMEOUT_MS);
		await expect(pending).resolves.toMatchObject({ status: "deferred" });
		expect(Date.now() - startedAt).toBe(2400);
		expect(postHookRuntimeJson).toHaveBeenCalledTimes(2);
		expect(vi.mocked(postHookRuntimeJson).mock.calls.every((call) => call[2].aborted)).toBe(true);
		expect(await record()).toMatchObject({ abandonedAt: expect.any(Number) });
	});
});
