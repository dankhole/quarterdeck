import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDesktopFileEditorRecoveryCommitStatus } from "@/hooks/git/desktop-file-editor-recovery";
import {
	clearCachedFileEditorTabs,
	discardFileEditorDraft,
	getCachedFileEditorTabs,
	getFileEditorDrafts,
	getFileEditorReviewTarget,
	registerFileEditorScope,
	retireFileEditorScopes,
	setCachedFileEditorTabs,
} from "@/hooks/git/file-editor-cache";
import { createFileEditorTab } from "@/hooks/git/file-editor-workspace";
import { getRuntimeEnvironment } from "@/runtime/runtime-environment";
import type {
	DesktopAppCommand,
	DesktopBridge,
	DesktopNotificationTarget,
	DesktopPreflightRelease,
	DesktopProjectOpenRequest,
	DesktopQuitPreflightRequest,
} from "../../../../src/shared/desktop-bridge-contract";
import { registerDesktopDraftProtection } from "./desktop-draft-protection";
import { type UseDesktopAppInput, useDesktopApp } from "./use-desktop-app";

vi.mock("@/runtime/runtime-environment", () => ({ getRuntimeEnvironment: vi.fn() }));
vi.mock("@/components/app-toaster", () => ({ showAppToast: vi.fn() }));
vi.mock("@/hooks/git/desktop-file-editor-recovery", () => ({ getDesktopFileEditorRecoveryCommitStatus: vi.fn() }));

const renderHarness = vi.fn();
function Harness(props: UseDesktopAppInput): null {
	renderHarness();
	useDesktopApp(props);
	return null;
}

