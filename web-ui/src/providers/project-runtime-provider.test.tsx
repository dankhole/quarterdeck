import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	type ProjectRuntimeContextValue,
	ProjectRuntimeProvider,
	useProjectRuntimeContext,
} from "@/providers/project-runtime-provider";

const mockShowAppToast = vi.fn();
const mockUseRuntimeProjectConfig = vi.fn();
const mockUseQuarterdeckAccessGate = vi.fn();
const mockUseStartupOnboarding = vi.fn();
const mockIsTaskAgentSetupSatisfied = vi.fn();
const mockSaveRuntimeConfig = vi.fn();

vi.mock("@/components/app-toaster", () => ({
	showAppToast: (...args: unknown[]) => mockShowAppToast(...args),
}));

vi.mock("@/runtime/use-runtime-project-config", () => ({
	useRuntimeProjectConfig: (...args: unknown[]) => mockUseRuntimeProjectConfig(...args),
}));

vi.mock("@/runtime/runtime-config-query", () => ({
	saveRuntimeConfig: (...args: unknown[]) => mockSaveRuntimeConfig(...args),
}));

vi.mock("@/hooks/project", () => ({
	useQuarterdeckAccessGate: (...args: unknown[]) => mockUseQuarterdeckAccessGate(...args),
	useStartupOnboarding: (...args: unknown[]) => mockUseStartupOnboarding(...args),
}));

vi.mock("@/runtime/native-agent", () => ({
	isTaskAgentSetupSatisfied: (...args: unknown[]) => mockIsTaskAgentSetupSatisfied(...args),
}));

function HookHarness({ onValue }: { onValue: (value: ProjectRuntimeContextValue) => void }): null {
	const value = useProjectRuntimeContext();
	useEffect(() => {
		onValue(value);
	}, [onValue, value]);
	return null;
}

describe("ProjectRuntimeProvider", () => {
	let container: HTMLDivElement;
	let root: Root;
	let latestValue: ProjectRuntimeContextValue;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		latestValue = null as unknown as ProjectRuntimeContextValue;

		mockUseQuarterdeckAccessGate.mockReturnValue({ isBlocked: false });
		mockUseStartupOnboarding.mockReturnValue({
			isStartupOnboardingDialogOpen: false,
			handleOpenStartupOnboardingDialog: () => {},
			handleCloseStartupOnboardingDialog: () => {},
			handleSelectOnboardingAgent: () => {},
		});
		mockIsTaskAgentSetupSatisfied.mockReturnValue(true);
		mockSaveRuntimeConfig.mockResolvedValue({});
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		mockUseRuntimeProjectConfig.mockReset();
		mockUseQuarterdeckAccessGate.mockReset();
		mockUseStartupOnboarding.mockReset();
		mockIsTaskAgentSetupSatisfied.mockReset();
		mockSaveRuntimeConfig.mockReset();
		mockShowAppToast.mockReset();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function renderProvider({
		currentProjectId,
		navigationCurrentProjectId,
	}: {
		currentProjectId: string | null;
		navigationCurrentProjectId: string | null;
	}): void {
		act(() => {
			root.render(
				createElement(
					ProjectRuntimeProvider,
					{ currentProjectId, navigationCurrentProjectId },
					createElement(HookHarness, { onValue: (value) => (latestValue = value) }),
				),
			);
		});
	}

	it("uses the navigation project for settings scope and falls back to the first shortcut label", () => {
		mockUseRuntimeProjectConfig.mockImplementation((projectId: string | null) => {
			if (projectId === "project-2") {
				return {
					config: {
						selectedAgentId: "agent-2",
					},
					isLoading: false,
					refresh: () => {},
				};
			}
			return {
				config: {
					llmConfigured: true,
					shortcuts: [
						{ label: "First", command: "echo first" },
						{ label: "Second", command: "echo second" },
					],
					selectedShortcutLabel: "Missing",
				},
				isLoading: false,
				refresh: () => {},
			};
		});

		renderProvider({ currentProjectId: "project-1", navigationCurrentProjectId: "project-2" });

		expect(latestValue.settingsProjectId).toBe("project-2");
		expect(latestValue.settingsRuntimeProjectConfig?.selectedAgentId).toBe("agent-2");
		expect(latestValue.selectedShortcutLabel).toBe("First");
		expect(latestValue.isLlmGenerationDisabled).toBe(false);
	});

	it("uses config defaults when no runtime config is available", () => {
		mockUseRuntimeProjectConfig.mockReturnValue({
			config: null,
			isLoading: false,
			refresh: () => {},
		});
		mockIsTaskAgentSetupSatisfied.mockReturnValue(null);

		renderProvider({ currentProjectId: null, navigationCurrentProjectId: null });

		expect(latestValue.settingsProjectId).toBeNull();
		expect(latestValue.shortcuts).toEqual([]);
		expect(latestValue.selectedShortcutLabel).toBeNull();
		expect(latestValue.isTaskAgentReady).toBeNull();
		expect(latestValue.audibleNotificationsEnabled).toBe(CONFIG_DEFAULTS.audibleNotificationsEnabled);
		expect(latestValue.showTrashWorktreeNotice).toBe(CONFIG_DEFAULTS.showTrashWorktreeNotice);
	});

	it("skips default base ref saves when no project is selected", async () => {
		mockUseRuntimeProjectConfig.mockReturnValue({
			config: null,
			isLoading: false,
			refresh: () => {},
		});

		renderProvider({ currentProjectId: null, navigationCurrentProjectId: null });

		await act(async () => {
			await latestValue.handleSetDefaultBaseRef("main");
		});

		expect(mockSaveRuntimeConfig).not.toHaveBeenCalled();
		expect(mockShowAppToast).not.toHaveBeenCalled();
	});

	it("shows a toast when dismissing the trash worktree notice fails", async () => {
		const refreshRuntimeProjectConfig = vi.fn();
		mockUseRuntimeProjectConfig.mockReturnValue({
			config: {
				showTrashWorktreeNotice: true,
			},
			isLoading: false,
			refresh: refreshRuntimeProjectConfig,
		});
		mockSaveRuntimeConfig.mockRejectedValue(new Error("save failed"));

		renderProvider({ currentProjectId: "project-1", navigationCurrentProjectId: null });

		await act(async () => {
			latestValue.saveTrashWorktreeNoticeDismissed();
			await Promise.resolve();
		});

		expect(mockSaveRuntimeConfig).toHaveBeenCalledWith("project-1", {
			showTrashWorktreeNotice: false,
		});
		expect(refreshRuntimeProjectConfig).not.toHaveBeenCalled();
		expect(mockShowAppToast).toHaveBeenCalledWith({
			intent: "danger",
			message: "Failed to dismiss trash worktree notice",
		});
	});
});
