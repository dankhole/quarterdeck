import * as RadixPopover from "@radix-ui/react-popover";
import {
	ArrowLeft,
	Bug,
	Check,
	ChevronDown,
	Command,
	GitBranch,
	MessageSquare,
	Play,
	Plus,
	Settings,
	Terminal,
} from "lucide-react";
import { useState } from "react";
import {
	getRuntimeShortcutIconComponent,
	getRuntimeShortcutPickerOption,
	RUNTIME_SHORTCUT_ICON_OPTIONS,
	type RuntimeShortcutPickerIconId,
} from "@/components/shared/runtime-shortcut-icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TruncateTooltip } from "@/components/ui/tooltip";
import type { PromptShortcut, RuntimeProjectShortcut } from "@/runtime/types";
import { formatPathForDisplay } from "@/utils/path-display";
import { isMacPlatform } from "@/utils/platform";

type SettingsSection = "shortcuts";
type CreateShortcutResult = { ok: boolean; message?: string };

function getProjectPathSegments(path: string): string[] {
	return path
		.replaceAll("\\", "/")
		.split("/")
		.filter((segment) => segment.length > 0);
}

function FirstShortcutIconPicker({
	value,
	onSelect,
}: {
	value: RuntimeShortcutPickerIconId;
	onSelect: (icon: RuntimeShortcutPickerIconId) => void;
}): React.ReactElement {
	const [open, setOpen] = useState(false);
	const selectedOption = getRuntimeShortcutPickerOption(value);
	const SelectedIconComponent = getRuntimeShortcutIconComponent(value);

	return (
		<RadixPopover.Root open={open} onOpenChange={setOpen}>
			<RadixPopover.Trigger asChild>
				<button
					type="button"
					aria-label={`Shortcut icon: ${selectedOption.label}`}
					className="inline-flex items-center gap-1 h-8 px-2 rounded-md border border-border bg-surface-2 text-text-primary hover:bg-surface-3"
				>
					<SelectedIconComponent size={14} />
					<ChevronDown size={12} />
				</button>
			</RadixPopover.Trigger>
			<RadixPopover.Portal>
				<RadixPopover.Content
					side="bottom"
					align="start"
					sideOffset={4}
					className="z-50 rounded-md border border-border bg-surface-2 p-1 shadow-lg"
					style={{ animation: "kb-tooltip-show 100ms ease" }}
				>
					<div className="flex gap-0.5">
						{RUNTIME_SHORTCUT_ICON_OPTIONS.map((option) => {
							const IconComponent = getRuntimeShortcutIconComponent(option.value);
							return (
								<button
									key={option.value}
									type="button"
									aria-label={option.label}
									className={cn(
										"p-1.5 rounded hover:bg-surface-3",
										selectedOption.value === option.value && "bg-surface-3",
									)}
									onClick={() => {
										onSelect(option.value);
										setOpen(false);
									}}
								>
									<IconComponent size={14} />
								</button>
							);
						})}
					</div>
				</RadixPopover.Content>
			</RadixPopover.Portal>
		</RadixPopover.Root>
	);
}

export function GitBranchStatusControl({
	branchLabel,
	changedFiles,
	additions,
	deletions,
	onToggleGitHistory,
	isGitHistoryOpen,
}: {
	branchLabel: string;
	changedFiles: number;
	additions: number;
	deletions: number;
	onToggleGitHistory?: () => void;
	isGitHistoryOpen?: boolean;
}): React.ReactElement {
	if (onToggleGitHistory) {
		return (
			<div className="flex items-center min-w-0 overflow-hidden">
				<Button
					variant={isGitHistoryOpen ? "primary" : "default"}
					size="sm"
					icon={<GitBranch size={12} />}
					onClick={onToggleGitHistory}
					className={cn(
						"font-mono text-xs shrink min-w-0 max-w-full overflow-hidden",
						isGitHistoryOpen ? "ring-1 ring-accent" : "kb-navbar-btn",
					)}
				>
					<TruncateTooltip content={branchLabel} side="bottom">
						<span className="truncate w-full text-left">{branchLabel}</span>
					</TruncateTooltip>
				</Button>
				<span className="font-mono text-xs text-text-tertiary ml-1.5 shrink-0 whitespace-nowrap">
					({changedFiles} {changedFiles === 1 ? "file" : "files"}
					<span className="text-status-green"> +{additions}</span>
					<span className="text-status-red"> -{deletions}</span>)
				</span>
			</div>
		);
	}

	return (
		<span className="font-mono text-xs text-text-secondary mr-1 whitespace-nowrap">
			<GitBranch size={12} className="inline-block mr-1" style={{ verticalAlign: -1 }} />
			<span className="text-text-primary">{branchLabel}</span>
			<span className="ml-1.5">
				<span className="text-text-tertiary">
					({changedFiles} {changedFiles === 1 ? "file" : "files"}
				</span>
				<span className="text-status-green"> +{additions}</span>
				<span className="text-status-red"> -{deletions}</span>
				<span className="text-text-tertiary">)</span>
			</span>
		</span>
	);
}

