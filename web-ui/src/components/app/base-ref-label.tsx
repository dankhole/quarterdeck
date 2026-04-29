import * as RadixPopover from "@radix-ui/react-popover";
import { Check, Lock, LockOpen, Search } from "lucide-react";
import { type ReactElement, useCallback, useMemo, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { resolveBranchSelectorSections } from "@/hooks/git/branch-selector-popover";
import type { RuntimeGitRef } from "@/runtime/types";
import type { BoardCard } from "@/types";
import { resolveTaskBaseRefDisplayState } from "@/utils/task-base-ref-display";

interface BaseRefLabelProps {
	card: BoardCard;
	behindBaseCount: number | null | undefined;
	branches: RuntimeGitRef[] | null;
	isLoadingBranches: boolean;
	requestBranches: () => void;
	onUpdateBaseRef: (taskId: string, baseRef: string, pinned: boolean) => void;
	pinnedBranches: string[];
}

interface BaseRefSectionProps {
	title: string;
	refs: RuntimeGitRef[];
	currentBaseRef: string;
	onSelectRef: (refName: string) => void;
}

function BaseRefSection({ title, refs, currentBaseRef, onSelectRef }: BaseRefSectionProps): ReactElement | null {
	if (refs.length === 0) {
		return null;
	}

	return (
		<>
			<div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">{title}</div>
			{refs.map((ref) => (
				<button
					key={ref.name}
					type="button"
					className="flex w-full cursor-pointer items-center gap-2 px-3 py-1 text-left text-xs text-text-secondary hover:bg-surface-2"
					onClick={() => onSelectRef(ref.name)}
				>
					<span className="w-3 shrink-0">
						{ref.name === currentBaseRef ? <Check size={12} className="text-accent" /> : null}
					</span>
					<span className="truncate font-mono">{ref.name}</span>
				</button>
			))}
		</>
	);
}

export function BaseRefLabel({
	card,
	behindBaseCount,
	branches,
	isLoadingBranches,
	requestBranches,
	onUpdateBaseRef,
	pinnedBranches,
}: BaseRefLabelProps): ReactElement {
	const [isOpen, setIsOpen] = useState(false);
	const [filter, setFilter] = useState("");
	const baseRefDisplay = resolveTaskBaseRefDisplayState({
		baseRef: card.baseRef,
		baseRefPinned: card.baseRefPinned,
		behindBaseCount,
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
							from <span className="font-mono">{baseRefState.baseRef}</span>
							{baseRefDisplay.behindLabel ? (
								<span className="text-status-blue">({baseRefDisplay.behindLabel})</span>
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
					className="z-50 w-64 rounded-md border border-border bg-surface-1 shadow-lg"
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
										refs={pinnedLocal}
										currentBaseRef={baseRefState.baseRef ?? ""}
										onSelectRef={handleSelect}
									/>
									<BaseRefSection
										title="Local"
										refs={unpinnedLocal}
										currentBaseRef={baseRefState.baseRef ?? ""}
										onSelectRef={handleSelect}
									/>
									<BaseRefSection
										title="Remote"
										refs={filteredRemote}
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
