import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import { type ReactElement, useId } from "react";

import { SearchSelectDropdown } from "@/components/search-select-dropdown";

export interface TaskOptionChoice {
	value: string;
	label: string;
	description?: string;
}

/** Labeled dropdown used by the per-agent starting-option pickers in task creation. */
export function TaskOptionSelector({
	label,
	value,
	options,
	disabled,
	searchable = false,
	onSelect,
	portalContainer,
}: {
	label: string;
	value: string;
	options: TaskOptionChoice[];
	disabled?: boolean;
	searchable?: boolean;
	onSelect: (value: string) => void;
	portalContainer: HTMLElement | null;
}): ReactElement {
	const id = useId();
	if (searchable) {
		return (
			<div className="min-w-0">
				<label htmlFor={id} className="mb-1 block text-[11px] text-text-secondary">
					{label}
				</label>
				<SearchSelectDropdown
					id={id}
					ariaLabel={label}
					options={options}
					selectedValue={value}
					onSelect={onSelect}
					disabled={disabled}
					portalContainer={portalContainer}
					placeholder="Search models…"
					showSelectedIndicator
					fill
					size="sm"
				/>
			</div>
		);
	}
	return (
		<div className="min-w-0">
			<span className="mb-1 block text-[11px] text-text-secondary">{label}</span>
			<DropdownMenu.Root modal={false}>
				<DropdownMenu.Trigger asChild>
					<button
						type="button"
						aria-label={label}
						disabled={disabled}
						className="flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border-bright bg-surface-2 px-2.5 text-left text-[12px] text-text-primary hover:bg-surface-3 disabled:cursor-default disabled:opacity-40"
					>
						<span className="truncate">{options.find((option) => option.value === value)?.label ?? value}</span>
						<ChevronDown size={14} className="shrink-0 text-text-secondary" />
					</button>
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal container={portalContainer}>
					<DropdownMenu.Content
						side="bottom"
						align="start"
						sideOffset={4}
						onCloseAutoFocus={(event) => event.preventDefault()}
						className="z-50 max-h-64 min-w-[200px] max-w-[340px] overflow-y-auto rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg"
					>
						{options.map((option) => (
							<DropdownMenu.Item
								key={option.value}
								onSelect={() => onSelect(option.value)}
								className="flex cursor-pointer items-start justify-between gap-3 rounded-sm px-2 py-1.5 text-[12px] text-text-primary outline-none data-[highlighted]:bg-surface-3"
							>
								<span className="min-w-0">
									<span>{option.label}</span>
									{option.description ? (
										<span className="mt-0.5 block text-[11px] text-text-secondary">{option.description}</span>
									) : null}
								</span>
								{option.value === value ? <Check size={14} className="mt-0.5 shrink-0 text-accent" /> : null}
							</DropdownMenu.Item>
						))}
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
		</div>
	);
}
