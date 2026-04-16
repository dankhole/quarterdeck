import { useCallback, useMemo, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { validateNewShortcut } from "@/hooks/settings/shortcut-actions";
import { saveRuntimeConfig } from "@/runtime/runtime-config-query";
import { waitForTerminalLikelyPrompt } from "@/terminal/terminal-controller-registry";
import type { SendTerminalInputOptions } from "@/terminal/terminal-input";
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
	selectedShortcutLabel: string | null | undefined;
	shortcuts: RuntimeShortcut[];
	refreshRuntimeProjectConfig: () => void;
	prepareTerminalForShortcut: (input: {
		prepareWaitForTerminalConnectionReady: (taskId: string) => () => Promise<void>;
	}) => Promise<{ ok: boolean; targetTaskId?: string; message?: string; hadExistingOpenTerminal?: boolean }>;
	prepareWaitForTerminalConnectionReady: (taskId: string) => () => Promise<void>;
	sendTaskSessionInput: (
		taskId: string,
		text: string,
		options?: SendTerminalInputOptions,
	) => Promise<{ ok: boolean; message?: string }>;
}

interface UseShortcutActionsResult {
	runningShortcutLabel: string | null;
	handleSelectShortcutLabel: (shortcutLabel: string) => void;
	handleRunShortcut: (shortcutLabel: string) => Promise<void>;
	handleCreateShortcut: (shortcut: RuntimeShortcut) => Promise<{ ok: boolean; message?: string }>;
}

export function useShortcutActions({
	currentProjectId,
	selectedShortcutLabel,
	shortcuts,
	refreshRuntimeProjectConfig,
	prepareTerminalForShortcut,
	prepareWaitForTerminalConnectionReady,
	sendTaskSessionInput,
}: UseShortcutActionsInput): UseShortcutActionsResult {
	const [runningShortcutLabel, setRunningShortcutLabel] = useState<string | null>(null);

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

			setRunningShortcutLabel(shortcutLabel);
			try {
				const prepared = await prepareTerminalForShortcut({
					prepareWaitForTerminalConnectionReady,
				});
				if (!prepared.ok || !prepared.targetTaskId) {
					throw new Error(prepared.message ?? "Could not open terminal.");
				}
				const waitForLikelyPrompt = waitForTerminalLikelyPrompt(
					prepared.targetTaskId,
					TERMINAL_PROMPT_WAIT_TIMEOUT_MS,
				);
				if (prepared.hadExistingOpenTerminal) {
					const interruptResult = await sendTaskSessionInput(prepared.targetTaskId, TERMINAL_INTERRUPT_SEQUENCE, {
						appendNewline: false,
					});
					if (!interruptResult.ok) {
						throw new Error(interruptResult.message ?? "Could not interrupt terminal command.");
					}
				}
				await waitForLikelyPrompt;
				const runResult = await sendTaskSessionInput(prepared.targetTaskId, shortcut.command, {
					appendNewline: true,
				});
				if (!runResult.ok) {
					throw new Error(runResult.message ?? "Could not run shortcut command.");
				}
			} catch (error) {
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
				setRunningShortcutLabel(null);
			}
		},
		[
			currentProjectId,
			prepareTerminalForShortcut,
			prepareWaitForTerminalConnectionReady,
			sendTaskSessionInput,
			shortcuts,
		],
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
