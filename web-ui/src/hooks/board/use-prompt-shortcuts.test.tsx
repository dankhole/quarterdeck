import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type UsePromptShortcutsResult, usePromptShortcuts } from "@/hooks/board/use-prompt-shortcuts";
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

const REVIEW_SHORTCUT = { label: "Review", prompt: "Review the changes.\nCall out risks." };
const DEFAULT_TEST_SHORTCUTS = [REVIEW_SHORTCUT];

function HookHarness({
	onSnapshot,
	sendTaskSessionInput,
	currentProjectId = "project-1",
	promptShortcuts = DEFAULT_TEST_SHORTCUTS,
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
	});

	it("pastes the entire prompt as one draft without submitting", async () => {
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

		await act(async () => {
			await requireSnapshot(latestSnapshot).runPromptShortcut("task-1", REVIEW_SHORTCUT.label);
		});

		expect(sendTaskSessionInput).toHaveBeenCalledExactlyOnceWith("task-1", REVIEW_SHORTCUT.prompt, {
			intent: "write",
			appendNewline: false,
			mode: "paste",
			asAgentDraft: true,
		});
		expect(showAppToastMock).not.toHaveBeenCalled();
	});

	it("shows an error when paste fails without changing the remembered shortcut", async () => {
		localStorage.setItem(LocalStorageKey.PromptShortcutLastLabel, "Previous");
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
			await requireSnapshot(latestSnapshot).runPromptShortcut("task-1", REVIEW_SHORTCUT.label);
		});

		expect(sendTaskSessionInput).toHaveBeenCalledOnce();
		expect(localStorage.getItem(LocalStorageKey.PromptShortcutLastLabel)).toBe("Previous");
		expect(showAppToastMock).toHaveBeenCalledWith({
			intent: "danger",
			icon: "warning-sign",
			message: "Connection failed",
			timeout: 7000,
		});
		expect(requireSnapshot(latestSnapshot).isRunning).toBe(false);
	});

	it("updates the remembered label after a successful paste", async () => {
		const sendTaskSessionInput = vi.fn(async () => ({ ok: true }));
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					sendTaskSessionInput={sendTaskSessionInput}
					promptShortcuts={[{ label: "Implement", prompt: "Implement the plan" }, REVIEW_SHORTCUT]}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			await requireSnapshot(latestSnapshot).runPromptShortcut("task-1", REVIEW_SHORTCUT.label);
		});

		expect(localStorage.getItem(LocalStorageKey.PromptShortcutLastLabel)).toBe(REVIEW_SHORTCUT.label);
	});

	it.each([
		[null, "Squash Merge"],
		["Missing", "Squash Merge"],
		["Commit", "Commit"],
	])("resolves remembered shortcut %s to %s", async (remembered, expected) => {
		if (remembered !== null) localStorage.setItem(LocalStorageKey.PromptShortcutLastLabel, remembered);
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					sendTaskSessionInput={vi.fn(async () => ({ ok: true }))}
					promptShortcuts={[
						{ label: "Squash Merge", prompt: "Review the squash merge" },
						{ label: "Commit", prompt: "My custom commit prompt" },
					]}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		expect(requireSnapshot(latestSnapshot).activeShortcut?.label).toBe(expected);
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
			await requireSnapshot(latestSnapshot).savePromptShortcuts(newShortcuts, []);
		});

		expect(saveRuntimeConfigMock).toHaveBeenCalledWith("project-1", {
			promptShortcuts: newShortcuts,
			hiddenDefaultPromptShortcuts: [],
		});
	});

	it("ignores a second click while the paste is pending", async () => {
		let finishPaste!: (result: { ok: boolean }) => void;
		const paste = new Promise<{ ok: boolean }>((resolve) => {
			finishPaste = resolve;
		});
		const sendTaskSessionInput = vi.fn(() => paste);

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

		let pending: Promise<void> | undefined;
		await act(async () => {
			const { runPromptShortcut } = requireSnapshot(latestSnapshot);
			pending = runPromptShortcut("task-1", REVIEW_SHORTCUT.label);
			await runPromptShortcut("task-1", REVIEW_SHORTCUT.label);
		});
		expect(sendTaskSessionInput).toHaveBeenCalledOnce();
		expect(requireSnapshot(latestSnapshot).isRunning).toBe(true);

		await act(async () => {
			finishPaste({ ok: true });
			await pending;
		});
		expect(requireSnapshot(latestSnapshot).isRunning).toBe(false);
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
			return requireSnapshot(latestSnapshot).savePromptShortcuts([{ label: "Test", prompt: "/test" }], []);
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
			return requireSnapshot(latestSnapshot).savePromptShortcuts([{ label: "Test", prompt: "/test" }], []);
		});

		expect(result).toBe(false);
		expect(saveRuntimeConfigMock).not.toHaveBeenCalled();
	});

	it("keeps retry available when the paste transport throws", async () => {
		const sendTaskSessionInput = vi.fn().mockRejectedValueOnce(new Error("Connection closed"));

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
			await requireSnapshot(latestSnapshot).runPromptShortcut("task-1", REVIEW_SHORTCUT.label);
		});

		expect(sendTaskSessionInput).toHaveBeenCalledOnce();
		expect(requireSnapshot(latestSnapshot).isRunning).toBe(false);
		expect(showAppToastMock).toHaveBeenCalledWith({
			intent: "danger",
			icon: "warning-sign",
			message: "Connection closed",
			timeout: 7000,
		});
	});
});
