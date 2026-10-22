import { type ReactElement, useCallback, useState } from "react";

import { TaskOptionSelector } from "@/components/task/task-option-selector";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeCodexOptions } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

interface TaskCodexOptionsProps {
	projectId: string | null;
	value: RuntimeCodexOptions | undefined;
	onValueChange: (value: RuntimeCodexOptions | undefined) => void;
	portalContainer?: HTMLElement | null;
}

export function TaskCodexOptions({
	projectId,
	value,
	onValueChange,
	portalContainer,
}: TaskCodexOptionsProps): ReactElement {
	const [localPortalContainer, setLocalPortalContainer] = useState<HTMLDivElement | null>(null);
	const queryFn = useCallback(() => getRuntimeTrpcClient(projectId).runtime.codexModels.query(), [projectId]);
	const { data, isLoading, isError } = useTrpcQuery({ enabled: true, queryFn });
	const models = data?.models ?? [];
	const selectedModel = models.find((model) => model.model === value?.model);
	const defaultOption = { value: "", label: "Codex default" };
	const resolvedPortalContainer = portalContainer ?? localPortalContainer;

	return (
		<div ref={setLocalPortalContainer} className="space-y-2">
			<div className="grid grid-cols-2 gap-2">
				<TaskOptionSelector
					label="Starting model"
					value={value?.model ?? ""}
					options={[defaultOption, ...models.map((model) => ({ value: model.model, label: model.displayName }))]}
					onSelect={(model) => onValueChange(model ? { model } : {})}
					portalContainer={resolvedPortalContainer}
				/>
				<TaskOptionSelector
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
						onValueChange({
							...(value?.model ? { model: value?.model } : {}),
							...(effort ? { reasoningEffort: effort } : {}),
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
			) : null}
		</div>
	);
}
