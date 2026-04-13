import {
	DragDropContext,
	Draggable,
	type DraggableProvidedDragHandleProps,
	Droppable,
	type DropResult,
} from "@hello-pangea/dnd";
import * as Collapsible from "@radix-ui/react-collapsible";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, ChevronUp, Ellipsis, ExternalLink, GripVertical, Lightbulb, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { statusPillColors } from "@/data/column-colors";
import type { RuntimeProjectSummary, RuntimeTaskSessionSummary } from "@/runtime/types";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { formatPathForDisplay } from "@/utils/path-display";
import { isMacPlatform, modifierKeyLabel } from "@/utils/platform";
import { useBooleanLocalStorageValue } from "@/utils/react-use";
import { isApprovalState } from "@/utils/session-status";

interface TaskCountBadge {
	id: string;
	title: string;
	shortLabel: string;
	toneClassName: string;
	count: number;
}

export function ProjectNavigationPanel({
	projects,
	isLoadingProjects = false,
	currentProjectId,
	removingProjectId,
	onSelectProject,
	onPreloadProject,
	onRemoveProject,
	onReorderProjects,
	onAddProject,
	notificationSessions,
	notificationWorkspaceIds,
}: {
	projects: RuntimeProjectSummary[];
	isLoadingProjects?: boolean;
	currentProjectId: string | null;
	removingProjectId: string | null;
	onSelectProject: (projectId: string) => void;
	onPreloadProject?: (projectId: string) => void;
	onRemoveProject: (projectId: string) => Promise<boolean>;
	onReorderProjects?: (projectOrder: string[]) => Promise<void>;
	onAddProject: () => void;
	notificationSessions: Record<string, RuntimeTaskSessionSummary>;
	notificationWorkspaceIds: Record<string, string>;
}): React.ReactElement {
	const canReorder = projects.length > 1 && onReorderProjects !== undefined;

	const needsInputByProject = useMemo(() => {
		const counts: Record<string, number> = {};
		for (const [taskId, session] of Object.entries(notificationSessions)) {
			if (isApprovalState(session)) {
				const projectId = notificationWorkspaceIds[taskId];
				if (projectId) {
					counts[projectId] = (counts[projectId] ?? 0) + 1;
				}
			}
		}
		return counts;
	}, [notificationSessions, notificationWorkspaceIds]);

	const [optimisticOrder, setOptimisticOrder] = useState<string[] | null>(null);
	const prevProjectIdsRef = useRef<string>("");

	const displayedProjects = useMemo(() => {
		if (!optimisticOrder) {
			return projects;
		}
		const projectsById = new Map(projects.map((p) => [p.id, p]));
		const currentIds = projects.map((p) => p.id).join(",");
		if (currentIds !== prevProjectIdsRef.current) {
			prevProjectIdsRef.current = currentIds;
			setOptimisticOrder(null);
			return projects;
		}
		const ordered: RuntimeProjectSummary[] = [];
		for (const id of optimisticOrder) {
			const project = projectsById.get(id);
			if (project) {
				ordered.push(project);
			}
		}
		for (const project of projects) {
			if (!optimisticOrder.includes(project.id)) {
				ordered.push(project);
			}
		}
		return ordered;
	}, [optimisticOrder, projects]);

	const handleDragEnd = useCallback(
		(result: DropResult) => {
			if (!result.destination || result.source.index === result.destination.index || !onReorderProjects) {
				return;
			}
			const reordered = Array.from(displayedProjects);
			const [moved] = reordered.splice(result.source.index, 1);
			if (moved !== undefined) {
				reordered.splice(result.destination.index, 0, moved);
			}
			const newOrder = reordered.map((p) => p.id);
			prevProjectIdsRef.current = projects.map((p) => p.id).join(",");
			setOptimisticOrder(newOrder);
			void onReorderProjects(newOrder);
		},
		[onReorderProjects, displayedProjects, projects],
	);

	const [pendingProjectRemoval, setPendingProjectRemoval] = useState<RuntimeProjectSummary | null>(null);
	const isProjectRemovalPending = pendingProjectRemoval !== null && removingProjectId === pendingProjectRemoval.id;
	const pendingProjectTaskCount = pendingProjectRemoval
		? pendingProjectRemoval.taskCounts.backlog +
			pendingProjectRemoval.taskCounts.in_progress +
			pendingProjectRemoval.taskCounts.review +
			pendingProjectRemoval.taskCounts.trash
		: 0;

	return (
		<div className="flex flex-col min-h-0 overflow-hidden bg-surface-1 flex-1">
			<div style={{ padding: "12px 12px 8px" }}>
				<div>
					<div className="font-semibold text-base flex items-baseline gap-1.5">
						Quarterdeck <span className="text-text-secondary font-normal text-xs">v{__APP_VERSION__}</span>
					</div>
				</div>
			</div>

			<div
				className="flex-1 min-h-0 overflow-y-auto overscroll-contain flex flex-col gap-1"
				style={{ padding: "4px 12px" }}
			>
				{projects.length === 0 && isLoadingProjects ? (
					<div style={{ padding: "4px 0" }}>
						{Array.from({ length: 3 }).map((_, index) => (
							<ProjectRowSkeleton key={`project-skeleton-${index}`} />
						))}
					</div>
				) : null}

				<DragDropContext onDragEnd={handleDragEnd}>
					<Droppable droppableId="project-list">
						{(droppableProvided) => (
							<div ref={droppableProvided.innerRef} {...droppableProvided.droppableProps}>
								{displayedProjects.map((project, index) => (
									<Draggable
										key={project.id}
										draggableId={project.id}
										index={index}
										isDragDisabled={!canReorder}
									>
										{(draggableProvided, draggableSnapshot) => {
											const row = (
												<div
													ref={draggableProvided.innerRef}
													{...draggableProvided.draggableProps}
													style={{
														...draggableProvided.draggableProps.style,
														marginBottom: 4,
													}}
												>
													<ProjectRow
														project={project}
														isCurrent={currentProjectId === project.id}
														removingProjectId={removingProjectId}
														needsInputCount={needsInputByProject[project.id] ?? 0}
														showDragHandle={canReorder}
														dragHandleProps={draggableProvided.dragHandleProps}
														isDragging={draggableSnapshot.isDragging}
														onSelect={onSelectProject}
														onPreload={onPreloadProject}
														onRemove={(projectId) => {
															const found = displayedProjects.find((item) => item.id === projectId);
															if (!found) {
																return;
															}
															setPendingProjectRemoval(found);
														}}
													/>
												</div>
											);
											if (draggableSnapshot.isDragging && typeof document !== "undefined") {
												return createPortal(row, document.body);
											}
											return row;
										}}
									</Draggable>
								))}
								{droppableProvided.placeholder}
							</div>
						)}
					</Droppable>
				</DragDropContext>

				{!isLoadingProjects ? (
					<button
						type="button"
						className="kb-project-row flex cursor-pointer items-center gap-1.5 rounded-md text-text-secondary hover:text-text-primary"
						style={{ padding: "6px 8px" }}
						onClick={onAddProject}
						disabled={removingProjectId !== null}
					>
						<Plus size={14} className="shrink-0" />
						<span className="text-sm">Add Project</span>
					</button>
				) : null}
			</div>
			<OnboardingTips />
			<ShortcutsCard />
			<BetaNotice />
			<AlertDialog
				open={pendingProjectRemoval !== null}
				onOpenChange={(open) => {
					if (!open && !isProjectRemovalPending) {
						setPendingProjectRemoval(null);
					}
				}}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>Remove Project</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription asChild>
						<div className="flex flex-col gap-3">
							<p>{pendingProjectRemoval ? pendingProjectRemoval.name : "This project"}</p>
							<p className="text-text-primary">
								This will delete all project tasks ({pendingProjectTaskCount}), remove task workspaces, and stop
								any running processes for this project.
							</p>
							<p className="text-text-primary">This action cannot be undone.</p>
						</div>
					</AlertDialogDescription>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button
							variant="default"
							disabled={isProjectRemovalPending}
							onClick={() => {
								if (!isProjectRemovalPending) {
									setPendingProjectRemoval(null);
								}
							}}
						>
							Cancel
						</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button
							variant="danger"
							disabled={isProjectRemovalPending}
							onClick={async () => {
								if (!pendingProjectRemoval) {
									return;
								}
								const removed = await onRemoveProject(pendingProjectRemoval.id);
								if (removed) {
									setPendingProjectRemoval(null);
								}
							}}
						>
							{isProjectRemovalPending ? (
								<>
									<Spinner size={14} />
									Removing...
								</>
							) : (
								"Remove Project"
							)}
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</div>
	);
}

