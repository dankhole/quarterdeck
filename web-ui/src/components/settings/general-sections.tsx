// Settings sections: diagnostics, Git, confirmations, and troubleshooting.
import { Button } from "@/components/ui/button";
import { SettingsSwitch } from "@/components/ui/settings-controls";
import {
	FILE_EDITOR_AUTOSAVE_MODES,
	type FileEditorAutosaveMode,
	normalizeFileEditorAutosaveMode,
} from "@/hooks/git/file-editor-workspace";
import type { SettingsSectionProps } from "./settings-section-props";

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export function DiagnosticsSection(): React.ReactElement {
	return (
		<>
			<h6 className="font-semibold text-text-primary mt-4 mb-1">Diagnostics</h6>
			<p className="text-text-secondary text-[13px] mt-0 mb-0">
				Press <kbd className="font-mono text-xs bg-surface-3 px-1 rounded">Cmd+Shift+D</kbd> to toggle the log
				panel. The log level can be changed from the panel header.
			</p>
		</>
	);
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

const GIT_CARD_INDICATOR_TOGGLES = [
	{
		field: "uncommittedChangesOnCardsEnabled",
		label: "Show uncommitted changes dot on cards",
		description: "Show a red dot on task cards when the worktree has uncommitted file changes.",
	},
	{
		field: "unmergedChangesIndicatorEnabled",
		label: "Show unmerged changes indicator",
		description:
			"Show a blue dot on the Changes icon when a task branch has committed changes not yet merged into the base branch.",
	},
	{
		field: "behindBaseIndicatorEnabled",
		label: "Show behind-base indicator",
		description: "Show a blue dot on the Files icon when the base branch has advanced since the task branched off.",
	},
] as const;

export function GitSection({ fields, setField, disabled }: SettingsSectionProps): React.ReactElement {
	return (
		<>
			<h6 className="font-semibold text-text-primary mt-4 mb-2">Git</h6>
			<p className="text-[13px] font-medium text-text-secondary mt-0 mb-2">Card indicators</p>
			{GIT_CARD_INDICATOR_TOGGLES.map(({ field, label, description }, i) => (
				<SettingsSwitch
					key={field}
					className={i > 0 ? "mt-3" : undefined}
					checked={fields[field]}
					onCheckedChange={(v) => setField(field, v)}
					disabled={disabled}
					label={label}
					description={description}
				/>
			))}
		</>
	);
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

const FILE_EDITOR_AUTOSAVE_LABELS: Record<FileEditorAutosaveMode, string> = {
	off: "Off",
	delay: "After a short delay",
	focus: "When focus leaves the editor",
};

export function EditorSection({ fields, setField, disabled }: SettingsSectionProps): React.ReactElement {
	return (
		<>
			<h6 className="font-semibold text-text-primary mt-4 mb-2">Editor</h6>
			<div className="flex items-center justify-between gap-3">
				<label htmlFor="runtime-settings-file-editor-autosave" className="text-text-primary text-[13px]">
					File editor autosave
				</label>
				<select
					id="runtime-settings-file-editor-autosave"
					name="fileEditorAutosaveMode"
					value={fields.fileEditorAutosaveMode}
					onChange={(event) => {
						setField("fileEditorAutosaveMode", normalizeFileEditorAutosaveMode(event.currentTarget.value));
					}}
					disabled={disabled}
					className="h-7 min-w-48 rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary outline-none hover:border-border-bright focus:border-border-focus disabled:opacity-40"
				>
					{FILE_EDITOR_AUTOSAVE_MODES.map((mode) => (
						<option key={mode} value={mode}>
							{FILE_EDITOR_AUTOSAVE_LABELS[mode]}
						</option>
					))}
				</select>
			</div>
			<p className="text-text-secondary text-[13px] mt-1 mb-0">
				Controls saves made by the in-app Files editor. Manual save remains available in every mode.
			</p>
		</>
	);
}

// ---------------------------------------------------------------------------
// Confirmations
// ---------------------------------------------------------------------------

const CONFIRMATION_TOGGLES = [
	{ field: "showTrashWorktreeNotice", label: "Show worktree notice when trashing tasks", inverted: false },
	{ field: "skipTaskCheckoutConfirmation", label: "Show task worktree checkout confirmation", inverted: true },
	{ field: "skipHomeCheckoutConfirmation", label: "Show home checkout confirmation", inverted: true },
	{ field: "skipCherryPickConfirmation", label: "Show cherry-pick landing confirmation", inverted: true },
] as const;

export function ConfirmationsSection({ fields, setField, disabled }: SettingsSectionProps): React.ReactElement {
	return (
		<>
			<h6 className="font-semibold text-text-primary mt-4 mb-2">Confirmations</h6>
			<p className="text-text-secondary text-[13px] mt-0 mb-2">
				Re-enable dialogs and confirmations you've previously dismissed.
			</p>
			{CONFIRMATION_TOGGLES.map(({ field, label, inverted }, i) => (
				<SettingsSwitch
					key={field}
					className={i > 0 ? "mt-3" : undefined}
					checked={inverted ? !fields[field] : fields[field]}
					onCheckedChange={(v) => setField(field, inverted ? !v : v)}
					disabled={disabled}
					label={label}
				/>
			))}
		</>
	);
}

// ---------------------------------------------------------------------------
// Troubleshooting
// ---------------------------------------------------------------------------

export function TroubleshootingSection({ onResetLayout }: { onResetLayout: () => void }): React.ReactElement {
	return (
		<>
			<h6 className="font-semibold text-text-primary mt-4 mb-2">Troubleshooting</h6>
			<Button size="sm" onClick={onResetLayout}>
				Reset layout
			</Button>
			<p className="text-text-secondary text-[13px] mt-2 mb-0">
				Reset sidebar, split pane, and terminal resize customizations back to their defaults.
			</p>
		</>
	);
}
