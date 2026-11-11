import * as RadixPopover from "@radix-ui/react-popover";
import { Fzf } from "fzf";
import { Check, ChevronDown } from "lucide-react";
import type { CSSProperties, KeyboardEvent, ReactElement, ReactNode, WheelEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { FolderSelectRowButton } from "@/components/shared/folder-select-row";
import { renderFuzzyHighlightedText } from "@/components/shared/render-fuzzy-highlighted-text";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import { useFolderSelectRows } from "@/hooks/search/use-folder-select-rows";

export interface SearchSelectOption {
	value: string;
	label: string;
}

export type RenderOptionAction = (option: SearchSelectOption) => ReactNode;

const getOptionKey = (option: SearchSelectOption): string => option.value;
const NO_RECOMMENDED_OPTIONS: readonly string[] = [];

const MATCHED_TEXT_STYLE = {
	color: "var(--color-text-primary)",
	fontWeight: 600,
} as const;

export function SearchSelectDropdown({
	options,
	selectedValue,
	onSelect,
	id,
	ariaLabel,
	icon,
	disabled = false,
	fill = false,
	size,
	buttonText,
	buttonClassName,
	buttonStyle,
	iconSize,
	placeholder = "Search...",
	emptyText = "No options available",
	noResultsText = "No matching results",
	showSelectedIndicator = false,
	pinSelectedToTop = true,
	recommendedOptionValues = NO_RECOMMENDED_OPTIONS,
	recommendedHeading = "Recommended models",
	matchTargetWidth = true,
	collisionPadding = 8,
	dropdownClassName,
	dropdownStyle,
	menuStyle,
	onPopoverOpenChange,
	portalContainer,
	footerAction,
	renderOptionAction,
	renderOptionTooltip,
	getOptionPath,
	buttonTooltip,
	ghostUntilOpen = false,
}: {
	options: readonly SearchSelectOption[];
	selectedValue?: string | null;
	onSelect: (value: string) => void;
	id?: string;
	ariaLabel?: string;
	icon?: ReactNode;
	disabled?: boolean;
	fill?: boolean;
	size?: "sm" | "md";
	buttonText?: string;
	buttonClassName?: string;
	buttonStyle?: CSSProperties;
	iconSize?: number;
	placeholder?: string;
	emptyText?: string;
	noResultsText?: string;
	showSelectedIndicator?: boolean;
	pinSelectedToTop?: boolean;
	recommendedOptionValues?: readonly string[];
	recommendedHeading?: string;
	matchTargetWidth?: boolean;
	collisionPadding?: number;
	dropdownClassName?: string;
	dropdownStyle?: CSSProperties;
	menuStyle?: CSSProperties;
	onPopoverOpenChange?: (isOpen: boolean) => void;
	portalContainer?: HTMLElement | null;
	footerAction?: {
		label: string;
		onClick: () => void;
	};
	renderOptionAction?: RenderOptionAction;
	renderOptionTooltip?: (option: SearchSelectOption) => ReactNode;
	/** Present canonical paths as folders without changing search labels or selection values. */
	getOptionPath?: (option: SearchSelectOption) => readonly string[];
	buttonTooltip?: ReactNode;
	/** When true the trigger button renders as a ghost until the popover opens. */
	ghostUntilOpen?: boolean;
}): ReactElement {
	const [isOpen, setIsOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [activeRowKey, setActiveRowKey] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const orderedOptions = useMemo(() => {
		const items = options.slice();
		if (!pinSelectedToTop || !selectedValue) {
			return items;
		}
		const selectedIndex = items.findIndex((option) => option.value === selectedValue);
		if (selectedIndex <= 0) {
			return items;
		}
		const [selectedOption] = items.splice(selectedIndex, 1);
		if (!selectedOption) {
			return items;
		}
		items.unshift(selectedOption);
		return items;
	}, [options, pinSelectedToTop, selectedValue]);
	const selectedOption = useMemo(
		() => orderedOptions.find((option) => option.value === selectedValue) ?? null,
		[orderedOptions, selectedValue],
	);
	const recommendedOptionValueSet = useMemo(
		() => new Set(recommendedOptionValues.map((value) => value.trim()).filter((value) => value.length > 0)),
		[recommendedOptionValues],
	);
	const fuzzyMatches = useMemo(() => {
		if (!query.trim()) {
			return [] as ReturnType<Fzf<SearchSelectOption[]>["find"]>;
		}
		const finder = new Fzf(orderedOptions, {
			selector: (option) => option.label,
		});
		return finder.find(query);
	}, [orderedOptions, query]);
	const fuzzyMatchesByValue = useMemo(
		() => new Map(fuzzyMatches.map((match) => [match.item.value, match])),
		[fuzzyMatches],
	);
	const filteredItems = useMemo(() => {
		if (!query.trim()) {
			if (recommendedOptionValueSet.size === 0) {
				return orderedOptions;
			}
			const recommendedItems = orderedOptions.filter((item) => recommendedOptionValueSet.has(item.value));
			const otherItems = orderedOptions.filter((item) => !recommendedOptionValueSet.has(item.value));
			return [...recommendedItems, ...otherItems];
		}
		return fuzzyMatches.map((entry) => entry.item);
	}, [fuzzyMatches, orderedOptions, query, recommendedOptionValueSet]);
	const isSearching = query.trim().length > 0;
	const showRecommendedSection = !getOptionPath && !isSearching && recommendedOptionValueSet.size > 0;
	const { rows, toggleFolder, resetFolders } = useFolderSelectRows({
		items: filteredItems,
		getKey: getOptionKey,
		getPath: getOptionPath,
		selectedKey: selectedValue,
		isSearching,
	});
	const activeOptionIndex = Math.max(
		0,
		rows.findIndex((row) => row.key === activeRowKey),
	);
	const activeOptionKey = rows[activeOptionIndex]?.key;
	const recommendedItems = useMemo(
		() => filteredItems.filter((item) => recommendedOptionValueSet.has(item.value)),
		[filteredItems, recommendedOptionValueSet],
	);
	const otherItems = useMemo(
		() => filteredItems.filter((item) => !recommendedOptionValueSet.has(item.value)),
		[filteredItems, recommendedOptionValueSet],
	);
	const visibleItemIndexByValue = useMemo(
		() => new Map(rows.flatMap((row, index) => (row.kind === "item" ? [[row.item.value, index] as const] : []))),
		[rows],
	);
	const resolvedButtonText = buttonText ?? selectedOption?.label ?? emptyText;

	const handleOpenChange = useCallback(
		(nextOpen: boolean) => {
			setIsOpen(nextOpen);
			setQuery("");
			setActiveRowKey(
				nextOpen && getOptionPath
					? (rows.find((row) => row.kind === "item" && row.item.value === selectedValue)?.key ?? null)
					: null,
			);
			if (!nextOpen) {
				resetFolders();
			}
			onPopoverOpenChange?.(nextOpen);
		},
		[getOptionPath, onPopoverOpenChange, resetFolders, rows, selectedValue],
	);

	useEffect(() => {
		if (activeRowKey !== null && !rows.some((row) => row.key === activeRowKey)) {
			setActiveRowKey(null);
		}
	}, [activeRowKey, rows]);

	useEffect(() => {
		if (!isOpen || activeOptionKey === undefined) {
			return;
		}
		const optionElement = optionRefs.current[activeOptionIndex] ?? null;
		optionElement?.scrollIntoView({ block: "nearest" });
	}, [activeOptionIndex, activeOptionKey, isOpen]);

	useEffect(() => {
		if (isOpen) {
			window.requestAnimationFrame(() => {
				inputRef.current?.focus();
			});
		}
	}, [isOpen]);

	const handleSearchInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (rows.length === 0) {
			if (event.key === "Escape") {
				event.preventDefault();
				handleOpenChange(false);
			}
			return;
		}

		if (event.key === "ArrowDown") {
			event.preventDefault();
			setActiveRowKey(rows[Math.min(activeOptionIndex + 1, rows.length - 1)]?.key ?? null);
			return;
		}

		if (event.key === "ArrowUp") {
			event.preventDefault();
			setActiveRowKey(rows[Math.max(activeOptionIndex - 1, 0)]?.key ?? null);
			return;
		}

		if (event.key === "Home") {
			event.preventDefault();
			setActiveRowKey(rows[0]?.key ?? null);
			return;
		}

		if (event.key === "End") {
			event.preventDefault();
			setActiveRowKey(rows[rows.length - 1]?.key ?? null);
			return;
		}

		if (event.key === "Enter") {
			event.preventDefault();
			const row = rows[activeOptionIndex];
			if (!row) {
				return;
			}
			if (row.kind === "folder") {
				setActiveRowKey(row.key);
				toggleFolder(row.key);
				return;
			}
			onSelect(row.item.value);
			handleOpenChange(false);
			return;
		}

		if (event.key === "Escape") {
			event.preventDefault();
			handleOpenChange(false);
		}
	};

	const resolvedIconSize = typeof iconSize === "number" ? iconSize : 14;

	const handleWheelCapture = useCallback((event: WheelEvent<HTMLDivElement>) => {
		const menu = menuRef.current;
		if (!menu || menu.scrollHeight <= menu.clientHeight) {
			return;
		}
		menu.scrollTop += event.deltaY;
		event.preventDefault();
		event.stopPropagation();
	}, []);

	const resolvedIcon = icon !== undefined ? icon : undefined;
	const renderOptionButton = (option: SearchSelectOption, label = option.label, depth = 0): ReactElement => {
		const optionIndex = visibleItemIndexByValue.get(option.value) ?? 0;
		const optionKey = rows[optionIndex]?.key ?? option.value;
		const match = fuzzyMatchesByValue.get(option.value);
		const isSelected = showSelectedIndicator && option.value === selectedValue;
		const isActive = optionIndex === activeOptionIndex;
		return (
			<button
				type="button"
				key={optionKey}
				ref={(node) => {
					optionRefs.current[optionIndex] = node;
				}}
				className={cn(
					"group/option flex w-full items-center gap-2 px-2.5 py-1.5 text-[13px] rounded-md text-left",
					isActive
						? "bg-surface-3 text-text-primary"
						: "text-text-secondary hover:bg-surface-3 hover:text-text-primary",
				)}
				style={depth > 0 ? { paddingLeft: 10 + depth * 16 } : undefined}
				onMouseEnter={() => setActiveRowKey(optionKey)}
				onClick={() => {
					onSelect(option.value);
					handleOpenChange(false);
				}}
			>
				<Tooltip content={renderOptionTooltip?.(option)} delayDuration={150}>
					<span className="min-w-0 flex-1 break-all">
						{renderFuzzyHighlightedText(label, match?.positions, MATCHED_TEXT_STYLE)}
					</span>
				</Tooltip>
				{renderOptionAction ? (
					<span
						className="shrink-0"
						onClick={(e) => {
							e.stopPropagation();
							e.preventDefault();
						}}
						onMouseDown={(e) => e.stopPropagation()}
					>
						{renderOptionAction(option)}
					</span>
				) : null}
				{isSelected ? <Check size={14} className="shrink-0 text-text-secondary" /> : null}
			</button>
		);
	};

	return (
		<RadixPopover.Root open={isOpen} onOpenChange={handleOpenChange}>
			<RadixPopover.Trigger asChild>
				<Button
					id={id}
					aria-label={ariaLabel}
					size={size}
					variant={ghostUntilOpen && !isOpen ? "ghost" : "default"}
					fill={fill}
					icon={resolvedIcon}
					iconRight={<ChevronDown size={resolvedIconSize} />}
					disabled={disabled}
					className={cn(fill && "justify-between text-left", buttonClassName)}
					style={buttonStyle}
				>
					<Tooltip content={buttonTooltip} delayDuration={150}>
						<span className="min-w-0 flex-1 truncate text-left">{resolvedButtonText}</span>
					</Tooltip>
				</Button>
			</RadixPopover.Trigger>
			<RadixPopover.Portal container={portalContainer}>
				<RadixPopover.Content
					className={cn(
						"z-50 max-h-[300px] rounded-lg border border-border bg-surface-1 shadow-xl overflow-hidden",
						dropdownClassName,
					)}
					onWheelCapture={handleWheelCapture}
					collisionPadding={collisionPadding}
					style={{
						width: matchTargetWidth ? "var(--radix-popover-trigger-width)" : undefined,
						...dropdownStyle,
					}}
					sideOffset={4}
				>
					<div className="p-2 border-b border-border">
						<input
							ref={inputRef}
							name={id ? `${id}-search` : "search-select-query"}
							className="h-7 w-full rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
							placeholder={placeholder}
							value={query}
							onChange={(event) => {
								setQuery(event.target.value);
								setActiveRowKey(null);
							}}
							onKeyDown={handleSearchInputKeyDown}
						/>
					</div>
					<div ref={menuRef} className="max-h-[250px] overflow-y-auto overscroll-contain p-1" style={menuStyle}>
						{filteredItems.length === 0 ? (
							<div className="px-2.5 py-1.5 text-[13px] text-text-tertiary">{noResultsText}</div>
						) : (
							<>
								{showRecommendedSection && recommendedItems.length > 0 ? (
									<div className="px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.02em] text-text-tertiary">
										{recommendedHeading}
									</div>
								) : null}
								{showRecommendedSection
									? recommendedItems.map((option) => renderOptionButton(option))
									: rows.map((row, index) => {
											if (row.kind === "folder") {
												return (
													<FolderSelectRowButton
														key={row.key}
														row={row}
														ref={(node) => {
															optionRefs.current[index] = node;
														}}
														className={cn(
															index === activeOptionIndex && "bg-surface-3 text-text-primary",
														)}
														onMouseEnter={() => setActiveRowKey(row.key)}
														onMouseDown={(event) => event.preventDefault()}
														onToggle={() => {
															setActiveRowKey(row.key);
															toggleFolder(row.key);
															inputRef.current?.focus();
														}}
													/>
												);
											}
											const label =
												getOptionPath && !isSearching && row.item.label.startsWith(row.item.value)
													? row.label + row.item.label.slice(row.item.value.length)
													: row.item.label;
											return renderOptionButton(row.item, label, row.depth);
										})}
								{footerAction ? (
									<div className="border-t border-border p-1">
										<button
											type="button"
											className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[13px] text-text-secondary hover:bg-surface-3 hover:text-text-primary"
											onClick={() => {
												footerAction.onClick();
												handleOpenChange(false);
											}}
										>
											{footerAction.label}
										</button>
									</div>
								) : null}
								{showRecommendedSection && recommendedItems.length > 0 && otherItems.length > 0 ? (
									<>
										<div className="my-1 border-t border-border" />
										<div className="px-2.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.02em] text-text-tertiary">
											All models
										</div>
									</>
								) : null}
								{showRecommendedSection && otherItems.length > 0
									? otherItems.map((option) => renderOptionButton(option))
									: null}
							</>
						)}
					</div>
				</RadixPopover.Content>
			</RadixPopover.Portal>
		</RadixPopover.Root>
	);
}
