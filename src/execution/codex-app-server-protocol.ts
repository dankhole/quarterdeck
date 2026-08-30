import { z } from "zod";

/**
 * Compatibility tuple generated from `codex app-server generate-json-schema
 * --experimental` for the installed Codex 0.149.1 CLI. Upgrade only after the
 * focused fake-protocol and authenticated fixture gates pass for the new tuple.
 */
export const CODEX_APP_SERVER_VERSION = "0.149.1";
export const CODEX_APP_SERVER_SCHEMA_FINGERPRINT = "6f76cce25156d405f1da54f205751e38f7b9eb42246ac0742b9958dd60275350";

const jsonObjectSchema = z.record(z.string(), z.unknown());
const requestIdSchema = z.union([z.string(), z.number()]);
const providerIdentifierSchema = z.string().min(1).max(512);
const interactionPresentationTextSchema = z.string().max(16 * 1024);
const MAX_INTERACTION_PRESENTATION_BYTES = 16 * 1024;
const MAX_INTERACTION_OPTION_BYTES = 1_024;
const MAX_INTERACTION_OPTIONS = 64;
const approvalPolicySchema = z.union([
	z.enum(["untrusted", "on-request", "never"]),
	z.object({
		granular: z.object({
			sandbox_approval: z.boolean(),
			rules: z.boolean(),
			skill_approval: z.boolean(),
			request_permissions: z.boolean(),
			mcp_elicitations: z.boolean(),
		}),
	}),
]);
const sandboxPolicySchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("dangerFullAccess") }),
	z.object({ type: z.literal("readOnly"), networkAccess: z.boolean() }),
	z.object({ type: z.literal("externalSandbox"), networkAccess: z.unknown() }),
	z.object({
		type: z.literal("workspaceWrite"),
		writableRoots: z.array(z.string()),
		networkAccess: z.boolean(),
		excludeTmpdirEnvVar: z.boolean(),
		excludeSlashTmp: z.boolean(),
	}),
]);

export type CodexApprovalPolicy = z.infer<typeof approvalPolicySchema>;
export type CodexSandboxPolicy = z.infer<typeof sandboxPolicySchema>;

const turnSchema = z
	.object({
		id: z.string().min(1),
		status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
		startedAt: z.number().nullable(),
		completedAt: z.number().nullable(),
		durationMs: z.number().nullable(),
		error: z.unknown().nullable(),
		items: z.array(z.unknown()),
		itemsView: z.unknown(),
	})
	.passthrough();
export type CodexTurn = z.infer<typeof turnSchema>;

const threadStatusSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("notLoaded") }),
	z.object({ type: z.literal("idle") }),
	z.object({ type: z.literal("systemError") }),
	z.object({ type: z.literal("active"), activeFlags: z.array(z.unknown()) }),
]);

const threadSchema = z
	.object({
		id: z.string().min(1),
		sessionId: z.string().min(1),
		forkedFromId: z.string().nullable(),
		parentThreadId: z.string().nullable(),
		ephemeral: z.boolean(),
		historyMode: z.string().min(1),
		cwd: z.string().min(1),
		cliVersion: z.string().min(1),
		modelProvider: z.string().min(1),
		status: threadStatusSchema,
		turns: z.array(turnSchema),
		canAcceptDirectInput: z.boolean().nullable(),
	})
	.passthrough();
export type CodexThread = z.infer<typeof threadSchema>;

export const initializeResponseSchema = z.object({
	userAgent: z.string(),
	codexHome: z.string().min(1),
	platformFamily: z.string(),
	platformOs: z.string(),
});

export const configReadResponseSchema = z.object({
	config: jsonObjectSchema,
	origins: jsonObjectSchema,
	layers: z.array(z.unknown()).nullable(),
});
export type CodexConfigReadResponse = z.infer<typeof configReadResponseSchema>;

export const threadResumeResponseSchema = z.object({
	thread: threadSchema,
	model: z.string().min(1),
	modelProvider: z.string().min(1),
	serviceTier: z.string().nullable(),
	cwd: z.string().min(1),
	runtimeWorkspaceRoots: z.array(z.string()),
	instructionSources: z.array(z.string()),
	approvalPolicy: approvalPolicySchema,
	approvalsReviewer: z.enum(["user", "auto_review", "guardian_subagent"]),
	sandbox: sandboxPolicySchema,
	activePermissionProfile: z.object({ id: z.string().min(1), extends: z.string().nullable() }).nullable(),
	reasoningEffort: z.string().nullable(),
	multiAgentMode: z.unknown(),
	initialTurnsPage: z.unknown().nullable(),
	turnsBackwardsCursor: z.string().nullable(),
	itemsBackwardsCursor: z.string().nullable(),
});
export type CodexThreadResumeResponse = z.infer<typeof threadResumeResponseSchema>;

