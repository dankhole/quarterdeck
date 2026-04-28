import * as RadixCheckbox from "@radix-ui/react-checkbox";
import { AlertTriangle, ArrowBigUp, Check, Command, CornerDownLeft } from "lucide-react";
import { type Dispatch, type ReactElement, type SetStateAction, useCallback, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";

import { BranchSelectDropdown, type BranchSelectOption } from "@/components/git/branch-select-dropdown";
import { TaskPromptComposer } from "@/components/task/task-prompt-composer";
import { Button } from "@/components/ui/button";
import type { TaskImage } from "@/types";
import { pasteShortcutLabel } from "@/utils/platform";
import { useDocumentEvent, useMeasure } from "@/utils/react-use";

export type TaskInlineCardMode = "create" | "edit";

export type TaskBranchOption = BranchSelectOption;

const COMPACT_ACTIONS_WIDTH_THRESHOLD_PX = 280;

function ButtonShortcut({ includeShift = false }: { includeShift?: boolean }): ReactElement {
	return (
		<span
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: 2,
				marginLeft: 6,
			}}
			aria-hidden
		>
			<Command size={12} />
			{includeShift ? <ArrowBigUp size={12} /> : null}
			<CornerDownLeft size={12} />
		</span>
	);
}

export function TaskInlineCreateCard({
	prompt,
	onPromptChange,
	images,
	onImagesChange,
	onCreate,
	onCreateAndStart,
	onCancel,
	useWorktree,
	onUseWorktreeChange,
	projectId,
	branchRef,
	branchOptions,
	onBranchRefChange,
	defaultBaseRef,
	onSetDefaultBaseRef,
	enabled = true,
	mode = "create",
	idPrefix = "inline-task",
}: {
	prompt: string;
	onPromptChange: (value: string) => void;
	images?: TaskImage[];
	onImagesChange?: Dispatch<SetStateAction<TaskImage[]>>;
	onCreate: () => void;
	onCreateAndStart?: () => void;
	onCancel?: () => void;
	useWorktree?: boolean;
	onUseWorktreeChange?: (value: boolean) => void;
	projectId: string | null;
	branchRef: string;
	branchOptions: TaskBranchOption[];
	onBranchRefChange: (value: string) => void;
	defaultBaseRef?: string;
	onSetDefaultBaseRef?: (value: string | null) => void;
	enabled?: boolean;
	mode?: TaskInlineCardMode;
	idPrefix?: string;
}): ReactElement {
	const promptId = `${idPrefix}-prompt-input`;
	const useWorktreeId = `${idPrefix}-use-worktree-toggle`;
	const branchSelectId = `${idPrefix}-branch-select`;
	const actionLabel = mode === "edit" ? "Save" : "Create";
	const [measureRef, cardRect] = useMeasure<HTMLDivElement>();
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [isBranchPopoverOpen, setIsBranchPopoverOpen] = useState(false);
	const setCardRef = useCallback(
		(node: HTMLDivElement | null) => {
			containerRef.current = node;
			if (node) {
				measureRef(node);
			}
		},
		[measureRef],
	);
	const isCompactActions = cardRect.width > 0 && cardRect.width < COMPACT_ACTIONS_WIDTH_THRESHOLD_PX;
	const hideCancelShortcut = isCompactActions;
	const hideCreateShortcut = mode === "create" && isCompactActions;
	const cancelLabel = hideCancelShortcut ? "Cancel" : "Cancel (esc)";
	const cardMarginBottom = mode === "create" ? 6 : 0;

	useHotkeys(
		"escape",
		(event) => {
			if (!onCancel) {
				return;
			}
			if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
				return;
			}
			onCancel();
		},
		{
			enabled: enabled && Boolean(onCancel),
			enableOnFormTags: true,
			enableOnContentEditable: true,
			ignoreEventWhen: (event) => event.defaultPrevented,
			preventDefault: true,
		},
		[enabled, mode, onCancel],
	);

	useDocumentEvent(
		"pointerdown",
		(event) => {
			if (!enabled || mode !== "edit" || isBranchPopoverOpen) {
				return;
			}
			const container = containerRef.current;
			if (!container) {
				return;
			}
			if (event.target instanceof Node && container.contains(event.target)) {
				return;
			}
			onCreate();
		},
		true,
	);

	return (
		<div
			ref={setCardRef}
			className="rounded-md border border-border-bright bg-surface-2 p-3"
			style={{ flexShrink: 0, marginBottom: cardMarginBottom, fontSize: 12 }}
		>
			<div>
				<TaskPromptComposer
					id={promptId}
					value={prompt}
					onValueChange={onPromptChange}
					images={images}
					onImagesChange={onImagesChange}
					onSubmit={onCreate}
					onSubmitAndStart={onCreateAndStart}
					onEscape={onCancel}
					placeholder="Describe the task..."
					enabled={enabled}
					autoFocus
					projectId={projectId}
					showAttachImageButton={false}
				/>
				<p className="text-[11px] text-text-tertiary mt-1 mb-0">
					Use <code className="rounded bg-surface-3 px-1 py-px font-mono text-[11px]">@file</code> to reference
					files. Drag and drop or{" "}
					<code className="rounded bg-surface-3 px-1 py-px font-mono text-[11px]">{pasteShortcutLabel}</code> to
					add images.
				</p>
			</div>

			<div className="flex flex-col gap-2 mt-3">
				<div>
					<span className="text-[11px] text-text-secondary block mb-1">Base ref</span>
					<BranchSelectDropdown
						id={branchSelectId}
						options={branchOptions}
						selectedValue={branchRef}
						onSelect={onBranchRefChange}
						onPopoverOpenChange={setIsBranchPopoverOpen}
						fill
						size="sm"
						emptyText="No branches detected"
						defaultValue={defaultBaseRef || null}
						onSetDefault={onSetDefaultBaseRef}
						ghostUntilOpen
					/>
				</div>

				{onUseWorktreeChange !== undefined ? (
					<div>
						<label
							htmlFor={useWorktreeId}
							className="flex items-center gap-2 text-[12px] text-text-primary cursor-pointer select-none"
						>
							<RadixCheckbox.Root
								id={useWorktreeId}
								checked={useWorktree ?? true}
								onCheckedChange={(checked) => onUseWorktreeChange(checked === true)}
								disabled={!enabled}
								className="flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded-sm border border-border-bright bg-surface-3 data-[state=checked]:bg-accent data-[state=checked]:border-accent disabled:cursor-default disabled:opacity-40"
							>
								<RadixCheckbox.Indicator>
									<Check size={10} className="text-white" />
								</RadixCheckbox.Indicator>
							</RadixCheckbox.Root>
							<span>Use isolated worktree</span>
						</label>
						{useWorktree === false ? (
							<div className="mt-1.5 flex items-start gap-1.5 rounded-md bg-status-orange/10 border border-status-orange/20 px-2 py-1.5 text-[11px] text-status-orange leading-snug">
								<AlertTriangle size={12} className="mt-0.5 shrink-0" />
								<span>
									Without isolation, the task runs directly in your main checkout. Running multiple tasks at
									once may cause file conflicts.
								</span>
							</div>
						) : null}
					</div>
				) : null}
			</div>

			<div className={`flex gap-2 mt-3 ${mode === "edit" ? "justify-end" : "justify-between"}`}>
				{mode === "create" && onCancel ? (
					<Button variant="default" size="sm" className="whitespace-nowrap" onClick={onCancel}>
						{cancelLabel}
					</Button>
				) : null}
				<div className="flex gap-2">
					<Button
						size="sm"
						className="whitespace-nowrap"
						onClick={onCreate}
						disabled={!prompt.trim() || !branchRef}
					>
						<span className="inline-flex items-center">
							<span>{actionLabel}</span>
							{hideCreateShortcut ? null : <ButtonShortcut />}
						</span>
					</Button>
					{onCreateAndStart ? (
						<Button
							variant="primary"
							size="sm"
							className="whitespace-nowrap"
							onClick={onCreateAndStart}
							disabled={!prompt.trim() || !branchRef}
						>
							<span className="inline-flex items-center">
								<span>Start</span>
								<ButtonShortcut includeShift />
							</span>
						</Button>
					) : null}
				</div>
			</div>
		</div>
	);
}
