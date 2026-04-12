import * as Collapsible from "@radix-ui/react-collapsible";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Popover from "@radix-ui/react-popover";
import { Archive, ChevronRight, Copy, Eye, GitBranch, Trash2, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { CONTEXT_MENU_ITEM_CLASS } from "@/components/detail-panels/context-menu-utils";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
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
import { Spinner } from "@/components/ui/spinner";
import { useStashList } from "@/hooks/use-stash-list";
import type { RuntimeStashEntry } from "@/runtime/types";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function formatRelativeDate(isoDate: string): string {
	const date = new Date(isoDate);
	const now = Date.now();
	const diffMs = now - date.getTime();
	const seconds = Math.floor(diffMs / 1000);
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo ago`;
	return `${Math.floor(months / 12)}y ago`;
}

/* ------------------------------------------------------------------ */
/* Diff Preview Popover                                                */
/* ------------------------------------------------------------------ */

function StashDiffPopover({
	open,
	onOpenChange,
	diff,
	isLoading,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	diff: string;
	isLoading: boolean;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<Popover.Root open={open} onOpenChange={onOpenChange}>
			<Popover.Anchor asChild>{children}</Popover.Anchor>
			<Popover.Portal>
				<Popover.Content
					side="left"
					align="start"
					sideOffset={8}
					className="z-50 rounded-md border border-border-bright bg-surface-1 shadow-lg"
					style={{ maxWidth: "min(600px, 90vw)" }}
				>
					<div className="flex items-center justify-between px-3 py-2 border-b border-border">
						<span className="text-xs font-medium text-text-secondary">Stash Diff</span>
						<Popover.Close className="p-0.5 rounded text-text-tertiary hover:text-text-primary cursor-pointer">
							<X size={14} />
						</Popover.Close>
					</div>
					{isLoading ? (
						<div className="flex items-center justify-center p-6">
							<Spinner size={18} />
						</div>
					) : diff ? (
						<pre className="text-xs font-mono whitespace-pre overflow-auto max-h-80 p-3 bg-surface-1 rounded-md">
							{diff}
						</pre>
					) : (
						<div className="p-3 text-xs text-text-tertiary">No diff available.</div>
					)}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

/* ------------------------------------------------------------------ */
/* Stash Entry Row                                                     */
/* ------------------------------------------------------------------ */

function StashEntryRow({
	entry,
	onPop,
	onApply,
	onDrop,
	onShowDiff,
}: {
	entry: RuntimeStashEntry;
	onPop: () => void;
	onApply: () => void;
	onDrop: () => void;
	onShowDiff: () => void;
}): React.ReactElement {
	return (
		<ContextMenu.Root>
			<ContextMenu.Trigger asChild>
				<div className="flex items-center gap-1.5 px-2 py-1.5 hover:bg-surface-3 rounded-sm min-w-0 cursor-default group">
					{/* Index badge */}
					<span className="shrink-0 text-[11px] font-mono font-medium text-text-tertiary bg-surface-2 rounded px-1 py-0.5">
						#{entry.index}
					</span>

					{/* Message (truncated) */}
					<span className="truncate flex-1 text-[13px] text-text-primary" title={entry.message}>
						{entry.message}
					</span>

					{/* Branch pill */}
					<span
						className="shrink-0 inline-flex items-center gap-1 text-[11px] text-text-secondary bg-surface-2 rounded-full px-1.5 py-0.5 max-w-[120px]"
						title={entry.branch}
					>
						<GitBranch size={10} className="shrink-0" />
						<span className="truncate">{entry.branch}</span>
					</span>

					{/* Relative date */}
					<span className="shrink-0 text-[11px] text-text-tertiary">{formatRelativeDate(entry.date)}</span>
				</div>
			</ContextMenu.Trigger>
			<ContextMenu.Portal>
				<ContextMenu.Content className="z-50 min-w-[160px] rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg">
					<ContextMenu.Item className={CONTEXT_MENU_ITEM_CLASS} onSelect={onPop}>
						<Archive size={14} className="text-text-secondary" />
						Pop
					</ContextMenu.Item>
					<ContextMenu.Item className={CONTEXT_MENU_ITEM_CLASS} onSelect={onApply}>
						<Copy size={14} className="text-text-secondary" />
						Apply
					</ContextMenu.Item>
					<ContextMenu.Item className={CONTEXT_MENU_ITEM_CLASS} onSelect={onShowDiff}>
						<Eye size={14} className="text-text-secondary" />
						Show Diff
					</ContextMenu.Item>
					<ContextMenu.Separator className="h-px bg-border my-1" />
					<ContextMenu.Item className={cn(CONTEXT_MENU_ITEM_CLASS, "text-status-red")} onSelect={onDrop}>
						<Trash2 size={14} className="text-status-red" />
						Drop
					</ContextMenu.Item>
				</ContextMenu.Content>
			</ContextMenu.Portal>
		</ContextMenu.Root>
	);
}

/* ------------------------------------------------------------------ */
/* StashListSection                                                    */
/* ------------------------------------------------------------------ */

export interface StashListSectionProps {
	taskId: string | undefined;
	workspaceId: string;
	stashCount: number;
}

export function StashListSection({ taskId, workspaceId, stashCount }: StashListSectionProps): React.ReactElement {
	const { entries, isLoading, isExpanded, setExpanded, popStash, applyStash, dropStash, showStashDiff } = useStashList(
		taskId,
		workspaceId,
	);

	// Drop confirmation dialog state.
	const [dropDialogState, setDropDialogState] = useState<{ open: boolean; index: number; message: string }>({
		open: false,
		index: -1,
		message: "",
	});
	// Ref flag to prevent Radix AlertDialog double-fire (see AGENTS.md).
	const dropConfirmedRef = useRef(false);

	// Diff popover state.
	const [diffState, setDiffState] = useState<{ open: boolean; anchorIndex: number; diff: string; isLoading: boolean }>(
		{
			open: false,
			anchorIndex: -1,
			diff: "",
			isLoading: false,
		},
	);

	const handleRequestDrop = useCallback((entry: RuntimeStashEntry) => {
		setDropDialogState({ open: true, index: entry.index, message: entry.message });
	}, []);

	const handleConfirmDrop = useCallback(() => {
		dropConfirmedRef.current = true;
		const { index } = dropDialogState;
		setDropDialogState({ open: false, index: -1, message: "" });
		void dropStash(index);
	}, [dropDialogState, dropStash]);

	const handleCancelDrop = useCallback(() => {
		// Guard against double-fire: if confirm already ran, skip the cancel revert.
		if (dropConfirmedRef.current) {
			dropConfirmedRef.current = false;
			return;
		}
		setDropDialogState({ open: false, index: -1, message: "" });
	}, []);

	const handleShowDiff = useCallback(
		async (entry: RuntimeStashEntry) => {
			setDiffState({ open: true, anchorIndex: entry.index, diff: "", isLoading: true });
			const diff = await showStashDiff(entry.index);
			setDiffState((prev) => ({ ...prev, diff, isLoading: false }));
		},
		[showStashDiff],
	);

	return (
		<>
			<Collapsible.Root open={isExpanded} onOpenChange={setExpanded}>
				{/* Section header */}
				<Collapsible.Trigger asChild>
					<button
						type="button"
						className="flex items-center gap-1.5 w-full px-3 py-2 text-left cursor-pointer bg-transparent border-0 border-t border-solid border-border hover:bg-surface-3"
					>
						<ChevronRight
							size={14}
							className={cn(
								"shrink-0 text-text-tertiary transition-transform duration-150",
								isExpanded && "rotate-90",
							)}
						/>
						<span className="text-[13px] font-medium text-text-secondary">Stashes</span>
						{stashCount > 0 ? (
							<span className="text-[11px] text-text-tertiary bg-surface-2 rounded-full px-1.5 py-0.5">
								{stashCount}
							</span>
						) : null}
					</button>
				</Collapsible.Trigger>

				<Collapsible.Content>
					<div className="pb-2">
						{isLoading ? (
							<div className="flex items-center justify-center py-4">
								<Spinner size={18} />
							</div>
						) : entries.length === 0 ? (
							<div className="px-3 py-3 text-[13px] text-text-tertiary">No stashes</div>
						) : (
							<div className="flex flex-col">
								{entries.map((entry) => (
									<StashDiffPopover
										key={entry.index}
										open={diffState.open && diffState.anchorIndex === entry.index}
										onOpenChange={(open) => {
											if (!open) {
												setDiffState({ open: false, anchorIndex: -1, diff: "", isLoading: false });
											}
										}}
										diff={diffState.anchorIndex === entry.index ? diffState.diff : ""}
										isLoading={diffState.anchorIndex === entry.index ? diffState.isLoading : false}
									>
										<StashEntryRow
											entry={entry}
											onPop={() => void popStash(entry.index)}
											onApply={() => void applyStash(entry.index)}
											onDrop={() => handleRequestDrop(entry)}
											onShowDiff={() => void handleShowDiff(entry)}
										/>
									</StashDiffPopover>
								))}
							</div>
						)}
					</div>
				</Collapsible.Content>
			</Collapsible.Root>

			{/* Drop confirmation AlertDialog */}
			<AlertDialog open={dropDialogState.open} onOpenChange={(open) => !open && handleCancelDrop()}>
				<AlertDialogHeader>
					<AlertDialogTitle>Drop stash?</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						This will permanently remove stash{" "}
						<span className="font-mono font-medium">#{dropDialogState.index}</span>
						{dropDialogState.message ? (
							<>
								{" "}
								(<span className="font-medium">{dropDialogState.message}</span>)
							</>
						) : null}
						. This action cannot be undone.
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="default" onClick={handleCancelDrop}>
							Cancel
						</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button variant="danger" onClick={handleConfirmDrop}>
							Drop
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</>
	);
}
