import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Bot, Check, ChevronDown, CircleAlert } from "lucide-react";
import { type ReactElement, useState } from "react";

import { cn } from "@/components/ui/cn";
import type { RuntimeAgentId } from "@/runtime/types";
import {
	getTaskAgentDisplayLabel,
	sortTaskAgentOptions,
	type TaskAgentDisplayOption,
} from "@/utils/task-agent-display";

interface TaskAgentSelectorProps {
	agents: readonly TaskAgentDisplayOption[];
	value: RuntimeAgentId;
	onValueChange: (value: RuntimeAgentId) => void;
	disabled?: boolean;
	portalContainer?: HTMLElement | null;
}

function getFallbackAgentOptions(selectedAgentId: RuntimeAgentId): TaskAgentDisplayOption[] {
	return sortTaskAgentOptions([
		{
			id: "claude",
			label: getTaskAgentDisplayLabel("claude"),
			installed: selectedAgentId === "claude" ? null : false,
		},
		{
			id: "codex",
			label: getTaskAgentDisplayLabel("codex"),
			installed: selectedAgentId === "codex" ? null : false,
		},
		{
			id: "pi",
			label: getTaskAgentDisplayLabel("pi"),
			installed: selectedAgentId === "pi" ? null : false,
		},
	]);
}

export function TaskAgentSelector({
	agents,
	value,
	onValueChange,
	disabled = false,
	portalContainer,
}: TaskAgentSelectorProps): ReactElement {
	const [localPortalContainer, setLocalPortalContainer] = useState<HTMLDivElement | null>(null);
	const resolvedPortalContainer = portalContainer ?? localPortalContainer;
	const options = sortTaskAgentOptions(agents.length > 0 ? agents : getFallbackAgentOptions(value));
	const selectedAgent =
		options.find((agent) => agent.id === value) ??
		({
			id: value,
			label: getTaskAgentDisplayLabel(value),
			installed: null,
		} satisfies TaskAgentDisplayOption);
	const selectedUnavailable = selectedAgent.installed === false;

	return (
		<div ref={setLocalPortalContainer} className="w-full">
			<DropdownMenu.Root modal={false}>
				<DropdownMenu.Trigger asChild>
					<button
						type="button"
						disabled={disabled}
						className={cn(
							"flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border-bright bg-surface-2 px-2.5 text-left text-[12px] text-text-primary hover:bg-surface-3 disabled:cursor-default disabled:opacity-40",
							selectedUnavailable && "border-status-orange/40 text-status-orange",
						)}
						aria-label="Task harness"
					>
						<span className="flex min-w-0 items-center gap-2">
							<Bot size={14} className={selectedUnavailable ? "text-status-orange" : "text-text-secondary"} />
							<span className="truncate">{selectedAgent.label}</span>
							{selectedAgent.id === "pi" ? (
								<span className="rounded bg-status-orange/10 px-1.5 py-0.5 text-[10px] font-medium text-status-orange">
									Experimental
								</span>
							) : null}
						</span>
						<ChevronDown size={14} className="shrink-0 text-text-secondary" />
					</button>
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal container={resolvedPortalContainer}>
					<DropdownMenu.Content
						side="bottom"
						align="start"
						sideOffset={4}
						className="z-50 min-w-[260px] rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg"
						onCloseAutoFocus={(event) => event.preventDefault()}
					>
						{options.map((agent) => {
							const isSelected = agent.id === value;
							const isUnavailable = agent.installed === false;
							const statusText =
								agent.statusMessage ??
								(isUnavailable ? "Not available on PATH" : agent.command || agent.binary || null);
							return (
								<DropdownMenu.Item
									key={agent.id}
									disabled={isUnavailable || disabled}
									onSelect={() => onValueChange(agent.id)}
									className={cn(
										"flex min-w-0 items-start justify-between gap-3 rounded-sm px-2 py-1.5 text-[12px] text-text-primary outline-none data-[highlighted]:bg-surface-3",
										isUnavailable ? "cursor-default opacity-55" : "cursor-pointer",
									)}
								>
									<span className="flex min-w-0 items-start gap-2">
										{isUnavailable ? (
											<CircleAlert size={14} className="mt-0.5 shrink-0 text-status-orange" />
										) : (
											<Bot size={14} className="mt-0.5 shrink-0 text-text-secondary" />
										)}
										<span className="min-w-0">
											<span className="flex flex-wrap items-center gap-1.5">
												<span className="font-medium">{agent.label}</span>
												{agent.id === "pi" ? (
													<span className="rounded bg-status-orange/10 px-1.5 py-0.5 text-[10px] font-medium text-status-orange">
														Experimental
													</span>
												) : null}
											</span>
											{statusText ? (
												<span
													className={cn(
														"mt-0.5 block truncate text-[11px]",
														isUnavailable ? "text-status-orange" : "font-mono text-text-secondary",
													)}
												>
													{statusText}
												</span>
											) : null}
										</span>
									</span>
									{isSelected ? <Check size={14} className="mt-0.5 shrink-0 text-accent" /> : null}
								</DropdownMenu.Item>
							);
						})}
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
		</div>
	);
}
