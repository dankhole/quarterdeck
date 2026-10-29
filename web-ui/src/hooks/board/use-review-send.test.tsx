import { TASK_QUICK_REPLY_MAX_LENGTH } from "@runtime-contract";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ReviewSendResult, useReviewSend } from "@/hooks/board/use-review-send";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { createTestTaskOutstandingInteraction, createTestTaskSessionSummary } from "@/test-utils/task-session-factory";

type HookInput = Parameters<typeof useReviewSend>[0];
type SendReview = ReturnType<typeof useReviewSend>;

function Harness({ capture, ...input }: HookInput & { capture: (send: SendReview) => void }): null {
	capture(useReviewSend(input));
	return null;
}

function readySummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return createTestTaskSessionSummary({
		taskId: "task-1",
		agentId: "codex",
		state: "awaiting_review",
		reviewReason: "hook",
		pid: 42,
		sessionInstanceId: "launch-1",
		...overrides,
	});
}

function deferredResult(): { promise: Promise<ReviewSendResult>; resolve: (result: ReviewSendResult) => void } {
	let resolve!: (result: ReviewSendResult) => void;
	const promise = new Promise<ReviewSendResult>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

describe("useReviewSend", () => {
	let root: Root;
	let container: HTMLDivElement;
	let send: SendReview;
	let input: HookInput;
	let sendInput: ReturnType<typeof vi.fn<HookInput["sendInput"]>>;
	let previousActEnvironment: boolean | undefined;
	const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

	beforeEach(async () => {
		previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		sendInput = vi.fn<HookInput["sendInput"]>().mockResolvedValue({ ok: true });
		input = {
			projectId: "project-1",
			taskId: "task-1",
			taskCreatedAt: 1,
			summary: readySummary(),
			sendInput,
		};
		await render();
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		if (previousActEnvironment === undefined) delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
		else actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
	});

	async function render(overrides: Partial<HookInput> = {}): Promise<void> {
		input = { ...input, ...overrides };
		await act(async () => {
			root.render(
				<Harness
					{...input}
					capture={(action) => {
						send = action;
					}}
				/>,
			);
		});
	}

	async function renderSecondSender(overrides: Partial<HookInput> = {}): Promise<SendReview> {
		let secondSend!: SendReview;
		await act(async () => {
			root.render(
				<>
					<Harness
						key="comparison-a"
						{...input}
						capture={(action) => {
							send = action;
						}}
					/>
					<Harness
						key="comparison-b"
						{...input}
						{...overrides}
						capture={(action) => {
							secondSend = action;
						}}
					/>
				</>,
			);
		});
		return secondSend;
	}

	it("locks the same target across two comparison senders until acknowledgement", async () => {
		const secondSend = await renderSecondSender();
		const deferred = deferredResult();
		sendInput.mockReturnValueOnce(deferred.promise);
		const pending = send("Comparison A review");
		await expect(secondSend("Comparison B review")).resolves.toEqual({
			ok: false,
			message: "Another review is being sent to this agent. Wait for it to finish; your draft is saved.",
		});
		expect(sendInput).toHaveBeenCalledTimes(1);
		deferred.resolve({ ok: true });
		await expect(pending).resolves.toEqual({ ok: true });
		await expect(secondSend("Comparison B review")).resolves.toEqual({ ok: true });
		expect(sendInput).toHaveBeenCalledTimes(2);
	});

	it("retains the target lock across hook unmount and remount without reviving stale callbacks", async () => {
		const deferred = deferredResult();
		sendInput.mockReturnValueOnce(deferred.promise);
		const staleSend = send;
		const pending = send("Comparison A review");
		await act(async () => root.render(null));
		await render();
		await expect(staleSend("Stale review")).resolves.toMatchObject({
			ok: false,
			message: expect.stringContaining("changed"),
		});
		await expect(send("Comparison B review")).resolves.toMatchObject({
			ok: false,
			message: expect.stringContaining("Another review is being sent"),
		});
		expect(sendInput).toHaveBeenCalledTimes(1);
		deferred.resolve({ ok: true });
		await expect(pending).resolves.toEqual({ ok: true });
		await expect(send("Comparison B review")).resolves.toEqual({ ok: true });
		expect(sendInput).toHaveBeenCalledTimes(2);
	});

	it.each(["rejection", "throw", "synchronous throw"])("releases the target lock after %s", async (failure) => {
		if (failure === "synchronous throw") {
			sendInput.mockImplementationOnce(() => {
				throw new Error("Connection lost");
			});
		} else if (failure === "throw") sendInput.mockRejectedValueOnce(new Error("Connection lost"));
		else sendInput.mockResolvedValueOnce({ ok: false, message: "Rejected by runtime" });
		await expect(send("Comparison A review")).resolves.toMatchObject({ ok: false });
		await expect(send("Comparison B review")).resolves.toEqual({ ok: true });
		expect(sendInput).toHaveBeenCalledTimes(2);
	});

	it("sends the complete unchanged text once to the exact session and awaits acknowledgement", async () => {
		const deferred = deferredResult();
		sendInput.mockReturnValue(deferred.promise);
		const text = "Review comments:\n  preserve indentation\n\nsecond comment";
		let settled = false;
		const pending = send(text).then((result) => {
			settled = true;
			return result;
		});
		expect(sendInput).toHaveBeenCalledExactlyOnceWith("task-1", text, {
			intent: "submit",
			appendNewline: true,
			preferTerminal: false,
			replyToSessionInstanceId: "launch-1",
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		deferred.resolve({ ok: true });
		await expect(pending).resolves.toEqual({ ok: true });
		expect(sendInput).toHaveBeenCalledTimes(1);
	});

	it("returns an explicit server rejection without a second write", async () => {
		sendInput.mockResolvedValue({ ok: false, message: "The agent is no longer ready." });
		await expect(send("Review comments")).resolves.toEqual({ ok: false, message: "The agent is no longer ready." });
		expect(sendInput).toHaveBeenCalledTimes(1);
	});

	it.each(["missing message", "throw"])("reports an unconfirmed delivery on %s without retry", async (failure) => {
		if (failure === "throw") sendInput.mockRejectedValue(new Error("private transport details"));
		else sendInput.mockResolvedValue({ ok: false });
		await expect(send("Review comments")).resolves.toEqual({
			ok: false,
			message: "Delivery could not be confirmed. Check the agent before resending.",
		});
		expect(sendInput).toHaveBeenCalledTimes(1);
	});

	it.each<{ name: string; summary: RuntimeTaskSessionSummary | null }>([
		{ name: "missing session", summary: null },
		{ name: "missing exact identity", summary: readySummary({ sessionInstanceId: undefined }) },
		{ name: "processless session", summary: readySummary({ pid: null }) },
		{ name: "wrong task", summary: readySummary({ taskId: "task-2" }) },
		{ name: "non-native session", summary: readySummary({ agentId: null }) },
		{ name: "busy session", summary: readySummary({ state: "running" }) },
		{
			name: "approval wait",
			summary: readySummary({
				outstandingInteraction: createTestTaskOutstandingInteraction({ kind: "permission" }),
			}),
		},
		{
			name: "question wait",
			summary: readySummary({ outstandingInteraction: createTestTaskOutstandingInteraction({ kind: "question" }) }),
		},
	])("rejects a $name before writing", async ({ summary }) => {
		await render({ summary });
		await expect(send("Review comments")).resolves.toMatchObject({ ok: false });
		expect(sendInput).not.toHaveBeenCalled();
	});

	it("requires a selected project", async () => {
		await render({ projectId: null });
		await expect(send("Review comments")).resolves.toMatchObject({ ok: false });
		expect(sendInput).not.toHaveBeenCalled();
	});

	it("rejects empty comments", async () => {
		await expect(send("  ")).resolves.toEqual({ ok: false, message: "Enter review comments before sending." });
		expect(sendInput).not.toHaveBeenCalled();
	});

	it("checks the aggregate formatted review limit, including context", async () => {
		const text = `File: src/example.ts, line 12\n${"x".repeat(TASK_QUICK_REPLY_MAX_LENGTH)}`;
		await expect(send(text)).resolves.toEqual({
			ok: false,
			message:
				"The complete review exceeds 8,000 characters, including file and line context. Shorten the review before sending.",
		});
		expect(sendInput).not.toHaveBeenCalled();
	});

	it("accepts a complete review at the exact character limit", async () => {
		await expect(send("x".repeat(TASK_QUICK_REPLY_MAX_LENGTH))).resolves.toEqual({ ok: true });
		expect(sendInput).toHaveBeenCalledTimes(1);
	});

	it("checks current readiness even through a retained ready callback", async () => {
		const retainedSend = send;
		await render({ summary: readySummary({ state: "running" }) });
		await expect(retainedSend("Review comments")).resolves.toMatchObject({ ok: false });
		expect(sendInput).not.toHaveBeenCalled();
	});

	const targetChanges: { name: string; overrides: Partial<HookInput> }[] = [
		{ name: "project switch", overrides: { projectId: "project-2" } },
		{ name: "task switch", overrides: { taskId: "task-2", summary: readySummary({ taskId: "task-2" }) } },
		{ name: "task recreation", overrides: { taskCreatedAt: 2 } },
		{ name: "session replacement", overrides: { summary: readySummary({ sessionInstanceId: "launch-2" }) } },
	];

	it.each(targetChanges)("allows an independent pending target after $name", async ({ overrides }) => {
		const secondSend = await renderSecondSender(overrides);
		const deferred = deferredResult();
		sendInput.mockReturnValueOnce(deferred.promise);
		const pending = send("Original target review");
		await expect(secondSend("Independent target review")).resolves.toEqual({ ok: true });
		expect(sendInput).toHaveBeenCalledTimes(2);
		expect(sendInput.mock.calls[0]?.[2].replyToSessionInstanceId).toBe("launch-1");
		expect(sendInput.mock.calls[1]?.[2].replyToSessionInstanceId).toBe(
			overrides.summary?.sessionInstanceId ?? "launch-1",
		);
		deferred.resolve({ ok: true });
		await expect(pending).resolves.toEqual({ ok: true });
	});

	it.each(targetChanges)("rejects retained callbacks after $name", async ({ overrides }) => {
		const retainedSend = send;
		await render(overrides);
		await expect(retainedSend("Review comments")).resolves.toMatchObject({ ok: false });
		expect(sendInput).not.toHaveBeenCalled();
	});

	it.each(targetChanges)("preserves late success after $name without retargeting", async ({ overrides }) => {
		const deferred = deferredResult();
		sendInput.mockReturnValue(deferred.promise);
		const pending = send("Review comments");
		await render(overrides);
		deferred.resolve({ ok: true });
		await expect(pending).resolves.toEqual({ ok: true });
		expect(sendInput).toHaveBeenCalledTimes(1);
		expect(sendInput.mock.calls[0]?.[2].replyToSessionInstanceId).toBe("launch-1");
	});

	it("preserves the actual rejection after navigation instead of replacing it with a stale-target error", async () => {
		const deferred = deferredResult();
		sendInput.mockReturnValue(deferred.promise);
		const pending = send("Review comments");
		await render({ projectId: "project-2" });
		deferred.resolve({ ok: false, message: "The runtime rejected this exact session." });
		await expect(pending).resolves.toEqual({ ok: false, message: "The runtime rejected this exact session." });
		expect(sendInput).toHaveBeenCalledTimes(1);
	});

	it("preserves acknowledgement after navigating away and back", async () => {
		const deferred = deferredResult();
		sendInput.mockReturnValue(deferred.promise);
		const pending = send("Review comments");
		await render({ projectId: "project-2" });
		await render({ projectId: "project-1" });
		deferred.resolve({ ok: true });
		await expect(pending).resolves.toEqual({ ok: true });
		expect(sendInput).toHaveBeenCalledTimes(1);
	});

	it("does not treat native work on the same session as a failed acknowledgement", async () => {
		const deferred = deferredResult();
		sendInput.mockReturnValue(deferred.promise);
		const pending = send("Review comments");
		await render({ summary: readySummary({ state: "running" }) });
		deferred.resolve({ ok: true });
		await expect(pending).resolves.toEqual({ ok: true });
	});

	it("rejects retained callbacks but preserves dispatched acknowledgements after unmount", async () => {
		const deferred = deferredResult();
		sendInput.mockReturnValue(deferred.promise);
		const retainedSend = send;
		const pending = send("Review comments");
		await act(async () => root.render(null));
		await expect(retainedSend("Another review")).resolves.toMatchObject({ ok: false });
		deferred.resolve({ ok: true });
		await expect(pending).resolves.toEqual({ ok: true });
		expect(sendInput).toHaveBeenCalledTimes(1);
	});
});
