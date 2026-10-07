import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeEnvironment } from "@/runtime/runtime-environment";
import type { DesktopAppCommand, DesktopBridge } from "../../../../src/shared/desktop-bridge-contract";
import { useAppHotkeys } from "./use-app-hotkeys";
import { useDesktopApp } from "./use-desktop-app";

vi.mock("@/runtime/runtime-environment", () => ({ getRuntimeEnvironment: vi.fn() }));
const cases = [
	["settings", ",", false, "settings"],
	["diagnostics", "d", true, "diagnostics"],
	["new-task", "n", false, "newTask"],
	["open-project", "o", false, "openProject"],
	["toggle-shell", "j", false, "toggleShell"],
	["file-finder", "p", false, "fileFinder"],
	["text-search", "f", true, "textSearch"],
] as const;

describe("exclusive native shortcut delivery", () => {
	let root: Root, container: HTMLDivElement;
	let deliver: ((command: DesktopAppCommand) => void) | undefined;
	const handlers = {
		settings: vi.fn(),
		diagnostics: vi.fn(),
		newTask: vi.fn(),
		openProject: vi.fn(),
		navigate: vi.fn(),
		fileFinder: vi.fn(),
		textSearch: vi.fn(),
		toggleShell: vi.fn(),
	};
	function Harness() {
		useAppHotkeys({
			selectedCard: null,
			canUseCreateTaskShortcut: true,
			currentProjectId: "project",
			handleToggleDetailTerminal: handlers.toggleShell,
			handleToggleHomeTerminal: handlers.toggleShell,
			handleOpenCreateTask: handlers.newTask,
			handleOpenSettings: handlers.settings,
			handleToggleDiagnosticsPanel: handlers.diagnostics,
			handleToggleFileFinder: handlers.fileFinder,
			handleToggleTextSearch: handlers.textSearch,
		});
		useDesktopApp({
			handlers,
			projectActionsEnabled: true,
			runtimeConnected: true,
			notificationProjects: {},
			taskDraftCount: 0,
		});
		return (
			<>
				<input aria-label="Editor input" />
				<div role="dialog" aria-label="Existing dialog">
					<button type="button">Dialog action</button>
				</div>
				<textarea className="xterm-helper-textarea" aria-label="Terminal input" />
			</>
		);
	}
	beforeEach(() => {
		vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X)");
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		const bridge: DesktopBridge = {
			version: 1,
			bootstrap: {
				runtimeGeneration: "current",
				runtimeOrigin: "http://127.0.0.1:12345",
				capabilities: { desktop: true, nativeDialogs: true, nativeNotifications: false },
			},
			onCommand: (listener) => {
				deliver = listener;
				return () => {
					deliver = undefined;
				};
			},
		};
		Object.defineProperty(window, "quarterdeckDesktop", { value: bridge, configurable: true });
		vi.mocked(getRuntimeEnvironment).mockReturnValue({ kind: "desktop", ...bridge.bootstrap });
		act(() => root.render(<Harness />));
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		Reflect.deleteProperty(window, "quarterdeckDesktop");
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});
	it.each(cases)("delivers %s once with input, dialog, or terminal focus", (command, key, shiftKey, handler) => {
		for (const focus of [
			container.querySelector("input"),
			container.querySelector("button"),
			container.querySelector("textarea"),
		]) {
			if (!focus) throw new Error("Expected focus target");
			focus.focus();
			vi.clearAllMocks();
			act(() => {
				focus.dispatchEvent(
					new KeyboardEvent("keydown", {
						key,
						code: `Key${key.toUpperCase()}`,
						metaKey: true,
						shiftKey,
						bubbles: true,
						cancelable: true,
					}),
				);
				deliver?.({ runtimeGeneration: "current", command });
				focus.dispatchEvent(new KeyboardEvent("keyup", { key, metaKey: true, shiftKey, bubbles: true }));
			});
			expect(handlers[handler]).toHaveBeenCalledTimes(1);
			for (const [name, action] of Object.entries(handlers))
				if (name !== handler) expect(action).not.toHaveBeenCalled();
		}
	});
	it("keeps the same browser shortcuts active with focused form input", () => {
		act(() => root.unmount());
		root = createRoot(container);
		Reflect.deleteProperty(window, "quarterdeckDesktop");
		vi.mocked(getRuntimeEnvironment).mockReturnValue({ kind: "browser", runtimeOrigin: "http://localhost" });
		act(() => root.render(<Harness />));
		const input = container.querySelector("input");
		if (!input) throw new Error("Expected editor input");
		input.focus();
		for (const [command, key, shiftKey, handler] of cases.filter(([command]) =>
			["toggle-shell", "file-finder", "text-search", "diagnostics"].includes(command),
		)) {
			vi.clearAllMocks();
			act(() => {
				input.dispatchEvent(
					new KeyboardEvent("keydown", {
						key,
						code: `Key${key.toUpperCase()}`,
						metaKey: true,
						shiftKey,
						bubbles: true,
						cancelable: true,
					}),
				);
				input.dispatchEvent(
					new KeyboardEvent("keyup", {
						key,
						code: `Key${key.toUpperCase()}`,
						metaKey: true,
						shiftKey,
						bubbles: true,
					}),
				);
			});
			expect(handlers[handler], command).toHaveBeenCalledTimes(1);
		}
	});
});
