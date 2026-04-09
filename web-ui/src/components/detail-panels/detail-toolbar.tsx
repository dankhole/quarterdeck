import { FolderOpen, GitCompareArrows, House, LayoutGrid } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { SidebarTabId } from "@/resize/use-card-detail-layout";

const TOOLBAR_WIDTH = 40;

interface DetailToolbarProps {
	visualActiveTab: SidebarTabId;
	onTabChange: (tab: SidebarTabId) => void;
	hasSelectedTask: boolean;
	hasUncommittedChanges?: boolean;
	hasUnmergedChanges?: boolean;
}

function ToolbarButton({
	tabId,
	visualActiveTab,
	onTabChange,
	icon,
	label,
	badgeColor,
	disabled,
}: {
	tabId: SidebarTabId;
	visualActiveTab: SidebarTabId;
	onTabChange: (tab: SidebarTabId) => void;
	icon: React.ReactElement;
	label: string;
	badgeColor?: "red" | "blue";
	disabled?: boolean;
}): React.ReactElement {
	const isActive = visualActiveTab === tabId;
	return (
		<Tooltip content={label} side="right">
			<button
				type="button"
				onClick={() => onTabChange(tabId)}
				disabled={disabled}
				className={cn(
					"relative flex items-center justify-center w-8 h-8 rounded-md cursor-pointer border-0",
					isActive
						? "bg-surface-3 text-text-primary"
						: "bg-transparent text-text-tertiary hover:text-text-secondary hover:bg-surface-2",
					disabled && "opacity-35 pointer-events-none cursor-default",
				)}
				aria-label={label}
				aria-pressed={isActive}
			>
				{icon}
				{badgeColor ? (
					<span
						className={cn(
							"absolute top-1 right-1 w-2 h-2 rounded-full",
							badgeColor === "red" ? "bg-status-red" : "bg-status-blue",
						)}
					/>
				) : null}
			</button>
		</Tooltip>
	);
}

export { TOOLBAR_WIDTH };

export function DetailToolbar({
	visualActiveTab,
	onTabChange,
	hasSelectedTask,
	hasUncommittedChanges,
	hasUnmergedChanges,
}: DetailToolbarProps): React.ReactElement {
	const changesBadgeColor: "red" | "blue" | undefined = hasSelectedTask
		? hasUncommittedChanges
			? "red"
			: hasUnmergedChanges
				? "blue"
				: undefined
		: undefined;

	return (
		<aside
			className="flex flex-col items-center shrink-0 py-2 gap-1"
			style={{
				width: TOOLBAR_WIDTH,
				minWidth: TOOLBAR_WIDTH,
				background: "var(--color-surface-1)",
				borderRight: "1px solid var(--color-divider)",
			}}
		>
			{/* Home — always enabled */}
			<ToolbarButton
				tabId="home"
				visualActiveTab={visualActiveTab}
				onTabChange={onTabChange}
				icon={<House size={18} />}
				label="Home"
			/>

			{/* Divider between Home and task-tied tabs */}
			<div className="w-5 my-1" style={{ height: 1, background: "var(--color-divider)" }} />

			{/* Task-tied tabs — greyed out when no task selected */}
			<ToolbarButton
				tabId="task_column"
				visualActiveTab={visualActiveTab}
				onTabChange={onTabChange}
				icon={<LayoutGrid size={18} />}
				label="Board"
				disabled={!hasSelectedTask}
			/>
			<ToolbarButton
				tabId="changes"
				visualActiveTab={visualActiveTab}
				onTabChange={onTabChange}
				icon={<GitCompareArrows size={18} />}
				label="Changes"
				badgeColor={changesBadgeColor}
				disabled={!hasSelectedTask}
			/>
			<ToolbarButton
				tabId="files"
				visualActiveTab={visualActiveTab}
				onTabChange={onTabChange}
				icon={<FolderOpen size={18} />}
				label="Files"
				disabled={!hasSelectedTask}
			/>
		</aside>
	);
}
