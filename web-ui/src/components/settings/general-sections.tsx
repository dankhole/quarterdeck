// Settings sections: diagnostics, editor, and troubleshooting.
import { Button } from "@/components/ui/button";
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
				Press <kbd className="font-mono text-xs bg-surface-3 px-1 rounded">Cmd+Shift+D</kbd> to toggle the
				Diagnostics panel. Console verbosity can be changed from the Timeline tab without changing flight-recorder
				capture.
			</p>
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
			<div className="settings-row">
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
			</div>
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
			<div className="settings-row">
				<Button size="sm" onClick={onResetLayout}>
					Reset layout
				</Button>
				<p className="text-text-secondary text-[13px] mt-2 mb-0">
					Reset sidebar, split pane, and terminal resize customizations back to their defaults.
				</p>
			</div>
		</>
	);
}
