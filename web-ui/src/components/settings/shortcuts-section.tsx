// Settings section: project-scoped shell command shortcuts.
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
	disabled,
}: {
	value: string | undefined;
	onSelect: (icon: RuntimeShortcutPickerIconId) => void;
	disabled: boolean;
}): React.ReactElement {
	const [open, setOpen] = useState(false);
	const selectedOption = getRuntimeShortcutPickerOption(value);

	return (
		<RadixPopover.Root open={open} onOpenChange={setOpen}>
			<RadixPopover.Trigger asChild>
				<button
					type="button"
					aria-label={`Shortcut icon: ${selectedOption.label}`}
					disabled={disabled}
					className="inline-flex items-center gap-1 h-9 px-2 rounded-md border border-border bg-surface-2 text-text-primary hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus disabled:opacity-40"
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

export function ShortcutsSection({ fields, setField, disabled }: SettingsSectionProps): React.ReactElement {
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
		<section aria-labelledby="settings-command-shortcuts-heading" className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h3 id="settings-command-shortcuts-heading" className="text-base font-semibold text-text-primary m-0">
					Shell command shortcuts
				</h3>
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
					Add command
				</Button>
			</div>
			<p className="m-0 text-sm leading-6 text-text-secondary">
				Run shell commands from this project's top bar. These are separate from global prompt shortcuts, which send
				instructions to an agent. Command changes take effect after Save changes.
			</p>

			{fields.shortcuts.map((shortcut, shortcutIndex) => (
				<div
					key={shortcutIndex}
					role="group"
					aria-label={`Command shortcut ${shortcutIndex + 1}`}
					ref={(node) => {
						rowRefs.current[shortcutIndex] = node;
					}}
					className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-3 rounded-md border border-border p-3"
				>
					<ShortcutIconPicker
						value={shortcut.icon}
						disabled={disabled}
						onSelect={(icon) =>
							setField(
								"shortcuts",
								fields.shortcuts.map((item, itemIndex) =>
									itemIndex === shortcutIndex ? { ...item, icon } : item,
								),
							)
						}
					/>
					<label className="min-w-0 text-sm font-medium leading-6 text-text-primary">
						Button label
						<input
							name={`project-shortcut-label-${shortcutIndex}`}
							disabled={disabled}
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
							className="mt-1 h-9 w-full rounded-md border border-border bg-surface-2 px-2 text-sm font-normal text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-40"
						/>
					</label>
					<Button
						variant="ghost"
						size="sm"
						icon={<X size={14} />}
						aria-label={`Remove shortcut ${shortcut.label}`}
						disabled={disabled}
						className="col-start-3 row-start-1"
						onClick={() =>
							setField(
								"shortcuts",
								fields.shortcuts.filter((_, itemIndex) => itemIndex !== shortcutIndex),
							)
						}
					/>
					<label className="col-span-3 row-start-2 min-w-0 text-sm font-medium leading-6 text-text-primary">
						Shell command
						<input
							name={`project-shortcut-command-${shortcutIndex}`}
							disabled={disabled}
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
							className="mt-1 h-9 w-full rounded-md border border-border bg-surface-2 px-2 font-mono text-sm font-normal text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-40"
						/>
					</label>
				</div>
			))}
			{fields.shortcuts.length === 0 ? (
				<p className="m-0 text-sm leading-6 text-text-secondary">No shell command shortcuts configured.</p>
			) : null}
		</section>
	);
}
