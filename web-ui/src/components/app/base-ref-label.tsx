import * as RadixPopover from "@radix-ui/react-popover";
import { Check, Lock, LockOpen, Search } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	BRANCH_DROPDOWN_CLASS_NAME,
	BRANCH_TOOLTIP_CLASS_NAME,
	getBranchFolderPath,
} from "@/components/git/branch-dropdown-presentation";
import { FolderSelectRowButton } from "@/components/shared/folder-select-row";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { resolveBranchSelectorSections } from "@/hooks/git/branch-selector-popover";
import { type FolderSelectRow, getFolderSelectRows } from "@/hooks/search/folder-select";
import { useFolderSelectRows } from "@/hooks/search/use-folder-select-rows";
import type { RuntimeGitRef } from "@/runtime/types";
import type { BoardCard } from "@/types";
import { resolveTaskBaseRefDisplayState } from "@/utils/task-base-ref-display";

interface BaseRefLabelProps {
	card: BoardCard;
	behindBaseCount: number | null | undefined;
	behindRemoteBaseCount: number | null | undefined;
	branches: RuntimeGitRef[] | null;
	isLoadingBranches: boolean;
	requestBranches: () => void;
	onUpdateBaseRef: (taskId: string, baseRef: string, pinned: boolean) => void;
	pinnedBranches: string[];
	groupBranchesByFolder?: boolean;
}

const getBranchKey = (ref: RuntimeGitRef): string => ref.name;
const getBranchPath = (ref: RuntimeGitRef): readonly string[] => getBranchFolderPath(ref.name);

interface BaseRefSectionProps {
	title: string;
	rows: FolderSelectRow<RuntimeGitRef>[];
	onToggleFolder?: (key: string) => void;
	currentBaseRef: string;
	onSelectRef: (refName: string) => void;
}

function BaseRefSection({
	title,
	rows,
	onToggleFolder,
	currentBaseRef,
	onSelectRef,
}: BaseRefSectionProps): ReactElement | null {
	if (rows.length === 0) {
		return null;
	}

	return (
		<>
			<div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">{title}</div>
			{rows.map((row) =>
				row.kind === "folder" ? (
					<FolderSelectRowButton key={row.key} row={row} onToggle={() => onToggleFolder?.(row.key)} />
				) : (
					<Tooltip
						key={row.key}
						content={<span className={cn(BRANCH_TOOLTIP_CLASS_NAME, "font-mono")}>{row.item.name}</span>}
						delayDuration={150}
					>
						<button
							type="button"
							className="flex w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-1 text-left text-xs text-text-secondary hover:bg-surface-2"
							onClick={() => onSelectRef(row.item.name)}
							style={row.depth > 0 ? { paddingLeft: 12 + row.depth * 16 } : undefined}
						>
							<span className="w-3 shrink-0">
								{row.item.name === currentBaseRef ? <Check size={12} className="text-accent" /> : null}
							</span>
							<span className="min-w-0 truncate font-mono">{row.label}</span>
						</button>
					</Tooltip>
				),
			)}
		</>
	);
}

