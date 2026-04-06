import { GitCompareArrows, LayoutGrid } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { DetailPanelId } from "@/resize/use-card-detail-layout";

const TOOLBAR_WIDTH = 40;

interface DetailToolbarProps {
	activePanel: DetailPanelId | null;
	onPanelChange: (panel: DetailPanelId | null) => void;
}

function ToolbarButton({
	panelId,
	activePanel,
	onPanelChange,
	icon,
	label,
}: {
	panelId: DetailPanelId;
	activePanel: DetailPanelId | null;
	onPanelChange: (panel: DetailPanelId | null) => void;
	icon: React.ReactElement;
	label: string;
}): React.ReactElement {
	const isActive = activePanel === panelId;
	return (
		<Tooltip content={label} side="right">
			<button
				type="button"
				onClick={() => onPanelChange(isActive ? null : panelId)}
				className={cn(
					"flex items-center justify-center w-8 h-8 rounded-md cursor-pointer border-0",
					isActive
						? "bg-surface-3 text-text-primary"
						: "bg-transparent text-text-tertiary hover:text-text-secondary hover:bg-surface-2",
				)}
				aria-label={label}
				aria-pressed={isActive}
			>
				{icon}
			</button>
		</Tooltip>
	);
}

export { TOOLBAR_WIDTH };

export function DetailToolbar({ activePanel, onPanelChange }: DetailToolbarProps): React.ReactElement {
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
			<ToolbarButton
				panelId="kanban"
				activePanel={activePanel}
				onPanelChange={onPanelChange}
				icon={<LayoutGrid size={18} />}
				label="Board"
			/>
			<ToolbarButton
				panelId="changes"
				activePanel={activePanel}
				onPanelChange={onPanelChange}
				icon={<GitCompareArrows size={18} />}
				label="Changes"
			/>
		</aside>
	);
}
