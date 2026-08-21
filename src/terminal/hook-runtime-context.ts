export const QUARTERDECK_HOOK_TASK_ID_ENV = "QUARTERDECK_HOOK_TASK_ID";
export const QUARTERDECK_HOOK_PROJECT_ID_ENV = "QUARTERDECK_HOOK_PROJECT_ID";
export const QUARTERDECK_HOOK_SESSION_INSTANCE_ID_ENV = "QUARTERDECK_HOOK_SESSION_INSTANCE_ID";

export interface HookRuntimeContext {
	taskId: string;
	projectId: string;
	sessionInstanceId?: string | null;
}

function requireTrimmedEnv(env: NodeJS.ProcessEnv, key: string): string {
	const value = env[key]?.trim();
	if (!value) {
		throw new Error(`Missing required environment variable: ${key}`);
	}
	return value;
}

export function createHookRuntimeEnv(context: HookRuntimeContext): Record<string, string> {
	const env = {
		[QUARTERDECK_HOOK_TASK_ID_ENV]: context.taskId,
		[QUARTERDECK_HOOK_PROJECT_ID_ENV]: context.projectId,
	};
	const sessionInstanceId = context.sessionInstanceId?.trim();
	return sessionInstanceId
		? {
				...env,
				[QUARTERDECK_HOOK_SESSION_INSTANCE_ID_ENV]: sessionInstanceId,
			}
		: env;
}

export function parseHookRuntimeContextFromEnv(env: NodeJS.ProcessEnv = process.env): HookRuntimeContext {
	const taskId = requireTrimmedEnv(env, QUARTERDECK_HOOK_TASK_ID_ENV);
	const projectId = requireTrimmedEnv(env, QUARTERDECK_HOOK_PROJECT_ID_ENV);
	return {
		taskId,
		projectId,
		sessionInstanceId: env[QUARTERDECK_HOOK_SESSION_INSTANCE_ID_ENV]?.trim() || null,
	};
}
