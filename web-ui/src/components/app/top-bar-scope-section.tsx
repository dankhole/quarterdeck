import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import { formatPathForDisplay } from "@/utils/path-display";

function getProjectPathSegments(path: string): string[] {
	return path
		.replaceAll("\\", "/")
		.split("/")
		.filter((segment) => segment.length > 0);
}

export function TopBarScopeSection({
	onBack,
	scopeType,
	taskTitle,
	projectPath,
	isProjectPathLoading,
	projectHint,
	runtimeHint,
	onOpenSettings,
	hideProjectDependentActions,
	branchPillSlot,
}: {
	onBack?: () => void;
	scopeType: "home" | "task" | "branch_view";
	taskTitle?: string | null;
	projectPath?: string;
	isProjectPathLoading: boolean;
	projectHint?: string;
	runtimeHint?: string;
	onOpenSettings?: () => void;
	hideProjectDependentActions: boolean;
	branchPillSlot?: React.ReactNode;
}): React.ReactElement {
	const displayProjectPath = projectPath ? formatPathForDisplay(projectPath) : null;
	const projectSegments = displayProjectPath ? getProjectPathSegments(displayProjectPath) : [];
	const hasAbsoluteLeadingSlash = Boolean(displayProjectPath?.startsWith("/"));

	return (
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
			{isProjectPathLoading ? (
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
						onClick={onOpenSettings}
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
	);
}

export function getTopBarScopeBorderClass(scopeType: "home" | "task" | "branch_view"): string {
	return cn(
		"border-l-3",
		scopeType === "home" && "border-l-text-secondary",
		scopeType === "task" && "border-l-accent",
		scopeType === "branch_view" && "border-l-status-purple",
	);
}
