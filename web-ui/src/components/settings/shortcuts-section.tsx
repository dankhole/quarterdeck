// Settings section: project script shortcuts + prompt shortcut defaults reset.
import * as RadixPopover from "@radix-ui/react-popover";
import { ChevronDown, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	getRuntimeShortcutIconComponent,
	getRuntimeShortcutPickerOption,
	RUNTIME_SHORTCUT_ICON_OPTIONS,
	type RuntimeShortcutPickerIconId,
} from "@/components/shared/runtime-shortcut-icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type { RuntimeProjectShortcut } from "@/runtime/types";
import type { SettingsSectionProps } from "./settings-section-props";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getNextShortcutLabel(shortcuts: RuntimeProjectShortcut[], baseLabel: string): string {
	const normalizedTakenLabels = new Set(
		shortcuts.map((shortcut) => shortcut.label.trim().toLowerCase()).filter((label) => label.length > 0),
	);
	const normalizedBaseLabel = baseLabel.trim().toLowerCase();
	if (!normalizedTakenLabels.has(normalizedBaseLabel)) {
		return baseLabel;
	}

	let suffix = 2;
	while (normalizedTakenLabels.has(`${normalizedBaseLabel} ${suffix}`)) {
		suffix += 1;
	}
	return `${baseLabel} ${suffix}`;
}

function ShortcutIconComponent({ icon, size = 14 }: { icon: string | undefined; size?: number }): React.ReactElement {
	const Component = getRuntimeShortcutIconComponent(icon);
	return <Component size={size} />;
}

// ---------------------------------------------------------------------------
// Icon picker
// ---------------------------------------------------------------------------

function ShortcutIconPicker({
	value,
	onSelect,
}: {
	value: string | undefined;
	onSelect: (icon: RuntimeShortcutPickerIconId) => void;
}): React.ReactElement {
	const [open, setOpen] = useState(false);
	const selectedOption = getRuntimeShortcutPickerOption(value);

	return (
		<RadixPopover.Root open={open} onOpenChange={setOpen}>
			<RadixPopover.Trigger asChild>
				<button
					type="button"
					aria-label={`Shortcut icon: ${selectedOption.label}`}
					className="inline-flex items-center gap-1 h-7 px-1.5 rounded-md border border-border bg-surface-2 text-text-primary hover:bg-surface-3"
				>
					<ShortcutIconComponent icon={value} size={14} />
					<ChevronDown size={12} />
				</button>
			</RadixPopover.Trigger>
			<RadixPopover.Portal>
				<RadixPopover.Content
					side="bottom"
					align="start"
					sideOffset={4}
					className="z-50 rounded-md border border-border bg-surface-2 p-1 shadow-lg"
					style={{ animation: "kb-tooltip-show 100ms ease" }}
				>
					<div className="flex gap-0.5">
						{RUNTIME_SHORTCUT_ICON_OPTIONS.map((option) => {
							const IconComponent = getRuntimeShortcutIconComponent(option.value);
							return (
								<button
									key={option.value}
									type="button"
									aria-label={option.label}
									className={cn(
										"p-1.5 rounded hover:bg-surface-3",
										selectedOption.value === option.value && "bg-surface-3",
									)}
									onClick={() => {
										onSelect(option.value);
										setOpen(false);
									}}
								>
									<IconComponent size={14} />
								</button>
							);
						})}
					</div>
				</RadixPopover.Content>
			</RadixPopover.Portal>
		</RadixPopover.Root>
	);
}

// ---------------------------------------------------------------------------
// Section component
// ---------------------------------------------------------------------------

