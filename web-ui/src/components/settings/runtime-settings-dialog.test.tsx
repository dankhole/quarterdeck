import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeSettingsDialog as RuntimeSettingsDialogComponent } from "@/components/settings/runtime-settings-dialog";
import type { SettingsProject } from "@/components/settings/settings-navigation";
import type { RuntimeConfigResponse, RuntimeConfigSaveRequest } from "@/runtime/types";
import { createTestAgentDef, createTestRuntimeConfigResponse } from "@/test-utils/runtime-config-factory";

const resetLayoutCustomizationsMock = vi.hoisted(() => vi.fn());
const saveMock = vi.hoisted(() => vi.fn(async (_request: RuntimeConfigSaveRequest): Promise<boolean> => true));
const refreshMock = vi.hoisted(() => vi.fn());
const configTargetsMock = vi.hoisted(() => vi.fn());
const restoreDefaultsMock = vi.hoisted(() => vi.fn(async (): Promise<unknown> => ({})));
const configHookState = vi.hoisted(() => ({
	isLoading: false,
	isSaving: false,
	configOverride: undefined as RuntimeConfigResponse | null | undefined,
}));

const DEFAULT_PROJECTS: readonly SettingsProject[] = [
	{ id: "project-1", name: "Test project", path: "/tmp/project" },
	{ id: "atlas", name: "Atlas", path: "/atlas" },
];

function RuntimeSettingsDialog({
	projects = DEFAULT_PROJECTS,
	...props
}: Omit<ComponentProps<typeof RuntimeSettingsDialogComponent>, "projects"> & {
	projects?: readonly SettingsProject[];
}): React.ReactElement | null {
	return <RuntimeSettingsDialogComponent {...props} projects={projects} />;
}

vi.mock("@runtime-agent-catalog", () => ({
	getRuntimeAgentCatalogEntry: vi.fn((agentId: string) => ({
		id: agentId,
		installUrl: null,
	})),
	getRuntimeLaunchSupportedAgentCatalog: vi.fn(() => [
		{ id: "claude", label: "Claude Code", binary: "claude" },
		{ id: "codex", label: "OpenAI Codex", binary: "codex" },
	]),
}));

vi.mock("@/resize/layout-customizations", () => ({
	useLayoutCustomizations: () => ({
		layoutResetNonce: 0,
		resetLayoutCustomizations: resetLayoutCustomizationsMock,
	}),
}));

vi.mock("@/runtime/use-runtime-config", () => ({
	useRuntimeConfig: (_open: boolean, projectId: string | null, initialConfig?: RuntimeConfigResponse | null) => {
		configTargetsMock(projectId);
		return {
			config:
				configHookState.configOverride === undefined ? (initialConfig ?? null) : configHookState.configOverride,
			isLoading: configHookState.isLoading,
			isSaving: configHookState.isSaving,
			refresh: refreshMock,
			save: saveMock,
		};
	},
}));

vi.mock("@/runtime/runtime-config-query", () => ({
	openFileOnHost: vi.fn(async () => ({ outcome: "native" })),
	saveRuntimeConfig: restoreDefaultsMock,
}));

vi.mock("@/utils/notification-audio", () => ({
	notificationAudioPlayer: {
		ensureContext: vi.fn(),
		preloadSounds: vi.fn(async () => {}),
		play: vi.fn(),
		dispose: vi.fn(),
		loadedBufferCount: 0,
	},
}));

function findButtonByText(container: ParentNode, text: string): HTMLButtonElement | null {
	return (Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === text) ??
		null) as HTMLButtonElement | null;
}

function findSwitchByLabel(container: ParentNode, label: string): HTMLButtonElement | null {
	return (
		Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="switch"]')).find((control) => {
			const id = control.getAttribute("aria-labelledby");
			return (id ? document.getElementById(id)?.textContent?.trim() : control.getAttribute("aria-label")) === label;
		}) ?? null
	);
}

async function navigateTo(title: string): Promise<void> {
	const nav = document.body.querySelector('nav[aria-label="Settings categories"]');
	const button = nav && findButtonByText(nav, title);
	expect(button).toBeInstanceOf(HTMLButtonElement);
	await act(async () => button?.click());
	expect(document.getElementById("settings-category-heading")?.textContent).toBe(title);
}

function createSavedConfig(overrides?: Partial<RuntimeConfigResponse>): RuntimeConfigResponse {
	return createTestRuntimeConfigResponse({
		detectedCommands: [],
		globalConfigPath: "/tmp/.quarterdeck/config.json",
		projectConfigPath: null,
		llmConfigured: true,
		...overrides,
	});
}

const savedConfig = createSavedConfig();

