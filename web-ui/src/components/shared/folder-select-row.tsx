import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "@/components/ui/cn";
import type { FolderSelectFolderRow } from "@/hooks/search/folder-select";

export interface FolderSelectRowButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onToggle"> {
	row: FolderSelectFolderRow;
	onToggle: () => void;
}

/** A native button: Enter/Space toggle without adding a second keyboard policy. */
export const FolderSelectRowButton = forwardRef<HTMLButtonElement, FolderSelectRowButtonProps>(
	function FolderSelectRowButton({ row, onToggle, className, style, onClick, ...rest }, ref) {
		const Chevron = row.expanded ? ChevronDown : ChevronRight;
		const FolderIcon = row.expanded ? FolderOpen : Folder;
		return (
			<button
				{...rest}
				ref={ref}
				type="button"
				aria-label={rest["aria-label"] ?? `${row.label}, ${row.count} ${row.count === 1 ? "item" : "items"}`}
				aria-expanded={row.expanded}
				className={cn(
					"flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-text-secondary hover:bg-surface-3 focus-visible:outline focus-visible:outline-accent",
					className,
				)}
				style={{ paddingInlineStart: 8 + row.depth * 16, ...style }}
				onClick={(event) => {
					onClick?.(event);
					if (!event.defaultPrevented) onToggle();
				}}
			>
				<Chevron size={12} aria-hidden="true" className="shrink-0" />
				<FolderIcon size={14} aria-hidden="true" className="shrink-0" />
				<span className="min-w-0 flex-1 truncate">{row.label}</span>
				<span aria-hidden="true" className="shrink-0 text-text-tertiary">
					{row.count}
				</span>
			</button>
		);
	},
);
