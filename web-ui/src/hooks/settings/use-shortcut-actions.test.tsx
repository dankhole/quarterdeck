import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useShortcutActions } from "@/hooks/settings/use-shortcut-actions";
import { registerTerminalController } from "@/terminal/terminal-controller-registry";

const saveRuntimeConfigMock = vi.hoisted(() => vi.fn());
const showAppToastMock = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/runtime-config-query", () => ({ saveRuntimeConfig: saveRuntimeConfigMock }));
vi.mock("@/components/app-toaster", () => ({ showAppToast: showAppToastMock }));

type ShortcutActions = ReturnType<typeof useShortcutActions>;
type ShortcutInput = Parameters<typeof useShortcutActions>[0];
const HOME_TASK_ID = "__home_terminal__";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function HookHarness({
	onSnapshot,
	prepareTerminalForShortcut,
	currentProjectId = "project-1",
}: {
	onSnapshot: (snapshot: ShortcutActions) => void;
	prepareTerminalForShortcut: ShortcutInput["prepareTerminalForShortcut"];
	currentProjectId?: string | null;
}): null {
	const actions = useShortcutActions({
		currentProjectId,
		selectedTaskId: null,
		setMainView: () => {},
		selectedShortcutLabel: "Ship",
		shortcuts: [{ label: "Ship", command: "npm run ship" }],
		refreshRuntimeProjectConfig: () => {},
		prepareTerminalForShortcut,
	});
	useEffect(() => {
		onSnapshot(actions);
	}, [actions, onSnapshot]);
	return null;
}

