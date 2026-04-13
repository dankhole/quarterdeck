// Reusable form controls for the settings dialog.
import * as RadixCheckbox from "@radix-ui/react-checkbox";
import * as RadixSwitch from "@radix-ui/react-switch";
import { Check } from "lucide-react";

import { cn } from "@/components/ui/cn";

export function SettingsSwitch({
	checked,
	onCheckedChange,
	disabled,
	label,
	description,
	className,
}: {
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	disabled: boolean;
	label: React.ReactNode;
	description?: React.ReactNode;
	className?: string;
}): React.ReactElement {
	return (
		<>
			<div className={cn("flex items-center gap-2", className)}>
				<RadixSwitch.Root
					checked={checked}
					disabled={disabled}
					onCheckedChange={onCheckedChange}
					className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer disabled:opacity-40"
				>
					<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
				</RadixSwitch.Root>
				<span className="text-[13px] text-text-primary">{label}</span>
			</div>
			{description != null ? <p className="text-text-secondary text-[13px] mt-1 mb-0">{description}</p> : null}
		</>
	);
}

export function SettingsCheckbox({
	id,
	checked,
	onCheckedChange,
	disabled,
	className,
}: {
	id?: string;
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	disabled: boolean;
	className?: string;
}): React.ReactElement {
	return (
		<RadixCheckbox.Root
			id={id}
			checked={checked}
			disabled={disabled}
			onCheckedChange={(v) => onCheckedChange(v === true)}
			className={cn(
				"flex h-4 w-4 cursor-pointer items-center justify-center rounded border border-border bg-surface-2 data-[state=checked]:bg-accent data-[state=checked]:border-accent disabled:cursor-default disabled:opacity-40",
				className,
			)}
		>
			<RadixCheckbox.Indicator>
				<Check size={12} className="text-white" />
			</RadixCheckbox.Indicator>
		</RadixCheckbox.Root>
	);
}
