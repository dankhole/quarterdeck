export const QUARTERDECK_HOOK_TASK_ID_ENV = "QUARTERDECK_HOOK_TASK_ID";
export const QUARTERDECK_HOOK_PROJECT_ID_ENV = "QUARTERDECK_HOOK_PROJECT_ID";
export const QUARTERDECK_HOOK_SESSION_INSTANCE_ID_ENV = "QUARTERDECK_HOOK_SESSION_INSTANCE_ID";
/** Runtime-prepared Windows outbox identity; never inherit this from another launch. */
export const QUARTERDECK_HOOK_PRIVATE_OUTBOX_ENV = "QUARTERDECK_HOOK_PRIVATE_OUTBOX";

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

export function createHookRuntimeEnv(
	context: HookRuntimeContext,
	privateOutboxCapability?: string,
): Record<string, string | undefined> {
	const env = {
		[QUARTERDECK_HOOK_TASK_ID_ENV]: context.taskId,
		[QUARTERDECK_HOOK_PROJECT_ID_ENV]: context.projectId,
		// Keep an explicit invalid value through every Windows merge, including
		// the final PTY spawn, so process.env cannot resurrect an inherited proof.
		[QUARTERDECK_HOOK_PRIVATE_OUTBOX_ENV]: privateOutboxCapability ?? "",
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
