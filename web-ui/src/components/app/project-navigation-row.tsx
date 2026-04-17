import type { DraggableProvidedDragHandleProps } from "@hello-pangea/dnd";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Ellipsis, GripVertical } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { statusPillColors } from "@/data/column-colors";
import type { RuntimeProjectSummary } from "@/runtime/types";
import { formatPathForDisplay } from "@/utils/path-display";

interface TaskCountBadge {
	id: string;
	title: string;
	shortLabel: string;
	toneClassName: string;
	count: number;
}

const PRELOAD_HOVER_DELAY_MS = 150;

export function ProjectRow({
	project,
	isCurrent,
	removingProjectId,
	needsInputCount = 0,
	showDragHandle = false,
	dragHandleProps,
	isDragging = false,
	onSelect,
	onPreload,
	onRemove,
}: {
	project: RuntimeProjectSummary;
	isCurrent: boolean;
	removingProjectId: string | null;
	needsInputCount?: number;
	showDragHandle?: boolean;
	dragHandleProps?: DraggableProvidedDragHandleProps | null;
	isDragging?: boolean;
	onSelect: (id: string) => void;
	onPreload?: (id: string) => void;
	onRemove: (id: string) => void;
}): React.ReactElement {
	const displayPath = formatPathForDisplay(project.path);
	const hoverTimerRef = useRef<number | null>(null);
	const [isMenuOpen, setIsMenuOpen] = useState(false);
	const isRemovingProject = removingProjectId === project.id;
	const hasAnyProjectRemoval = removingProjectId !== null;

	useEffect(() => {
		return () => {
			if (hoverTimerRef.current !== null) {
				window.clearTimeout(hoverTimerRef.current);
			}
		};
	}, []);

	const taskCountBadges: TaskCountBadge[] = [
		{
			id: "backlog",
			title: "Backlog",
			shortLabel: "B",
			toneClassName: statusPillColors.backlog,
			count: project.taskCounts.backlog,
		},
		{
			id: "in_progress",
			title: "In Progress",
			shortLabel: "IP",
			toneClassName: statusPillColors.in_progress,
			count: project.taskCounts.in_progress,
		},
		{
			id: "review",
			title: "Review",
			shortLabel: "R",
			toneClassName: statusPillColors.review,
			count: Math.max(0, project.taskCounts.review - needsInputCount),
		},
		{
			id: "needs_input",
			title: "Needs Input",
			shortLabel: "NI",
			toneClassName: statusPillColors.needs_input,
			count: needsInputCount,
		},
	].filter((item) => item.count > 0);

	return (
		<div
			role="button"
			tabIndex={0}
			onClick={() => onSelect(project.id)}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onSelect(project.id);
				}
			}}
			onMouseEnter={() => {
				if (isCurrent || !onPreload) {
					return;
				}
				hoverTimerRef.current = window.setTimeout(() => {
					hoverTimerRef.current = null;
					onPreload(project.id);
				}, PRELOAD_HOVER_DELAY_MS);
			}}
			onMouseLeave={() => {
				if (hoverTimerRef.current !== null) {
					window.clearTimeout(hoverTimerRef.current);
					hoverTimerRef.current = null;
				}
			}}
			className={cn(
				"kb-project-row group cursor-pointer rounded-md",
				isCurrent && "kb-project-row-selected",
				isDragging && "shadow-lg bg-surface-2 rounded-md",
			)}
			style={{
				display: "flex",
				alignItems: "center",
				gap: 6,
				padding: "6px 8px",
			}}
		>
			{showDragHandle ? (
				<div
					{...dragHandleProps}
					className={cn(
						"shrink-0 cursor-grab opacity-0 group-hover:opacity-100 transition-opacity",
						isCurrent ? "text-white/50 hover:text-white/80" : "text-text-tertiary hover:text-text-secondary",
						isDragging && "opacity-100 cursor-grabbing",
					)}
					onClick={(event) => event.stopPropagation()}
					onKeyDown={(event) => event.stopPropagation()}
				>
					<GripVertical size={14} />
				</div>
			) : null}
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-1.5">
					{needsInputCount > 0 ? (
						<span
							className="shrink-0 w-2 h-2 rounded-full bg-status-orange"
							title={`${needsInputCount} task${needsInputCount > 1 ? "s" : ""} need${needsInputCount === 1 ? "s" : ""} input`}
						/>
					) : null}
					<span
						className={cn(
							"font-medium whitespace-nowrap overflow-hidden text-ellipsis text-sm",
							isCurrent ? "text-white" : "text-text-primary",
						)}
					>
						{project.name}
					</span>
				</div>
				<div
					className={cn(
						"font-mono text-[10px] whitespace-nowrap overflow-hidden text-ellipsis",
						isCurrent ? "text-white/60" : "text-text-secondary",
					)}
				>
					{displayPath}
				</div>
				{taskCountBadges.length > 0 ? (
					<div className="flex gap-1 mt-1">
						{taskCountBadges.map((badge) => (
							<span
								key={badge.id}
								className={cn(
									"inline-flex items-center gap-1 rounded-full text-[10px] px-1.5 py-px font-medium",
									isCurrent ? "bg-white/20 text-white" : badge.toneClassName,
								)}
								title={badge.title}
							>
								<span>{badge.shortLabel}</span>
								<span style={{ opacity: 0.4 }}>|</span>
								<span>{badge.count}</span>
							</span>
						))}
					</div>
				) : null}
			</div>
			<div className="kb-project-row-actions flex items-center" style={isMenuOpen ? { opacity: 1 } : undefined}>
				<DropdownMenu.Root open={isMenuOpen} onOpenChange={setIsMenuOpen}>
					<DropdownMenu.Trigger asChild>
						<Button
							variant="ghost"
							size="sm"
							icon={isRemovingProject ? <Spinner size={12} /> : <Ellipsis size={14} />}
							disabled={hasAnyProjectRemoval && !isRemovingProject}
							className={
								isCurrent ? "text-white hover:bg-white/20 hover:text-white active:bg-white/30" : undefined
							}
							onClick={(event) => {
								event.stopPropagation();
							}}
							aria-label="Project actions"
						/>
					</DropdownMenu.Trigger>
					<DropdownMenu.Portal>
						<DropdownMenu.Content
							side="bottom"
							align="end"
							sideOffset={4}
							className="z-50 min-w-[140px] rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg"
							onCloseAutoFocus={(event) => event.preventDefault()}
						>
							<DropdownMenu.Item
								className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] text-status-red cursor-pointer outline-none data-[highlighted]:bg-surface-3"
								onSelect={() => onRemove(project.id)}
							>
								Delete
							</DropdownMenu.Item>
						</DropdownMenu.Content>
					</DropdownMenu.Portal>
				</DropdownMenu.Root>
			</div>
		</div>
	);
}

export function ProjectRowSkeleton(): React.ReactElement {
	return (
		<div className="flex items-center gap-1.5" style={{ padding: "6px 8px" }}>
			<div className="flex-1 min-w-0">
				<div className="kb-skeleton" style={{ height: 14, width: "58%", borderRadius: 3, marginBottom: 6 }} />
				<div
					className="kb-skeleton font-mono"
					style={{ height: 10, width: "86%", borderRadius: 3, marginBottom: 6 }}
				/>
				<div className="flex gap-1">
					<div className="kb-skeleton" style={{ height: 18, width: 30, borderRadius: 999 }} />
					<div className="kb-skeleton" style={{ height: 18, width: 30, borderRadius: 999 }} />
					<div className="kb-skeleton" style={{ height: 18, width: 30, borderRadius: 999 }} />
				</div>
			</div>
		</div>
	);
}
