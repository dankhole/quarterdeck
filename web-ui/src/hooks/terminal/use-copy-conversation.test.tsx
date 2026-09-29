import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCopyConversation } from "./use-copy-conversation";

const { query, writeClipboardText, toast } = vi.hoisted(() => ({
	query: vi.fn(),
	writeClipboardText: vi.fn(),
	toast: vi.fn(),
}));
vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({ runtime: { readTaskConversation: { query } } }),
}));
vi.mock("@/runtime/browser-host-integrations", () => ({ browserHostIntegrations: { writeClipboardText } }));
vi.mock("@/components/app-toaster", () => ({ showAppToast: toast }));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((nextResolve) => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

describe("copy conversation", () => {
	let root: Root;
	let container: HTMLDivElement;
	let current: ReturnType<typeof useCopyConversation>;
	let previousActEnvironment: boolean | undefined;
	function Harness({ task = "task-1" }: { task?: string }) {
		current = useCopyConversation("project-1", task, "launch-1");
		return null;
	}
	beforeEach(async () => {
		previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		root = createRoot(container);
		vi.resetAllMocks();
		writeClipboardText.mockImplementation(async (text: Promise<string>) => {
			await text;
		});
		await act(async () => root.render(<Harness />));
	});
	afterEach(() => {
		act(() => root.unmount());
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
	});
	it("starts the clipboard write in the click gesture, waits for the full response, and prevents double clicks", async () => {
		const response = deferred<{ ok: true; text: string }>();
		query.mockReturnValue(response.promise);
		let copying: Promise<void>;
		act(() => {
			copying = current.copyConversation();
			void current.copyConversation();
			expect(writeClipboardText).toHaveBeenCalledOnce();
		});
		expect(current.isCopying).toBe(true);
		expect(query).toHaveBeenCalledOnce();
		expect(query).toHaveBeenCalledWith(
			{ taskId: "task-1", sessionInstanceId: "launch-1" },
			{ signal: expect.any(AbortSignal) },
		);
		expect(toast).not.toHaveBeenCalled();
		await act(async () => {
			response.resolve({ ok: true, text: "oldest\nnewest" });
			await copying;
		});
		await expect(writeClipboardText.mock.calls[0]?.[0]).resolves.toBe("oldest\nnewest");
		expect(toast).toHaveBeenCalledWith({ intent: "success", message: "Full conversation copied." });
		expect(current.isCopying).toBe(false);
	});
	it("cancels pending content when changing task", async () => {
		const response = deferred<{ ok: true; text: string }>();
		query.mockReturnValue(response.promise);
		let copying: Promise<void>;
		act(() => {
			copying = current.copyConversation();
		});
		await act(async () => root.render(<Harness task="task-2" />));
		expect(query.mock.calls[0]?.[1].signal.aborted).toBe(true);
		await act(async () => {
			response.resolve({ ok: true, text: "stale history" });
			await copying;
		});
		await expect(writeClipboardText.mock.calls[0]?.[0]).rejects.toThrow("cancelled");
		expect(toast).not.toHaveBeenCalled();
		expect(current.isCopying).toBe(false);
	});
	it("reports a failed read and rejects clipboard content", async () => {
		query.mockResolvedValue({ ok: false, error: "Conversation changed" });
		await act(async () => current.copyConversation());
		await expect(writeClipboardText.mock.calls[0]?.[0]).rejects.toThrow("Conversation changed");
		expect(toast).toHaveBeenCalledWith({ intent: "danger", message: "Conversation changed" });
	});
});
