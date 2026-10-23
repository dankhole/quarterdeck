import { PI_THINKING_LEVELS, runtimePiOptionsSchema } from "@runtime-contract";
import { type ReactElement, useCallback, useState } from "react";

import { TaskOptionSelector } from "@/components/task/task-option-selector";
import { fetchPiModels, getCachedPiModels } from "@/runtime/pi-model-query";
import type { RuntimePiOptions } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

interface TaskPiOptionsProps {
	projectId: string | null;
	value: RuntimePiOptions | undefined;
	onValueChange: (value: RuntimePiOptions | undefined) => void;
	portalContainer?: HTMLElement | null;
}

export function TaskPiOptions({ projectId, value, onValueChange, portalContainer }: TaskPiOptionsProps): ReactElement {
	const [localPortalContainer, setLocalPortalContainer] = useState<HTMLDivElement | null>(null);
	const queryFn = useCallback(
		async () => ({ projectId, catalog: projectId === null ? null : await fetchPiModels(projectId) }),
		[projectId],
	);
	const { data, isLoading, isError } = useTrpcQuery({ enabled: projectId !== null, queryFn });
	const catalog = (data?.projectId === projectId ? data?.catalog : null) ?? getCachedPiModels(projectId);
	const models = catalog?.models ?? [];
	const resolvedPortalContainer = portalContainer ?? localPortalContainer;
	return (
		<div ref={setLocalPortalContainer} className="space-y-2">
			<TaskOptionSelector
				label="Starting model"
				searchable
				value={value?.model ? `${value.model.provider}/${value.model.id}` : ""}
				options={[
					{ value: "", label: "Pi default" },
					...models.map((model) => ({
						value: `${model.provider}/${model.id}`,
						label: `${model.provider}/${model.id}`,
					})),
				]}
				onSelect={(selected) => {
					const model = models.find((model) => `${model.provider}/${model.id}` === selected);
					const next = {
						...(model ? { model } : {}),
						...(value?.thinkingLevel ? { thinkingLevel: value.thinkingLevel } : {}),
					};
					onValueChange(Object.keys(next).length ? next : undefined);
				}}
				portalContainer={resolvedPortalContainer}
			/>
			<TaskOptionSelector
				label="Thinking level"
				value={value?.thinkingLevel ?? ""}
				options={[
					{ value: "", label: "Pi default" },
					...PI_THINKING_LEVELS.map((level) => ({ value: level, label: level })),
				]}
				onSelect={(thinkingLevel) => {
					const next = runtimePiOptionsSchema.parse({
						...(value?.model ? { model: value.model } : {}),
						...(thinkingLevel ? { thinkingLevel } : {}),
					});
					onValueChange(Object.keys(next).length ? next : undefined);
				}}
				portalContainer={resolvedPortalContainer}
			/>
			{isLoading && !catalog ? <p className="text-[11px] text-text-secondary">Loading Pi models…</p> : null}
			{isError || (!isLoading && models.length === 0) ? (
				<p role="status" className="text-[11px] text-text-secondary">
					Model choices are unavailable. You can still start with Pi default.
				</p>
			) : null}
			<p className="text-[11px] text-text-secondary">
				Extension-defined models may be absent. Use Pi default or Pi’s /model selector for those models.
			</p>
		</div>
	);
}
