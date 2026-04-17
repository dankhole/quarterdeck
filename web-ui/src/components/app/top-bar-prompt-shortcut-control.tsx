import * as RadixPopover from "@radix-ui/react-popover";
import { Check, ChevronDown, MessageSquare, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import type { PromptShortcut } from "@/runtime/types";

export function TopBarPromptShortcutControl({
	selectedTaskId,
	promptShortcuts,
	activePromptShortcut,
	onSelectPromptShortcutLabel,
	isPromptShortcutRunning,
	onRunPromptShortcut,
	onManagePromptShortcuts,
}: {
	selectedTaskId?: string | null;
	promptShortcuts?: PromptShortcut[];
	activePromptShortcut?: PromptShortcut | null;
	onSelectPromptShortcutLabel?: (label: string) => void;
	isPromptShortcutRunning?: boolean;
	onRunPromptShortcut?: (taskId: string, shortcutLabel: string) => void;
	onManagePromptShortcuts?: () => void;
}): React.ReactElement | null {
	const promptShortcutItems = promptShortcuts ?? [];

	if (!selectedTaskId || !activePromptShortcut || !onRunPromptShortcut) {
		return null;
	}

	return (
		<div className="flex ml-1">
			<Button
				variant="default"
				size="sm"
				icon={isPromptShortcutRunning ? <Spinner size={12} /> : <MessageSquare size={14} />}
				disabled={isPromptShortcutRunning}
				onClick={() => onRunPromptShortcut(selectedTaskId, activePromptShortcut.label)}
				className="text-xs rounded-r-none kb-navbar-btn"
			>
				{activePromptShortcut.label}
			</Button>
			<RadixPopover.Root>
				<RadixPopover.Trigger asChild>
					<Button
						size="sm"
						variant="default"
						icon={<ChevronDown size={12} />}
						aria-label="Select prompt shortcut"
						disabled={isPromptShortcutRunning}
						className="rounded-l-none border-l-0 kb-navbar-btn"
						style={{ width: 24, paddingLeft: 0, paddingRight: 0 }}
					/>
				</RadixPopover.Trigger>
				<RadixPopover.Portal>
					<RadixPopover.Content
						className="z-50 rounded-lg border border-border bg-surface-2 p-1 shadow-xl"
						style={{ animation: "kb-tooltip-show 100ms ease" }}
						sideOffset={5}
						align="end"
					>
						<div className="min-w-[180px]">
							{promptShortcutItems.map((shortcut, shortcutIndex) => {
								const isActive = shortcut.label === activePromptShortcut.label;
								return (
									<button
										type="button"
										key={`${shortcut.label}:${shortcutIndex}`}
										className={cn(
											"flex w-full items-center gap-2 px-2.5 py-1.5 text-[13px] text-text-primary rounded-md hover:bg-surface-3 text-left",
											isActive && "bg-surface-3",
										)}
										onClick={() => onSelectPromptShortcutLabel?.(shortcut.label)}
									>
										<MessageSquare size={14} />
										<span className="flex-1">{shortcut.label}</span>
										{isActive ? <Check size={14} className="text-text-secondary" /> : null}
									</button>
								);
							})}
							{onManagePromptShortcuts ? (
								<>
									<div className="h-px bg-border my-1" />
									<button
										type="button"
										className="flex w-full items-center gap-2 px-2.5 py-1.5 text-[13px] text-text-primary rounded-md hover:bg-surface-3 text-left"
										onClick={onManagePromptShortcuts}
									>
										<Settings size={14} />
										<span>Manage shortcuts...</span>
									</button>
								</>
							) : null}
						</div>
					</RadixPopover.Content>
				</RadixPopover.Portal>
			</RadixPopover.Root>
		</div>
	);
}
