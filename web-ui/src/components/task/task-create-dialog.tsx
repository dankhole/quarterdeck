import * as RadixCheckbox from "@radix-ui/react-checkbox";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as RadixSwitch from "@radix-ui/react-switch";
import {
	AlertTriangle,
	ArrowBigUp,
	Check,
	ChevronDown,
	Command,
	CornerDownLeft,
	List,
	PencilLine,
	Sparkles,
} from "lucide-react";
import type { Dispatch, ReactElement, SetStateAction } from "react";
import { useId } from "react";

import type { BranchSelectOption } from "@/components/git/branch-select-dropdown";
import { BranchSelectDropdown } from "@/components/git/branch-select-dropdown";
import { TaskAgentSelector } from "@/components/task/task-agent-selector";
import { ButtonShortcut, DIALOG_STYLE } from "@/components/task/task-create-dialog-utils";
import { TaskCreateMultiList } from "@/components/task/task-create-multi-list";
import { TaskPromptComposer } from "@/components/task/task-prompt-composer";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useTaskCreateDialog } from "@/hooks/board/use-task-create-dialog";
import type { RuntimeAgentDefinition, RuntimeAgentId } from "@/runtime/types";
import type { TaskImage } from "@/types";
import { pasteShortcutLabel } from "@/utils/platform";

