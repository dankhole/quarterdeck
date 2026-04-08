import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type UsePromptShortcutsResult, usePromptShortcuts } from "@/hooks/use-prompt-shortcuts";
import type { PromptShortcut } from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";

const saveRuntimeConfigMock = vi.hoisted(() => vi.fn());
const showAppToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/runtime-config-query", () => ({
	saveRuntimeConfig: saveRuntimeConfigMock,
}));

vi.mock("@/components/app-toaster", () => ({
	showAppToast: showAppToastMock,
}));

interface HookSnapshot {
	lastUsedLabel: string;
	activeShortcut: PromptShortcut | null;
	isRunning: boolean;
	runPromptShortcut: UsePromptShortcutsResult["runPromptShortcut"];
	selectShortcutLabel: UsePromptShortcutsResult["selectShortcutLabel"];
	savePromptShortcuts: UsePromptShortcutsResult["savePromptShortcuts"];
}

function requireSnapshot(snapshot: HookSnapshot | null): HookSnapshot {
	if (snapshot === null) {
		throw new Error("Expected a hook snapshot.");
	}
	return snapshot;
}

function HookHarness({
	onSnapshot,
	sendTaskSessionInput,
	currentProjectId = "project-1",
	promptShortcuts = [{ label: "Commit", prompt: "/commit" }],
}: {
	onSnapshot: (snapshot: HookSnapshot) => void;
	sendTaskSessionInput: Parameters<typeof usePromptShortcuts>[0]["sendTaskSessionInput"];
	currentProjectId?: string | null;
	promptShortcuts?: PromptShortcut[];
}): null {
	const hookResult = usePromptShortcuts({
		currentProjectId,
		promptShortcuts,
		refreshRuntimeConfig: () => {},
		sendTaskSessionInput,
	});

	useEffect(() => {
		onSnapshot({
			lastUsedLabel: hookResult.lastUsedLabel,
			activeShortcut: hookResult.activeShortcut,
			isRunning: hookResult.isRunning,
			runPromptShortcut: hookResult.runPromptShortcut,
			selectShortcutLabel: hookResult.selectShortcutLabel,
			savePromptShortcuts: hookResult.savePromptShortcuts,
		});
	}, [
		onSnapshot,
		hookResult.lastUsedLabel,
		hookResult.activeShortcut,
		hookResult.isRunning,
		hookResult.runPromptShortcut,
		hookResult.selectShortcutLabel,
		hookResult.savePromptShortcuts,
	]);

	return null;
}