const ONBOARDING_TIPS = [
	{ label: "Create tasks", hint: "Add prompts to the backlog, then start them to spawn isolated agents" },
	{ label: "Run in parallel", hint: "Each task gets its own git worktree — agents work simultaneously" },
	{ label: "Review changes", hint: "When an agent finishes, review its diff and commit or iterate" },
] as const;

function OnboardingTips(): React.ReactElement | null {
	const [isDismissed, setIsDismissed] = useBooleanLocalStorageValue(LocalStorageKey.OnboardingTipsDismissed, false);

	if (isDismissed) {
		return (
			<div style={{ padding: "0 20px 4px" }}>
				<button
					type="button"
					onClick={() => setIsDismissed(false)}
					className="flex cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-[11px] text-text-tertiary hover:text-text-secondary"
				>
					<Lightbulb size={11} />
					Show tips
				</button>
			</div>
		);
	}

	return (
		<div style={{ padding: "4px 12px" }}>
			<div className="rounded-md border border-border-bright/50 bg-surface-0/60 px-3 py-2">
				<div className="flex items-center justify-between mb-1.5">
					<span className="text-[11px] font-medium text-text-secondary flex items-center gap-1">
						<Lightbulb size={11} className="text-status-gold" />
						Getting started
					</span>
					<button
						type="button"
						onClick={() => setIsDismissed(true)}
						className="cursor-pointer border-none bg-transparent p-0 text-text-tertiary hover:text-text-secondary"
						aria-label="Dismiss tips"
					>
						<X size={12} />
					</button>
				</div>
				<ul className="m-0 p-0 list-none space-y-1">
					{ONBOARDING_TIPS.map((tip) => (
						<li key={tip.label} className="text-[11px] text-text-tertiary">
							<span className="text-text-primary font-medium">{tip.label}</span> — {tip.hint}
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}

const MOD = isMacPlatform ? "⌘" : modifierKeyLabel;
const ALT = isMacPlatform ? "⌥" : "Alt";

const ESSENTIAL_SHORTCUTS = [
	{ keys: ["C"], label: "New task" },
	{ keys: [MOD, "B"], label: "Start backlog tasks" },
	{ keys: [MOD, "Shift", "S"], label: "Settings" },
	{ keys: ["Click", MOD], label: "Hold to link tasks" },
	{ keys: [MOD, "G"], label: "Toggle git view" },
	{ keys: [MOD, "J"], label: "Toggle terminal" },
];

const MORE_SHORTCUTS = [
	{ keys: [MOD, "Shift", "A"], label: "Toggle plan / act" },
	{ keys: [ALT, "Shift", "Enter"], label: "Start and open task" },
	{ keys: [MOD, "M"], label: "Expand terminal" },
	{ keys: ["Esc"], label: "Close / back" },
];

function ShortcutHint({ keys, label }: { keys: string[]; label: string }): React.ReactElement {
	return (
		<div className="flex justify-between items-center py-px">
			<span className="text-text-tertiary text-xs">{label}</span>
			<span className="inline-flex items-center gap-0.5">
				{keys.map((key, i) => (
					<Kbd key={`${key}-${i}`}>{key}</Kbd>
				))}
			</span>
		</div>
	);
}

function ShortcutsCard(): React.ReactElement {
	const [expanded, setExpanded] = useState(false);

	return (
		<div style={{ padding: "8px 12px" }}>
			<div style={{ padding: "0 8px" }}>
				<div className="flex flex-col gap-0.5">
					{ESSENTIAL_SHORTCUTS.map((s) => (
						<ShortcutHint key={s.label} keys={s.keys} label={s.label} />
					))}
				</div>
				<Collapsible.Root open={expanded} onOpenChange={setExpanded}>
					<Collapsible.Content>
						<div className="flex flex-col gap-0.5">
							{MORE_SHORTCUTS.map((s) => (
								<ShortcutHint key={s.label} keys={s.keys} label={s.label} />
							))}
						</div>
					</Collapsible.Content>
					<Collapsible.Trigger asChild>
						<button
							type="button"
							className="flex items-center gap-1 mt-1.5 text-xs text-text-tertiary hover:text-text-secondary cursor-pointer bg-transparent border-none p-0"
						>
							{expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
							{expanded ? "Less" : "All shortcuts"}
						</button>
					</Collapsible.Trigger>
				</Collapsible.Root>
			</div>
		</div>
	);
}

const REPO_URL = "https://bitbucket.build.dkinternal.com/users/d.cole/repos/quarterdeck/browse";

function BetaNotice(): React.ReactElement {
	return (
		<div style={{ padding: "4px 12px 12px" }}>
			<div className="flex items-start gap-2 rounded-md border border-status-orange/25 bg-status-orange/5 px-3 py-2.5">
				<div className="flex flex-col gap-1.5">
					<p className="m-0 text-xs text-status-orange/80">
						Quarterdeck is in beta. Help me improve by sharing your experience.
					</p>
					<a
						href={REPO_URL}
						target="_blank"
						rel="noopener noreferrer"
						className="flex items-center gap-1 self-start text-xs font-semibold text-status-orange hover:text-status-orange/80 active:text-status-orange/60 no-underline"
					>
						Report issue <ExternalLink size={11} />
					</a>
				</div>
			</div>
		</div>
	);
}

function ProjectRowSkeleton(): React.ReactElement {
	return (
		<div
			className="flex items-center gap-1.5"
			style={{
				padding: "6px 8px",
			}}
		>
			<div className="flex-1 min-w-0">
				<div
					className="kb-skeleton"
					style={{
						height: 14,
						width: "58%",
						borderRadius: 3,
						marginBottom: 6,
					}}
				/>
				<div
					className="kb-skeleton font-mono"
					style={{
						height: 10,
						width: "86%",
						borderRadius: 3,
						marginBottom: 6,
					}}
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

const PRELOAD_HOVER_DELAY_MS = 150;

function ProjectRow({
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
	useEffect(() => {
		return () => {
			if (hoverTimerRef.current !== null) {
				window.clearTimeout(hoverTimerRef.current);
			}
		};
	}, []);
	const isRemovingProject = removingProjectId === project.id;
	const hasAnyProjectRemoval = removingProjectId !== null;
	const [isMenuOpen, setIsMenuOpen] = useState(false);
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
			// Server counts all awaiting_review sessions as "review" — subtract the
			// needs-input subset so tasks aren't double-counted across R and NI pills.
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
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onSelect(project.id);
				}
			}}
			onMouseEnter={() => {
				if (isCurrent || !onPreload) return;
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
					onClick={(e) => e.stopPropagation()}
					onKeyDown={(e) => e.stopPropagation()}
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
							onClick={(e) => {
								e.stopPropagation();
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
