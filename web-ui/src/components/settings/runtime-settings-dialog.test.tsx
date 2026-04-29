import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeSettingsDialog } from "@/components/settings/runtime-settings-dialog";
import type { RuntimeConfigResponse, RuntimeConfigSaveRequest } from "@/runtime/types";
import { createTestAgentDef, createTestRuntimeConfigResponse } from "@/test-utils/runtime-config-factory";

const resetLayoutCustomizationsMock = vi.hoisted(() => vi.fn());
const saveMock = vi.hoisted(() => vi.fn(async () => true));
const refreshMock = vi.hoisted(() => vi.fn());

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

vi.mock("@runtime-shortcuts", () => ({
	areRuntimeProjectShortcutsEqual: vi.fn(() => true),
}));

vi.mock("@/resize/layout-customizations", () => ({
	useLayoutCustomizations: () => ({
		layoutResetNonce: 0,
		resetLayoutCustomizations: resetLayoutCustomizationsMock,
	}),
}));

vi.mock("@/runtime/use-runtime-config", () => ({
	useRuntimeConfig: (_open: boolean, _projectId: string | null, initialConfig?: RuntimeConfigResponse | null) => ({
		config: initialConfig ?? null,
		isLoading: false,
		isSaving: false,
		refresh: refreshMock,
		save: saveMock,
	}),
}));

vi.mock("@/runtime/runtime-config-query", () => ({
	openFileOnHost: vi.fn(async () => undefined),
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
		document.body.innerHTML = "";
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
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

	it("renders the show summary on cards checkbox", async () => {
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

		const checkbox = document.body.querySelector("#runtime-settings-show-summary-on-cards");
		expect(checkbox).toBeInstanceOf(HTMLButtonElement);
		expect(checkbox?.getAttribute("data-state")).toBe("unchecked");
	});

	it("renders the LLM summary polish checkbox and cost reminder", async () => {
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

		const checkbox = document.body.querySelector("#runtime-settings-llm-summary-polish");
		expect(checkbox).toBeInstanceOf(HTMLButtonElement);
		expect(checkbox?.getAttribute("data-state")).toBe("unchecked");
		expect(document.body.textContent).toContain("cheap, fast configured model");
	});

	it("keeps harness selection out of settings and keeps launch tuning", async () => {
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

		const bodyText = document.body.textContent ?? "";
		expect(bodyText).toContain("Harnesses");
		expect(bodyText).toContain("checks the PATH");
		expect(bodyText).toContain("Choose a harness in the new task dialog");
		expect(bodyText).toContain("Diagnostics");
		expect(bodyText).toContain("Cmd+Shift+D");
		expect(bodyText).toContain("Claude row multiplier");
		expect(bodyText).toContain("Worktree context prompt");
		expect(bodyText).not.toContain("OpenAI Codex");
		expect(bodyText).not.toContain("Pi support is experimental");
		expect(bodyText).not.toContain("Allow agents to access the parent repo");
		expect(bodyText).not.toContain("Rogue writes can corrupt project state");
		expect(bodyText).not.toContain("These settings let agents escape their worktree sandbox");
	});

	it("shows orange warning when LLM is not configured", async () => {
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

		const warningText = document.body.textContent;
		expect(warningText).toContain("QUARTERDECK_LLM_BASE_URL");
		expect(warningText).toContain("QUARTERDECK_LLM_API_KEY");
		expect(warningText).toContain("QUARTERDECK_LLM_MODEL");
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

		const resetButton = findButtonByText(document.body, "Reset layout");
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

		expect(findButtonByText(document.body, "Reset terminal rendering")).toBeInstanceOf(HTMLButtonElement);
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
		expect(findButtonByText(document.body, "Test sound")).toBeInstanceOf(HTMLButtonElement);
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

		// Volume slider should be disabled.
		const volumeSlider = document.body.querySelector('input[type="range"]') as HTMLInputElement;
		expect(volumeSlider.disabled).toBe(true);

		// Event checkboxes should be disabled.
		for (const key of ["permission", "review", "failure"]) {
			const checkbox = document.getElementById(`audible-notification-${key}`) as HTMLButtonElement;
			expect(checkbox.dataset.disabled).toBeDefined();
		}

		// Test sound button should be disabled.
		const testButton = findButtonByText(document.body, "Test sound")!;
		expect(testButton.disabled).toBe(true);
	});

	it("includes audible settings in save payload", async () => {
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

		// Toggle master switch off to create a change.
		const switches = document.body.querySelectorAll<HTMLButtonElement>('button[role="switch"]');
		const audibleSwitch = Array.from(switches).find((s) =>
			s.nextElementSibling?.textContent?.includes("Play sounds when tasks need attention"),
		);
		expect(audibleSwitch).toBeDefined();
		await act(async () => {
			audibleSwitch!.click();
		});

		// Click save.
		const saveButton = findButtonByText(document.body, "Save");
		expect(saveButton).toBeInstanceOf(HTMLButtonElement);
		await act(async () => {
			saveButton!.click();
		});

		expect(saveMock).toHaveBeenCalledTimes(1);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing mock call args
		const payload = (saveMock.mock.calls as any)[0][0] as RuntimeConfigSaveRequest;
		expect(payload.audibleNotificationsEnabled).toBe(false);
		expect(payload.audibleNotificationVolume).toBe(0.7);
		expect(payload.audibleNotificationEvents).toEqual({
			permission: true,
			review: true,
			failure: true,
		});
	});

	it("includes LLM summary polish in save payload", async () => {
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

		const checkbox = document.getElementById("runtime-settings-llm-summary-polish") as HTMLButtonElement;
		await act(async () => {
			checkbox.click();
		});

		const saveButton = findButtonByText(document.body, "Save");
		expect(saveButton).toBeInstanceOf(HTMLButtonElement);
		await act(async () => {
			saveButton!.click();
		});

		expect(saveMock).toHaveBeenCalledTimes(1);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing mock call args
		const payload = (saveMock.mock.calls as any)[0][0] as RuntimeConfigSaveRequest;
		expect(payload.llmSummaryPolishEnabled).toBe(true);
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