describe("RuntimeSettingsDialog", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		resetLayoutCustomizationsMock.mockReset();
		refreshMock.mockReset();
		configTargetsMock.mockClear();
		restoreDefaultsMock.mockReset();
		restoreDefaultsMock.mockResolvedValue({});
		configHookState.isLoading = false;
		configHookState.isSaving = false;
		configHookState.configOverride = undefined;
		saveMock.mockReset();
		saveMock.mockResolvedValue(true);
		Object.defineProperty(window, "quarterdeckDesktopEnvironment", {
			configurable: true,
			value: {
				version: 1,
				getSnapshot: async () => ({
					ownership: "owned",
					source: "inherited",
					failureReason: null,
					appliedDirectories: [],
					appliedImportLoginShellEnvironment: false,
					preferences: { importLoginShellEnvironment: false, extraExecutableDirectories: [] },
				}),
				request: vi.fn(),
			},
		});
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
		Reflect.deleteProperty(window, "quarterdeckDesktopEnvironment");
		document.body.innerHTML = "";
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("opens generic settings on Agents with grouped rail and a labelled narrow-screen select", async () => {
		await act(async () =>
			root.render(
				<RuntimeSettingsDialog open projectId={null} initialConfig={savedConfig} onOpenChange={() => {}} />,
			),
		);
		expect(document.getElementById("settings-category-heading")?.textContent).toBe("Agents");
		expect(document.body.querySelector('nav button[aria-current="page"]')?.textContent).toBe("Agents");
		const groupLabels = Array.from(document.body.querySelectorAll("nav ul[aria-labelledby]")).map(
			(list) => document.getElementById(list.getAttribute("aria-labelledby")!)?.textContent,
		);
		expect(groupLabels).toEqual(["All projects", "Project: No project selected", "This desktop", "Tools"]);
		const select = document.getElementById("settings-category") as HTMLSelectElement;
		expect(document.body.querySelector('label[for="settings-category"]')?.textContent).toBe("Settings category");
		expect(Array.from(select.querySelectorAll("optgroup")).map((group) => group.label)).toEqual([
			"All projects",
			"Project: No project selected",
			"This desktop",
			"Tools",
		]);
		await act(async () => {
			select.value = "notifications";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(document.getElementById("settings-page-notifications")?.hidden).toBe(false);
		expect(document.getElementById("settings-page-agents")?.hidden).toBe(true);
	});

	it("explains config load failures outside the selected page and offers a retry", async () => {
		await act(async () =>
			root.render(<RuntimeSettingsDialog open projectId={null} projects={[]} onOpenChange={() => {}} />),
		);
		const alert = document.body.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain("Could not load runtime settings");
		expect(alert?.closest("[hidden]")).toBeNull();
		expect(findButtonByText(document.body, "Save changes")?.disabled).toBe(true);
		await navigateTo("Task creation");
		expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("Could not load runtime settings");
		await act(async () => findButtonByText(document.body, "Retry loading settings")?.click());
		expect(refreshMock).toHaveBeenCalledOnce();
	});

	it("honors the initial shortcut entry without a project, ignores entry changes while open, and resets on reopen", async () => {
		const props = { projectId: null, projects: [], initialConfig: savedConfig, onOpenChange: vi.fn() };
		await act(async () => root.render(<RuntimeSettingsDialog {...props} open initialSection="shortcuts" />));
		expect(document.getElementById("settings-category-heading")?.textContent).toBe("Command shortcuts");
		expect(document.getElementById("settings-page-shortcuts")?.textContent).toContain("No project selected");
		await navigateTo("Agents");
		await act(async () => root.render(<RuntimeSettingsDialog {...props} open initialSection={null} />));
		await act(async () => root.render(<RuntimeSettingsDialog {...props} open initialSection="shortcuts" />));
		expect(document.getElementById("settings-category-heading")?.textContent).toBe("Agents");
		await act(async () => root.render(<RuntimeSettingsDialog {...props} open={false} />));
		await act(async () => root.render(<RuntimeSettingsDialog {...props} open />));
		expect(document.getElementById("settings-category-heading")?.textContent).toBe("Agents");
	});

	it("blocks closing and repeated submission while the main save is pending", async () => {
		const onOpenChange = vi.fn();
		const props = { open: true, projectId: "project-1", initialConfig: savedConfig, onOpenChange };
		await act(async () => root.render(<RuntimeSettingsDialog {...props} />));
		await navigateTo("Terminal & editor");
		await act(async () => findSwitchByLabel(document.body, "Show generated worktrees")?.click());
		configHookState.isSaving = true;
		await act(async () => root.render(<RuntimeSettingsDialog {...props} />));
		expect(findButtonByText(document.body, "Save changes")?.disabled).toBe(true);
		expect(findButtonByText(document.body, "Cancel")?.disabled).toBe(true);
		await act(async () => {
			findButtonByText(document.body, "Cancel")?.click();
			document.body.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]')?.click();
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		expect(onOpenChange).not.toHaveBeenCalled();
		configHookState.isSaving = false;
		await act(async () => root.render(<RuntimeSettingsDialog {...props} />));
		expect(findSwitchByLabel(document.body, "Show generated worktrees")?.getAttribute("aria-checked")).toBe("true");
		await act(async () => findButtonByText(document.body, "Cancel")?.click());
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("keeps the unsaved-change live region mounted before the first edit and after reverting", async () => {
		await act(async () =>
			root.render(
				<RuntimeSettingsDialog
					open
					projectId={null}
					projects={[]}
					initialConfig={savedConfig}
					onOpenChange={() => {}}
				/>,
			),
		);
		const liveRegion = document.getElementById("settings-unsaved-changes");
		expect(liveRegion?.getAttribute("aria-live")).toBe("polite");
		expect(liveRegion?.textContent).toBe("");
		await navigateTo("Terminal & editor");
		const toggle = findSwitchByLabel(document.body, "Show generated worktrees");
		await act(async () => toggle?.click());
		expect(document.getElementById("settings-unsaved-changes")).toBe(liveRegion);
		expect(liveRegion?.textContent).toContain("Unsaved changes: All projects");
		await act(async () => toggle?.click());
		expect(document.getElementById("settings-unsaved-changes")).toBe(liveRegion);
		expect(liveRegion?.textContent).toBe("");
	});

	it("opens command shortcuts immediately and identifies the settings target by name and path", async () => {
		await act(async () =>
			root.render(
				<RuntimeSettingsDialog
					open
					projectId="target"
					projects={[{ id: "target", name: "folder", displayName: "Actual project", path: "/workspace/actual" }]}
					initialSection="shortcuts"
					initialConfig={createSavedConfig({ projectConfigPath: "/workspace/actual/config.json" })}
					onOpenChange={() => {}}
				/>,
			),
		);
		expect(document.getElementById("settings-category-heading")?.textContent).toBe("Command shortcuts");
		const header = document.getElementById("settings-category-heading")?.parentElement;
		expect(header?.textContent).toContain("Applies only to Actual project");
		expect(header?.textContent).toContain("/workspace/actual");
		const projectFolder = header?.querySelector("details");
		expect(projectFolder?.open).toBe(false);
		expect(projectFolder?.querySelector("summary")?.textContent).toBe("Project folder");
		const fileAction = header?.querySelector('button[aria-label="Open configuration file for Actual project"]');
		expect(fileAction?.textContent).toBe("Open configuration file");
		expect(fileAction?.getAttribute("title")).toBe("/workspace/actual/config.json");
		expect(document.getElementById("settings-page-shortcuts")?.textContent).not.toContain("Restore defaults");
		await navigateTo("Task creation");
		expect(document.getElementById("settings-page-task-creation")?.textContent).toContain(
			"new tasks in Actual project",
		);
	});

	it("passes the settings target's folder-only mode to task creation without changing its saved preference", async () => {
		await act(async () =>
			root.render(
				<RuntimeSettingsDialog
					open
					projectId="folder"
					projects={[{ id: "folder", name: "Assets", path: "/assets", folderOnly: true }]}
					initialConfig={createSavedConfig({
						projectConfigPath: "/assets/config.json",
						defaultUseWorktree: true,
						worktreeSetupScript: "preserve setup",
					})}
					onOpenChange={() => {}}
				/>,
			),
		);
		await navigateTo("Task creation");
		expect(document.getElementById("settings-page-task-creation")?.textContent).toContain(
			"Shared project folder (fixed)",
		);
		expect(document.body.querySelector('input[type="radio"]')).toBeNull();
		expect(document.body.querySelector<HTMLTextAreaElement>("#runtime-settings-worktree-setup")?.value).toBe(
			"preserve setup",
		);
		expect(document.body.querySelector<HTMLTextAreaElement>("#runtime-settings-worktree-setup")?.disabled).toBe(true);
		expect(findButtonByText(document.body, "Save changes")?.disabled).toBe(true);
	});

	it("does not expose project controls for an unavailable settings destination", async () => {
		await act(async () =>
			root.render(
				<RuntimeSettingsDialog
					open
					projectId="missing"
					projects={[
						{
							id: "missing",
							name: "Missing folder",
							path: "/missing",
							availability: { status: "unavailable", reason: "missing" },
						},
					]}
					initialConfig={createSavedConfig({ projectConfigPath: "/missing/config.json" })}
					onOpenChange={() => {}}
				/>,
			),
		);
		expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
			"All-project settings are also disabled in this project-bound session",
		);
		expect(findButtonByText(document.body, "Save changes")?.disabled).toBe(true);
		await navigateTo("Notifications");
		expect(findSwitchByLabel(document.body, "Play sounds when tasks need attention")?.disabled).toBe(true);
		await navigateTo("Task creation");
		expect(document.getElementById("settings-page-task-creation")?.textContent).toContain(
			"project folder is unavailable",
		);
		expect(document.body.querySelector('input[type="radio"]')).toBeNull();
		await navigateTo("Command shortcuts");
		expect(document.getElementById("settings-page-shortcuts")?.textContent).toContain(
			"project folder is unavailable",
		);
	});

	it("retains mixed-scope drafts across categories and saves hidden changes through one main save", async () => {
		await act(async () =>
			root.render(
				<RuntimeSettingsDialog
					open
					projectId="atlas"
					projects={[{ id: "atlas", name: "Atlas", path: "/atlas" }]}
					initialConfig={createSavedConfig({ projectConfigPath: "/atlas/config.json", defaultUseWorktree: true })}
					onOpenChange={() => {}}
				/>,
			),
		);
		await navigateTo("Task creation");
		await act(async () =>
			document.body.querySelector<HTMLInputElement>('input[type="radio"][value="shared"]')?.click(),
		);
		await navigateTo("Terminal & editor");
		await act(async () => findSwitchByLabel(document.body, "Show generated worktrees")?.click());
		expect(document.body.textContent).toContain("Unsaved changes: All projects; Project: Atlas");
		await navigateTo("Task creation");
		expect(document.body.querySelector<HTMLInputElement>('input[type="radio"][value="shared"]')?.checked).toBe(true);
		await navigateTo("Agents");
		await act(async () => findButtonByText(document.body, "Save changes")?.click());
		expect(saveMock).toHaveBeenCalledTimes(1);
		expect(saveMock).toHaveBeenCalledWith(
			expect.objectContaining({ defaultUseWorktree: false, showGeneratedWorktrees: true }),
		);
	});

	it("discards drafts on cancel and resets category selection on reopen", async () => {
		const onOpenChange = vi.fn();
		const props = { projectId: "atlas", initialConfig: savedConfig, onOpenChange };
		await act(async () => root.render(<RuntimeSettingsDialog {...props} open />));
		await navigateTo("Terminal & editor");
		await act(async () => findSwitchByLabel(document.body, "Show generated worktrees")?.click());
		await act(async () => findButtonByText(document.body, "Cancel")?.click());
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(saveMock).not.toHaveBeenCalled();
		await act(async () => root.render(<RuntimeSettingsDialog {...props} open={false} />));
		await act(async () => root.render(<RuntimeSettingsDialog {...props} open />));
		expect(document.getElementById("settings-category-heading")?.textContent).toBe("Agents");
		expect(findButtonByText(document.body, "Save changes")?.disabled).toBe(true);
		await navigateTo("Terminal & editor");
		expect(findSwitchByLabel(document.body, "Show generated worktrees")?.getAttribute("aria-checked")).toBe("false");
	});

	it("keeps save failures visible outside the selected page and preserves every draft", async () => {
		saveMock.mockResolvedValue(false);
		const onOpenChange = vi.fn();
		await act(async () =>
			root.render(
				<RuntimeSettingsDialog open projectId={null} initialConfig={savedConfig} onOpenChange={onOpenChange} />,
			),
		);
		await navigateTo("Terminal & editor");
		await act(async () => findSwitchByLabel(document.body, "Show generated worktrees")?.click());
		await act(async () => findButtonByText(document.body, "Save changes")?.click());
		expect(onOpenChange).not.toHaveBeenCalled();
		await navigateTo("Agents");
		expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("Could not save runtime settings");
		expect(document.body.querySelector('[role="alert"]')?.closest("[hidden]")).toBeNull();
		await navigateTo("Terminal & editor");
		expect(findSwitchByLabel(document.body, "Show generated worktrees")?.getAttribute("aria-checked")).toBe("true");
		expect(saveMock.mock.calls[0]?.[0]).not.toHaveProperty("defaultUseWorktree");
	});

	it("pins open drafts and the save destination when the surrounding project changes", async () => {
		const configA = createSavedConfig({ projectConfigPath: "/alpha/config.json", defaultUseWorktree: true });
		const configB = createSavedConfig({
			projectConfigPath: "/beta/config.json",
			defaultUseWorktree: true,
			worktreeSetupScript: "beta setup",
		});
		const onOpenChange = vi.fn();
		const projects = [
			{ id: "alpha", name: "Alpha", path: "/alpha" },
			{ id: "beta", name: "Beta", path: "/beta" },
		];
		await act(async () =>
			root.render(
				<RuntimeSettingsDialog
					open
					projectId="alpha"
					projects={projects}
					initialConfig={configA}
					onOpenChange={onOpenChange}
				/>,
			),
		);
		await navigateTo("Task creation");
		await act(async () =>
			document.body.querySelector<HTMLInputElement>('input[type="radio"][value="shared"]')?.click(),
		);
		await act(async () =>
			root.render(
				<RuntimeSettingsDialog
					open
					projectId="beta"
					projects={projects}
					initialConfig={configB}
					onOpenChange={onOpenChange}
				/>,
			),
		);
		expect(document.body.textContent).toContain("Settings remain for Alpha");
		expect(document.getElementById("settings-category-heading")?.parentElement?.textContent).toContain(
			"only to Alpha",
		);
		expect(document.body.querySelector<HTMLInputElement>('input[type="radio"][value="shared"]')?.checked).toBe(true);
		expect(configTargetsMock.mock.calls.every(([id]) => id === "alpha")).toBe(true);
		await act(async () => findButtonByText(document.body, "Save changes")?.click());
		expect(saveMock).toHaveBeenCalledWith(
			expect.objectContaining({ defaultUseWorktree: false, worktreeSetupScript: "" }),
		);
		await act(async () =>
			root.render(<RuntimeSettingsDialog open={false} projectId="beta" onOpenChange={onOpenChange} />),
		);
		await act(async () =>
			root.render(
				<RuntimeSettingsDialog
					open
					projectId="beta"
					projects={projects}
					initialConfig={configB}
					onOpenChange={onOpenChange}
				/>,
			),
		);
		expect(configTargetsMock).toHaveBeenLastCalledWith("beta");
		await navigateTo("Task creation");
		expect(document.body.querySelector<HTMLTextAreaElement>("#runtime-settings-worktree-setup")?.value).toBe(
			"beta setup",
		);
	});

	it("resolves the locked project from the live registry through rename, removal, and unavailability", async () => {
		const config = createSavedConfig({ projectConfigPath: "/alpha/config.json", defaultUseWorktree: true });
		const props = { open: true, initialConfig: config, onOpenChange: vi.fn() };
		const beta = { id: "beta", name: "Beta", path: "/beta" };
		await act(async () =>
			root.render(
				<RuntimeSettingsDialog
					{...props}
					projectId="alpha"
					projects={[{ id: "alpha", name: "Alpha", path: "/alpha" }, beta]}
				/>,
			),
		);
		await navigateTo("Task creation");
		await act(async () =>
			document.body.querySelector<HTMLInputElement>('input[type="radio"][value="shared"]')?.click(),
		);
		const renamed = { id: "alpha", name: "alpha-folder", displayName: "Renamed Alpha", path: "/renamed-alpha" };
		await act(async () =>
			root.render(<RuntimeSettingsDialog {...props} projectId="beta" projects={[renamed, beta]} />),
		);
		expect(document.getElementById("settings-category-heading")?.parentElement?.textContent).toContain(
			"only to Renamed Alpha",
		);
		expect(document.getElementById("settings-category-heading")?.parentElement?.textContent).toContain(
			"/renamed-alpha",
		);
		expect(document.body.querySelector<HTMLInputElement>('input[type="radio"][value="shared"]')?.checked).toBe(true);
		await act(async () => root.render(<RuntimeSettingsDialog {...props} projectId="beta" projects={[beta]} />));
		expect(document.body.textContent).toContain("Unknown project");
		expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("not registered");
		expect(findButtonByText(document.body, "Save changes")?.disabled).toBe(true);
		await navigateTo("Agents");
		expect(document.body.querySelector('[role="alert"]')?.closest("[hidden]")).toBeNull();
		await act(async () =>
			root.render(
				<RuntimeSettingsDialog
					{...props}
					projectId="beta"
					projects={[{ ...renamed, availability: { status: "unavailable", reason: "missing" } }, beta]}
				/>,
			),
		);
		expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("folder is unavailable");
		expect(findButtonByText(document.body, "Save changes")?.disabled).toBe(true);
		await act(async () =>
			root.render(<RuntimeSettingsDialog {...props} projectId="beta" projects={[renamed, beta]} />),
		);
		await navigateTo("Task creation");
		expect(document.body.querySelector<HTMLInputElement>('input[type="radio"][value="shared"]')?.checked).toBe(true);
		await act(async () => findButtonByText(document.body, "Save changes")?.click());
		expect(saveMock).toHaveBeenCalledWith(expect.objectContaining({ defaultUseWorktree: false }));
		expect(configTargetsMock.mock.calls.every(([id]) => id === "alpha")).toBe(true);
	});

	it("uses refresh rather than the global restore response for a project form, retaining drafts and focus", async () => {
		const project = { id: "alpha", name: "Alpha", path: "/alpha" };
		const config = createSavedConfig({
			projectConfigPath: "/alpha/config.json",
			worktreeSetupScript: "alpha setup",
			hiddenDefaultPromptShortcuts: ["Commit"],
			promptShortcuts: [{ label: "Custom", prompt: "Keep custom" }],
		});
		const props = { open: true, projectId: "alpha", projects: [project], onOpenChange: vi.fn() };
		const refreshed = { ...config, hiddenDefaultPromptShortcuts: [] };
		// A global save response may describe the runtime's active project, not Alpha.
		restoreDefaultsMock.mockResolvedValueOnce(
			createSavedConfig({ projectConfigPath: "/beta/config.json", worktreeSetupScript: "DO NOT ADOPT BETA" }),
		);
		refreshMock.mockImplementation(() => root.render(<RuntimeSettingsDialog {...props} initialConfig={refreshed} />));
		await act(async () => root.render(<RuntimeSettingsDialog {...props} initialConfig={config} />));
		await navigateTo("Task creation");
		await act(async () =>
			document.body.querySelector<HTMLInputElement>('input[type="radio"][value="shared"]')?.click(),
		);
		await navigateTo("Prompt shortcuts");
		await act(async () => findButtonByText(document.body, "Restore defaults now…")?.click());
		await act(async () => findButtonByText(document.body, "Restore and save now")?.click());
		expect(refreshMock).toHaveBeenCalledOnce();
		expect(restoreDefaultsMock).toHaveBeenCalledWith(null, {
			promptShortcuts: [{ label: "Custom", prompt: "Keep custom" }],
			hiddenDefaultPromptShortcuts: [],
		});
		expect(findButtonByText(document.body, "Restore defaults now…")?.disabled).toBe(true);
		expect(document.activeElement?.textContent).toBe("Built-in prompt shortcuts");
		expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull();
		expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
		await navigateTo("Task creation");
		expect(document.body.querySelector<HTMLTextAreaElement>("#runtime-settings-worktree-setup")?.value).toBe(
			"alpha setup",
		);
		expect(document.body.querySelector<HTMLInputElement>('input[type="radio"][value="shared"]')?.checked).toBe(true);
		await act(async () => findButtonByText(document.body, "Save changes")?.click());
		expect(saveMock).toHaveBeenCalledWith(
			expect.objectContaining({ defaultUseWorktree: false, worktreeSetupScript: "alpha setup" }),
		);
	});

	it("restores global prompt defaults without a project only after confirmation and preserves custom prompts", async () => {
		const onSaved = vi.fn();
		await act(async () =>
			root.render(
				<RuntimeSettingsDialog
					open
					projectId={null}
					initialConfig={createSavedConfig({
						promptShortcuts: [
							{ label: "Commit", prompt: "Customized built-in" },
							{ label: "My custom prompt", prompt: "Preserve me" },
						],
						hiddenDefaultPromptShortcuts: ["Squash Merge"],
					})}
					onOpenChange={() => {}}
					onSaved={onSaved}
				/>,
			),
		);
		await navigateTo("Terminal & editor");
		await act(async () => findSwitchByLabel(document.body, "Show generated worktrees")?.click());
		await navigateTo("Prompt shortcuts");
		await act(async () => findButtonByText(document.body, "Restore defaults now…")?.click());
		expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull();
		expect(restoreDefaultsMock).not.toHaveBeenCalled();
		const confirmation = document.body.querySelector('[role="alertdialog"]')!;
		await act(async () => findButtonByText(confirmation, "Cancel")?.click());
		expect(restoreDefaultsMock).not.toHaveBeenCalled();
		await act(async () => findButtonByText(document.body, "Restore defaults now…")?.click());
		await act(async () => findButtonByText(document.body, "Restore and save now")?.click());
		expect(restoreDefaultsMock).toHaveBeenCalledWith(null, {
			promptShortcuts: [{ label: "My custom prompt", prompt: "Preserve me" }],
			hiddenDefaultPromptShortcuts: [],
		});
		expect(saveMock).not.toHaveBeenCalled();
		expect(onSaved).toHaveBeenCalledOnce();
		expect(refreshMock).toHaveBeenCalledOnce();
		expect(document.body.textContent).toContain("Unsaved changes: All projects");
		await act(async () => findButtonByText(document.body, "Save changes")?.click());
		expect(saveMock).toHaveBeenCalledWith(expect.objectContaining({ showGeneratedWorktrees: true }));
		expect(saveMock.mock.calls[0]?.[0]).not.toHaveProperty("shortcuts");
	});

	it("keeps restoration errors actionable without closing the confirmation", async () => {
		restoreDefaultsMock.mockRejectedValueOnce(new Error("Disk is read-only"));
		await act(async () =>
			root.render(
				<RuntimeSettingsDialog
					open
					projectId={null}
					initialConfig={createSavedConfig({ hiddenDefaultPromptShortcuts: ["Commit"] })}
					onOpenChange={() => {}}
				/>,
			),
		);
		await navigateTo("Prompt shortcuts");
		await act(async () => findButtonByText(document.body, "Restore defaults now…")?.click());
		await act(async () => findButtonByText(document.body, "Restore and save now")?.click());
		expect(document.body.querySelector('[role="alertdialog"] [role="alert"]')?.textContent).toContain(
			"Disk is read-only",
		);
		expect(findButtonByText(document.body, "Restore and save now")?.disabled).toBe(false);
	});

	it("loads and saves the project task-isolation default", async () => {
		saveMock.mockClear();
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open
					projectId="project-1"
					initialConfig={createSavedConfig({
						projectConfigPath: "/tmp/project/config.json",
						defaultUseWorktree: false,
					})}
					onOpenChange={() => {}}
				/>,
			);
		});
		await navigateTo("Task creation");
		const shared = document.body.querySelector<HTMLInputElement>('input[type="radio"][value="shared"]');
		const isolated = document.body.querySelector<HTMLInputElement>('input[type="radio"][value="isolated"]');
		expect(shared?.checked).toBe(true);
		expect(isolated?.disabled).toBe(false);
		await act(async () => isolated?.click());
		expect(isolated?.checked).toBe(true);
		await act(async () => {
			findButtonByText(document.body, "Save changes")?.click();
		});
		expect(saveMock).toHaveBeenCalledWith(expect.objectContaining({ defaultUseWorktree: true }));
	});

	it("loads, edits, and saves the project worktree setup script", async () => {
		saveMock.mockClear();
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					projectId="project-1"
					initialConfig={createSavedConfig({
						projectConfigPath: "/tmp/project/config.json",
						worktreeSetupScript: "npm ci",
					})}
					onOpenChange={() => {}}
				/>,
			);
		});
		await navigateTo("Task creation");
		const input = document.body.querySelector<HTMLTextAreaElement>("#runtime-settings-worktree-setup");
		expect(input?.value).toBe("npm ci");
		expect(input?.disabled).toBe(false);
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
				input,
				"npm ci\nnpm run build",
			);
			input?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const saveButton = findButtonByText(document.body, "Save changes");
		expect(saveButton?.disabled).toBe(false);
		await act(async () => {
			saveButton?.click();
		});
		expect(saveMock).toHaveBeenCalledWith(expect.objectContaining({ worktreeSetupScript: "npm ci\nnpm run build" }));
	});

	it("disables worktree setup without a selected project", async () => {
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog open={true} projectId={null} initialConfig={savedConfig} onOpenChange={() => {}} />,
			);
		});
		await navigateTo("Task creation");
		expect(document.body.querySelector("#settings-page-task-creation")?.textContent).toContain("No project selected");
		expect(document.body.querySelector("#runtime-settings-worktree-setup")).toBeNull();
		expect(document.body.querySelector('input[type="radio"]')).toBeNull();
	});

	it("does not render support actions inside settings", async () => {
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					projectId={"project-1"}
					initialConfig={savedConfig}
					onOpenChange={() => {}}
				/>,
			);
		});

		expect(findButtonByText(document.body, "Send feedback")).toBeNull();
		expect(findButtonByText(document.body, "Report issue")).toBeNull();
	});

	it("omits conversation summary controls and keeps saved-login guidance for AI helpers", async () => {
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					projectId="project-1"
					initialConfig={savedConfig}
					onOpenChange={() => {}}
				/>,
			);
		});

		await navigateTo("Diagnostics & AI setup");
		expect(document.body.querySelector("#runtime-settings-summary-display")).toBeNull();
		expect(document.body.querySelector("#runtime-settings-llm-summary-polish")).toBeNull();
		expect(document.body.textContent).not.toContain("Conversation summaries");
		expect(document.body.textContent).not.toContain("Polish summaries with AI");
		expect(document.body.textContent).toContain("Titles, branch names, and commit messages");
		expect(document.body.textContent).toContain("saved Codex/ChatGPT login first");
		expect(document.body.textContent).toContain("saved Claude Code login");
	});

	it("keeps harness selection out of settings and keeps worktree context tuning", async () => {
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					projectId={"project-1"}
					initialConfig={createSavedConfig({
						agents: [createTestAgentDef("claude"), createTestAgentDef("codex"), createTestAgentDef("pi")],
					})}
					onOpenChange={() => {}}
				/>,
			);
		});

		await navigateTo("Agents");
		const bodyText = document.getElementById("settings-page-agents")?.textContent ?? "";
		expect(bodyText).toContain("Agent launch settings");
		expect(bodyText).toContain("checks the PATH");
		expect(bodyText).toContain("Choose a harness in the new task dialog");
		expect(bodyText).not.toContain("Cmd+Shift+D");
		expect(bodyText).toContain("Worktree context prompt");
		expect(bodyText).not.toContain("Claude row multiplier");
		expect(bodyText).not.toContain("OpenAI Codex");
		expect(bodyText).not.toContain("Pi support is experimental");
		expect(bodyText).not.toContain("Allow agents to access the parent repo");
		expect(bodyText).not.toContain("Rogue writes can corrupt project state");
		expect(bodyText).not.toContain("These settings let agents escape their worktree sandbox");
		await navigateTo("Diagnostics & AI setup");
		expect(document.getElementById("settings-page-diagnostics")?.textContent).toContain("Cmd+Shift+D");
	});

	it("groups Claude, Codex, and Pi launch permissions in collapsible subsections and drops legacy toggles on save", async () => {
		saveMock.mockReset();
		saveMock.mockResolvedValue(true);

		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					projectId={"project-1"}
					initialConfig={createSavedConfig()}
					onOpenChange={() => {}}
				/>,
			);
		});

		const claudeSectionButton = Array.from(document.body.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Claude Code"),
		);
		expect(claudeSectionButton).toBeInstanceOf(HTMLButtonElement);
		expect(claudeSectionButton?.getAttribute("aria-expanded")).toBe("false");
		expect(document.body.textContent).toContain("New/restarted sessions only · Inherit Claude config");
		expect(findSwitchByLabel(document.body, "Fullscreen rendering")).toBeNull();

		await act(async () => {
			claudeSectionButton?.click();
		});

		const claudePermissionModeSelect = document.body.querySelector<HTMLSelectElement>(
			"#runtime-settings-claude-permission-mode",
		);
		expect(findSwitchByLabel(document.body, "Fullscreen rendering")).toBeNull();
		expect(claudePermissionModeSelect).toBeInstanceOf(HTMLSelectElement);
		expect(claudePermissionModeSelect?.value).toBe("inherit");
		expect(claudeSectionButton?.getAttribute("aria-expanded")).toBe("true");
		expect(document.body.textContent).toContain("without a Quarterdeck override");

		await act(async () => {
			if (claudePermissionModeSelect) {
				claudePermissionModeSelect.value = "bypassPermissions";
				claudePermissionModeSelect.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		expect(claudePermissionModeSelect?.value).toBe("bypassPermissions");
		expect(document.body.textContent).toContain("externally isolated environment");

		const codexSectionButton = Array.from(document.body.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Codex"),
		);
		expect(codexSectionButton).toBeInstanceOf(HTMLButtonElement);
		expect(document.body.textContent).toContain("New/restarted sessions only · Inherit Codex config");
		await act(async () => {
			codexSectionButton?.click();
		});
		const approvalsReviewerSelect = document.body.querySelector<HTMLSelectElement>(
			"#runtime-settings-codex-approvals-reviewer",
		);
		expect(approvalsReviewerSelect).toBeInstanceOf(HTMLSelectElement);
		expect(approvalsReviewerSelect?.value).toBe("inherit");
		expect(document.body.textContent).toContain("without a Quarterdeck override");
		await act(async () => {
			if (approvalsReviewerSelect) {
				approvalsReviewerSelect.value = "auto_review";
				approvalsReviewerSelect.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		expect(approvalsReviewerSelect?.value).toBe("auto_review");
		expect(document.body.textContent).toContain("--approve-for-me");
		expect(document.body.textContent).toContain("workspace-write sandbox");
		await act(async () => {
			if (approvalsReviewerSelect) {
				approvalsReviewerSelect.value = "dangerously_bypass";
				approvalsReviewerSelect.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		expect(approvalsReviewerSelect?.value).toBe("dangerously_bypass");
		expect(document.body.textContent).toContain("--dangerously-bypass-approvals-and-sandbox");
		expect(document.body.textContent).toContain("without confirmation prompts or Codex sandboxing");

		const piSectionButton = Array.from(document.body.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Native Pi execution"),
		);
		expect(piSectionButton).toBeInstanceOf(HTMLButtonElement);
		await act(async () => {
			piSectionButton?.click();
		});
		expect(findSwitchByLabel(document.body, "Require tool approvals")).toBeNull();
		expect(document.body.textContent).toContain("Pi runs with its native tool and extension behavior");

		const saveButton = findButtonByText(document.body, "Save changes");
		await act(async () => {
			saveButton?.click();
		});
		expect(saveMock).toHaveBeenCalledWith(
			expect.objectContaining({
				claudeLaunchPermissionMode: "bypassPermissions",
				codexApprovalsReviewer: "dangerously_bypass",
			}),
		);
		expect(saveMock.mock.calls[0]?.[0]).not.toHaveProperty("piToolApprovalsEnabled");
		expect(saveMock.mock.calls[0]?.[0]).not.toHaveProperty("statuslineEnabled");
	});

	it("shows optional helper setup guidance when LLM is not configured", async () => {
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					projectId={"project-1"}
					initialConfig={createSavedConfig({ llmConfigured: false })}
					onOpenChange={() => {}}
				/>,
			);
		});

		await navigateTo("Diagnostics & AI setup");
		const warningText = document.body.textContent;
		expect(warningText).toContain("QUARTERDECK_LLM_BASE_URL");
		expect(warningText).toContain("QUARTERDECK_LLM_API_KEY");
		expect(warningText).toContain("QUARTERDECK_LLM_MODEL");
		expect(warningText).toContain("saved Codex/ChatGPT login first");
		expect(warningText).toContain("saved Claude Code login");
	});

	it("does not show LLM warning when configured", async () => {
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					projectId={"project-1"}
					initialConfig={createSavedConfig({ llmConfigured: true })}
					onOpenChange={() => {}}
				/>,
			);
		});

		await navigateTo("Diagnostics & AI setup");
		const warningText = document.body.textContent;
		expect(warningText).not.toContain("QUARTERDECK_LLM_BASE_URL");
	});

	it("calls the layout reset callback when reset layout is clicked", async () => {
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					projectId={"project-1"}
					initialConfig={savedConfig}
					onOpenChange={() => {}}
				/>,
			);
		});

		await navigateTo("Troubleshooting");
		const resetButton = findButtonByText(document.body, "Reset this window's layout now");
		expect(resetButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			resetButton?.click();
		});

		expect(resetLayoutCustomizationsMock).toHaveBeenCalledTimes(1);
	});

	it("does not render the old terminal re-sync action in settings", async () => {
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					projectId={"project-1"}
					initialConfig={savedConfig}
					onOpenChange={() => {}}
				/>,
			);
		});

		await navigateTo("Terminal & editor");
		expect(findButtonByText(document.body, "Reset window terminal rendering now")).toBeInstanceOf(HTMLButtonElement);
		expect(findButtonByText(document.body, "Re-sync terminal content")).toBeNull();
	});

	it("renders audible notification controls when dialog is open", async () => {
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					projectId={"project-1"}
					initialConfig={savedConfig}
					onOpenChange={() => {}}
				/>,
			);
		});

		await navigateTo("Notifications");
		// Master toggle — look for the "Notifications" heading and the switch.
		expect(document.body.textContent).toContain("Notifications");
		expect(document.body.textContent).toContain("Play sounds when tasks need attention");

		// Volume slider.
		const volumeSlider = document.body.querySelector('input[type="range"]');
		expect(volumeSlider).toBeInstanceOf(HTMLInputElement);

		// 3 event checkboxes.
		for (const key of ["permission", "review", "failure"]) {
			const checkbox = document.getElementById(`audible-notification-${key}`);
			expect(checkbox).not.toBeNull();
		}

		// Test sound button.
		expect(findButtonByText(document.body, "Test sound now")).toBeInstanceOf(HTMLButtonElement);
	});

	it("disables per-event controls when master toggle is off", async () => {
		const configWithAudioOff: RuntimeConfigResponse = {
			...savedConfig,
			audibleNotificationsEnabled: false,
		};

		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					projectId={"project-1"}
					initialConfig={configWithAudioOff}
					onOpenChange={() => {}}
				/>,
			);
		});

		await navigateTo("Notifications");
		// Volume slider should be disabled.
		const volumeSlider = document.body.querySelector('input[type="range"]') as HTMLInputElement;
		expect(volumeSlider.disabled).toBe(true);

		// Event checkboxes should be disabled.
		for (const key of ["permission", "review", "failure"]) {
			const checkbox = document.getElementById(`audible-notification-${key}`) as HTMLButtonElement;
			expect(checkbox.dataset.disabled).toBeDefined();
		}

		// Test sound button should be disabled.
		const testButton = findButtonByText(document.body, "Test sound now")!;
		expect(testButton.disabled).toBe(true);
	});

	it("saves audible settings without resubmitting legacy summary settings", async () => {
		saveMock.mockReset();
		saveMock.mockResolvedValue(true);
		const legacyConfig = {
			...savedConfig,
			showSummaryOnCards: true,
			showSummaryOnHover: true,
			llmSummaryPolishEnabled: true,
		};

		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					projectId={"project-1"}
					initialConfig={legacyConfig}
					onOpenChange={() => {}}
				/>,
			);
		});

		await navigateTo("Notifications");
		// Toggle the labelled master switch to create a change.
		const audibleSwitch = findSwitchByLabel(document.body, "Play sounds when tasks need attention");
		expect(audibleSwitch).toBeDefined();
		await act(async () => {
			audibleSwitch!.click();
		});

		// Click save.
		const saveButton = findButtonByText(document.body, "Save changes");
		expect(saveButton).toBeInstanceOf(HTMLButtonElement);
		await act(async () => {
			saveButton!.click();
		});

		expect(saveMock).toHaveBeenCalledTimes(1);
		const payload = saveMock.mock.calls[0]?.[0];
		if (!payload) throw new Error("Expected a runtime config save payload.");
		expect(payload).not.toHaveProperty("showSummaryOnCards");
		expect(payload).not.toHaveProperty("showSummaryOnHover");
		expect(payload).not.toHaveProperty("llmSummaryPolishEnabled");
		expect(payload.audibleNotificationsEnabled).toBe(false);
		expect(payload.audibleNotificationVolume).toBe(0.7);
		expect(payload.audibleNotificationEvents).toEqual({
			permission: true,
			review: true,
			failure: true,
		});
	});

	it.each([false, true])("saves the app-wide generated-worktrees preference from %s", async (initial) => {
		saveMock.mockReset();
		saveMock.mockResolvedValue(true);
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open
					projectId="project-1"
					initialConfig={createSavedConfig({ showGeneratedWorktrees: initial })}
					onOpenChange={() => {}}
				/>,
			);
		});

		await navigateTo("Terminal & editor");
		const control = findSwitchByLabel(document.body, "Show generated worktrees");
		expect(control?.getAttribute("data-state")).toBe(initial ? "checked" : "unchecked");
		const saveButton = findButtonByText(document.body, "Save changes");
		expect(saveButton?.disabled).toBe(true);
		await act(async () => control!.click());
		expect(saveButton?.disabled).toBe(false);
		await act(async () => saveButton!.click());
		expect(saveMock).toHaveBeenCalledWith(expect.objectContaining({ showGeneratedWorktrees: !initial }));
	});

	it.each([false, true])("saves the global branch folder preference from %s without a project", async (initial) => {
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open
					projectId={null}
					initialConfig={createSavedConfig({ groupBranchesByFolder: initial })}
					onOpenChange={() => {}}
				/>,
			);
		});
		await navigateTo("Git branches");
		expect(document.getElementById("settings-page-branches")?.textContent).toContain("Group branches by folder");
		const control = findSwitchByLabel(document.body, "Group branches by folder");
		expect(control?.getAttribute("data-state")).toBe(initial ? "checked" : "unchecked");
		const saveButton = findButtonByText(document.body, "Save changes");
		expect(saveButton?.disabled).toBe(true);
		await act(async () => control!.click());
		expect(saveButton?.disabled).toBe(false);
		expect(document.getElementById("settings-unsaved-changes")?.textContent).toContain("All projects");
		await act(async () => saveButton!.click());
		expect(saveMock).toHaveBeenCalledWith(expect.objectContaining({ groupBranchesByFolder: !initial }));
		expect(saveMock.mock.calls[0]?.[0]).not.toHaveProperty("defaultUseWorktree");
	});

	it("defaults branch folders off for older runtimes, reverts dirty state, and discards cancelled drafts on reopen", async () => {
		const olderConfig = createSavedConfig();
		Reflect.deleteProperty(olderConfig, "groupBranchesByFolder");
		const onOpenChange = vi.fn();
		const renderDialog = (open: boolean) =>
			root.render(
				<RuntimeSettingsDialog
					open={open}
					projectId={null}
					initialConfig={olderConfig}
					onOpenChange={onOpenChange}
				/>,
			);
		await act(async () => renderDialog(true));
		await navigateTo("Git branches");
		const control = findSwitchByLabel(document.body, "Group branches by folder");
		const saveButton = findButtonByText(document.body, "Save changes");
		expect(control?.getAttribute("data-state")).toBe("unchecked");
		await act(async () => control!.click());
		expect(saveButton?.disabled).toBe(false);
		await act(async () => control!.click());
		expect(saveButton?.disabled).toBe(true);
		await act(async () => control!.click());
		await act(async () => findButtonByText(document.body, "Cancel")!.click());
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(saveMock).not.toHaveBeenCalled();
		await act(async () => renderDialog(false));
		await act(async () => renderDialog(true));
		await navigateTo("Git branches");
		expect(findSwitchByLabel(document.body, "Group branches by folder")?.getAttribute("data-state")).toBe(
			"unchecked",
		);
		expect(findButtonByText(document.body, "Save changes")?.disabled).toBe(true);
	});

	it("includes file editor autosave mode in save payload", async () => {
		saveMock.mockReset();
		saveMock.mockResolvedValue(true);

		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					projectId={"project-1"}
					initialConfig={savedConfig}
					onOpenChange={() => {}}
				/>,
			);
		});

		await navigateTo("Terminal & editor");
		const autosaveSelect = document.getElementById("runtime-settings-file-editor-autosave") as HTMLSelectElement;
		expect(autosaveSelect).toBeInstanceOf(HTMLSelectElement);
		await act(async () => {
			autosaveSelect.value = "focus";
			autosaveSelect.dispatchEvent(new Event("change", { bubbles: true }));
		});

		const saveButton = findButtonByText(document.body, "Save changes");
		expect(saveButton).toBeInstanceOf(HTMLButtonElement);
		await act(async () => {
			saveButton!.click();
		});

		expect(saveMock).toHaveBeenCalledTimes(1);
		const payload = saveMock.mock.calls[0]?.[0];
		if (!payload) throw new Error("Expected a runtime config save payload.");
		expect(payload.fileEditorAutosaveMode).toBe("focus");
	});

	it("opts into code navigation and saves structured language server edits", async () => {
		saveMock.mockReset();
		saveMock.mockResolvedValue(true);
		await act(async () => {
			root.render(
				<RuntimeSettingsDialog open projectId="project-1" initialConfig={savedConfig} onOpenChange={() => {}} />,
			);
		});

		await navigateTo("Code navigation");
		const enabled = findSwitchByLabel(document.body, "Enable code navigation");
		expect(enabled?.getAttribute("data-state")).toBe("unchecked");
		await act(async () => {
			enabled?.click();
		});
		const section = document.body.querySelector('[aria-labelledby="code-navigation-settings-heading"]')!;
		await act(async () => {
			findButtonByText(section, "Edit")?.click();
		});
		const executableLabel = Array.from(document.body.querySelectorAll("label")).find(
			(label) => label.textContent?.trim() === "Executable",
		);
		const executable = executableLabel?.querySelector("input");
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
				executable,
				"/tools/custom language server",
			);
			executable?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			findButtonByText(document.body, "Apply server")?.click();
		});
		await act(async () => {
			findButtonByText(document.body, "Save changes")?.click();
		});
		expect(saveMock).toHaveBeenCalledWith(
			expect.objectContaining({
				codeNavigationEnabled: true,
				lspServers: [expect.objectContaining({ command: "/tools/custom language server", args: ["--stdio"] })],
			}),
		);
	});

	it("syncs audible settings from loaded config", async () => {
		const customConfig: RuntimeConfigResponse = {
			...savedConfig,
			audibleNotificationsEnabled: false,
			audibleNotificationVolume: 0.3,
			audibleNotificationEvents: { permission: false, review: true, failure: false },
		};

		await act(async () => {
			root.render(
				<RuntimeSettingsDialog
					open={true}
					projectId={"project-1"}
					initialConfig={customConfig}
					onOpenChange={() => {}}
				/>,
			);
		});

		await navigateTo("Notifications");
		// Volume should show 30%.
		const volumeSlider = document.body.querySelector('input[type="range"]') as HTMLInputElement;
		expect(volumeSlider.value).toBe("30");

		// Permission and failure checkboxes should be unchecked.
		const permissionCheckbox = document.getElementById("audible-notification-permission") as HTMLButtonElement;
		expect(permissionCheckbox.dataset.state).toBe("unchecked");

		const reviewCheckbox = document.getElementById("audible-notification-review") as HTMLButtonElement;
		expect(reviewCheckbox.dataset.state).toBe("checked");

		const failureCheckbox = document.getElementById("audible-notification-failure") as HTMLButtonElement;
		expect(failureCheckbox.dataset.state).toBe("unchecked");
	});
});
