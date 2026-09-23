import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as RadixSwitch from "@radix-ui/react-switch";
import { Check, ChevronDown } from "lucide-react";
import { type ReactElement, useCallback, useId, useState } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeCodexOptions } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

interface TaskCodexOptionsProps {
	projectId: string | null;
	value: RuntimeCodexOptions | undefined;
	onValueChange: (value: RuntimeCodexOptions | undefined) => void;
	portalContainer?: HTMLElement | null;
	harnessSelector?: ReactElement;
}

interface Option {
	value: string;
	label: string;
	description?: string;
}

function OptionSelector({
	label,
	value,
	options,
	disabled,
	onSelect,
	portalContainer,
}: {
	label: string;
	value: string;
	options: Option[];
	disabled?: boolean;
	onSelect: (value: string) => void;
	portalContainer: HTMLElement | null;
}): ReactElement {
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

export function TaskCodexOptions({
	projectId,
	value,
	onValueChange,
	portalContainer,
	harnessSelector,
}: TaskCodexOptionsProps): ReactElement {
	const [localPortalContainer, setLocalPortalContainer] = useState<HTMLDivElement | null>(null);
	const queryFn = useCallback(() => getRuntimeTrpcClient(projectId).runtime.codexModels.query(), [projectId]);
	const overrideId = useId();
	const overrideEnabled = value !== undefined;
	const { data, isLoading, isError } = useTrpcQuery({ enabled: overrideEnabled, queryFn });
	const models = data?.models ?? [];
	const selectedModel = models.find((model) => model.model === value?.model);
	const defaultOption = { value: "", label: "Codex default" };
	const resolvedPortalContainer = portalContainer ?? localPortalContainer;

	return (
		<div ref={setLocalPortalContainer} className="space-y-2">
			<div className="flex flex-wrap items-end justify-between gap-3">
				{harnessSelector}
				<label
					htmlFor={overrideId}
					className="flex h-8 shrink-0 cursor-pointer items-center gap-2 text-[12px] text-text-primary"
				>
					<RadixSwitch.Root
						id={overrideId}
						checked={overrideEnabled}
						onCheckedChange={(checked) => onValueChange(checked ? {} : undefined)}
						className="relative h-5 w-9 shrink-0 cursor-pointer rounded-full bg-surface-4 data-[state=checked]:bg-accent"
					>
						<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
					</RadixSwitch.Root>
					Override Codex settings
				</label>
			</div>
			{overrideEnabled ? (
				<>
					<div className="grid grid-cols-2 gap-2">
						<OptionSelector
							label="Starting model"
							value={value?.model ?? ""}
							options={[
								defaultOption,
								...models.map((model) => ({ value: model.model, label: model.displayName })),
							]}
							onSelect={(model) => onValueChange(model ? { model } : {})}
							portalContainer={resolvedPortalContainer}
						/>
						<OptionSelector
							label="Reasoning level"
							value={value?.reasoningEffort ?? ""}
							options={[
								defaultOption,
								...(selectedModel?.supportedReasoningEfforts.map((effort) => ({
									value: effort.reasoningEffort,
									label: effort.reasoningEffort.charAt(0).toUpperCase() + effort.reasoningEffort.slice(1),
									description: effort.description,
								})) ?? []),
							]}
							disabled={!selectedModel && !value?.reasoningEffort}
							onSelect={(effort) => {
								const supported = selectedModel?.supportedReasoningEfforts.find(
									(item) => item.reasoningEffort === effort,
								);
								onValueChange({
									...(value?.model ? { model: value?.model } : {}),
									...(supported ? { reasoningEffort: supported.reasoningEffort } : {}),
								});
							}}
							portalContainer={resolvedPortalContainer}
						/>
					</div>
					{isLoading ? <p className="text-[11px] text-text-secondary">Loading Codex models…</p> : null}
					{isError || (!isLoading && data && models.length === 0) ? (
						<p role="status" className="text-[11px] text-text-secondary">
							Model choices are unavailable. You can still start with Codex default.
						</p>
					) : !value?.model ? (
						<p className="text-[11px] text-text-secondary">Choose a model to select its reasoning level.</p>
					) : null}
				</>
			) : null}
		</div>
	);
}