export function TaskCreateDialog({
	open,
	onOpenChange,
	prompt,
	onPromptChange,
	images,
	onImagesChange,
	agentOptions,
	agentId,
	onAgentIdChange,
	onCreate,
	onCreateAndStart,
	onCreateMultiple,
	onCreateAndStartMultiple,
	onCreateStartAndOpen,
	useWorktree,
	onUseWorktreeChange,
	createFeatureBranch,
	onCreateFeatureBranchChange,
	branchName,
	onBranchNameEdit,
	onGenerateBranchName,
	isGeneratingBranchName,
	isLlmGenerationDisabled = false,
	projectId,
	currentBranch,
	branchRef,
	branchOptions,
	onBranchRefChange,
	defaultBaseRef,
	onSetDefaultBaseRef,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	prompt: string;
	onPromptChange: (value: string) => void;
	images: TaskImage[];
	onImagesChange: Dispatch<SetStateAction<TaskImage[]>>;
	agentOptions: RuntimeAgentDefinition[];
	agentId: RuntimeAgentId;
	onAgentIdChange: (value: RuntimeAgentId) => void;
	onCreate: (options?: { keepDialogOpen?: boolean }) => string | null;
	onCreateAndStart?: (options?: { keepDialogOpen?: boolean }) => string | null;
	onCreateMultiple: (prompts: string[], options?: { keepDialogOpen?: boolean }) => string[];
	onCreateAndStartMultiple?: (prompts: string[], options?: { keepDialogOpen?: boolean }) => string[];
	onCreateStartAndOpen?: (options?: { keepDialogOpen?: boolean }) => string | null;
	useWorktree: boolean;
	onUseWorktreeChange: (value: boolean) => void;
	createFeatureBranch: boolean;
	onCreateFeatureBranchChange: (value: boolean) => void;
	branchName: string;
	onBranchNameEdit: (value: string) => void;
	onGenerateBranchName: () => void;
	isGeneratingBranchName: boolean;
	isLlmGenerationDisabled?: boolean;
	projectId: string | null;
	currentBranch: string | null;
	branchRef: string;
	branchOptions: BranchSelectOption[];
	onBranchRefChange: (value: string) => void;
	defaultBaseRef?: string;
	onSetDefaultBaseRef?: (value: string | null) => void;
}): ReactElement {
	const useWorktreeId = useId();
	const createFeatureBranchId = useId();
	const createMoreId = useId();
	const {
		mode,
		createMore,
		setCreateMore,
		composerResetKey,
		taskPrompts,
		setTaskPrompts,
		detectedItems,
		validTaskCount,
		dialogTitle,
		taskCountLabel,
		primaryStartAction,
		primaryStartLabel,
		primaryStartIncludesShift,
		secondaryStartAction,
		secondaryStartLabel,
		secondaryStartIncludesShift,
		handleSplitIntoTasks,
		handleBackToSingle,
		handleCreateSingle,
		handleRunSingleStartAction,
		handleCreateAll,
		handleCreateAndStartAll,
	} = useTaskCreateDialog({
		open,
		prompt,
		onPromptChange,
		onImagesChange,
		onCreate,
		onCreateAndStart,
		onCreateMultiple,
		onCreateAndStartMultiple,
		onCreateStartAndOpen,
	});

	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
			contentClassName="resize overflow-auto"
			contentStyle={DIALOG_STYLE}
		>
			<DialogHeader title={dialogTitle} icon={<PencilLine size={16} />} />
			<DialogBody>
				{mode === "single" ? (
					<div>
						<TaskPromptComposer
							key={composerResetKey}
							value={prompt}
							onValueChange={onPromptChange}
							images={images}
							onImagesChange={onImagesChange}
							onSubmit={handleCreateSingle}
							onSubmitAndStart={() => handleRunSingleStartAction("start")}
							placeholder="Describe the task..."
							autoFocus
							projectId={projectId}
							showAttachImageButton={false}
						/>
						<div className="flex items-center justify-between mt-1.5">
							<div className="text-[11px] text-text-tertiary space-y-0.5">
								<p>
									Use <code className="rounded bg-surface-3 px-1 py-px font-mono text-[11px]">@file</code> to
									reference files. Drag and drop or{" "}
									<code className="rounded bg-surface-3 px-1 py-px font-mono text-[11px]">
										{pasteShortcutLabel}
									</code>{" "}
									to add images.
								</p>
								<p>Paste a numbered or bulleted list to create multiple tasks at once.</p>
							</div>
							{detectedItems.length >= 2 ? (
								<button
									type="button"
									onClick={handleSplitIntoTasks}
									className="inline-flex items-center gap-1.5 text-[12px] text-status-blue hover:text-[#86BEFF] cursor-pointer shrink-0"
								>
									<List size={12} />
									Split into {detectedItems.length} tasks
								</button>
							) : null}
						</div>
					</div>
				) : (
					<TaskCreateMultiList
						taskPrompts={taskPrompts}
						onTaskPromptsChange={setTaskPrompts}
						onBackToSingle={handleBackToSingle}
						onCreateAll={handleCreateAll}
						onCreateAndStartAll={handleCreateAndStartAll}
					/>
				)}

				<div className="mt-4 border-t border-border pt-4">
					<div>
						<span className="text-[11px] text-text-secondary block mb-1">Harness</span>
						<TaskAgentSelector agents={agentOptions} value={agentId} onValueChange={onAgentIdChange} />
					</div>
					<div className={useWorktree ? "mt-3" : "mt-3 opacity-40"}>
						<span className="text-[11px] text-text-secondary block mb-1">Base ref</span>
						<BranchSelectDropdown
							options={branchOptions}
							selectedValue={branchRef}
							onSelect={onBranchRefChange}
							disabled={!useWorktree}
							fill
							size="sm"
							emptyText="No branches detected"
							defaultValue={defaultBaseRef || null}
							onSetDefault={onSetDefaultBaseRef}
						/>
					</div>
					<div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
						<label
							htmlFor={useWorktreeId}
							className="flex items-center gap-2 text-[13px] text-text-primary cursor-pointer select-none"
						>
							<RadixCheckbox.Root
								id={useWorktreeId}
								checked={useWorktree}
								onCheckedChange={(checked) => onUseWorktreeChange(checked === true)}
								className="flex h-4 w-4 shrink-0 translate-y-px cursor-pointer items-center justify-center rounded-sm border border-border-bright bg-surface-3 data-[state=checked]:bg-accent data-[state=checked]:border-accent"
							>
								<RadixCheckbox.Indicator className="flex items-center justify-center">
									<Check size={11} className="block text-white" />
								</RadixCheckbox.Indicator>
							</RadixCheckbox.Root>
							Use isolated worktree
						</label>
						<label
							htmlFor={createFeatureBranchId}
							className={cn(
								"flex items-center gap-2 text-[13px] text-text-primary select-none",
								useWorktree ? "cursor-pointer" : "cursor-default opacity-40",
							)}
						>
							<RadixCheckbox.Root
								id={createFeatureBranchId}
								checked={createFeatureBranch}
								onCheckedChange={(checked) => onCreateFeatureBranchChange(checked === true)}
								disabled={!useWorktree}
								className="flex h-4 w-4 shrink-0 translate-y-px cursor-pointer items-center justify-center rounded-sm border border-border-bright bg-surface-3 data-[state=checked]:bg-accent data-[state=checked]:border-accent disabled:cursor-default"
							>
								<RadixCheckbox.Indicator className="flex items-center justify-center">
									<Check size={11} className="block text-white" />
								</RadixCheckbox.Indicator>
							</RadixCheckbox.Root>
							Create feature branch
						</label>
					</div>
					{!useWorktree ? (
						<div className="mt-1.5 flex items-start gap-1.5 rounded-md bg-status-orange/10 border border-status-orange/20 px-2 py-1.5 text-[11px] text-status-orange leading-snug">
							<AlertTriangle size={12} className="mt-0.5 shrink-0" />
							<span>
								Without isolation, the task runs directly on{" "}
								<code className="rounded bg-status-orange/15 px-1 py-px font-mono text-[11px]">
									{currentBranch ?? "detached HEAD"}
								</code>{" "}
								in your main checkout. Running multiple tasks at once may cause file conflicts.
							</span>
						</div>
					) : null}
					{useWorktree && createFeatureBranch ? (
						<div className="mt-2 flex items-center gap-1.5">
							<input
								name="feature-branch-name"
								type="text"
								value={branchName}
								onChange={(e) => onBranchNameEdit(e.currentTarget.value)}
								placeholder="quarterdeck/branch-name"
								className="h-7 flex-1 min-w-0 rounded-md border border-border-bright bg-surface-2 px-2 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
							/>
							<button
								type="button"
								onClick={onGenerateBranchName}
								disabled={!prompt.trim() || isGeneratingBranchName || isLlmGenerationDisabled}
								title={isLlmGenerationDisabled ? "LLM not configured" : "Generate branch name from prompt"}
								className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border-bright bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:opacity-40 disabled:cursor-default cursor-pointer"
							>
								{isGeneratingBranchName ? <Spinner size={12} /> : <Sparkles size={12} />}
							</button>
						</div>
					) : null}
				</div>
			</DialogBody>
			<DialogFooter>
				<label
					htmlFor={createMoreId}
					className="mr-auto flex items-center gap-2 text-[12px] text-text-primary cursor-pointer select-none"
				>
					<RadixSwitch.Root
						id={createMoreId}
						checked={createMore}
						onCheckedChange={setCreateMore}
						className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer"
					>
						<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
					</RadixSwitch.Root>
					<span>Create more</span>
				</label>
				{mode === "single" ? (
					<>
						<Button size="sm" onClick={handleCreateSingle} disabled={!prompt.trim() || !branchRef}>
							<span className="inline-flex items-center">
								Create
								<ButtonShortcut includeAlt />
							</span>
						</Button>
						{onCreateAndStart ? (
							<DropdownMenu.Root>
								<div className="inline-flex items-center">
									<Button
										variant="primary"
										size="sm"
										onClick={() => handleRunSingleStartAction(primaryStartAction)}
										disabled={!prompt.trim() || !branchRef}
										className={onCreateStartAndOpen ? "rounded-r-none" : undefined}
									>
										<span className="inline-flex items-center">
											{primaryStartLabel}
											<ButtonShortcut includeShift={primaryStartIncludesShift} />
										</span>
									</Button>
									{onCreateStartAndOpen ? (
										<DropdownMenu.Trigger asChild>
											<Button
												variant="primary"
												size="sm"
												disabled={!prompt.trim() || !branchRef}
												className="rounded-l-none border-l border-white/20 px-1"
												aria-label="More start options"
											>
												<ChevronDown size={12} />
											</Button>
										</DropdownMenu.Trigger>
									) : null}
								</div>
								<DropdownMenu.Portal>
									<DropdownMenu.Content
										side="bottom"
										align="end"
										sideOffset={4}
										className="z-50 rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg"
										onCloseAutoFocus={(event) => event.preventDefault()}
									>
										<DropdownMenu.Item
											className="flex items-center justify-between gap-2 rounded-sm px-2 py-1 text-[12px] text-text-primary cursor-pointer outline-none data-[highlighted]:bg-surface-3 whitespace-nowrap"
											onSelect={() => handleRunSingleStartAction(secondaryStartAction)}
										>
											{secondaryStartLabel}
											<span className="inline-flex items-center gap-0.5 text-text-tertiary" aria-hidden>
												<Command size={10} />
												{secondaryStartIncludesShift ? <ArrowBigUp size={10} /> : null}
												<CornerDownLeft size={10} />
											</span>
										</DropdownMenu.Item>
									</DropdownMenu.Content>
								</DropdownMenu.Portal>
							</DropdownMenu.Root>
						) : null}
					</>
				) : (
					<>
						<Button size="sm" onClick={handleCreateAll} disabled={validTaskCount === 0 || !branchRef}>
							<span className="inline-flex items-center">
								Create {validTaskCount} {taskCountLabel}
								<ButtonShortcut includeAlt />
							</span>
						</Button>
						{onCreateAndStartMultiple ? (
							<Button
								variant="primary"
								size="sm"
								onClick={handleCreateAndStartAll}
								disabled={validTaskCount === 0 || !branchRef}
							>
								<span className="inline-flex items-center">
									Start {validTaskCount} {taskCountLabel}
									<ButtonShortcut />
								</span>
							</Button>
						) : null}
					</>
				)}
			</DialogFooter>
		</Dialog>
	);
}
