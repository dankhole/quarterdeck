import { join, resolve } from "node:path";

import { buildStatuslineCommand } from "../commands/statusline";
import type {
	RuntimeAgentId,
	RuntimeHookEvent,
	RuntimeTaskImage,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import { createTaggedLogger } from "../core/debug-logger";
import { buildQuarterdeckCommandParts } from "../core/quarterdeck-command";
import { quoteShellArg } from "../core/shell";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/workspace-state";
import { createHookRuntimeEnv } from "./hook-runtime-context";
import { stripAnsi } from "./output-utils";
import type { SessionTransitionEvent } from "./session-state-machine";
import { prepareTaskPromptWithImages } from "./task-image-prompt";
import { buildWorktreeContextPrompt } from "./worktree-context";

export interface AgentAdapterLaunchInput {
	taskId: string;
	agentId: RuntimeAgentId;
	binary?: string;
	args: string[];
	autonomousModeEnabled?: boolean;
	cwd: string;
	prompt: string;
	images?: RuntimeTaskImage[];
	startInPlanMode?: boolean;
	resumeConversation?: boolean;
	env?: Record<string, string | undefined>;
	workspaceId?: string;
	workspacePath?: string;
	statuslineEnabled?: boolean;
	worktreeAddParentGitDir?: boolean;
	worktreeAddQuarterdeckDir?: boolean;
	worktreeSystemPromptTemplate?: string;
}

export type AgentOutputTransitionDetector = (
	data: string,
	summary: RuntimeTaskSessionSummary,
) => SessionTransitionEvent | null;

export type AgentOutputTransitionInspectionPredicate = (summary: RuntimeTaskSessionSummary) => boolean;

export interface PreparedAgentLaunch {
	binary?: string;
	args: string[];
	env: Record<string, string | undefined>;
	cleanup?: () => Promise<void>;
	deferredStartupInput?: string;
	detectOutputTransition?: AgentOutputTransitionDetector;
	shouldInspectOutputForTransition?: AgentOutputTransitionInspectionPredicate;
}

interface HookContext {
	taskId: string;
	workspaceId: string;
}

interface HookCommandMetadata {
	source?: string;
	activityText?: string;
	hookEventName?: string;
	notificationType?: string;
}

interface AgentSessionAdapter {
	prepare(input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch>;
}

function resolveHookContext(input: AgentAdapterLaunchInput): HookContext | null {
	const workspaceId = input.workspaceId?.trim();
	if (!workspaceId) {
		return null;
	}
	return {
		taskId: input.taskId,
		workspaceId,
	};
}

function buildHookCommand(event: RuntimeHookEvent, metadata?: HookCommandMetadata): string {
	const parts = buildHooksCommandParts(["ingest", "--event", event]);
	if (metadata?.source) {
		parts.push("--source", metadata.source);
	}
	if (metadata?.activityText) {
		parts.push("--activity-text", metadata.activityText);
	}
	if (metadata?.hookEventName) {
		parts.push("--hook-event-name", metadata.hookEventName);
	}
	if (metadata?.notificationType) {
		parts.push("--notification-type", metadata.notificationType);
	}
	return parts.map(quoteShellArg).join(" ");
}

function buildHooksCommandParts(args: string[]): string[] {
	return buildQuarterdeckCommandParts(["hooks", ...args]);
}

function hasCliOption(args: string[], optionName: string): boolean {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === optionName || arg.startsWith(`${optionName}=`)) {
			return true;
		}
	}
	return false;
}

function getHookAgentDirectory(agentId: RuntimeAgentId): string {
	return join(getRuntimeHomePath(), "hooks", agentId);
}

async function ensureTextFile(filePath: string, content: string, executable = false): Promise<void> {
	await lockedFileSystem.writeTextFileAtomic(filePath, content, {
		executable,
	});
}