export const threadReadResponseSchema = z.object({ thread: threadSchema });
export const threadTurnsListResponseSchema = z.object({
	data: z.array(turnSchema),
	nextCursor: z.string().nullable(),
	backwardsCursor: z.string().nullable(),
});
export const turnStartResponseSchema = z.object({ turn: turnSchema });
export const turnInterruptResponseSchema = jsonObjectSchema;

const serverRequestSchema = z
	.object({
		id: requestIdSchema,
		method: z.string().min(1),
		params: jsonObjectSchema,
	})
	.passthrough();
const serverNotificationSchema = z
	.object({
		method: z.string().min(1),
		params: jsonObjectSchema,
	})
	.passthrough();
const successResponseSchema = z.object({ id: requestIdSchema, result: z.unknown() }).passthrough();
const errorResponseSchema = z.object({
	id: requestIdSchema,
	error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).passthrough(),
});

export type CodexJsonRpcMessage =
	| { kind: "request"; id: string | number; method: string; params: Record<string, unknown> }
	| { kind: "notification"; method: string; params: Record<string, unknown> }
	| { kind: "success"; id: string | number; result: unknown }
	| { kind: "error"; id: string | number; code: number; message: string };

export function parseCodexJsonRpcMessage(input: unknown): CodexJsonRpcMessage {
	const serverRequest = serverRequestSchema.safeParse(input);
	if (serverRequest.success) return { kind: "request", ...serverRequest.data };
	const notification = serverNotificationSchema.safeParse(input);
	if (notification.success) return { kind: "notification", ...notification.data };
	const success = successResponseSchema.safeParse(input);
	if (success.success) return { kind: "success", ...success.data };
	const failure = errorResponseSchema.safeParse(input);
	if (failure.success) {
		return {
			kind: "error",
			id: failure.data.id,
			code: failure.data.error.code,
			message: failure.data.error.message,
		};
	}
	throw new Error("Codex app-server emitted an invalid JSON-RPC message.");
}

export const turnStartedNotificationSchema = z.object({ threadId: z.string(), turn: turnSchema });
export const turnCompletedNotificationSchema = z.object({ threadId: z.string(), turn: turnSchema });
export const serverRequestResolvedNotificationSchema = z.object({
	threadId: z.string().min(1),
	requestId: z.union([z.string(), z.number()]),
});

const interactionIdentitySchema = z.object({
	threadId: providerIdentifierSchema,
	turnId: providerIdentifierSchema.nullable(),
	itemId: providerIdentifierSchema,
});
const basicApprovalDecisionSchema = z.enum(["accept", "acceptForSession", "decline", "cancel"]);
export type CodexBasicApprovalDecision = z.infer<typeof basicApprovalDecisionSchema>;

const commandApprovalParamsSchema = interactionIdentitySchema.extend({
	startedAtMs: z.number(),
	approvalId: z.string().nullable().optional(),
	environmentId: z.string().nullable(),
	availableDecisions: z.array(z.unknown()).max(32).nullable().optional(),
});

const fileApprovalParamsSchema = interactionIdentitySchema.extend({
	startedAtMs: z.number(),
});

const userInputOptionSchema = z.object({
	label: interactionPresentationTextSchema,
	description: interactionPresentationTextSchema,
});
const userInputQuestionSchema = z.object({
	id: providerIdentifierSchema,
	header: interactionPresentationTextSchema,
	question: interactionPresentationTextSchema,
	isOther: z.boolean().optional().default(false),
	isSecret: z.boolean().optional().default(false),
	options: z.array(userInputOptionSchema).max(32).nullable().optional().default(null),
});
const userInputParamsSchema = interactionIdentitySchema.extend({
	questions: z.array(userInputQuestionSchema).max(64),
	isBlocking: z.boolean(),
	autoResolutionMs: z.number().nullable(),
});

