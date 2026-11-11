import { act, useEffect, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useShortcutActions } from "@/hooks/settings/use-shortcut-actions";
import { SurfaceNavigationProvider, useSurfaceNavigationContext } from "@/providers/surface-navigation-provider";
import { getDetailTerminalTaskId } from "@/terminal/terminal-constants";
import { getTerminalController, registerTerminalController } from "@/terminal/terminal-controller-registry";

const scope = vi.hoisted(() => ({ projectId: "project-1", taskId: "task-1" }));
const setSelectedTaskId = vi.hoisted(() => vi.fn());
const showAppToast = vi.hoisted(() => vi.fn());
vi.mock("@/providers/board-provider", () => ({
	useBoardContext: () => ({ selectedTaskId: scope.taskId, setSelectedTaskId }),
}));
vi.mock("@/providers/project-provider", () => ({
	useProjectNavigationContext: () => ({
		currentProjectId: scope.projectId,
		hasNoProjects: false,
		isProjectSwitching: false,
		projects: [],
	}),
}));
vi.mock("@/components/app-toaster", () => ({ showAppToast }));
vi.mock("@/runtime/runtime-config-query", () => ({ saveRuntimeConfig: vi.fn() }));

type ShortcutInput = Parameters<typeof useShortcutActions>[0];
type PreparedTerminal = Awaited<ReturnType<ShortcutInput["prepareTerminalForShortcut"]>>;
type ShortcutActions = ReturnType<typeof useShortcutActions>;
type Navigation = ReturnType<typeof useSurfaceNavigationContext>;

function Viewer({ projectId, taskId, input }: { projectId: string; taskId: string; input: (text: string) => boolean }) {
	useLayoutEffect(
		() =>
			registerTerminalController(
				getDetailTerminalTaskId(taskId),
				{
					input,
					paste: input,
					waitForLikelyPrompt: async () => true,
				},
				{ projectId, sessionInstanceId: `${projectId}:${taskId}` },
			),
		[projectId, taskId, input],
	);
	return null;
}

function RunCaller({
	projectId,
	taskId,
	prepare,
	input,
	events,
	onSnapshot,
}: {
	projectId: string;
	taskId: string;
	prepare: ShortcutInput["prepareTerminalForShortcut"];
	input: (text: string) => boolean;
	events: string[];
	onSnapshot: (actions: ShortcutActions, navigation: Navigation) => void;
}) {
	const navigation = useSurfaceNavigationContext();
	// Same shortcut/navigation composition as App: navigation changes the surface,
	// while the shortcut and preparation closures keep their selected task/project.
	const actions = useShortcutActions({
		currentProjectId: projectId,
		selectedTaskId: taskId,
		setMainView: (view) => {
			events.push(`activate:${view}`);
			navigation.setMainView(view);
		},
		selectedShortcutLabel: "Run",
		shortcuts: [{ label: "Run", command: "npm run dev" }],
		refreshRuntimeProjectConfig: () => {},
		prepareTerminalForShortcut: prepare,
	});
	useEffect(() => {
		onSnapshot(actions, navigation);
	}, [actions, navigation, onSnapshot]);
	return navigation.mainView === "terminal" ? <Viewer projectId={projectId} taskId={taskId} input={input} /> : null;
}

describe("project shortcut surface navigation", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;
	let actions: ShortcutActions;
	let navigation: Navigation;
	let events: string[];
	let input: ReturnType<typeof vi.fn<(text: string) => boolean>>;
	let prepare: ReturnType<typeof vi.fn<ShortcutInput["prepareTerminalForShortcut"]>>;
	let finishPreparation: () => void;

	async function render() {
		const capturedProjectId = scope.projectId;
		const capturedTaskId = scope.taskId;
		await act(async () => {
			root.render(
				<SurfaceNavigationProvider>
					<RunCaller
						projectId={capturedProjectId}
						taskId={capturedTaskId}
						prepare={prepare}
						input={input}
						events={events}
						onSnapshot={(nextActions, nextNavigation) => {
							actions = nextActions;
							navigation = nextNavigation;
						}}
					/>
				</SurfaceNavigationProvider>,
			);
		});
	}
	beforeEach(() => {
		scope.projectId = "project-1";
		scope.taskId = "task-1";
		setSelectedTaskId.mockReset();
		showAppToast.mockReset();
		events = [];
		input = vi.fn(() => true);
		prepare = vi.fn(() => {
			const { projectId, taskId } = scope;
			events.push(`prepare:${projectId}:${taskId}`);
			return new Promise<PreparedTerminal>((resolve) => {
				finishPreparation = () =>
					resolve({
						ok: true,
						targetTaskId: getDetailTerminalTaskId(taskId),
						targetSessionInstanceId: `${projectId}:${taskId}`,
						hadExistingSession: true,
						isCurrent: () => scope.projectId === projectId && scope.taskId === taskId,
					});
			});
		});
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it.each(["files", "git"] as const)(
		"Run from task %s activates Terminal before preparing the selected shell",
		async (view) => {
			await render();
			act(() => navigation.setMainView(view));
			expect(
				getTerminalController(getDetailTerminalTaskId(scope.taskId), { projectId: scope.projectId }),
			).toBeNull();
			let pending!: Promise<void>;
			await act(async () => {
				pending = actions.handleRunShortcut("Run");
			});
			expect(events).toEqual(["activate:terminal", "prepare:project-1:task-1"]);
			expect(navigation.mainView).toBe("terminal");
			expect(
				getTerminalController(getDetailTerminalTaskId(scope.taskId), { projectId: scope.projectId }),
			).not.toBeNull();
			await act(async () => {
				finishPreparation();
				await pending;
			});
			expect(input.mock.calls.map(([text]) => text)).toEqual(["\u0003", "npm run dev", "\r"]);
			expect(scope).toEqual({ projectId: "project-1", taskId: "task-1" });
			expect(setSelectedTaskId).not.toHaveBeenCalled();
			expect(showAppToast).not.toHaveBeenCalled();
		},
	);

	it.each([
		["files", "project"],
		["files", "task"],
		["git", "project"],
		["git", "task"],
	] as const)("Run from %s does not follow a %s change while preparing", async (view, change) => {
		await render();
		act(() => navigation.setMainView(view));
		const oldRun = actions.handleRunShortcut;
		let pending!: Promise<void>;
		await act(async () => {
			pending = oldRun("Run");
		});
		if (change === "project") scope.projectId = "project-2";
		else scope.taskId = "task-2";
		await render();
		await act(async () => {
			finishPreparation();
			await pending;
		});
		expect(input).not.toHaveBeenCalled();
		expect(events).toEqual(["activate:terminal", "prepare:project-1:task-1"]);
		// A retained button callback cannot activate a surface or prepare another shell.
		act(() => navigation.setMainView(view));
		await act(async () => {
			await oldRun("Run");
		});
		expect(navigation.mainView).toBe(view);
		expect(prepare).toHaveBeenCalledOnce();
		expect(events).toHaveLength(2);
		expect(showAppToast).not.toHaveBeenCalled();
	});
});
