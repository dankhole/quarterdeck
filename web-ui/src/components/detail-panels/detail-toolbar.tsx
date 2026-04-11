import {
	FolderKanban,
	FolderOpen,
	GitCompareArrows,
	House,
	LayoutGrid,
	Pin,
	PinOff,
	SquareTerminal,
} from "lucide-react";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { MainViewId, SidebarId } from "@/resize/use-card-detail-layout";

const TOOLBAR_WIDTH = 40;

interface DetailToolbarProps {
	activeMainView: MainViewId;
	activeSidebar: SidebarId | null;
	onMainViewChange: (view: MainViewId) => void;
	onSidebarChange: (id: SidebarId) => void;
	sidebarPinned: boolean;
	onToggleSidebarPinned: () => void;
	hasSelectedTask: boolean;
	gitBadgeColor?: "red" | "blue";
	isBehindBase?: boolean;
	projectsBadgeColor?: "orange";
}

function Badge({ color }: { color: "red" | "blue" | "orange" }): React.ReactElement {
	return (
		<span
			className={cn(
				"absolute top-1 right-1 w-2 h-2 rounded-full",
				color === "red" ? "bg-status-red" : color === "orange" ? "bg-status-orange" : "bg-status-blue",
			)}
		/>
	);
}

/** Main view button — filled background when active */
function MainViewButton({
	viewId,
	activeMainView,
	onMainViewChange,
	icon,
	label,
	badgeColor,
	disabled,
}: {
	viewId: MainViewId;
	activeMainView: MainViewId;
	onMainViewChange: (view: MainViewId) => void;
	icon: React.ReactElement;
	label: string;
	badgeColor?: "red" | "blue" | "orange";
	disabled?: boolean;
}): React.ReactElement {
	const isActive = !disabled && activeMainView === viewId;
	return (
		<Tooltip content={label} side="right">
			<button
				type="button"
				onClick={() => onMainViewChange(viewId)}
				disabled={disabled}
				className={cn(
					"relative flex items-center justify-center w-8 h-8 rounded-md cursor-pointer border-0",
					disabled
						? "opacity-35 pointer-events-none cursor-default text-text-tertiary"
						: isActive
							? "bg-surface-3 text-text-primary"
							: "bg-transparent text-text-tertiary hover:text-text-secondary hover:bg-surface-2",
				)}
				aria-label={label}
				aria-pressed={isActive}
			>
				{icon}
				{badgeColor ? <Badge color={badgeColor} /> : null}
			</button>
		</Tooltip>
	);
}

/** Sidebar button — left border accent when active */
function SidebarButton({
	sidebarId,
	activeSidebar,
	onSidebarChange,
	icon,
	label,
	badgeColor,
	disabled,
}: {
	sidebarId: SidebarId;
	activeSidebar: SidebarId | null;
	onSidebarChange: (id: SidebarId) => void;
	icon: React.ReactElement;
	label: string;
	badgeColor?: "red" | "blue" | "orange";
	disabled?: boolean;
}): React.ReactElement {
	const isActive = !disabled && activeSidebar === sidebarId;
	return (
		<Tooltip content={label} side="right">
			<button
				type="button"
				onClick={() => onSidebarChange(sidebarId)}
				disabled={disabled}
				className={cn(
					"relative flex items-center justify-center w-8 h-8 rounded-md cursor-pointer border-0",
					disabled
						? "opacity-35 pointer-events-none cursor-default text-text-tertiary"
						: isActive
							? "bg-transparent text-accent border-l-2 border-accent"
							: "bg-transparent text-text-tertiary hover:text-text-secondary hover:bg-surface-2",
				)}
				aria-label={label}
				aria-pressed={isActive}
			>
				{icon}
				{badgeColor ? <Badge color={badgeColor} /> : null}
			</button>
		</Tooltip>
	);
}

export { TOOLBAR_WIDTH };

export function DetailToolbar({
	activeMainView,
	activeSidebar,
	onMainViewChange,
	onSidebarChange,
	sidebarPinned,
	onToggleSidebarPinned,
	hasSelectedTask,
	gitBadgeColor,
	isBehindBase,
	projectsBadgeColor,
}: DetailToolbarProps): React.ReactElement {
	const filesBadgeColor: "blue" | undefined = hasSelectedTask && isBehindBase ? "blue" : undefined;

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
			{/* Main view buttons — above divider */}
			<MainViewButton
				viewId="home"
				activeMainView={activeMainView}
				onMainViewChange={onMainViewChange}
				icon={<House size={18} />}
				label="Home"
			/>
			<MainViewButton
				viewId="terminal"
				activeMainView={activeMainView}
				onMainViewChange={onMainViewChange}
				icon={<SquareTerminal size={18} />}
				label="Terminal"
				disabled={!hasSelectedTask}
			/>
			<MainViewButton
				viewId="files"
				activeMainView={activeMainView}
				onMainViewChange={onMainViewChange}
				icon={<FolderOpen size={18} />}
				label="Files"
				badgeColor={filesBadgeColor}
			/>
			<MainViewButton
				viewId="git"
				activeMainView={activeMainView}
				onMainViewChange={onMainViewChange}
				icon={<GitCompareArrows size={18} />}
				label="Git"
				badgeColor={gitBadgeColor}
			/>

			{/* Divider between main view and sidebar buttons */}
			<div className="w-5 my-1" style={{ height: 1, background: "var(--color-divider)" }} />

			{/* Sidebar buttons — below divider */}
			<SidebarButton
				sidebarId="projects"
				activeSidebar={activeSidebar}
				onSidebarChange={onSidebarChange}
				icon={<FolderKanban size={18} />}
				label="Projects"
				badgeColor={projectsBadgeColor}
			/>
			<SidebarButton
				sidebarId="task_column"
				activeSidebar={activeSidebar}
				onSidebarChange={onSidebarChange}
				icon={<LayoutGrid size={18} />}
				label="Board"
				disabled={!hasSelectedTask}
			/>

			{/* Pin toggle — prevents sidebar from auto-switching when selecting/deselecting tasks */}
			<Tooltip content={sidebarPinned ? "Unpin sidebar" : "Pin sidebar"} side="right">
				<button
					type="button"
					onClick={onToggleSidebarPinned}
					className={cn(
						"flex items-center justify-center w-6 h-6 rounded cursor-pointer border-0 mt-0.5 bg-transparent",
						sidebarPinned
							? "text-accent"
							: "text-text-tertiary opacity-40 hover:opacity-100 hover:text-text-secondary",
					)}
					aria-label={sidebarPinned ? "Unpin sidebar" : "Pin sidebar"}
					aria-pressed={sidebarPinned}
				>
					{sidebarPinned ? <Pin size={14} /> : <PinOff size={14} />}
				</button>
			</Tooltip>
		</aside>
	);
}