describe("usePromptShortcuts", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		saveRuntimeConfigMock.mockReset();
		showAppToastMock.mockReset();
		localStorage.clear();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
		vi.useRealTimers();
	});

	it("runs prompt shortcut via paste and submit", async () => {
		vi.useFakeTimers();
		const sendTaskSessionInput = vi.fn(async () => ({ ok: true }));
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					sendTaskSessionInput={sendTaskSessionInput}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const runPromise = act(async () => {
			const promise = requireSnapshot(latestSnapshot).runPromptShortcut("task-1", "Commit");
			await vi.advanceTimersByTimeAsync(200);
			await promise;
		});

		await runPromise;

		expect(sendTaskSessionInput).toHaveBeenNthCalledWith(1, "task-1", "/commit", {
			appendNewline: false,
			mode: "paste",
		});
		expect(sendTaskSessionInput).toHaveBeenNthCalledWith(2, "task-1", "\r", { appendNewline: false });
		expect(showAppToastMock).not.toHaveBeenCalled();
	});

	it("shows error toast when paste fails", async () => {
		const sendTaskSessionInput = vi.fn(async () => ({ ok: false, message: "Connection failed" }));
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					sendTaskSessionInput={sendTaskSessionInput}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			await requireSnapshot(latestSnapshot).runPromptShortcut("task-1", "Commit");
		});

		expect(showAppToastMock).toHaveBeenCalledWith({
			intent: "danger",
			icon: "warning-sign",
			message: "Connection failed",
			timeout: 7000,
		});
		expect(requireSnapshot(latestSnapshot).isRunning).toBe(false);
	});

	it("updates last used label after successful run", async () => {
		vi.useFakeTimers();
		const sendTaskSessionInput = vi.fn(async () => ({ ok: true }));
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					sendTaskSessionInput={sendTaskSessionInput}
					promptShortcuts={[
						{ label: "Commit", prompt: "/commit" },
						{ label: "Review", prompt: "/review" },
					]}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const runPromise = act(async () => {
			const promise = requireSnapshot(latestSnapshot).runPromptShortcut("task-1", "Review");
			await vi.advanceTimersByTimeAsync(200);
			await promise;
		});

		await runPromise;

		expect(localStorage.getItem(LocalStorageKey.PromptShortcutLastLabel)).toBe("Review");
	});

	it("falls back to first shortcut when last used label not found", async () => {
		localStorage.setItem(LocalStorageKey.PromptShortcutLastLabel, "NonExistent");
		const sendTaskSessionInput = vi.fn(async () => ({ ok: true }));
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					sendTaskSessionInput={sendTaskSessionInput}
					promptShortcuts={[
						{ label: "First", prompt: "/first" },
						{ label: "Second", prompt: "/second" },
					]}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		expect(requireSnapshot(latestSnapshot).activeShortcut?.label).toBe("First");
	});

	it("saves prompt shortcuts via config", async () => {
		saveRuntimeConfigMock.mockResolvedValue({});
		const sendTaskSessionInput = vi.fn(async () => ({ ok: true }));
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					sendTaskSessionInput={sendTaskSessionInput}
					currentProjectId="project-1"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const newShortcuts: PromptShortcut[] = [
			{ label: "Build", prompt: "/build" },
			{ label: "Test", prompt: "/test" },
		];

		await act(async () => {
			await requireSnapshot(latestSnapshot).savePromptShortcuts(newShortcuts);
		});

		expect(saveRuntimeConfigMock).toHaveBeenCalledWith("project-1", {
			promptShortcuts: newShortcuts,
		});
	});

	it("does not fire shortcut when already running", async () => {
		vi.useFakeTimers();
		let resolveFirstCall: (() => void) | null = null;
		const firstCallPromise = new Promise<void>((resolve) => {
			resolveFirstCall = resolve;
		});
		let callCount = 0;

		const sendTaskSessionInput = vi.fn(async () => {
			callCount++;
			if (callCount === 1) {
				await firstCallPromise;
			}
			return { ok: true };
		});

		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					sendTaskSessionInput={sendTaskSessionInput}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		// Start first run (intentionally not awaited immediately to test concurrent behavior)
		const firstRunPromise = act(async () => {
			const promise = requireSnapshot(latestSnapshot).runPromptShortcut("task-1", "Commit");
			await vi.advanceTimersByTimeAsync(0);
			return promise;
		});

		await act(async () => {
			await requireSnapshot(latestSnapshot).runPromptShortcut("task-1", "Commit");
		});

		expect(sendTaskSessionInput).toHaveBeenCalledTimes(1);

		(resolveFirstCall as (() => void) | null)?.();
		await vi.advanceTimersByTimeAsync(200);
		await firstRunPromise;
	});

	it("shows error toast when save fails", async () => {
		saveRuntimeConfigMock.mockRejectedValue(new Error("Network error"));
		const sendTaskSessionInput = vi.fn(async () => ({ ok: true }));
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					sendTaskSessionInput={sendTaskSessionInput}
					currentProjectId="project-1"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const result = await act(async () => {
			return requireSnapshot(latestSnapshot).savePromptShortcuts([{ label: "Test", prompt: "/test" }]);
		});

		expect(result).toBe(false);
		expect(showAppToastMock).toHaveBeenCalledWith({
			intent: "danger",
			icon: "error",
			message: "Could not save prompt shortcuts: Network error",
			timeout: 7000,
		});
	});

	it("returns false when currentProjectId is null", async () => {
		const sendTaskSessionInput = vi.fn(async () => ({ ok: true }));
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					sendTaskSessionInput={sendTaskSessionInput}
					currentProjectId={null}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const result = await act(async () => {
			return requireSnapshot(latestSnapshot).savePromptShortcuts([{ label: "Test", prompt: "/test" }]);
		});

		expect(result).toBe(false);
		expect(saveRuntimeConfigMock).not.toHaveBeenCalled();
	});

	it("handles submit failure after paste success", async () => {
		vi.useFakeTimers();
		let callNumber = 0;
		const sendTaskSessionInput = vi.fn(async () => {
			callNumber++;
			if (callNumber === 1) {
				return { ok: true };
			}
			return { ok: false, message: "Submit failed" };
		});

		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					sendTaskSessionInput={sendTaskSessionInput}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const runPromise = act(async () => {
			const promise = requireSnapshot(latestSnapshot).runPromptShortcut("task-1", "Commit");
			await vi.advanceTimersByTimeAsync(200);
			await promise;
		});

		await runPromise;

		expect(sendTaskSessionInput).toHaveBeenCalledTimes(2);
		expect(showAppToastMock).toHaveBeenCalledWith({
			intent: "danger",
			icon: "warning-sign",
			message: "Submit failed",
			timeout: 7000,
		});
	});
});
