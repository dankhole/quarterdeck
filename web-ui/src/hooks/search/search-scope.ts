import type { RuntimeWorkdirSearchScope } from "@/runtime/types";

export type WorkdirSearchScope = Required<Pick<RuntimeWorkdirSearchScope, "taskId">> &
	Omit<RuntimeWorkdirSearchScope, "taskId">;

export const DEFAULT_WORKDIR_SEARCH_SCOPE: WorkdirSearchScope = { taskId: null };

export function createWorkdirSearchScope(input: RuntimeWorkdirSearchScope): WorkdirSearchScope {
	return {
		taskId: input.taskId ?? null,
		...(input.baseRef ? { baseRef: input.baseRef } : {}),
		...(input.ref ? { ref: input.ref } : {}),
	};
}
