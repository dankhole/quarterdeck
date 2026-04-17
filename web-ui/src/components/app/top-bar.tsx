import { Bug, Command, Settings, Terminal } from "lucide-react";
import { TopBarProjectShortcutControl } from "@/components/app/top-bar-project-shortcut-control";
import { TopBarPromptShortcutControl } from "@/components/app/top-bar-prompt-shortcut-control";
import { getTopBarScopeBorderClass, TopBarScopeSection } from "@/components/app/top-bar-scope-section";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { PromptShortcut, RuntimeProjectShortcut } from "@/runtime/types";
import { isMacPlatform } from "@/utils/platform";

type SettingsSection = "shortcuts";
type CreateShortcutResult = { ok: boolean; message?: string };

export { GitBranchStatusControl } from "@/components/app/git-branch-status-control";

export function TopBar({
	onBack,
	projectPath,
	isProjectPathLoading = false,
	projectHint,
	runtimeHint,
	onToggleTerminal,
	isTerminalOpen,
	isTerminalLoading,
	onOpenSettings,
	showDebugButton,
	onOpenDebugDialog,
	shortcuts,
	selectedShortcutLabel,
	onSelectShortcutLabel,
	runningShortcutLabel,
	onRunShortcut,
	onCreateFirstShortcut,
	promptShortcuts,
	activePromptShortcut,
	onSelectPromptShortcutLabel,
	isPromptShortcutRunning,
	onRunPromptShortcut,
	onManagePromptShortcuts,
	selectedTaskId,
	hideProjectDependentActions = false,
	branchPillSlot,
	scopeType: rawScopeType,
	taskTitle,
}: {
	onBack?: () => void;
	projectPath?: string;
	isProjectPathLoading?: boolean;
	projectHint?: string;
	runtimeHint?: string;
	onToggleTerminal?: () => void;
	isTerminalOpen?: boolean;
	isTerminalLoading?: boolean;
	onOpenSettings?: (section?: SettingsSection) => void;
	showDebugButton?: boolean;
	onOpenDebugDialog?: () => void;
	shortcuts?: RuntimeProjectShortcut[];
	selectedShortcutLabel?: string | null;
	onSelectShortcutLabel?: (shortcutLabel: string) => void;
	runningShortcutLabel?: string | null;
	onRunShortcut?: (shortcutLabel: string) => void;
	onCreateFirstShortcut?: (shortcut: RuntimeProjectShortcut) => Promise<CreateShortcutResult>;
	promptShortcuts?: PromptShortcut[];
	activePromptShortcut?: PromptShortcut | null;
	onSelectPromptShortcutLabel?: (label: string) => void;
	isPromptShortcutRunning?: boolean;
	onRunPromptShortcut?: (taskId: string, shortcutLabel: string) => void;
	onManagePromptShortcuts?: () => void;
	selectedTaskId?: string | null;
	hideProjectDependentActions?: boolean;
	branchPillSlot?: React.ReactNode;
	scopeType?: "home" | "task" | "branch_view";
	taskTitle?: string | null;
}): React.ReactElement {
	const scopeType = rawScopeType ?? "home";
	const scopeBorderClass = getTopBarScopeBorderClass(scopeType);

	return (
		<nav
			className={cn(
				"kb-top-bar flex flex-nowrap items-center h-10 min-h-[40px] min-w-0 bg-surface-1",
				scopeBorderClass,
			)}
			style={{
				paddingLeft: onBack ? 6 : 12,
				paddingRight: 8,
				borderBottom: "1px solid var(--color-divider)",
			}}
		>
			<TopBarScopeSection
				onBack={onBack}
				scopeType={scopeType}
				taskTitle={taskTitle}
				projectPath={projectPath}
				isProjectPathLoading={isProjectPathLoading}
				projectHint={projectHint}
				runtimeHint={runtimeHint}
				onOpenSettings={onOpenSettings ? () => onOpenSettings() : undefined}
				hideProjectDependentActions={hideProjectDependentActions}
				branchPillSlot={branchPillSlot}
			/>
			<div className="flex flex-nowrap items-center h-10 pr-0.5 shrink-0">
				{!hideProjectDependentActions ? (
					<TopBarProjectShortcutControl
						shortcuts={shortcuts}
						selectedShortcutLabel={selectedShortcutLabel}
						onSelectShortcutLabel={onSelectShortcutLabel}
						runningShortcutLabel={runningShortcutLabel}
						onRunShortcut={onRunShortcut}
						onCreateFirstShortcut={onCreateFirstShortcut}
						onOpenSettings={onOpenSettings}
					/>
				) : null}
				{!hideProjectDependentActions ? (
					<TopBarPromptShortcutControl
						selectedTaskId={selectedTaskId}
						promptShortcuts={promptShortcuts}
						activePromptShortcut={activePromptShortcut}
						onSelectPromptShortcutLabel={onSelectPromptShortcutLabel}
						isPromptShortcutRunning={isPromptShortcutRunning}
						onRunPromptShortcut={onRunPromptShortcut}
						onManagePromptShortcuts={onManagePromptShortcuts}
					/>
				) : null}
				{onToggleTerminal ? (
					<Tooltip
						side="bottom"
						content={
							<span className="inline-flex items-center gap-1.5 whitespace-nowrap">
								<span>Toggle terminal</span>
								<span className="inline-flex items-center gap-0.5 whitespace-nowrap">
									<span>(</span>
									{isMacPlatform ? <Command size={11} /> : <span>Ctrl</span>}
									<span>+ J)</span>
								</span>
							</span>
						}
					>
						<Button
							variant="ghost"
							size="sm"
							icon={<Terminal size={16} />}
							onClick={onToggleTerminal}
							disabled={Boolean(isTerminalLoading)}
							aria-label={isTerminalOpen ? "Close terminal" : "Open terminal"}
							className="ml-2"
						/>
					</Tooltip>
				) : null}
				{showDebugButton && onOpenDebugDialog ? (
					<Button
						variant="ghost"
						size="sm"
						icon={<Bug size={16} />}
						onClick={onOpenDebugDialog}
						aria-label="Debug"
						data-testid="open-debug-dialog-button"
						className="ml-0.5 mr-0.5"
					/>
				) : null}
				<Button
					variant="ghost"
					size="sm"
					icon={<Settings size={16} />}
					onClick={() => onOpenSettings?.()}
					aria-label="Settings"
					data-testid="open-settings-button"
					className="ml-0.5 mr-0.5"
				/>
			</div>
		</nav>
	);
}