describe("useShortcutActions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let snapshot: ShortcutActions;
	let unregister: (() => void)[];
	let input: ReturnType<typeof vi.fn<(text: string) => boolean>>;
	let waitForPrompt: ReturnType<typeof vi.fn<(timeout: number) => Promise<boolean>>>;

	async function render(
		prepareTerminalForShortcut: ShortcutInput["prepareTerminalForShortcut"],
		projectId = "project-1",
	) {
		await act(async () => {
			root.render(
				<HookHarness
					currentProjectId={projectId}
					prepareTerminalForShortcut={prepareTerminalForShortcut}
					onSnapshot={(value) => {
						snapshot = value;
					}}
				/>,
			);
		});
	}
	function prepared(hadExistingSession = true, isCurrent = () => true) {
		return {
			ok: true,
			targetTaskId: HOME_TASK_ID,
			targetSessionInstanceId: "launch-1",
			hadExistingSession,
			isCurrent,
		};
	}
	function attach(projectId: string, sessionInstanceId: string) {
		const controller = { input: vi.fn(() => true), paste: vi.fn(() => true), waitForLikelyPrompt: waitForPrompt };
		unregister.push(registerTerminalController(HOME_TASK_ID, controller, { projectId, sessionInstanceId }));
		return controller;
	}

	beforeEach(() => {
		saveRuntimeConfigMock.mockReset();
		showAppToastMock.mockReset();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		unregister = [];
		waitForPrompt = vi.fn(async () => true);
		input = attach("project-1", "launch-1").input;
	});
	afterEach(() => {
		act(() => root.unmount());
		for (const dispose of unregister.reverse()) dispose();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("interrupts an existing hidden shell before sending a shortcut, regardless of panel visibility", async () => {
		await render(async () => prepared(true));
		await act(async () => {
			await snapshot.handleRunShortcut("Ship");
		});
		expect(waitForPrompt).toHaveBeenCalledWith(3000);
		expect(input.mock.calls.map(([text]) => text)).toEqual(["\u0003", "npm run ship", "\r"]);
		expect(waitForPrompt.mock.invocationCallOrder[0]).toBeLessThan(input.mock.invocationCallOrder[0] ?? 0);
		expect(showAppToastMock).not.toHaveBeenCalled();
	});

	it("does not interrupt a fresh shell", async () => {
		await render(async () => prepared(false));
		await act(async () => {
			await snapshot.handleRunShortcut("Ship");
		});
		expect(input.mock.calls.map(([text]) => text)).toEqual(["npm run ship", "\r"]);
	});

	it.each(["project", "task"])("cancels while connecting after a %s switch", async (scope) => {
		const connection = deferred<ReturnType<typeof prepared>>();
		let current = true;
		const prepare = vi.fn(() => connection.promise);
		await render(prepare);
		let pending!: Promise<void>;
		act(() => {
			pending = snapshot.handleRunShortcut("Ship");
		});
		current = false;
		if (scope === "project") {
			attach("project-2", "launch-2");
			await render(prepare, "project-2");
		}
		await act(async () => {
			connection.resolve(prepared(true, () => current));
			await pending;
		});
		expect(input).not.toHaveBeenCalled();
		expect(waitForPrompt).not.toHaveBeenCalled();
		expect(showAppToastMock).not.toHaveBeenCalled();
	});

	it.each(["project", "task", "replacement", "unmount"])("cancels while awaiting a prompt after %s", async (scope) => {
		const prompt = deferred<boolean>();
		waitForPrompt.mockReturnValue(prompt.promise);
		let current = true;
		const prepare = async () => prepared(true, () => current);
		await render(prepare);
		let pending!: Promise<void>;
		await act(async () => {
			pending = snapshot.handleRunShortcut("Ship");
		});
		expect(input).toHaveBeenCalledExactlyOnceWith("\u0003");
		let replacement: ReturnType<typeof attach> | undefined;
		if (scope === "project") {
			replacement = attach("project-2", "launch-2");
			await render(prepare, "project-2");
		} else if (scope === "replacement") {
			replacement = attach("project-1", "launch-2");
		} else if (scope === "unmount") {
			await act(async () => root.render(null));
		} else {
			current = false;
		}
		await act(async () => {
			prompt.resolve(true);
			await pending;
		});
		expect(input).toHaveBeenCalledTimes(1);
		expect(replacement?.input ?? input).not.toHaveBeenCalledWith("npm run ship");
		expect(showAppToastMock).not.toHaveBeenCalled();
	});

	it("does not adopt a replacement session that connects while preparation is pending", async () => {
		const connection = deferred<ReturnType<typeof prepared>>();
		await render(() => connection.promise);
		let pending!: Promise<void>;
		act(() => {
			pending = snapshot.handleRunShortcut("Ship");
		});
		const replacement = attach("project-1", "launch-2");
		await act(async () => {
			connection.resolve(prepared());
			await pending;
		});
		expect(input).not.toHaveBeenCalled();
		expect(replacement.input).not.toHaveBeenCalled();
	});

	it("does not revive a retained shortcut callback after navigating away and back", async () => {
		const prepare = vi.fn(async () => prepared());
		await render(prepare);
		const oldRun = snapshot.handleRunShortcut;
		await render(prepare, "project-2");
		await render(prepare, "project-1");
		await act(async () => {
			await oldRun("Ship");
		});
		expect(prepare).not.toHaveBeenCalled();
		expect(input).not.toHaveBeenCalled();
	});

	it("rejects another project's controller with the same home task ID", async () => {
		const otherProject = attach("project-2", "launch-2");
		await render(async () => prepared());
		await act(async () => {
			await snapshot.handleRunShortcut("Ship");
		});
		expect(otherProject.input).not.toHaveBeenCalled();
		expect(showAppToastMock).toHaveBeenCalledOnce();
	});

	it("does not send a command when interrupting the old process fails", async () => {
		input.mockReturnValue(false);
		await render(async () => prepared());
		await act(async () => {
			await snapshot.handleRunShortcut("Ship");
		});
		expect(input).toHaveBeenCalledExactlyOnceWith("\u0003");
		expect(showAppToastMock).toHaveBeenCalledOnce();
	});

	it("saves a created shortcut and selects it", async () => {
		saveRuntimeConfigMock.mockResolvedValue({});
		await render(async () => prepared());
		await act(async () => {
			await snapshot.handleCreateShortcut({ label: "Run", command: "npm run dev", icon: "play" });
		});
		expect(saveRuntimeConfigMock).toHaveBeenCalledWith("project-1", {
			shortcuts: [
				{ label: "Ship", command: "npm run ship" },
				{ label: "Run", command: "npm run dev", icon: "play" },
			],
			selectedShortcutLabel: "Run",
		});
		expect(showAppToastMock).not.toHaveBeenCalled();
	});
});