export function TopBar({
	onBack,
	projectPath,
	isWorkspacePathLoading = false,
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
	isWorkspacePathLoading?: boolean;
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
	/** Scope type for the left-edge accent color ("home" | "task" | "branch_view"). */
	scopeType?: "home" | "task" | "branch_view";
	/** Task title to display as a scope indicator when in task scope. */
	taskTitle?: string | null;
}): React.ReactElement {
	const displayProjectPath = projectPath ? formatPathForDisplay(projectPath) : null;
	const projectSegments = displayProjectPath ? getProjectPathSegments(displayProjectPath) : [];
	const hasAbsoluteLeadingSlash = Boolean(displayProjectPath?.startsWith("/"));
	const handleAddShortcut = () => {
		onOpenSettings?.("shortcuts");
	};
	const shortcutItems = shortcuts ?? [];
	const selectedShortcutIndex =
		selectedShortcutLabel === null || selectedShortcutLabel === undefined
			? 0
			: shortcutItems.findIndex((shortcut) => shortcut.label === selectedShortcutLabel);
	const selectedShortcut = shortcutItems[selectedShortcutIndex >= 0 ? selectedShortcutIndex : 0] ?? null;
	const SelectedShortcutIcon = selectedShortcut ? getRuntimeShortcutIconComponent(selectedShortcut.icon) : Terminal;
	const [isCreateShortcutDialogOpen, setIsCreateShortcutDialogOpen] = useState(false);
	const [isCreateShortcutSaving, setIsCreateShortcutSaving] = useState(false);
	const [createShortcutError, setCreateShortcutError] = useState<string | null>(null);
	const [newShortcutIcon, setNewShortcutIcon] = useState<RuntimeShortcutPickerIconId>("play");
	const [newShortcutLabel, setNewShortcutLabel] = useState("Run");
	const [newShortcutCommand, setNewShortcutCommand] = useState("");
	const promptShortcutItems = promptShortcuts ?? [];
	const canSaveNewShortcut = newShortcutCommand.trim().length > 0;
	const handleOpenCreateShortcutDialog = () => {
		setCreateShortcutError(null);
		setNewShortcutIcon("play");
		setNewShortcutLabel("Run");
		setNewShortcutCommand("");
		setIsCreateShortcutDialogOpen(true);
	};
	const handleSaveFirstShortcut = async () => {
		if (!onCreateFirstShortcut || !canSaveNewShortcut || isCreateShortcutSaving) {
			return;
		}
		setCreateShortcutError(null);
		setIsCreateShortcutSaving(true);
		const result = await onCreateFirstShortcut({
			label: newShortcutLabel.trim(),
			command: newShortcutCommand.trim(),
			icon: newShortcutIcon,
		});
		setIsCreateShortcutSaving(false);
		if (!result.ok) {
			setCreateShortcutError(result.message ?? "Could not save shortcut.");
			return;
		}
		setIsCreateShortcutDialogOpen(false);
	};

	const scopeType = rawScopeType ?? "home";
	const scopeBorderClass = cn(
		"border-l-3",
		scopeType === "home" && "border-l-text-secondary",
		scopeType === "task" && "border-l-accent",
		scopeType === "branch_view" && "border-l-status-purple",
	);

	return (
		<>
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
				<div className="flex flex-nowrap items-center h-10 flex-1 min-w-0 overflow-hidden gap-1.5">
					{onBack ? (
						<div className="flex items-center shrink-0 overflow-visible">
							<Button
								variant="ghost"
								size="sm"
								icon={<ArrowLeft size={16} />}
								onClick={onBack}
								aria-label="Back to board"
								className="mr-1 shrink-0"
							/>
						</div>
					) : null}
					{scopeType === "task" && taskTitle ? (
						<Tooltip side="bottom" content="Task name">
							<span className="inline-flex items-center shrink min-w-0 mr-1.5 text-xs">
								<span className="text-accent truncate max-w-[200px]">{taskTitle}</span>
							</span>
						</Tooltip>
					) : null}
					{isWorkspacePathLoading ? (
						<span
							className="kb-skeleton inline-block"
							style={{ height: 14, width: 320, borderRadius: 3 }}
							aria-hidden
						/>
					) : displayProjectPath ? (
						<div className="shrink min-w-0 max-w-[640px] overflow-hidden">
							<span
								className="font-mono truncate block w-full min-w-0 text-xs max-w-full text-text-secondary"
								title={projectPath}
								data-testid="project-path"
							>
								{hasAbsoluteLeadingSlash ? "/" : ""}
								{projectSegments.map((segment, index) => {
									const isLast = index === projectSegments.length - 1;
									return (
										<span key={`${segment}-${index}`}>
											{index === 0 ? "" : "/"}
											<span className={isLast ? "text-text-primary" : undefined}>{segment}</span>
										</span>
									);
								})}
							</span>
						</div>
					) : null}
					{!hideProjectDependentActions && projectHint ? (
						<span className="kb-navbar-tag inline-flex items-center rounded border border-border bg-surface-2 px-1.5 py-0.5 text-xs text-text-secondary">
							{projectHint}
						</span>
					) : null}
					{!hideProjectDependentActions && runtimeHint ? (
						onOpenSettings ? (
							<button
								type="button"
								onClick={() => onOpenSettings()}
								className="kb-navbar-tag inline-flex items-center rounded border border-status-orange/30 bg-status-orange/10 px-1.5 py-0.5 text-xs text-status-orange transition-colors hover:bg-status-orange/15 focus:outline-none focus:ring-2 focus:ring-border-focus focus:ring-offset-0"
							>
								{runtimeHint}
							</button>
						) : (
							<span className="kb-navbar-tag inline-flex items-center rounded border border-status-orange/30 bg-status-orange/10 px-1.5 py-0.5 text-xs text-status-orange">
								{runtimeHint}
							</span>
						)
					) : null}
					{!hideProjectDependentActions && branchPillSlot ? branchPillSlot : null}
				</div>
				<div className="flex flex-nowrap items-center h-10 pr-0.5 shrink-0">
					{!hideProjectDependentActions && onRunShortcut ? (
						selectedShortcut ? (
							<div className="flex">
								<Button
									variant="default"
									size="sm"
									icon={runningShortcutLabel ? <Spinner size={12} /> : <SelectedShortcutIcon size={14} />}
									disabled={Boolean(runningShortcutLabel)}
									onClick={() => onRunShortcut(selectedShortcut.label)}
									className="text-xs rounded-r-none kb-navbar-btn"
								>
									{selectedShortcut.label}
								</Button>
								<RadixPopover.Root>
									<RadixPopover.Trigger asChild>
										<Button
											size="sm"
											variant="default"
											icon={<ChevronDown size={12} />}
											aria-label="Select shortcut"
											disabled={Boolean(runningShortcutLabel)}
											className="rounded-l-none border-l-0 kb-navbar-btn"
											style={{ width: 24, paddingLeft: 0, paddingRight: 0 }}
										/>
									</RadixPopover.Trigger>
									<RadixPopover.Portal>
										<RadixPopover.Content
											className="z-50 rounded-lg border border-border bg-surface-2 p-1 shadow-xl"
											style={{ animation: "kb-tooltip-show 100ms ease" }}
											sideOffset={5}
											align="end"
										>
											<div className="min-w-[180px]">
												{shortcutItems.map((shortcut, shortcutIndex) => {
													const ShortcutIcon = getRuntimeShortcutIconComponent(shortcut.icon);
													const isActive =
														shortcutIndex === (selectedShortcutIndex >= 0 ? selectedShortcutIndex : 0);
													return (
														<button
															type="button"
															key={`${shortcut.label}:${shortcut.command}:${shortcutIndex}`}
															className={cn(
																"flex w-full items-center gap-2 px-2.5 py-1.5 text-[13px] text-text-primary rounded-md hover:bg-surface-3 text-left",
																isActive && "bg-surface-3",
															)}
															onClick={() => onSelectShortcutLabel?.(shortcut.label)}
														>
															<ShortcutIcon size={14} />
															<span className="flex-1">{shortcut.label}</span>
															{isActive ? <Check size={14} className="text-text-secondary" /> : null}
														</button>
													);
												})}
												<div className="h-px bg-border my-1" />
												<button
													type="button"
													className="flex w-full items-center gap-2 px-2.5 py-1.5 text-[13px] text-text-primary rounded-md hover:bg-surface-3 text-left"
													onClick={handleAddShortcut}
												>
													<Plus size={14} />
													<span>Add shortcut</span>
												</button>
											</div>
										</RadixPopover.Content>
									</RadixPopover.Portal>
								</RadixPopover.Root>
							</div>
						) : onCreateFirstShortcut ? (
							<Button
								variant="default"
								size="sm"
								icon={<Play size={14} />}
								onClick={handleOpenCreateShortcutDialog}
								className="text-xs kb-navbar-btn"
							>
								Run
							</Button>
						) : null
					) : null}
					{!hideProjectDependentActions && selectedTaskId && activePromptShortcut && onRunPromptShortcut ? (
						<div className="flex ml-1">
							<Button
								variant="default"
								size="sm"
								icon={isPromptShortcutRunning ? <Spinner size={12} /> : <MessageSquare size={14} />}
								disabled={isPromptShortcutRunning}
								onClick={() => onRunPromptShortcut(selectedTaskId, activePromptShortcut.label)}
								className="text-xs rounded-r-none kb-navbar-btn"
							>
								{activePromptShortcut.label}
							</Button>
							<RadixPopover.Root>
								<RadixPopover.Trigger asChild>
									<Button
										size="sm"
										variant="default"
										icon={<ChevronDown size={12} />}
										aria-label="Select prompt shortcut"
										disabled={isPromptShortcutRunning}
										className="rounded-l-none border-l-0 kb-navbar-btn"
										style={{ width: 24, paddingLeft: 0, paddingRight: 0 }}
									/>
								</RadixPopover.Trigger>
								<RadixPopover.Portal>
									<RadixPopover.Content
										className="z-50 rounded-lg border border-border bg-surface-2 p-1 shadow-xl"
										style={{ animation: "kb-tooltip-show 100ms ease" }}
										sideOffset={5}
										align="end"
									>
										<div className="min-w-[180px]">
											{promptShortcutItems.map((shortcut, shortcutIndex) => {
												const isActive = shortcut.label === activePromptShortcut?.label;
												return (
													<button
														type="button"
														key={`${shortcut.label}:${shortcutIndex}`}
														className={cn(
															"flex w-full items-center gap-2 px-2.5 py-1.5 text-[13px] text-text-primary rounded-md hover:bg-surface-3 text-left",
															isActive && "bg-surface-3",
														)}
														onClick={() => onSelectPromptShortcutLabel?.(shortcut.label)}
													>
														<MessageSquare size={14} />
														<span className="flex-1">{shortcut.label}</span>
														{isActive ? <Check size={14} className="text-text-secondary" /> : null}
													</button>
												);
											})}
											{onManagePromptShortcuts ? (
												<>
													<div className="h-px bg-border my-1" />
													<button
														type="button"
														className="flex w-full items-center gap-2 px-2.5 py-1.5 text-[13px] text-text-primary rounded-md hover:bg-surface-3 text-left"
														onClick={onManagePromptShortcuts}
													>
														<Settings size={14} />
														<span>Manage shortcuts...</span>
													</button>
												</>
											) : null}
										</div>
									</RadixPopover.Content>
								</RadixPopover.Portal>
							</RadixPopover.Root>
						</div>
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
			<Dialog
				open={isCreateShortcutDialogOpen}
				contentAriaDescribedBy={undefined}
				onOpenChange={(nextOpen) => {
					if (isCreateShortcutSaving) {
						return;
					}
					setIsCreateShortcutDialogOpen(nextOpen);
					if (!nextOpen) {
						setCreateShortcutError(null);
					}
				}}
			>
				<DialogHeader title="Set up your first script shortcut" icon={<Play size={16} />} />
				<DialogBody>
					<p className="text-text-secondary text-[13px] mt-0 mb-2">
						Script shortcuts run a command in the bottom terminal so you can quickly run and test your project.
					</p>
					<p className="text-text-secondary text-[13px] mt-0 mb-3">
						You can always open Settings to add and manage more shortcuts later.
					</p>
					<div className="grid gap-2" style={{ gridTemplateColumns: "max-content 1fr 2fr" }}>
						<FirstShortcutIconPicker value={newShortcutIcon} onSelect={setNewShortcutIcon} />
						<input
							value={newShortcutLabel}
							onChange={(event) => setNewShortcutLabel(event.target.value)}
							placeholder="Label"
							disabled={isCreateShortcutSaving}
							className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-60"
						/>
						<input
							value={newShortcutCommand}
							onChange={(event) => setNewShortcutCommand(event.target.value)}
							placeholder="npm run dev"
							disabled={isCreateShortcutSaving}
							className="h-8 w-full rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-60"
						/>
					</div>
					{createShortcutError ? (
						<p className="text-status-red text-[13px] mt-3 mb-0">{createShortcutError}</p>
					) : null}
				</DialogBody>
				<DialogFooter>
					<Button
						onClick={() => {
							if (!isCreateShortcutSaving) {
								setIsCreateShortcutDialogOpen(false);
								setCreateShortcutError(null);
							}
						}}
						disabled={isCreateShortcutSaving}
					>
						Cancel
					</Button>
					<Button
						variant="primary"
						onClick={() => {
							void handleSaveFirstShortcut();
						}}
						disabled={!canSaveNewShortcut || isCreateShortcutSaving}
					>
						{isCreateShortcutSaving ? (
							<>
								<Spinner size={12} />
								Saving...
							</>
						) : (
							"Save"
						)}
					</Button>
				</DialogFooter>
			</Dialog>
		</>
	);
}
