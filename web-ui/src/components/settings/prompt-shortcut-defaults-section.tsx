import { DEFAULT_PROMPT_SHORTCUTS } from "@runtime-config-defaults";
import { useEffect, useRef, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import { saveRuntimeConfig } from "@/runtime/runtime-config-query";
import type { RuntimeConfigResponse } from "@/runtime/types";
import { toErrorMessage } from "@/utils/to-error-message";

/** Global immediate action: deliberately independent of the main form's project and drafts. */
export function PromptShortcutDefaultsSection({
	config,
	disabled,
	onRestored,
}: {
	config: RuntimeConfigResponse | null;
	disabled: boolean;
	onRestored: () => void;
}): React.ReactElement {
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const restoreButtonRef = useRef<HTMLButtonElement | null>(null);
	const headingRef = useRef<HTMLHeadingElement | null>(null);
	const wasConfirmationOpenRef = useRef(false);
	const shortcuts = config?.promptShortcuts ?? [];
	const needsRestore =
		(config?.hiddenDefaultPromptShortcuts ?? []).length > 0 ||
		DEFAULT_PROMPT_SHORTCUTS.some((defaultShortcut) => {
			const match = shortcuts.find(
				(shortcut) => shortcut.label.trim().toLowerCase() === defaultShortcut.label.trim().toLowerCase(),
			);
			return match !== undefined && match.prompt !== defaultShortcut.prompt;
		});

	// This confirmation has no Radix Trigger. Restore focus explicitly to a
	// stable element even when refreshing makes the restoration button disabled.
	useEffect(() => {
		if (wasConfirmationOpenRef.current && !confirmOpen) {
			const button = restoreButtonRef.current;
			if (button && !button.disabled) button.focus();
			else headingRef.current?.focus();
		}
		wasConfirmationOpenRef.current = confirmOpen;
	}, [confirmOpen]);

	const restoreDefaults = async () => {
		if (busy || disabled || !config) return;
		setBusy(true);
		setError(null);
		try {
			const defaultLabels = new Set(DEFAULT_PROMPT_SHORTCUTS.map((shortcut) => shortcut.label.trim().toLowerCase()));
			// null is the supported global API path, including when no projects exist.
			await saveRuntimeConfig(null, {
				promptShortcuts: shortcuts.filter((shortcut) => !defaultLabels.has(shortcut.label.trim().toLowerCase())),
				hiddenDefaultPromptShortcuts: [],
			});
			setConfirmOpen(false);
			onRestored();
			showAppToast({ intent: "success", message: "Default prompt shortcuts restored.", timeout: 3000 });
		} catch (cause) {
			setError(`Could not restore default prompt shortcuts: ${toErrorMessage(cause)}`);
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="space-y-4 text-sm leading-6">
			<div>
				<h3
					ref={headingRef}
					tabIndex={-1}
					className="text-base font-semibold text-text-primary m-0 focus-visible:outline-2 focus-visible:outline-border-focus"
				>
					Built-in prompt shortcuts
				</h3>
				<p className="text-text-secondary mt-1 mb-0">
					Prompt shortcuts send reusable prompts to agents from Review cards. Edit prompts from the prompt shortcut
					menu; these are separate from project command shortcuts.
				</p>
			</div>
			<div className="border-t border-border pt-4">
				<Button
					ref={restoreButtonRef}
					disabled={disabled || busy || !needsRestore}
					onClick={() => {
						setError(null);
						setConfirmOpen(true);
					}}
				>
					Restore defaults now…
				</Button>
				<p className="text-text-secondary mt-2 mb-0">
					Restores the built-in prompt shortcuts for all projects and saves immediately. Custom prompts with other
					names are preserved. Cancel in Settings does not undo this action.
				</p>
				{!needsRestore && config ? (
					<p className="text-text-secondary mt-2 mb-0">The built-in defaults are already restored.</p>
				) : null}
			</div>
			<AlertDialog open={confirmOpen} onOpenChange={(next) => !busy && setConfirmOpen(next)}>
				<AlertDialogHeader>
					<AlertDialogTitle>Restore default prompt shortcuts?</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						This immediately restores the built-in defaults (Commit and Squash Merge) for all projects, replacing
						customizations to those names. Your other custom prompt shortcuts and unsaved Settings changes are not
						affected.
					</AlertDialogDescription>
					{error ? (
						<p role="alert" className="text-status-red m-0">
							{error}
						</p>
					) : null}
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button disabled={busy}>Cancel</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button
							variant="primary"
							disabled={busy}
							onClick={(event) => {
								event.preventDefault();
								void restoreDefaults();
							}}
						>
							{busy ? "Restoring…" : "Restore and save now"}
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</section>
	);
}