const mcpElicitationParamsSchema = z.discriminatedUnion("mode", [
	z.object({
		threadId: providerIdentifierSchema,
		turnId: providerIdentifierSchema.nullable(),
		serverName: providerIdentifierSchema,
		mode: z.literal("form"),
		_meta: z.unknown().nullable(),
		message: interactionPresentationTextSchema,
		requestedSchema: z.unknown(),
	}),
	z.object({
		threadId: providerIdentifierSchema,
		turnId: providerIdentifierSchema.nullable(),
		serverName: providerIdentifierSchema,
		mode: z.literal("openai/form"),
		_meta: z.unknown().nullable(),
		message: interactionPresentationTextSchema,
		requestedSchema: z.unknown(),
	}),
	z.object({
		threadId: providerIdentifierSchema,
		turnId: providerIdentifierSchema.nullable(),
		serverName: providerIdentifierSchema,
		mode: z.literal("url"),
		_meta: z.unknown().nullable(),
		message: interactionPresentationTextSchema,
		url: z.string(),
		elicitationId: providerIdentifierSchema,
	}),
]);

export const addressableServerRequestMethods = new Set([
	"item/commandExecution/requestApproval",
	"item/fileChange/requestApproval",
	"item/tool/requestUserInput",
	"mcpServer/elicitation/request",
]);

export interface CodexAddressableServerRequestIdentity {
	threadId: string;
	turnId: string | null;
	itemId: string | null;
	kind: "question" | "approval" | "elicitation";
	questionIds: string[];
	allowedApprovalDecisions: CodexBasicApprovalDecision[] | null;
	promptText: string | null;
	optionLabels: string[];
}

function truncateUtf8(value: string, maxBytes: number): string {
	let result = "";
	let usedBytes = 0;
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (usedBytes + characterBytes > maxBytes) break;
		result += character;
		usedBytes += characterBytes;
	}
	return result;
}

function formatQuestionPrompt(questions: readonly z.infer<typeof userInputQuestionSchema>[]): string | null {
	const prompts = questions.flatMap((question) => {
		const header = question.header.trim();
		const body = question.question.trim();
		if (!header && !body) return [];
		if (!header) return [body];
		if (!body) return [header];
		return [`${header}\n${body}`];
	});
	return prompts.length > 0 ? truncateUtf8(prompts.join("\n\n"), MAX_INTERACTION_PRESENTATION_BYTES) : null;
}

function collectQuestionOptionLabels(questions: readonly z.infer<typeof userInputQuestionSchema>[]): string[] {
	const labels = new Set<string>();
	for (const question of questions) {
		for (const option of question.options ?? []) {
			const label = truncateUtf8(option.label.trim(), MAX_INTERACTION_OPTION_BYTES);
			if (label) labels.add(label);
			if (labels.size >= MAX_INTERACTION_OPTIONS) return [...labels];
		}
	}
	return [...labels];
}

export function parseAddressableServerRequestIdentity(
	method: string,
	params: Record<string, unknown>,
): CodexAddressableServerRequestIdentity {
	if (method === "item/commandExecution/requestApproval") {
		const parsed = commandApprovalParamsSchema.parse(params);
		const allowedApprovalDecisions = parsed.availableDecisions
			? parsed.availableDecisions.flatMap((decision) => {
					const supported = basicApprovalDecisionSchema.safeParse(decision);
					return supported.success ? [supported.data] : [];
				})
			: null;
		return {
			threadId: parsed.threadId,
			turnId: parsed.turnId,
			itemId: parsed.itemId,
			kind: "approval",
			questionIds: [],
			allowedApprovalDecisions,
			promptText: null,
			optionLabels: allowedApprovalDecisions ?? [],
		};
	}
	if (method === "item/fileChange/requestApproval") {
		const parsed = fileApprovalParamsSchema.parse(params);
		return {
			threadId: parsed.threadId,
			turnId: parsed.turnId,
			itemId: parsed.itemId,
			kind: "approval",
			questionIds: [],
			allowedApprovalDecisions: basicApprovalDecisionSchema.options,
			promptText: null,
			optionLabels: basicApprovalDecisionSchema.options,
		};
	}
	if (method === "item/tool/requestUserInput") {
		const parsed = userInputParamsSchema.parse(params);
		return {
			threadId: parsed.threadId,
			turnId: parsed.turnId,
			itemId: parsed.itemId,
			kind: "question",
			questionIds: parsed.questions.map((question) => question.id),
			allowedApprovalDecisions: null,
			promptText: formatQuestionPrompt(parsed.questions),
			optionLabels: collectQuestionOptionLabels(parsed.questions),
		};
	}
	const parsed = mcpElicitationParamsSchema.parse(params);
	const promptText = truncateUtf8(parsed.message.trim(), MAX_INTERACTION_PRESENTATION_BYTES);
	return {
		threadId: parsed.threadId,
		turnId: parsed.turnId,
		itemId: null,
		kind: "elicitation",
		questionIds: [],
		allowedApprovalDecisions: null,
		promptText: promptText || null,
		optionLabels: [],
	};
}
