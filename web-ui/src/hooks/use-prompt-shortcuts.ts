import { useCallback, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { saveRuntimeConfig } from "@/runtime/runtime-config-query";
import type { PromptShortcut } from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";
import type { SendTerminalInputOptions } from "@/terminal/terminal-input";
import { useRawLocalStorageValue } from "@/utils/react-use";

interface UsePromptShortcutsInput {
	currentProjectId: string | null;
	promptShortcuts: PromptShortcut[];
	refreshRuntimeConfig: () => void;
	sendTaskSessionInput: (
		taskId: string,
		text: string,
		options?: SendTerminalInputOptions,
	) => Promise<{ ok: boolean; message?: string }>;
}

export interface UsePromptShortcutsResult {
	lastUsedLabel: string;
	activeShortcut: PromptShortcut | null;
	isRunning: boolean;
	runPromptShortcut: (taskId: string, shortcutLabel: string) => Promise<void>;
	selectShortcutLabel: (label: string) => void;
	savePromptShortcuts: (shortcuts: PromptShortcut[], hiddenDefaults: string[]) => Promise<boolean>;
}

const normalizeLabel = (value: string): string | null => {
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
};

export function usePromptShortcuts({
	currentProjectId,
	promptShortcuts,
	refreshRuntimeConfig,
	sendTaskSessionInput,
}: UsePromptShortcutsInput): UsePromptShortcutsResult {
	const [lastUsedLabel, setLastUsedLabel] = useRawLocalStorageValue<string>(
		LocalStorageKey.PromptShortcutLastLabel,
		"Commit",
		normalizeLabel,
	);
	const [isRunning, setIsRunning] = useState(false);
	const isRunningRef = useRef(false);

	const activeShortcut = promptShortcuts.find((s) => s.label === lastUsedLabel) ?? promptShortcuts[0] ?? null;

	const runPromptShortcut = useCallback(
		async (taskId: string, shortcutLabel: string) => {
			const shortcut = promptShortcuts.find((s) => s.label === shortcutLabel);
			if (!shortcut || isRunningRef.current) {
				return;
			}

			isRunningRef.current = true;
			setIsRunning(true);
			try {
				const pasteResult = await sendTaskSessionInput(taskId, shortcut.prompt, {
					appendNewline: false,
					mode: "paste",
				});
				if (!pasteResult.ok) {
					showAppToast({
						intent: "danger",
						icon: "warning-sign",
						message: pasteResult.message ?? "Could not send prompt to the task session.",
						timeout: 7000,
					});
					return;
				}

				await new Promise<void>((resolve) => {
					setTimeout(resolve, 200);
				});

				const submitResult = await sendTaskSessionInput(taskId, "\r", { appendNewline: false });
				if (!submitResult.ok) {
					showAppToast({
						intent: "danger",
						icon: "warning-sign",
						message: submitResult.message ?? "Could not submit prompt to the task session.",
						timeout: 7000,
					});
				}

				setLastUsedLabel(shortcutLabel);
			} finally {
				isRunningRef.current = false;
				setIsRunning(false);
			}
		},
		[promptShortcuts, sendTaskSessionInput, setLastUsedLabel],
	);

	const selectShortcutLabel = useCallback(
		(label: string) => {
			setLastUsedLabel(label);
		},
		[setLastUsedLabel],
	);

	const savePromptShortcuts = useCallback(
		async (shortcuts: PromptShortcut[], hiddenDefaults: string[]): Promise<boolean> => {
			if (currentProjectId === null) {
				return false;
			}
			try {
				await saveRuntimeConfig(currentProjectId, {
					promptShortcuts: shortcuts,
					hiddenDefaultPromptShortcuts: hiddenDefaults,
				});
				refreshRuntimeConfig();
				return true;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				showAppToast({
					intent: "danger",
					icon: "error",
					message: `Could not save prompt shortcuts: ${message}`,
					timeout: 7000,
				});
				return false;
			}
		},
		[currentProjectId, refreshRuntimeConfig],
	);

	return {
		lastUsedLabel,
		activeShortcut,
		isRunning,
		runPromptShortcut,
		selectShortcutLabel,
		savePromptShortcuts,
	};
}
