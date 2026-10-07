import { EventEmitter } from "node:events";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { showAppToast } from "@/components/app-toaster";
import {
	clearCachedFileEditorTabs,
	registerFileEditorScope,
	setCachedFileEditorTabs,
} from "@/hooks/git/file-editor-cache";
import { createFileEditorTab } from "@/hooks/git/file-editor-workspace";
import { useDesktopFileEditorRecovery } from "@/hooks/git/use-desktop-file-editor-recovery";
import { DesktopLaunchRequests } from "../../../../desktop/src/desktop-launch-requests";
import { createDesktopBridge } from "../../../../desktop/src/preload-bridge";
import type { ApprovedRenderer } from "../../../../desktop/src/renderer-admission";
import { DesktopRendererCommands } from "../../../../desktop/src/renderer-commands";
import { RuntimeSelection } from "../../../../desktop/src/runtime-selection";
import type { DesktopCommandAvailability } from "../../../../src/shared/desktop-bridge-contract";
import type { DesktopLaunchRequest } from "../../../../src/shared/desktop-launch-contract";
import { type UseDesktopAppInput, useDesktopApp } from "./use-desktop-app";

const database = vi.hoisted(() => {
	let read!: () => void;
	let commit!: () => void;
	const reading = new Promise<void>((resolve) => {
		read = resolve;
	});
	const committing = new Promise<void>((resolve) => {
		commit = resolve;
	});
	return {
		read: () => read(),
		commit: () => commit(),
		adapter: {
			read: vi.fn(async () => {
				await reading;
				return undefined;
			}),
			write: vi.fn(async () => {
				await committing;
			}),
			close: vi.fn(),
		},
	};
});
vi.mock("@/runtime/runtime-environment", () => ({
	getRuntimeEnvironment: () => ({ kind: "desktop", runtimeGeneration: "current" }),
}));
vi.mock("@/components/app-toaster", () => ({ showAppToast: vi.fn() }));
vi.mock("@/hooks/git/file-editor-recovery-indexed-db", () => ({
	createFileEditorRecoveryIndexedDB: () => database.adapter,
}));

function Harness(input: UseDesktopAppInput): null {
	useDesktopFileEditorRecovery();
	useDesktopApp(input);
	return null;
}

describe("npm project intent across native and renderer readiness", () => {
	it("waits through initial recovery read and commit, then consumes a later dirty-work refusal once", async () => {
		const ipcMain = new EventEmitter();
		const ipcRenderer = new EventEmitter();
		const publications: DesktopCommandAvailability[] = [];
		const contents = {
			id: 42,
			mainFrame: { url: "app://quarterdeck/" },
			getURL: () => "app://quarterdeck/",
			isDestroyed: () => false,
			send: (channel: string, payload: unknown) => ipcRenderer.emit(channel, null, payload),
		} as unknown as ApprovedRenderer["contents"];
		const renderer: ApprovedRenderer = { contents, generation: "current", documentId: "document-current" };
		const selection = new RuntimeSelection();
		const selected = selection.select({
			generation: "current",
			origin: "http://127.0.0.1:54321",
			clientToken: "a".repeat(43),
		});
		let launches: DesktopLaunchRequests | undefined;
		const commands = new DesktopRendererCommands(
			ipcMain as unknown as ConstructorParameters<typeof DesktopRendererCommands>[0],
			() => renderer,
			selection,
			5_000,
			{ onAvailability: () => launches?.deliver() },
		);
		const bridge = createDesktopBridge(
			{
				runtimeOrigin: selected.origin,
				runtimeGeneration: selected.generation,
				capabilities: { desktop: true, nativeDialogs: false, nativeNotifications: false },
			},
			{
				on: (channel, listener) => {
					ipcRenderer.on(channel, listener);
				},
				removeListener: (channel, listener) => {
					ipcRenderer.removeListener(channel, listener);
				},
				send: (channel, payload) => {
					if ("availability" in (payload as Record<string, unknown>))
						publications.push((payload as { availability: DesktopCommandAvailability }).availability);
					ipcMain.emit(channel, { sender: contents, senderFrame: contents.mainFrame }, payload);
				},
				invoke: async () => ({ kind: "failed" }),
			},
			renderer.documentId ?? "",
		);
		const request: DesktopLaunchRequest = {
			schemaVersion: 1,
			version: "0.12.8",
			arch: "arm64",
			buildId: "build-current",
			appAsarSha256: "a".repeat(64),
			appPath: "/Applications/Quarterdeck.app",
			stateHome: "/private/tmp/state",
			projectPath: "/private/tmp/initial",
		};
		launches = new DesktopLaunchRequests(request, (projectPath) =>
			commands.openProject({ runtimeGeneration: "current", projectPath }),
		);
		const open = vi.fn(async (_path: string, canNavigate: () => boolean) => {
			expect(canNavigate()).toBe(true);
		});
		const input: UseDesktopAppInput = {
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
			taskDraftCount: 0,
			notificationProjects: {},
			openProjectByPath: open,
		};
		Object.defineProperty(window, "quarterdeckDesktop", { value: bridge, configurable: true });
		const node = document.createElement("div");
		const root = createRoot(node);
		try {
			await act(async () => {
				root.render(<Harness {...input} />);
			});
			expect(publications.at(-1)?.projectLaunchReady).toBe(false);
			act(() => {
				expect(launches?.accept(request)).toBeNull();
			});
			expect(open).not.toHaveBeenCalled();
			await act(async () => {
				database.read();
			});
			expect(database.adapter.write).toHaveBeenCalledOnce();
			expect(publications.at(-1)?.projectLaunchReady).toBe(false);
			expect(open).not.toHaveBeenCalled();
			await act(async () => {
				database.commit();
			});
			expect(publications.at(-1)?.projectLaunchReady).toBe(true);
			expect(open).toHaveBeenCalledExactlyOnceWith(request.projectPath, expect.any(Function));
			act(() => {
				registerFileEditorScope("hidden", { projectId: "p", taskId: null });
				const tab = createFileEditorTab("draft.ts", {
					content: "saved",
					contentHash: "hash",
					language: "typescript",
					binary: false,
					truncated: false,
					size: 5,
				});
				setCachedFileEditorTabs("hidden", [{ ...tab, value: "dirty" }]);
				launches?.accept({ ...request, projectPath: "/private/tmp/refused" });
			});
			expect(open).toHaveBeenCalledTimes(1);
			expect(showAppToast).toHaveBeenCalledWith(
				expect.objectContaining({ message: expect.stringContaining("Save or cancel") }),
			);
			await act(async () => {
				clearCachedFileEditorTabs();
			});
			launches.deliver();
			expect(open).toHaveBeenCalledTimes(1);
		} finally {
			await act(async () => {
				root.unmount();
			});
			commands.dispose();
			clearCachedFileEditorTabs();
			Reflect.deleteProperty(window, "quarterdeckDesktop");
		}
	});
});
