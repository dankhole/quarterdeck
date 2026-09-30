import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CreateTaskButton({
	onClick,
	disabled = false,
}: {
	onClick: () => void;
	disabled?: boolean;
}): React.ReactElement {
	return (
		<div className="shrink-0 px-2 pt-3 pb-2">
			<Button
				fill
				className="h-11 rounded-lg shadow-sm"
				icon={<Plus size={16} className="text-accent" />}
				aria-label="Create task"
				onClick={onClick}
				disabled={disabled}
			>
				Create task{" "}
				<span
					aria-hidden
					className="ml-auto rounded border border-border-bright bg-surface-1 px-1.5 py-0.5 text-[11px] text-text-secondary"
				>
					C
				</span>
			</Button>
		</div>
	);
}
