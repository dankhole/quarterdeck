import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { validateNewShortcut } from "@/hooks/settings/shortcut-actions";
import { saveRuntimeConfig } from "@/runtime/runtime-config-query";
import { getTerminalController } from "@/terminal/terminal-controller-registry";
import { toErrorMessage } from "@/utils/to-error-message";

const TERMINAL_INTERRUPT_SEQUENCE = "\u0003";
const TERMINAL_PROMPT_WAIT_TIMEOUT_MS = 3000;

interface RuntimeShortcut {
	label: string;
	command: string;
	icon?: string;
}

interface UseShortcutActionsInput {
	currentProjectId: string | null;
	selectedTaskId: string | null;
	setMainView: (view: "terminal") => void;
	selectedShortcutLabel: string | null | undefined;
	shortcuts: RuntimeShortcut[];
	refreshRuntimeProjectConfig: () => void;
	prepareTerminalForShortcut: () => Promise<{
		ok: boolean;
		targetTaskId?: string;
		targetSessionInstanceId?: string;
		message?: string;
		hadExistingSession?: boolean;
		isCurrent?: () => boolean;
	}>;
}

interface UseShortcutActionsResult {
	runningShortcutLabel: string | null;
	handleSelectShortcutLabel: (shortcutLabel: string) => void;
	handleRunShortcut: (shortcutLabel: string) => Promise<void>;
	handleCreateShortcut: (shortcut: RuntimeShortcut) => Promise<{ ok: boolean; message?: string }>;
}

