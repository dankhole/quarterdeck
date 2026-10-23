import { runtimeOpencodeOptionsSchema } from "@runtime-contract";
import { type ReactElement, useCallback, useState } from "react";

import { type TaskOptionChoice, TaskOptionSelector } from "@/components/task/task-option-selector";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeOpencodeOptions } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

interface TaskOpencodeOptionsProps {
	projectId: string | null;
	value: RuntimeOpencodeOptions | undefined;
	onValueChange: (value: RuntimeOpencodeOptions | undefined) => void;
	portalContainer?: HTMLElement | null;
}

const DEFAULT_OPTION: TaskOptionChoice = { value: "", label: "opencode default" };
const CUSTOM_MODEL_OPTION_VALUE = "__custom_model__";
const CUSTOM_MODEL_OPTION: TaskOptionChoice = { value: CUSTOM_MODEL_OPTION_VALUE, label: "Custom model…" };

function isValidOpencodeModelId(candidate: string): boolean {
	return runtimeOpencodeOptionsSchema.shape.model.safeParse(candidate).success;
}

export function TaskOpencodeOptions({
	projectId,
	value,
	onValueChange,
	portalContainer,
}: TaskOpencodeOptionsProps): ReactElement {
	const [localPortalContainer, setLocalPortalContainer] = useState<HTMLDivElement | null>(null);
	const resolvedPortalContainer = portalContainer ?? localPortalContainer;
	const queryFn = useCallback(() => getRuntimeTrpcClient(projectId).runtime.opencodeCatalog.query(), [projectId]);
	const { data, isLoading, isError } = useTrpcQuery({ enabled: true, queryFn });
	const models = data?.models ?? [];
	const agents = data?.agents ?? [];

	// Explicit "Custom model…" selection, independent of whether the current model happens to
	// match a catalog entry. Cleared whenever the user picks Default or a concrete catalog model.
	const [customModeOverride, setCustomModeOverride] = useState(false);
	const modelInCatalog = value?.model ? models.some((model) => model.id === value.model) : false;
	const isCustomModelMode = customModeOverride || (Boolean(value?.model) && !modelInCatalog);

	const commitModel = useCallback(
		(model: string | undefined) => {
			onValueChange({
				...(value?.agent ? { agent: value.agent } : {}),
				...(model ? { model } : {}),
			});
		},
		[onValueChange, value?.agent],
	);

	const commitAgent = useCallback(
		(agent: string | undefined) => {
			onValueChange({
				...(agent ? { agent } : {}),
				...(value?.model ? { model: value.model } : {}),
			});
		},
		[onValueChange, value?.model],
	);

	const agentUnknownToCatalog = value?.agent && !agents.some((agent) => agent.name === value.agent);
	const agentOptions: TaskOptionChoice[] = [
		DEFAULT_OPTION,
		...agents.map((agent) => ({ value: agent.name, label: agent.name })),
		...(agentUnknownToCatalog ? [{ value: value.agent as string, label: value.agent as string }] : []),
	];

	const sortedModels = [...models].sort((a, b) => a.id.localeCompare(b.id));
	const modelOptions: TaskOptionChoice[] = [
		DEFAULT_OPTION,
		...sortedModels.map((model) => ({ value: model.id, label: `${model.providerId} / ${model.modelId}` })),
		CUSTOM_MODEL_OPTION,
	];
	const modelSelectValue = isCustomModelMode ? CUSTOM_MODEL_OPTION_VALUE : (value?.model ?? "");

	const hasCatalogError = isError || (!isLoading && Boolean(data) && models.length === 0 && agents.length === 0);

	return (
		<div ref={setLocalPortalContainer} className="space-y-2">
			<div className="grid grid-cols-2 gap-2">
				<TaskOptionSelector
					label="Agent"
					value={value?.agent ?? ""}
					options={agentOptions}
					onSelect={(selected) => commitAgent(selected || undefined)}
					portalContainer={resolvedPortalContainer}
				/>
				<div className="min-w-0">
					<TaskOptionSelector
						label="Starting model"
						value={modelSelectValue}
						options={modelOptions}
						onSelect={(selected) => {
							if (selected === CUSTOM_MODEL_OPTION_VALUE) {
								setCustomModeOverride(true);
								return;
							}
							setCustomModeOverride(false);
							commitModel(selected || undefined);
						}}
						portalContainer={resolvedPortalContainer}
					/>
					{isCustomModelMode ? (
						<input
							type="text"
							value={value?.model ?? ""}
							onChange={(event) => {
								const nextValue = event.currentTarget.value;
								if (nextValue === "") {
									commitModel(undefined);
									return;
								}
								if (isValidOpencodeModelId(nextValue)) {
									commitModel(nextValue);
								}
							}}
							placeholder="provider/model"
							aria-label="Custom starting model"
							className="mt-1.5 h-8 w-full rounded-md border border-border-bright bg-surface-2 px-2.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
						/>
					) : null}
				</div>
			</div>
			{isLoading ? <p className="text-[11px] text-text-secondary">Loading opencode models and agents…</p> : null}
			{hasCatalogError ? (
				<p role="status" className="text-[11px] text-text-secondary">
					Model and agent choices are unavailable. You can still start with opencode default, or enter a custom
					model above.
				</p>
			) : null}
		</div>
	);
}
