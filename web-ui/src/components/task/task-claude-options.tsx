import { CLAUDE_EFFORT_LEVELS, CLAUDE_MODEL_CHOICES } from "@runtime-contract";
import { type ReactElement, useState } from "react";

import { type TaskOptionChoice, TaskOptionSelector } from "@/components/task/task-option-selector";
import type { RuntimeClaudeEffort, RuntimeClaudeOptions } from "@/runtime/types";

interface TaskClaudeOptionsProps {
	value: RuntimeClaudeOptions | undefined;
	onValueChange: (value: RuntimeClaudeOptions | undefined) => void;
	portalContainer?: HTMLElement | null;
}

const DEFAULT_OPTION: TaskOptionChoice = { value: "", label: "Claude default" };

const EFFORT_LABELS: Record<RuntimeClaudeEffort, string> = {
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};

const MODEL_OPTIONS: TaskOptionChoice[] = [DEFAULT_OPTION, ...CLAUDE_MODEL_CHOICES];
const EFFORT_OPTIONS: TaskOptionChoice[] = [
	DEFAULT_OPTION,
	...CLAUDE_EFFORT_LEVELS.map((effort) => ({ value: effort, label: EFFORT_LABELS[effort] })),
];

function toClaudeEffort(value: string): RuntimeClaudeEffort | undefined {
	return CLAUDE_EFFORT_LEVELS.find((effort) => effort === value);
}

export function TaskClaudeOptions({ value, onValueChange, portalContainer }: TaskClaudeOptionsProps): ReactElement {
	const [localPortalContainer, setLocalPortalContainer] = useState<HTMLDivElement | null>(null);
	const resolvedPortalContainer = portalContainer ?? localPortalContainer;

	return (
		<div ref={setLocalPortalContainer} className="grid grid-cols-2 gap-2">
			<TaskOptionSelector
				label="Starting model"
				value={value?.model ?? ""}
				options={MODEL_OPTIONS}
				onSelect={(model) =>
					onValueChange({
						...(model ? { model } : {}),
						...(value?.effort ? { effort: value.effort } : {}),
					})
				}
				portalContainer={resolvedPortalContainer}
			/>
			<TaskOptionSelector
				label="Effort level"
				value={value?.effort ?? ""}
				options={EFFORT_OPTIONS}
				onSelect={(selected) => {
					const effort = toClaudeEffort(selected);
					onValueChange({
						...(value?.model ? { model: value.model } : {}),
						...(effort ? { effort } : {}),
					});
				}}
				portalContainer={resolvedPortalContainer}
			/>
		</div>
	);
}