export function useShortcutActions({
	currentProjectId,
	selectedTaskId,
	setMainView,
	selectedShortcutLabel,
	shortcuts,
	refreshRuntimeProjectConfig,
	prepareTerminalForShortcut,
}: UseShortcutActionsInput): UseShortcutActionsResult {
	const [runningShortcutLabel, setRunningShortcutLabel] = useState<string | null>(null);
	const projectScope = useMemo(
		() => ({ projectId: currentProjectId, taskId: selectedTaskId }),
		[currentProjectId, selectedTaskId],
	);
	const projectScopeRef = useRef<typeof projectScope | null>(projectScope);
	const activeRunRef = useRef<object | null>(null);
	useLayoutEffect(() => {
		projectScopeRef.current = projectScope;
		activeRunRef.current = null;
		setRunningShortcutLabel(null);
		return () => {
			projectScopeRef.current = null;
			activeRunRef.current = null;
		};
	}, [projectScope]);

	const existingLabels = useMemo(() => shortcuts.map((s) => s.label), [shortcuts]);

	const saveSelectedShortcutPreference = useCallback(
		async (nextShortcutLabel: string | null): Promise<boolean> => {
			if (!currentProjectId) {
				return false;
			}
			try {
				await saveRuntimeConfig(currentProjectId, {
					selectedShortcutLabel: nextShortcutLabel,
				});
				refreshRuntimeProjectConfig();
				return true;
			} catch (error) {
				const message = toErrorMessage(error);
				showAppToast(
					{
						intent: "danger",
						icon: "error",
						message: `Could not save shortcut selection: ${message}`,
						timeout: 5000,
					},
					"shortcut-selection-save-failed",
				);
				return false;
			}
		},
		[currentProjectId, refreshRuntimeProjectConfig],
	);

	const handleSelectShortcutLabel = useCallback(
		(shortcutLabel: string) => {
			if (shortcutLabel === selectedShortcutLabel) {
				return;
			}
			void saveSelectedShortcutPreference(shortcutLabel);
		},
		[saveSelectedShortcutPreference, selectedShortcutLabel],
	);

	const handleRunShortcut = useCallback(
		async (shortcutLabel: string) => {
			const shortcut = shortcuts.find((item) => item.label === shortcutLabel);
			if (!shortcut || !currentProjectId) {
				return;
			}

			if (projectScopeRef.current !== projectScope) return;
			const run = {};
			activeRunRef.current = run;
			const isCurrentRun = () => projectScopeRef.current === projectScope && activeRunRef.current === run;
			let isCurrent = isCurrentRun;
			setRunningShortcutLabel(shortcutLabel);
			try {
				// Files/Git unmount the detail shell viewer. Reveal its owning surface first;
				// preparation retains this run's task/project while the viewer reconnects.
				if (selectedTaskId) setMainView("terminal");
				if (!isCurrentRun()) return;
				const prepared = await prepareTerminalForShortcut();
				if (!isCurrentRun()) return;
				if (prepared.isCurrent) {
					isCurrent = () => isCurrentRun() && prepared.isCurrent?.() === true;
				}
				if (!isCurrent()) return;
				if (!prepared.ok || !prepared.targetTaskId) {
					throw new Error(prepared.message ?? "Could not open terminal.");
				}
				if (!prepared.isCurrent || !prepared.targetSessionInstanceId) {
					throw new Error("Terminal scope is unavailable.");
				}
				// Capture one exact viewer. Never resolve a task-only controller again for delivery:
				// home task IDs are shared by projects and a reconnect can replace the session.
				const targetTaskId = prepared.targetTaskId;
				const terminalScope = { projectId: currentProjectId, sessionInstanceId: prepared.targetSessionInstanceId };
				const controller = getTerminalController(targetTaskId, terminalScope);
				if (!controller) throw new Error("Terminal is not connected.");
				const scopeIsCurrent = isCurrent;
				isCurrent = () => scopeIsCurrent() && getTerminalController(targetTaskId, terminalScope) === controller;
				if (!isCurrent()) return;
				const waitForLikelyPrompt = controller.waitForLikelyPrompt?.(TERMINAL_PROMPT_WAIT_TIMEOUT_MS);
				// Observe an abandoned prompt wait too if interrupt delivery fails first.
				void waitForLikelyPrompt?.catch(() => {});
				if (!isCurrent()) return;
				if (prepared.hadExistingSession && !controller.input(TERMINAL_INTERRUPT_SEQUENCE)) {
					throw new Error("Could not interrupt terminal command.");
				}
				await waitForLikelyPrompt;
				if (!isCurrent()) return;
				if (!controller.input(shortcut.command) || !controller.input("\r")) {
					throw new Error("Could not run shortcut command.");
				}
			} catch (error) {
				if (!isCurrent()) return;
				const message = toErrorMessage(error);
				showAppToast(
					{
						intent: "danger",
						icon: "error",
						message: `Could not run shortcut "${shortcut.label}": ${message}`,
						timeout: 6000,
					},
					`shortcut-run-failed:${shortcut.label}`,
				);
			} finally {
				if (activeRunRef.current === run) {
					activeRunRef.current = null;
					setRunningShortcutLabel(null);
				}
			}
		},
		[currentProjectId, prepareTerminalForShortcut, projectScope, selectedTaskId, setMainView, shortcuts],
	);

	const handleCreateShortcut = useCallback(
		async (shortcut: RuntimeShortcut): Promise<{ ok: boolean; message?: string }> => {
			if (!currentProjectId) {
				return { ok: false, message: "Select a project first." };
			}
			const validated = validateNewShortcut(shortcut.command, shortcut.label, existingLabels);
			if (!validated.ok) {
				return validated;
			}
			try {
				await saveRuntimeConfig(currentProjectId, {
					shortcuts: [
						...shortcuts,
						{
							label: validated.label,
							command: validated.command,
							icon: shortcut.icon,
						},
					],
					selectedShortcutLabel: validated.label,
				});
				refreshRuntimeProjectConfig();
				return { ok: true };
			} catch (error) {
				const message = toErrorMessage(error);
				showAppToast(
					{
						intent: "danger",
						icon: "error",
						message: `Could not save shortcut: ${message}`,
						timeout: 5000,
					},
					"shortcut-save-failed",
				);
				return { ok: false, message: `Could not save shortcut: ${message}` };
			}
		},
		[currentProjectId, existingLabels, refreshRuntimeProjectConfig, shortcuts],
	);

	return {
		runningShortcutLabel,
		handleSelectShortcutLabel,
		handleRunShortcut,
		handleCreateShortcut,
	};
}