function withPrompt(args: string[], prompt: string, mode: "append" | "flag", flag?: string): PreparedAgentLaunch {
	const trimmed = prompt.trim();
	if (!trimmed) {
		return {
			args,
			env: {},
		};
	}
	if (mode === "flag" && flag) {
		args.push(flag, trimmed);
	} else {
		args.push(trimmed);
	}
	return {
		args,
		env: {},
	};
}

const log = createTaggedLogger("agent-launch");

function toBracketedPasteSubmission(command: string): string {
	return `\u001b[200~${command}\u001b[201~\r`;
}

const claudeAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {
			FORCE_HYPERLINK: "1",
		};
		if (
			input.autonomousModeEnabled &&
			!input.startInPlanMode &&
			!hasCliOption(args, "--dangerously-skip-permissions")
		) {
			args.push("--dangerously-skip-permissions");
		}
		if (input.resumeConversation && !hasCliOption(args, "--continue")) {
			args.push("--continue");
		}
		if (input.startInPlanMode) {
			const withoutImmediateBypass = args.filter((arg) => arg !== "--dangerously-skip-permissions");
			args.length = 0;
			args.push(...withoutImmediateBypass);
			if (!hasCliOption(args, "--allow-dangerously-skip-permissions")) {
				args.push("--allow-dangerously-skip-permissions");
			}
			args.push("--permission-mode", "plan");
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			const settingsPath = join(getHookAgentDirectory("claude"), "settings.json");
			const hooksSettings = {
				hooks: {
					Stop: [{ hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }] }],
					SubagentStop: [
						{ hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }] },
					],
					PreToolUse: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }],
						},
					],
					PermissionRequest: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }],
						},
					],
					PostToolUse: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
						},
					],
					PostToolUseFailure: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
						},
					],
					Notification: [
						{
							matcher: "permission_prompt",
							hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }],
						},
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }],
						},
					],
					UserPromptSubmit: [
						{
							hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
						},
					],
				},
				...(input.statuslineEnabled !== false && {
					statusLine: {
						type: "command",
						command: buildStatuslineCommand(),
					},
				}),
			};
			await ensureTextFile(settingsPath, JSON.stringify(hooksSettings, null, 2));
			args.push("--settings", settingsPath);
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
		}

		// When running in a worktree, optionally give the agent access to the
		// parent repo directory and/or the ~/.quarterdeck state directory via --add-dir.
		const isWorktree = input.workspacePath && resolve(input.cwd) !== resolve(input.workspacePath);
		log.debug("claude adapter --add-dir check", {
			cwd: input.cwd,
			workspacePath: input.workspacePath ?? null,
			isWorktree,
			worktreeAddParentGitDir: input.worktreeAddParentGitDir ?? false,
			worktreeAddQuarterdeckDir: input.worktreeAddQuarterdeckDir ?? false,
		});
		if (isWorktree && input.workspacePath) {
			if (input.worktreeAddParentGitDir) {
				const gitDir = join(input.workspacePath, ".git");
				log.debug("adding --add-dir for parent .git dir", { path: gitDir });
				args.push("--add-dir", gitDir);
			}
			if (input.worktreeAddQuarterdeckDir) {
				const quarterdeckPath = getRuntimeHomePath();
				log.debug("adding --add-dir for quarterdeck dir", { path: quarterdeckPath });
				args.push("--add-dir", quarterdeckPath);
			}
		}

		// Inject worktree context so the agent knows it's in an isolated worktree,
		// not the main repo. Must go before "--" which terminates option parsing.
		if (!hasCliOption(args, "--append-system-prompt") && !hasCliOption(args, "--system-prompt")) {
			const worktreeContext = await buildWorktreeContextPrompt({
				cwd: input.cwd,
				workspacePath: input.workspacePath,
				template: input.worktreeSystemPromptTemplate,
			});
			if (worktreeContext) {
				args.push("--append-system-prompt", worktreeContext);
			}
		}

		// "--" terminates option parsing so the prompt positional arg can't be
		// consumed by variadic flags like --add-dir.
		if (input.prompt.trim()) {
			args.push("--");
		}
		const withPromptLaunch = withPrompt(args, input.prompt, "append");
		log.debug("claude adapter prepared launch", {
			taskId: input.taskId,
			argCount: withPromptLaunch.args.length,
			promptLength: input.prompt.trim().length,
			args: withPromptLaunch.args.map((a) => (a.length > 200 ? `${a.slice(0, 200)}…(${a.length})` : a)),
		});
		return {
			...withPromptLaunch,
			env: {
				...withPromptLaunch.env,
				...env,
			},
		};
	},
};

