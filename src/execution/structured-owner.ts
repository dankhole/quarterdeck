import type { TaskInteractionOutcome } from "./execution-ownership-contracts";

export type StructuredExecutionProvider = "codex" | "claude";

export interface StructuredOwnerContext {
	provider: StructuredExecutionProvider;
	projectId: string;
	projectPath: string;
	taskId: string;
	ownerGeneration: number;
	ownerSessionInstanceId: string;
}

export interface StructuredTurn {
	/** Null when the provider does not expose a first-class turn identifier. */
	id: string | null;
	status: "inProgress" | "completed" | "interrupted" | "failed";
}

export interface StructuredPendingInteraction {
	interactionId: string;
	kind: "question" | "approval" | "elicitation";
	providerSessionId: string;
	turnId: string | null;
	itemId: string | null;
	createdAt: number;
	promptText: string | null;
	optionLabels: readonly string[];
}

export type StructuredInteractionAnswer =
	| { type: "question"; answers: Record<string, string[]> }
	| { type: "approval"; decision: "accept" | "acceptForSession" | "decline" | "cancel" }
	| { type: "elicitation"; action: "accept" | "decline" | "cancel"; content: unknown | null };

export interface StructuredOwnerIdentity {
	providerSessionId: string;
	providerSessionTreeId: string | null;
	providerProfileFingerprint: string;
	configurationFingerprint: string;
	providerVersion: string;
	protocolSchemaFingerprint: string;
	historyMode: "legacy" | "paginated" | null;
	ownerSessionInstanceId: string;
	pid: number;
	processKind: "stdio_app_server" | "stdio_agent_sdk";
}

export interface StructuredOwner {
	readonly context: StructuredOwnerContext;
	readonly identity: StructuredOwnerIdentity;
	hasActiveTurn(): boolean;
	getActiveTurnId(): string | null;
	getActiveTurn(): { turnId: string | null; clientUserMessageId: string } | null;
	hasPendingInteractions(): boolean;
	listPendingInteractions(): readonly StructuredPendingInteraction[];
	hasWriteAuthority(): boolean;
	startMessage(
		text: string,
		clientUserMessageId: string,
	): Promise<{ turn: StructuredTurn; completion: Promise<StructuredTurn> }>;
	interruptActiveTurn(timeoutMs?: number): Promise<StructuredTurn | null>;
	readRecentTurns(limit?: number): Promise<StructuredTurn[]>;
	answerInteraction(
		interactionId: string,
		answer: StructuredInteractionAnswer,
	): "completed" | "question_not_found" | "approval_not_found" | "unsupported_interaction";
	stopAndWait(timeoutMs: number): Promise<boolean>;
}

export interface StructuredOwnerEvents {
	onTurnStarted?: (context: StructuredOwnerContext, turn: StructuredTurn, clientUserMessageId: string) => void;
	onTurnCompleted?: (context: StructuredOwnerContext, turn: StructuredTurn) => void;
	onInteractionRequested?: (context: StructuredOwnerContext, interaction: StructuredPendingInteraction) => void;
	onInteractionResolved?: (context: StructuredOwnerContext, interaction: StructuredPendingInteraction) => void;
	onInteractionCancelled?: (context: StructuredOwnerContext, interaction: StructuredPendingInteraction) => void;
	onExit?: (context: StructuredOwnerContext, turnOutcomeUnknown: boolean) => void;
}

export interface StructuredOwnerRegistryContract {
	setEvents(events: StructuredOwnerEvents): void;
	get(projectId: string, taskId: string): StructuredOwner | null;
	start(input: StartStructuredOwnerInput): Promise<StructuredOwner>;
	stop(
		projectId: string,
		taskId: string,
		ownerGeneration: number,
		ownerSessionInstanceId: string,
		timeoutMs?: number,
	): Promise<"exited" | "not_running" | "superseded" | "timed_out">;
	stopAll(timeoutMs?: number): Promise<number>;
}

export interface StartStructuredOwnerInput {
	provider: StructuredExecutionProvider;
	projectId: string;
	projectPath: string;
	taskId: string;
	binary: string;
	nativeArgs: string[];
	cwd: string;
	env?: Record<string, string | undefined>;
	providerSessionId: string;
	expectedProviderSessionTreeId?: string | null;
	expectedProviderProfileFingerprint?: string | null;
	expectedConfigurationFingerprint?: string | null;
	expectedProviderVersion?: string | null;
	expectedProtocolSchemaFingerprint?: string | null;
	expectedHistoryMode?: "legacy" | "paginated" | null;
	ownerGeneration: number;
	ownerSessionInstanceId: string;
	launchOperationId: string;
	claudeLaunchPermissionMode?:
		| "inherit"
		| "default"
		| "acceptEdits"
		| "plan"
		| "auto"
		| "dontAsk"
		| "bypassPermissions";
	codexApprovalsReviewer?: "inherit" | "user" | "auto_review" | "dangerously_bypass";
	statuslineEnabled?: boolean;
	worktreeSystemPromptTemplate?: string;
	onProcessStarted?: (identity: { pid: number; ownerSessionInstanceId: string }) => Promise<void>;
}

export class StructuredOwnerCompatibilityError extends Error {
	constructor(
		readonly code:
			| "unsupported_version"
			| "profile_mismatch"
			| "configuration_mismatch"
			| "identity_mismatch"
			| "history_mode",
	) {
		super(`Structured ownership compatibility check failed: ${code}.`);
		this.name = "StructuredOwnerCompatibilityError";
	}
}

export class StructuredOwnerStopUnconfirmedError extends Error {
	constructor(readonly startError?: unknown) {
		super("Structured execution owner exit could not be confirmed.");
		this.name = "StructuredOwnerStopUnconfirmedError";
	}
}

export type StructuredInteractionFailureOutcome = Extract<
	TaskInteractionOutcome,
	"question_not_found" | "approval_not_found" | "unsupported_interaction"
>;
