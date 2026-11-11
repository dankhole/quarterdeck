import type { DiffViewMode } from "./diff-viewer-utils";

/** Layout is presentation only; selecting it never changes the comparison. */
export function DiffLayoutSelector({
	viewMode,
	onViewModeChange,
}: {
	viewMode: DiffViewMode;
	onViewModeChange: (mode: DiffViewMode) => void;
}): React.ReactElement {
	return (
		<label className="flex items-center gap-2 text-xs text-text-secondary">
			View
			<select
				aria-label="Diff layout"
				className="rounded-sm border border-border-bright bg-surface-2 px-2 py-1 text-text-primary"
				value={viewMode}
				onChange={(event) => {
					const mode = event.target.value;
					if (mode === "unified" || mode === "split" || mode === "resulting") onViewModeChange(mode);
				}}
			>
				<option value="unified">Unified</option>
				<option value="split">Split</option>
				<option value="resulting">Resulting file</option>
			</select>
		</label>
	);
}
