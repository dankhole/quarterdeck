// Settings sections: Git, Confirmations, Troubleshooting, and Advanced.
import { Button } from "@/components/ui/button";
import { SettingsSwitch } from "@/components/ui/settings-controls";
import type { SettingsSectionProps } from "./settings-section-props";

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
			<p className="text-text-secondary text-[13px] mt-3 mb-0">
				Press <kbd className="font-mono text-xs bg-surface-3 px-1 rounded">Cmd+Shift+D</kbd> to toggle the log
				panel. The log level can be changed from the panel header.
			</p>
		</>
	);
}

// ---------------------------------------------------------------------------
// Advanced
// ---------------------------------------------------------------------------

export function AdvancedSection({ fields, setField, disabled }: SettingsSectionProps): React.ReactElement {
	return (
		<>
			<h6 className="font-semibold text-text-primary mt-4 mb-1">Advanced</h6>
			<p className="text-text-secondary text-[13px] mt-1 mb-3">
				These settings let agents escape their worktree sandbox. Enabling them means the agent can{" "}
				<code className="text-xs bg-surface-3 px-1 rounded">cd</code> out of the task worktree into shared
				directories, which breaks worktree isolation — the status bar, branch display, and "shared" indicators may
				desync because they assume the agent stays in its assigned worktree.
			</p>
			<SettingsSwitch
				checked={fields.worktreeAddParentGitDir}
				onCheckedChange={(v) => setField("worktreeAddParentGitDir", v)}
				disabled={disabled}
				label={
					<>
						Allow agents to access the parent repo's{" "}
						<code className="text-xs bg-surface-3 px-1 rounded">.git</code> directory
					</>
				}
				description={
					<>
						Passes only the parent repo's <code className="text-xs bg-surface-3 px-1 rounded">.git</code>{" "}
						directory via <code className="text-xs bg-surface-3 px-1 rounded">--add-dir</code> instead of the
						entire repo. Agents can read git history, branches, and refs without full file access. Ignored when
						the full parent repo option above is enabled. Claude Code only.
					</>
				}
			/>
			<SettingsSwitch
				className="mt-3"
				checked={fields.worktreeAddQuarterdeckDir}
				onCheckedChange={(v) => setField("worktreeAddQuarterdeckDir", v)}
				disabled={disabled}
				label={
					<>
						Allow agents to access the <code className="text-xs bg-surface-3 px-1 rounded">~/.quarterdeck</code>{" "}
						directory
					</>
				}
				description="Gives agents read/write access to Quarterdeck state files (board data, session state, other worktrees). Rogue writes can corrupt project state and cause revision conflicts. The agent can also navigate into other task worktrees, breaking isolation. Claude Code only."
			/>
		</>
	);
}
