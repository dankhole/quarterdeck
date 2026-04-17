export const QUARTERDECK_HOOK_TASK_ID_ENV = "QUARTERDECK_HOOK_TASK_ID";
export const QUARTERDECK_HOOK_WORKSPACE_ID_ENV = "QUARTERDECK_HOOK_WORKSPACE_ID";

export interface HookRuntimeContext {
	taskId: string;
	projectId: string;
}

function requireTrimmedEnv(env: NodeJS.ProcessEnv, key: string): string {
	const value = env[key]?.trim();
	if (!value) {
		throw new Error(`Missing required environment variable: ${key}`);
	}
	return value;
}

export function createHookRuntimeEnv(context: HookRuntimeContext): Record<string, string> {
	return {
		[QUARTERDECK_HOOK_TASK_ID_ENV]: context.taskId,
		[QUARTERDECK_HOOK_WORKSPACE_ID_ENV]: context.projectId,
	};
}

export function parseHookRuntimeContextFromEnv(env: NodeJS.ProcessEnv = process.env): HookRuntimeContext {
	const taskId = requireTrimmedEnv(env, QUARTERDECK_HOOK_TASK_ID_ENV);
	const projectId = requireTrimmedEnv(env, QUARTERDECK_HOOK_WORKSPACE_ID_ENV);
	return {
		taskId,
		projectId,
	};
}
