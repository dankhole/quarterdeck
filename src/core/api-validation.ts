import { z } from "zod";

import {
	type RuntimeCommandRunRequest,
	type RuntimeConfigSaveRequest,
	type RuntimeGitCheckoutRequest,
	type RuntimeHookIngestRequest,
	type RuntimeProjectAddRequest,
	type RuntimeProjectRemoveRequest,
	type RuntimeProjectReorderRequest,
	type RuntimeProjectStateSaveRequest,
	type RuntimeShellSessionStartRequest,
	type RuntimeTaskSessionInputRequest,
	type RuntimeTaskSessionStartRequest,
	type RuntimeTaskSessionStopRequest,
	type RuntimeTaskWorktreeInfoRequest,
	type RuntimeTerminalWsClientMessage,
	type RuntimeWorktreeDeleteRequest,
	type RuntimeWorktreeEnsureRequest,
	runtimeCommandRunRequestSchema,
	runtimeConfigSaveRequestSchema,
	runtimeGitCheckoutRequestSchema,
	runtimeHookIngestRequestSchema,
	runtimeProjectAddRequestSchema,
	runtimeProjectRemoveRequestSchema,
	runtimeProjectReorderRequestSchema,
	runtimeProjectStateSaveRequestSchema,
	runtimeShellSessionStartRequestSchema,
	runtimeTaskSessionInputRequestSchema,
	runtimeTaskSessionStartRequestSchema,
	runtimeTaskSessionStopRequestSchema,
	runtimeTaskWorktreeInfoRequestSchema,
	runtimeTerminalWsClientMessageSchema,
	runtimeWorktreeDeleteRequestSchema,
	runtimeWorktreeEnsureRequestSchema,
} from "./api-contract";

const trimmedStringSchema = z.string().transform((value) => value.trim());
const requiredTrimmedStringSchema = (message: string) => trimmedStringSchema.pipe(z.string().min(1, message));

function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new Error(parsed.error.issues[0]?.message ?? "Invalid request payload.");
	}
	return parsed.data;
}

export function parseTaskWorktreeInfoRequest(query: URLSearchParams): RuntimeTaskWorktreeInfoRequest {
	const taskId = parseWithSchema(
		requiredTrimmedStringSchema("Missing taskId query parameter."),
		query.get("taskId") ?? "",
	);
	const baseRef = parseWithSchema(
		requiredTrimmedStringSchema("Missing baseRef query parameter."),
		query.get("baseRef") ?? "",
	);
	return parseWithSchema(runtimeTaskWorktreeInfoRequestSchema, { taskId, baseRef });
}

export function parseGitCheckoutRequest(value: unknown): RuntimeGitCheckoutRequest {
	const parsed = parseWithSchema(runtimeGitCheckoutRequestSchema, value);
	const branch = parsed.branch.trim();
	if (!branch) {
		throw new Error("Branch cannot be empty.");
	}
	return {
		branch,
	};
}

export function parseWorktreeEnsureRequest(value: unknown): RuntimeWorktreeEnsureRequest {
	const parsed = parseWithSchema(runtimeWorktreeEnsureRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Invalid worktree ensure payload.");
	}
	const baseRef = parsed.baseRef.trim();
	if (!baseRef) {
		throw new Error("Invalid worktree ensure payload.");
	}
	return {
		taskId,
		baseRef,
		branch: parsed.branch,
	};
}

export function parseWorktreeDeleteRequest(value: unknown): RuntimeWorktreeDeleteRequest {
	const parsed = parseWithSchema(runtimeWorktreeDeleteRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Invalid worktree delete payload.");
	}
	return {
		taskId,
	};
}

export function parseProjectStateSaveRequest(value: unknown): RuntimeProjectStateSaveRequest {
	return parseWithSchema(runtimeProjectStateSaveRequestSchema, value);
}

export function parseProjectAddRequest(value: unknown): RuntimeProjectAddRequest {
	const parsed = parseWithSchema(runtimeProjectAddRequestSchema, value);
	const path = parsed.path.trim();
	if (!path) {
		throw new Error("Project path cannot be empty.");
	}
	return {
		path,
		initializeGit: parsed.initializeGit,
	};
}

