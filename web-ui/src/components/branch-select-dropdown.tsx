import { GitBranch, Pin } from "lucide-react";
import type { CSSProperties, ReactElement } from "react";

import type { RenderOptionAction, SearchSelectOption } from "@/components/search-select-dropdown";
import { SearchSelectDropdown } from "@/components/search-select-dropdown";
import { Tooltip } from "@/components/ui/tooltip";

export type BranchSelectOption = SearchSelectOption;

/**
 * Simple branch select dropdown for choosing a branch by name, used in task
 * creation flows (task-create-dialog, task-inline-create-card). Wraps the
 * generic SearchSelectDropdown with a git branch icon.
 *
 * For the full-featured branch picker with local/remote grouping, checkout
 * actions, and worktree-locked indicators, use BranchSelectorPopover instead.
 */
export function BranchSelectDropdown({
	options,
	selectedValue,
	onSelect,
	id,
	disabled = false,
	fill = false,
	size,
	buttonText,
	buttonClassName,
	buttonStyle,
	iconSize,
	emptyText = "No branches detected",
	noResultsText = "No matching branches",
	showSelectedIndicator = false,
	matchTargetWidth = true,
	dropdownStyle,
	menuStyle,
	onPopoverOpenChange,
	defaultValue,
	onSetDefault,
}: {
	options: readonly BranchSelectOption[];
	selectedValue?: string | null;
	onSelect: (value: string) => void;
	id?: string;
	disabled?: boolean;
	fill?: boolean;
	size?: "sm" | "md";
	buttonText?: string;
	buttonClassName?: string;
	buttonStyle?: CSSProperties;
	iconSize?: number;
	emptyText?: string;
	noResultsText?: string;
	showSelectedIndicator?: boolean;
	matchTargetWidth?: boolean;
	dropdownStyle?: CSSProperties;
	menuStyle?: CSSProperties;
	onPopoverOpenChange?: (isOpen: boolean) => void;
	/** The branch currently set as the default base ref. */
	defaultValue?: string | null;
	/** Called when the user pins/unpins a branch as the default. Null means clear. */
	onSetDefault?: (value: string | null) => void;
}): ReactElement {
	const resolvedIconSize = typeof iconSize === "number" ? iconSize : 14;

	const renderOptionAction: RenderOptionAction | undefined = onSetDefault
		? (option) => {
				const isDefault = option.value === defaultValue;
				return (
					<Tooltip content={isDefault ? "Clear default base ref" : "Set as default base ref"} side="right">
						<button
							type="button"
							className={
								isDefault
									? "flex items-center justify-center w-5 h-5 rounded text-accent cursor-pointer"
									: "flex items-center justify-center w-5 h-5 rounded text-text-tertiary opacity-0 group-hover/option:opacity-100 hover:text-text-primary cursor-pointer"
							}
							onClick={() => onSetDefault(isDefault ? null : option.value)}
						>
							<Pin size={12} className={isDefault ? "fill-current" : undefined} />
						</button>
					</Tooltip>
				);
			}
		: undefined;

	return (
		<SearchSelectDropdown
			options={options}
			selectedValue={selectedValue}
			onSelect={onSelect}
			id={id}
			icon={<GitBranch size={resolvedIconSize} />}
			disabled={disabled}
			fill={fill}
			size={size}
			buttonText={buttonText}
			buttonClassName={buttonClassName}
			buttonStyle={buttonStyle}
			iconSize={iconSize}
			emptyText={emptyText}
			noResultsText={noResultsText}
			showSelectedIndicator={showSelectedIndicator}
			matchTargetWidth={matchTargetWidth}
			dropdownStyle={dropdownStyle}
			menuStyle={menuStyle}
			onPopoverOpenChange={onPopoverOpenChange}
			renderOptionAction={renderOptionAction}
		/>
	);
}
