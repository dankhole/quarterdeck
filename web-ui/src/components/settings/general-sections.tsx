// Settings sections: diagnostics, editor, and troubleshooting.
import { Button } from "@/components/ui/button";
import { SettingsSwitch } from "@/components/ui/settings-controls";
import {
	FILE_EDITOR_AUTOSAVE_MODES,
	type FileEditorAutosaveMode,
	normalizeFileEditorAutosaveMode,
} from "@/hooks/git/file-editor-workspace";
import type { SettingsSectionProps } from "./settings-section-props";

export function DiagnosticsSection(): React.ReactElement {
	return (
		<section aria-labelledby="settings-diagnostics-heading" className="space-y-2">
			<h3 id="settings-diagnostics-heading" className="m-0 text-base font-semibold text-text-primary">
				Diagnostics
			</h3>
			<p className="m-0 text-sm leading-6 text-text-secondary">
				Press <kbd className="font-mono text-sm bg-surface-3 px-1 rounded">Cmd+Shift+D</kbd> to toggle the
				Diagnostics panel. Console verbosity can be changed from the Timeline tab without changing flight-recorder
				capture. These tools do not change settings in this form.
			</p>
		</section>
	);
}

const FILE_EDITOR_AUTOSAVE_LABELS: Record<FileEditorAutosaveMode, string> = {
	off: "Off",
	delay: "After a short delay",
	focus: "When focus leaves the editor",
};

export function EditorSection({ fields, setField, disabled }: SettingsSectionProps): React.ReactElement {
	return (
		<section aria-labelledby="settings-editor-heading" className="mt-6 space-y-4 border-t border-border pt-6">
			<h3 id="settings-editor-heading" className="m-0 text-base font-semibold text-text-primary">
				Editor
			</h3>
			<SettingsSwitch
				checked={fields.showGeneratedWorktrees}
				onCheckedChange={(value) => setField("showGeneratedWorktrees", value)}
				disabled={disabled}
				label="Show generated worktrees"
				description="Show generated worktree folders in the Files tree for all projects."
			/>
			<div className="settings-row">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<label htmlFor="runtime-settings-file-editor-autosave" className="text-text-primary text-sm font-medium">
						File editor autosave
					</label>
					<select
						id="runtime-settings-file-editor-autosave"
						name="fileEditorAutosaveMode"
						aria-describedby="runtime-settings-file-editor-autosave-help"
						value={fields.fileEditorAutosaveMode}
						onChange={(event) => {
							setField("fileEditorAutosaveMode", normalizeFileEditorAutosaveMode(event.currentTarget.value));
						}}
						disabled={disabled}
						className="h-9 max-w-full rounded-md border border-border bg-surface-2 px-2 text-sm text-text-primary outline-none hover:border-border-bright focus:border-border-focus disabled:opacity-40"
					>
						{FILE_EDITOR_AUTOSAVE_MODES.map((mode) => (
							<option key={mode} value={mode}>
								{FILE_EDITOR_AUTOSAVE_LABELS[mode]}
							</option>
						))}
					</select>
				</div>
				<p
					id="runtime-settings-file-editor-autosave-help"
					className="text-text-secondary text-sm leading-6 mt-1 mb-0"
				>
					Controls saves made by the in-app Files editor. Manual save remains available in every mode.
				</p>
			</div>
		</section>
	);
}

export function TroubleshootingSection({ onResetLayout }: { onResetLayout: () => void }): React.ReactElement {
	return (
		<section aria-labelledby="settings-troubleshooting-heading" className="space-y-4">
			<h3 id="settings-troubleshooting-heading" className="m-0 text-base font-semibold text-text-primary">
				Layout recovery
			</h3>
			<div>
				<Button size="sm" onClick={onResetLayout}>
					Reset this window's layout now
				</Button>
				<p className="text-text-secondary text-sm leading-6 mt-2 mb-0">
					Immediately reset this window's sidebar, split pane, and terminal resize customizations to their
					defaults. Saved layout preferences are shared with other windows using this runtime. This does not change
					project settings or restart tasks. Cancel will not undo this action.
				</p>
			</div>
		</section>
	);
}