export function ShortcutsSection({
	fields,
	setField,
	disabled,
	sectionRef,
	showResetDefaultShortcuts,
	isResettingDefaultShortcuts,
	onResetDefaultShortcuts,
}: SettingsSectionProps & {
	sectionRef: React.Ref<HTMLHeadingElement>;
	showResetDefaultShortcuts: boolean;
	isResettingDefaultShortcuts: boolean;
	onResetDefaultShortcuts: () => void;
}): React.ReactElement {
	const [pendingScrollIndex, setPendingScrollIndex] = useState<number | null>(null);
	const rowRefs = useRef<Array<HTMLDivElement | null>>([]);

	// Scroll-and-focus newly added shortcut row
	useEffect(() => {
		if (pendingScrollIndex === null) {
			return;
		}
		const frame = window.requestAnimationFrame(() => {
			const target = rowRefs.current[pendingScrollIndex] ?? null;
			if (target) {
				target.scrollIntoView({ block: "nearest", behavior: "smooth" });
				const firstInput = target.querySelector("input");
				firstInput?.focus();
				setPendingScrollIndex(null);
			}
		});
		return () => {
			window.cancelAnimationFrame(frame);
		};
	}, [pendingScrollIndex, fields.shortcuts]);

	return (
		<>
			<div className="flex items-center justify-between mt-3 mb-2">
				<h6 ref={sectionRef} className="font-semibold text-text-primary m-0">
					Script shortcuts
				</h6>
				<Button
					variant="ghost"
					size="sm"
					icon={<Plus size={14} />}
					onClick={() => {
						const current = fields.shortcuts;
						const nextLabel = getNextShortcutLabel(current, "Run");
						setPendingScrollIndex(current.length);
						setField("shortcuts", [
							...current,
							{
								label: nextLabel,
								command: "",
								icon: "play",
							},
						]);
					}}
					disabled={disabled}
				>
					Add
				</Button>
			</div>

			{fields.shortcuts.map((shortcut, shortcutIndex) => (
				<div
					key={shortcutIndex}
					ref={(node) => {
						rowRefs.current[shortcutIndex] = node;
					}}
					className="grid gap-2 mb-1"
					style={{ gridTemplateColumns: "max-content 1fr 2fr auto" }}
				>
					<ShortcutIconPicker
						value={shortcut.icon}
						onSelect={(icon) =>
							setField(
								"shortcuts",
								fields.shortcuts.map((item, itemIndex) =>
									itemIndex === shortcutIndex ? { ...item, icon } : item,
								),
							)
						}
					/>
					<input
						name={`project-shortcut-label-${shortcutIndex}`}
						value={shortcut.label}
						onChange={(event) =>
							setField(
								"shortcuts",
								fields.shortcuts.map((item, itemIndex) =>
									itemIndex === shortcutIndex ? { ...item, label: event.target.value } : item,
								),
							)
						}
						placeholder="Label"
						className="h-7 w-full rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
					/>
					<input
						name={`project-shortcut-command-${shortcutIndex}`}
						value={shortcut.command}
						onChange={(event) =>
							setField(
								"shortcuts",
								fields.shortcuts.map((item, itemIndex) =>
									itemIndex === shortcutIndex ? { ...item, command: event.target.value } : item,
								),
							)
						}
						placeholder="Command"
						className="h-7 w-full rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
					/>
					<Button
						variant="ghost"
						size="sm"
						icon={<X size={14} />}
						aria-label={`Remove shortcut ${shortcut.label}`}
						onClick={() =>
							setField(
								"shortcuts",
								fields.shortcuts.filter((_, itemIndex) => itemIndex !== shortcutIndex),
							)
						}
					/>
				</div>
			))}
			{fields.shortcuts.length === 0 ? (
				<p className="text-text-secondary text-[13px]">No shortcuts configured.</p>
			) : null}

			{showResetDefaultShortcuts ? (
				<>
					<h6 className="font-semibold text-text-primary mt-4 mb-2">Default Prompt Shortcuts</h6>
					<p className="text-text-secondary text-[13px] mt-0 mb-2">
						Restore the built-in default prompt shortcuts (Commit and Squash Merge), replacing any customizations.
					</p>
					<Button
						variant="default"
						size="sm"
						disabled={disabled || isResettingDefaultShortcuts}
						onClick={onResetDefaultShortcuts}
					>
						{isResettingDefaultShortcuts ? "Restoring..." : "Restore defaults"}
					</Button>
				</>
			) : null}
		</>
	);
}