function codexPromptDetector(data: string, summary: RuntimeTaskSessionSummary): SessionTransitionEvent | null {
	if (summary.state !== "awaiting_review") {
		return null;
	}
	if (summary.reviewReason !== "attention" && summary.reviewReason !== "hook") {
		return null;
	}
	const stripped = stripAnsi(data);
	if (/(?:^|\n)\s*›/.test(stripped)) {
		return { type: "agent.prompt-ready" };
	}
	return null;
}

function shouldInspectCodexOutputForTransition(summary: RuntimeTaskSessionSummary): boolean {
	return (
		summary.state === "awaiting_review" &&
		(summary.reviewReason === "attention" || summary.reviewReason === "hook" || summary.reviewReason === "error")
	);
}

const codexAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const codexArgs = [...input.args];
		const env: Record<string, string | undefined> = {};
		let binary = input.binary;
		let deferredStartupInput: string | undefined;

		if (input.autonomousModeEnabled && !hasCliOption(codexArgs, "--dangerously-bypass-approvals-and-sandbox")) {
			codexArgs.push("--dangerously-bypass-approvals-and-sandbox");
		}

		if (input.resumeConversation) {
			if (!codexArgs.includes("resume")) {
				codexArgs.push("resume");
			}
			if (!hasCliOption(codexArgs, "--last")) {
				codexArgs.push("--last");
			}
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
		}

		const trimmed = input.prompt.trim();
		if (input.startInPlanMode) {
			const planCommand = trimmed ? `/plan ${trimmed}` : "/plan";
			deferredStartupInput = toBracketedPasteSubmission(planCommand);
		} else if (trimmed) {
			codexArgs.push(trimmed);
		}

		if (hooks) {
			const wrapperParts = buildHooksCommandParts([
				"codex-wrapper",
				"--real-binary",
				input.binary ?? "codex",
				"--",
				...codexArgs,
			]);
			binary = wrapperParts[0];
			const args = wrapperParts.slice(1);
			return {
				binary,
				args,
				env,
				deferredStartupInput,
				detectOutputTransition: codexPromptDetector,
				shouldInspectOutputForTransition: shouldInspectCodexOutputForTransition,
			};
		}

		return {
			binary,
			args: codexArgs,
			env,
			deferredStartupInput,
			detectOutputTransition: codexPromptDetector,
			shouldInspectOutputForTransition: shouldInspectCodexOutputForTransition,
		};
	},
};

const ADAPTERS: Record<RuntimeAgentId, AgentSessionAdapter> = {
	claude: claudeAdapter,
	codex: codexAdapter,
};

export async function prepareAgentLaunch(input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch> {
	log.debug("prepareAgentLaunch called", {
		taskId: input.taskId,
		agentId: input.agentId,
		cwd: input.cwd,
		workspacePath: input.workspacePath ?? null,
		worktreeAddParentGitDir: input.worktreeAddParentGitDir ?? false,
		worktreeAddQuarterdeckDir: input.worktreeAddQuarterdeckDir ?? false,
		hasPrompt: input.prompt.trim().length > 0,
		imageCount: input.images?.length ?? 0,
		resumeConversation: input.resumeConversation ?? false,
		startInPlanMode: input.startInPlanMode ?? false,
		autonomousMode: input.autonomousModeEnabled ?? false,
	});
	const preparedPrompt = await prepareTaskPromptWithImages({
		prompt: input.prompt,
		images: input.images,
	});
	return await ADAPTERS[input.agentId].prepare({
		...input,
		prompt: preparedPrompt,
	});
}