export function BaseRefLabel({
	card,
	behindBaseCount,
	behindRemoteBaseCount,
	branches,
	isLoadingBranches,
	requestBranches,
	onUpdateBaseRef,
	pinnedBranches,
	groupBranchesByFolder = false,
}: BaseRefLabelProps): ReactElement {
	const [isOpen, setIsOpen] = useState(false);
	const [filter, setFilter] = useState("");
	const baseRefDisplay = resolveTaskBaseRefDisplayState({
		baseRef: card.baseRef,
		baseRefPinned: card.baseRefPinned,
		behindBaseCount,
		behindRemoteBaseCount,
	});
	const baseRefState = baseRefDisplay.baseRefState;
	const [isBaseRefPinned, setIsBaseRefPinned] = useState(baseRefState.isPinned);
	const inputRef = useRef<HTMLInputElement>(null);

	const handleOpen = useCallback(
		(open: boolean) => {
			if (open) {
				setFilter("");
				setIsBaseRefPinned(baseRefState.isPinned);
				requestBranches();
			}
			setIsOpen(open);
		},
		[baseRefState.isPinned, requestBranches],
	);

	const handleSelect = useCallback(
		(refName: string) => {
			if (refName !== (baseRefState.baseRef ?? "") || isBaseRefPinned !== baseRefState.isPinned) {
				onUpdateBaseRef(card.id, refName, isBaseRefPinned);
			}
			setIsOpen(false);
		},
		[isBaseRefPinned, baseRefState.baseRef, baseRefState.isPinned, card.id, onUpdateBaseRef],
	);

	const { pinnedLocal, unpinnedLocal, filteredRemote } = useMemo(
		() => resolveBranchSelectorSections(branches, pinnedBranches, filter),
		[branches, pinnedBranches, filter],
	);
	const isSearching = filter.trim().length > 0;
	const localFolders = useFolderSelectRows({
		items: unpinnedLocal,
		getKey: getBranchKey,
		getPath: groupBranchesByFolder ? getBranchPath : undefined,
		selectedKey: baseRefState.baseRef,
		isSearching,
	});
	const remoteFolders = useFolderSelectRows({
		items: filteredRemote,
		getKey: getBranchKey,
		getPath: groupBranchesByFolder ? getBranchPath : undefined,
		selectedKey: baseRefState.baseRef,
		isSearching,
	});
	const pinnedRows = useMemo(
		() => getFolderSelectRows({ items: pinnedLocal, getKey: getBranchKey, isSearching: false }),
		[pinnedLocal],
	);
	const { resetFolders: resetLocalFolders } = localFolders;
	const { resetFolders: resetRemoteFolders } = remoteFolders;
	useEffect(() => {
		if (!isOpen) {
			resetLocalFolders();
			resetRemoteFolders();
		}
	}, [isOpen, resetLocalFolders, resetRemoteFolders]);
	const hasMatchingRefs = pinnedLocal.length > 0 || unpinnedLocal.length > 0 || filteredRemote.length > 0;

	return (
		<RadixPopover.Root open={isOpen} onOpenChange={handleOpen}>
			<RadixPopover.Trigger asChild>
				<button
					type="button"
					className={cn(
						"flex cursor-pointer items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs",
						isOpen
							? "bg-surface-2 text-text-secondary"
							: "text-text-tertiary hover:bg-surface-2 hover:text-text-secondary",
					)}
				>
					{baseRefState.isResolved ? (
						<>
							{baseRefState.isPinned ? <Lock size={10} className="text-text-quaternary" /> : null}
							from{" "}
							<Tooltip
								content={
									<span className={cn(BRANCH_TOOLTIP_CLASS_NAME, "font-mono")}>{baseRefState.baseRef}</span>
								}
								delayDuration={150}
							>
								<span className="font-mono">{baseRefState.baseRef}</span>
							</Tooltip>
							{baseRefDisplay.behindLabel ? (
								<span className={baseRefDisplay.isBehind ? "text-status-blue" : undefined}>
									({baseRefDisplay.behindLabel})
								</span>
							) : null}
						</>
					) : (
						<span className="text-status-orange">{baseRefDisplay.triggerLabel}</span>
					)}
				</button>
			</RadixPopover.Trigger>
			<RadixPopover.Portal>
				<RadixPopover.Content
					side="bottom"
					align="start"
					sideOffset={6}
					collisionPadding={8}
					className={cn("z-50 rounded-md border border-border bg-surface-1 shadow-lg", BRANCH_DROPDOWN_CLASS_NAME)}
					onOpenAutoFocus={(e) => {
						e.preventDefault();
						inputRef.current?.focus();
					}}
				>
					<div className="flex flex-col">
						<div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
							<Search size={12} className="shrink-0 text-text-quaternary" />
							<input
								ref={inputRef}
								name={`base-ref-filter-${card.id}`}
								type="text"
								value={filter}
								onChange={(e) => setFilter(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Escape") setIsOpen(false);
								}}
								placeholder="Filter refs..."
								className="h-5 w-full bg-transparent font-mono text-xs text-text-primary placeholder:text-text-quaternary focus:outline-none"
							/>
						</div>
						<div className="max-h-56 overflow-y-auto py-1">
							{isLoadingBranches && !branches ? (
								<div className="flex items-center justify-center gap-1.5 px-3 py-3">
									<Spinner size={12} />
									<span className="text-xs text-text-tertiary">Loading refs...</span>
								</div>
							) : !hasMatchingRefs ? (
								<div className="px-3 py-2 text-xs text-text-quaternary">No matching refs</div>
							) : (
								<>
									<BaseRefSection
										title="Pinned"
										rows={pinnedRows}
										currentBaseRef={baseRefState.baseRef ?? ""}
										onSelectRef={handleSelect}
									/>
									<BaseRefSection
										title="Local"
										rows={localFolders.rows}
										onToggleFolder={localFolders.toggleFolder}
										currentBaseRef={baseRefState.baseRef ?? ""}
										onSelectRef={handleSelect}
									/>
									<BaseRefSection
										title="Remote"
										rows={remoteFolders.rows}
										onToggleFolder={remoteFolders.toggleFolder}
										currentBaseRef={baseRefState.baseRef ?? ""}
										onSelectRef={handleSelect}
									/>
								</>
							)}
						</div>
						{baseRefState.isResolved ? (
							<div className="border-t border-border px-2 py-1.5">
								<button
									type="button"
									className="flex cursor-pointer items-center gap-1.5 text-xs text-text-tertiary hover:text-text-secondary"
									onClick={() => {
										const next = !isBaseRefPinned;
										setIsBaseRefPinned(next);
										if (next !== baseRefState.isPinned) {
											onUpdateBaseRef(card.id, baseRefState.baseRef, next);
										}
									}}
								>
									{isBaseRefPinned ? <Lock size={11} /> : <LockOpen size={11} />}
									{baseRefDisplay.pinToggleLabel}
								</button>
							</div>
						) : null}
					</div>
				</RadixPopover.Content>
			</RadixPopover.Portal>
		</RadixPopover.Root>
	);
}