describe("desktop frontend lifecycle bridge", () => {
	let root: Root;
	let container: HTMLDivElement;
	let command: ((event: DesktopAppCommand) => void) | undefined;
	let openProject: ((request: DesktopProjectOpenRequest) => void) | undefined;
	let preflight: ((request: DesktopQuitPreflightRequest) => void) | undefined;
	let notificationTarget: ((target: DesktopNotificationTarget) => void) | undefined;
	let release: ((event: DesktopPreflightRelease) => void) | undefined;
	const reply = vi.fn();
	const publish = vi.fn();
	const reportContext = vi.fn();
	const offCommand = vi.fn();
	const offPreflight = vi.fn();
	let props: UseDesktopAppInput;
	beforeEach(() => {
		vi.mocked(getDesktopFileEditorRecoveryCommitStatus).mockReturnValue({
			loaded: true,
			pending: false,
			busy: false,
			problem: null,
			desiredRevision: 1,
			committedRevision: 1,
			ready: true,
		});
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		const bridge: DesktopBridge = {
			version: 1,
			bootstrap: {
				runtimeOrigin: "http://127.0.0.1:54321",
				runtimeGeneration: "current",
				capabilities: { desktop: true, nativeDialogs: false, nativeNotifications: false },
			},
			onCommand: (listener) => {
				command = listener;
				return offCommand;
			},
			onOpenProject: (listener) => {
				openProject = listener;
				return () => {
					openProject = undefined;
				};
			},
			onQuitPreflight: (listener) => {
				preflight = listener;
				return offPreflight;
			},
			respondQuitPreflight: reply,
			publishCommandAvailability: publish,
			reportNotificationContext: reportContext,
			onNotificationTarget: (listener) => {
				notificationTarget = listener;
				return () => {
					notificationTarget = undefined;
				};
			},
			onPreflightReleased: (listener) => {
				release = listener;
				return vi.fn();
			},
		};
		Object.defineProperty(window, "quarterdeckDesktop", { value: bridge, configurable: true });
		vi.mocked(getRuntimeEnvironment).mockReturnValue({
			kind: "desktop",
			runtimeOrigin: bridge.bootstrap.runtimeOrigin,
			runtimeGeneration: "current",
			capabilities: bridge.bootstrap.capabilities,
		});
		props = {
			handlers: {
				settings: vi.fn(),
				diagnostics: vi.fn(),
				newTask: vi.fn(),
				openProject: vi.fn(),
				navigate: vi.fn(),
				fileFinder: vi.fn(),
				textSearch: vi.fn(),
				toggleShell: vi.fn(),
			},
			projectActionsEnabled: true,
			runtimeConnected: true,
			notificationProjects: {},
			taskDraftCount: 0,
		};
	});
	afterEach(() => {
		vi.useRealTimers();
		act(() => root.unmount());
		container.remove();
		clearCachedFileEditorTabs();
		Reflect.deleteProperty(window, "quarterdeckDesktop");
		delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		command = undefined;
		openProject = undefined;
		preflight = undefined;
		release = undefined;
		vi.clearAllMocks();
	});
	function mount() {
		act(() => root.render(<Harness {...props} />));
	}
	function request(reason: "quit" | "update" | "reload" = "quit", runtimeGeneration = "current") {
		act(() => preflight?.({ requestId: "request-1", runtimeGeneration, reason }));
	}
	function cache(scope: string, saving = false) {
		registerFileEditorScope(scope, { projectId: scope, taskId: null });
		const tab = createFileEditorTab("draft.ts", {
			content: "saved",
			contentHash: "hash",
			language: "typescript",
			binary: false,
			truncated: false,
			size: 5,
		});
		setCachedFileEditorTabs(scope, [{ ...tab, value: "unsaved text", isSaving: saving }]);
	}

	it("routes typed project launch intent through the existing owner and rechecks work before its async navigation", () => {
		const open = vi.fn(async (_path: string, canNavigate: () => boolean) => {
			expect(canNavigate()).toBe(true);
		});
		props = { ...props, openProjectByPath: open };
		mount();
		act(() => openProject?.({ runtimeGeneration: "old", projectPath: "/private/tmp/stale" }));
		expect(open).not.toHaveBeenCalled();
		act(() => openProject?.({ runtimeGeneration: "current", projectPath: "/private/tmp/project" }));
		expect(open).toHaveBeenCalledExactlyOnceWith("/private/tmp/project", expect.any(Function));
		const guard = open.mock.calls[0]?.[1];
		props = { ...props, taskDraftCount: 1 };
		mount();
		expect(guard?.()).toBe(false);
		act(() => openProject?.({ runtimeGeneration: "current", projectPath: "/private/tmp/another" }));
		expect(open).toHaveBeenCalledTimes(1);
	});

	it("preserves hidden file and Settings drafts before an npm project open", () => {
		const open = vi.fn(async () => {});
		props = { ...props, openProjectByPath: open };
		cache("hidden");
		mount();
		act(() => openProject?.({ runtimeGeneration: "current", projectPath: "/private/tmp/project" }));
		expect(open).not.toHaveBeenCalled();
		expect(getCachedFileEditorTabs("hidden")[0]?.value).toBe("unsaved text");
		expect(getFileEditorReviewTarget()).toBe("all");
		for (const draft of getFileEditorDrafts("all")) discardFileEditorDraft(draft);
		const unregister = registerDesktopDraftProtection("Settings", () => true);
		try {
			act(() => openProject?.({ runtimeGeneration: "current", projectPath: "/private/tmp/project" }));
			expect(open).not.toHaveBeenCalled();
		} finally {
			unregister();
		}
	});
	it("keeps older preload availability unchanged when typed project handoff is unavailable", () => {
		const bridge = window.quarterdeckDesktop;
		Object.defineProperty(window, "quarterdeckDesktop", {
			value: { ...bridge, onOpenProject: undefined },
			configurable: true,
		});
		props = { ...props, openProjectByPath: vi.fn(async () => {}) };
		mount();
		expect(publish).toHaveBeenCalled();
		expect(publish.mock.lastCall?.[0]).not.toHaveProperty("projectLaunchReady");
	});
	it.each(["desktop", "browser"] as const)("does not rerender %s App for file cache content changes", (kind) => {
		if (kind === "browser")
			vi.mocked(getRuntimeEnvironment).mockReturnValue({ kind: "browser", runtimeOrigin: "http://127.0.0.1:54321" });
		mount();
		const renders = renderHarness.mock.calls.length;
		act(() => cache("hidden"));
		act(() => cache("hidden"));
		expect(renderHarness).toHaveBeenCalledTimes(renders);
	});
	it("publishes explicit refusal readiness for recovery failures", () => {
		vi.mocked(getDesktopFileEditorRecoveryCommitStatus).mockReturnValue({
			loaded: false,
			pending: false,
			busy: false,
			problem: "storage",
			desiredRevision: 0,
			committedRevision: 0,
			ready: false,
		});
		props = { ...props, openProjectByPath: vi.fn(async () => {}) };
		mount();
		expect(publish.mock.lastCall?.[0]).toMatchObject({ projectLaunchReady: true });
		act(() => openProject?.({ runtimeGeneration: "current", projectPath: "/private/tmp/project" }));
		expect(props.openProjectByPath).not.toHaveBeenCalled();
	});

	it("reports current project context and protects task drafts before notification navigation", async () => {
		const selectProject = vi.fn(),
			selectTask = vi.fn();
		props = {
			...props,
			notificationNavigation: {
				currentProjectId: "first",
				navigationProjectId: "first",
				boardProjectId: "first",
				projectIds: ["first", "second"],
				taskIds: ["one"],
				isProjectSwitching: false,
				selectProject,
				selectTask,
			},
			taskDraftCount: 1,
		};
		mount();
		expect(reportContext).toHaveBeenLastCalledWith({ currentProjectId: "first" });
		act(() => notificationTarget?.({ runtimeGeneration: "current", projectId: "second", taskId: "two" }));
		expect(selectProject).not.toHaveBeenCalled();
		props = { ...props, taskDraftCount: 0 };
		mount();
		act(() => notificationTarget?.({ runtimeGeneration: "old", projectId: "second", taskId: "two" }));
		expect(selectProject).not.toHaveBeenCalled();
		act(() => notificationTarget?.({ runtimeGeneration: "current", projectId: "second", taskId: "two" }));
		expect(selectProject).toHaveBeenCalledWith("second");
		expect(selectTask).not.toHaveBeenCalled();
		props = {
			...props,
			notificationNavigation: {
				...props.notificationNavigation!,
				currentProjectId: "second",
				navigationProjectId: "second",
				boardProjectId: "first",
				isProjectSwitching: false,
			},
		};
		mount();
		expect(selectTask).not.toHaveBeenCalled();
		props = {
			...props,
			notificationNavigation: { ...props.notificationNavigation!, boardProjectId: "second", taskIds: ["two"] },
		};
		mount();
		await act(async () => {});
		expect(selectTask).toHaveBeenCalledOnce();
		expect(selectTask).toHaveBeenCalledWith("two");
		expect(reportContext).toHaveBeenLastCalledWith({ currentProjectId: "second" });
		props = { ...props, runtimeConnected: false };
		mount();
		expect(reportContext).toHaveBeenLastCalledWith({ currentProjectId: null });
	});

	it("revalidates a deleted task after project hydration and falls back to the existing board", async () => {
		const selectProject = vi.fn(),
			selectTask = vi.fn();
		props = {
			...props,
			notificationNavigation: {
				currentProjectId: "first",
				navigationProjectId: "first",
				boardProjectId: "first",
				projectIds: ["first", "second"],
				taskIds: [],
				isProjectSwitching: false,
				selectProject,
				selectTask,
			},
		};
		mount();
		act(() => notificationTarget?.({ runtimeGeneration: "current", projectId: "second", taskId: "deleted" }));
		props = {
			...props,
			notificationNavigation: {
				...props.notificationNavigation!,
				currentProjectId: "second",
				navigationProjectId: "second",
				boardProjectId: "second",
			},
		};
		mount();
		expect(selectTask).not.toHaveBeenCalled();
		await act(async () => {});
		expect(props.handlers.navigate).toHaveBeenLastCalledWith("home");
		act(() => notificationTarget?.({ runtimeGeneration: "current", projectId: "removed", taskId: null }));
		expect(selectProject).toHaveBeenCalledTimes(1);
		expect(props.handlers.navigate).toHaveBeenCalledTimes(2);
	});

	it("publishes current availability and rechecks it before dispatching stale menu intent", () => {
		mount();
		expect(publish).toHaveBeenLastCalledWith(
			expect.objectContaining({
				runtimeGeneration: "current",
				runtimeConnected: true,
				commands: expect.not.arrayContaining(["terminal"]),
			}),
		);
		props = { ...props, selectedTask: true };
		mount();
		expect(publish.mock.lastCall?.[0].commands).toContain("terminal");
		props = { ...props, runtimeConnected: false };
		mount();
		expect(publish).toHaveBeenLastCalledWith({
			runtimeGeneration: "current",
			runtimeConnected: false,
			commands: ["settings", "diagnostics"],
		});
		act(() => command?.({ runtimeGeneration: "current", command: "open-project" }));
		expect(props.handlers.openProject).not.toHaveBeenCalled();
		act(() => command?.({ runtimeGeneration: "current", command: "terminal" }));
		expect(props.handlers.navigate).not.toHaveBeenCalled();
		act(() => root.render(null));
		expect(publish).toHaveBeenLastCalledWith({ runtimeGeneration: "current", runtimeConnected: false, commands: [] });
	});

	it("preserves hidden and detached drafts, opens their existing review workflow, and allows quit only after exact discard", () => {
		cache("hidden");
		cache("removed");
		retireFileEditorScopes({ projectId: "removed" });
		mount();
		request();
		expect(reply).toHaveBeenLastCalledWith(
			expect.objectContaining({ decision: "blocked", status: expect.objectContaining({ dirtyEditorCount: 2 }) }),
		);
		expect(getFileEditorReviewTarget()).toBe("all");
		expect(getCachedFileEditorTabs("hidden")[0]?.value).toBe("unsaved text");
		for (const draft of getFileEditorDrafts("all")) discardFileEditorDraft(draft);
		request();
		expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({ decision: "ready" }));
	});

	it("blocks updates during saves and rejects stale generation requests without responding", () => {
		cache("saving", true);
		mount();
		request("update");
		expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({ decision: "blocked" }));
		const calls = reply.mock.calls.length;
		request("quit", "old");
		expect(reply).toHaveBeenCalledTimes(calls);
		expect(getCachedFileEditorTabs("saving")[0]?.isSaving).toBe(true);
	});

	it("uses latest app handlers and protects drafts while allowing clean offline quit", () => {
		mount();
		act(() => command?.({ runtimeGeneration: "current", command: "new-task" }));
		expect(props.handlers.newTask).toHaveBeenCalledTimes(1);
		props = { ...props, taskDraftCount: 1 };
		mount();
		request();
		expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({ decision: "blocked" }));
		props = { ...props, taskDraftCount: 0, runtimeConnected: false };
		mount();
		request();
		expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({ decision: "ready" }));
		request("update");
		expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({ decision: "blocked" }));
	});

	it("seals input before final readiness and unlocks only the matching transition", () => {
		mount();
		act(() =>
			preflight?.({
				requestId: "final",
				runtimeGeneration: "current",
				reason: "quit",
				freezeUntil: Date.now() + 10_000,
			}),
		);
		expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({ decision: "ready" }));
		expect(publish.mock.lastCall?.[0].commands).toEqual([]);
		const key = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
		container.dispatchEvent(key);
		expect(key.defaultPrevented).toBe(true);
		act(() => command?.({ runtimeGeneration: "current", command: "new-task" }));
		expect(props.handlers.newTask).not.toHaveBeenCalled();
		act(() => release?.({ requestId: "stale", runtimeGeneration: "current" }));
		act(() => command?.({ runtimeGeneration: "current", command: "new-task" }));
		expect(props.handlers.newTask).not.toHaveBeenCalled();
		act(() => release?.({ requestId: "final", runtimeGeneration: "current" }));
		act(() => command?.({ runtimeGeneration: "current", command: "new-task" }));
		expect(props.handlers.newTask).toHaveBeenCalledOnce();
	});
	it.each(["pending", "failed"] as const)(
		"blocks zero-dirty preflight without sealing while recovery is %s",
		(state) => {
			vi.mocked(getDesktopFileEditorRecoveryCommitStatus).mockReturnValue({
				loaded: true,
				pending: true,
				busy: state === "pending",
				problem: state === "failed" ? "storage" : null,
				desiredRevision: 2,
				committedRevision: 1,
				ready: false,
			});
			mount();
			act(() =>
				preflight?.({
					requestId: "storage",
					runtimeGeneration: "current",
					reason: "reload",
					freezeMode: "navigation",
					freezeUntil: Date.now() + 10_000,
				}),
			);
			expect(reply).toHaveBeenLastCalledWith(
				expect.objectContaining({ decision: "blocked", status: expect.objectContaining({ dirtyEditorCount: 0 }) }),
			);
			const key = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
			container.dispatchEvent(key);
			expect(key.defaultPrevented).toBe(false);
			act(() => command?.({ runtimeGeneration: "current", command: "new-task" }));
			expect(props.handlers.newTask).toHaveBeenCalledOnce();
		},
	);
	it("keeps a navigation replacement frozen past thirty seconds and releases only explicit matching cancellation", () => {
		vi.useFakeTimers();
		mount();
		act(() =>
			preflight?.({
				requestId: "navigation",
				runtimeGeneration: "current",
				reason: "reload",
				freezeUntil: Date.now() + 30_000,
				freezeMode: "navigation",
			}),
		);
		expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({ decision: "ready" }));
		act(() => vi.advanceTimersByTime(60_000));
		const key = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
		container.dispatchEvent(key);
		expect(key.defaultPrevented).toBe(true);
		act(() => command?.({ runtimeGeneration: "current", command: "new-task" }));
		expect(props.handlers.newTask).not.toHaveBeenCalled();
		expect(publish.mock.lastCall?.[0].commands).toEqual([]);
		act(() =>
			preflight?.({
				requestId: "replacement",
				runtimeGeneration: "current",
				reason: "quit",
				freezeUntil: Date.now() + 1_000,
			}),
		);
		expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({ decision: "blocked" }));
		act(() => release?.({ requestId: "replacement", runtimeGeneration: "current" }));
		act(() => release?.({ requestId: "navigation", runtimeGeneration: "current" }));
		act(() => command?.({ runtimeGeneration: "current", command: "new-task" }));
		expect(props.handlers.newTask).toHaveBeenCalledOnce();
	});
	it("never acknowledges an expired navigation admission as ready", () => {
		mount();
		act(() =>
			preflight?.({
				requestId: "late",
				runtimeGeneration: "current",
				reason: "reload",
				freezeUntil: Date.now() - 1,
				freezeMode: "navigation",
			}),
		);
		expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({ decision: "blocked" }));
		act(() => command?.({ runtimeGeneration: "current", command: "new-task" }));
		expect(props.handlers.newTask).toHaveBeenCalledOnce();
	});

	it("keeps ordinary browser mode free of desktop listeners", () => {
		vi.mocked(getRuntimeEnvironment).mockReturnValue({ kind: "browser", runtimeOrigin: "http://localhost" });
		mount();
		expect(command).toBeUndefined();
		expect(preflight).toBeUndefined();
	});

	it("preserves Settings and prompt-shortcut drafts until their ordinary save or cancel flow resolves them", () => {
		let dirty = true;
		const unregister = registerDesktopDraftProtection("Settings", () => dirty);
		try {
			mount();
			request("update");
			expect(reply).toHaveBeenLastCalledWith(
				expect.objectContaining({ decision: "blocked", status: expect.objectContaining({ dirtyEditorCount: 1 }) }),
			);
			dirty = false;
			request("update");
			expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({ decision: "ready" }));
		} finally {
			unregister();
		}
	});
});
