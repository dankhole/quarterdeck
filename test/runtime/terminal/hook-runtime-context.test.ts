import { describe, expect, it } from "vitest";

import {
	createHookRuntimeEnv,
	parseHookRuntimeContextFromEnv,
	QUARTERDECK_HOOK_PROJECT_ID_ENV,
	QUARTERDECK_HOOK_SESSION_INSTANCE_ID_ENV,
	QUARTERDECK_HOOK_TASK_ID_ENV,
} from "../../../src/terminal";

describe("hook-runtime-context", () => {
	it("creates expected environment variables", () => {
		const env = createHookRuntimeEnv({
			taskId: "task-1",
			projectId: "project-1",
			sessionInstanceId: "process-1",
		});
		expect(env).toEqual({
			[QUARTERDECK_HOOK_TASK_ID_ENV]: "task-1",
			[QUARTERDECK_HOOK_PROJECT_ID_ENV]: "project-1",
			[QUARTERDECK_HOOK_SESSION_INSTANCE_ID_ENV]: "process-1",
		});
	});

	it("parses hook runtime context from env", () => {
		const parsed = parseHookRuntimeContextFromEnv({
			[QUARTERDECK_HOOK_TASK_ID_ENV]: "task-2",
			[QUARTERDECK_HOOK_PROJECT_ID_ENV]: "project-2",
			[QUARTERDECK_HOOK_SESSION_INSTANCE_ID_ENV]: "process-2",
		});
		expect(parsed).toEqual({
			taskId: "task-2",
			projectId: "project-2",
			sessionInstanceId: "process-2",
		});
	});

	it("keeps session identity optional for legacy launch contexts", () => {
		expect(
			parseHookRuntimeContextFromEnv({
				[QUARTERDECK_HOOK_TASK_ID_ENV]: "task-legacy",
				[QUARTERDECK_HOOK_PROJECT_ID_ENV]: "project-legacy",
			}),
		).toEqual({
			taskId: "task-legacy",
			projectId: "project-legacy",
			sessionInstanceId: null,
		});
	});

	it("throws when required env vars are missing", () => {
		expect(() => parseHookRuntimeContextFromEnv({})).toThrow(
			`Missing required environment variable: ${QUARTERDECK_HOOK_TASK_ID_ENV}`,
		);
	});
});