export function parseProjectRemoveRequest(value: unknown): RuntimeProjectRemoveRequest {
	const parsed = parseWithSchema(runtimeProjectRemoveRequestSchema, value);
	const projectId = parsed.projectId.trim();
	if (!projectId) {
		throw new Error("Project ID cannot be empty.");
	}
	return {
		projectId,
	};
}

export function parseProjectReorderRequest(value: unknown): RuntimeProjectReorderRequest {
	const parsed = parseWithSchema(runtimeProjectReorderRequestSchema, value);
	const projectOrder = parsed.projectOrder.map((id) => id.trim()).filter((id) => id.length > 0);
	if (projectOrder.length === 0) {
		throw new Error("Project order cannot be empty.");
	}
	return {
		projectOrder,
	};
}

export function parseRuntimeConfigSaveRequest(value: unknown): RuntimeConfigSaveRequest {
	return parseWithSchema(runtimeConfigSaveRequestSchema, value);
}

export function parseCommandRunRequest(value: unknown): RuntimeCommandRunRequest {
	const parsed = parseWithSchema(runtimeCommandRunRequestSchema, value);
	const command = parsed.command.trim();
	if (!command) {
		throw new Error("Command cannot be empty.");
	}
	return {
		command,
	};
}

export function parseTaskSessionStartRequest(value: unknown): RuntimeTaskSessionStartRequest {
	const parsed = parseWithSchema(runtimeTaskSessionStartRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task session taskId cannot be empty.");
	}
	const baseRef = parsed.baseRef.trim();
	if (!baseRef) {
		throw new Error("Task session baseRef cannot be empty.");
	}
	return {
		...parsed,
		taskId,
		baseRef,
	};
}

export function parseTaskSessionStopRequest(value: unknown): RuntimeTaskSessionStopRequest {
	const parsed = parseWithSchema(runtimeTaskSessionStopRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Invalid task session stop payload.");
	}
	return {
		taskId,
	};
}

export function parseTaskSessionInputRequest(value: unknown): RuntimeTaskSessionInputRequest {
	const parsed = parseWithSchema(runtimeTaskSessionInputRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task session taskId cannot be empty.");
	}
	return {
		...parsed,
		taskId,
	};
}

export function parseShellSessionStartRequest(value: unknown): RuntimeShellSessionStartRequest {
	const parsed = parseWithSchema(runtimeShellSessionStartRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Shell session taskId cannot be empty.");
	}
	if (parsed.projectTaskId !== undefined && !parsed.projectTaskId.trim()) {
		throw new Error("Invalid shell session projectTaskId.");
	}
	const projectTaskId = parsed.projectTaskId?.trim() || undefined;
	const baseRef = parsed.baseRef.trim();
	if (!baseRef) {
		throw new Error("Shell session baseRef cannot be empty.");
	}
	return {
		...parsed,
		taskId,
		projectTaskId,
		baseRef,
	};
}

export function parseHookIngestRequest(value: unknown): RuntimeHookIngestRequest {
	const parsed = parseWithSchema(runtimeHookIngestRequestSchema, value);
	const taskId = parsed.taskId.trim();
	const projectId = parsed.projectId.trim();
	if (!taskId) {
		throw new Error("Missing taskId");
	}
	if (!projectId) {
		throw new Error("Missing projectId");
	}
	const metadata = parsed.metadata
		? {
				activityText: parsed.metadata.activityText?.trim(),
				toolName: parsed.metadata.toolName?.trim(),
				toolInputSummary: parsed.metadata.toolInputSummary?.trim() ?? null,
				finalMessage: parsed.metadata.finalMessage?.trim(),
				hookEventName: parsed.metadata.hookEventName?.trim(),
				notificationType: parsed.metadata.notificationType?.trim(),
				source: parsed.metadata.source?.trim(),
				sessionId: parsed.metadata.sessionId?.trim() || null,
				transcriptPath: parsed.metadata.transcriptPath?.trim() || null,
				conversationSummaryText: parsed.metadata.conversationSummaryText?.trim() || null,
			}
		: undefined;
	return {
		...parsed,
		taskId,
		projectId,
		metadata,
	};
}

export function parseTerminalWsClientMessage(value: unknown): RuntimeTerminalWsClientMessage | null {
	const parsed = runtimeTerminalWsClientMessageSchema.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	return parsed.data;
}
