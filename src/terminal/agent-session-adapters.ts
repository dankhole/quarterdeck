import { join } from "node:path";

import { buildClaudeHooksSettings } from "../claude-hooks";
import { buildCodexHookConfigOverrides, CODEX_HOOKS_FEATURE_NAME, serializeCodexTomlValue } from "../codex-hooks";
import { buildStatuslineCommand } from "../commands/statusline";
import type {
	ClaudeLaunchPermissionMode,
	CodexApprovalsReviewer,
	ManagedClaudePermissionMode,
	RuntimeAgentId,
	RuntimeTaskImage,
	RuntimeTaskSessionSummary,
} from "../core";
import { buildQuarterdeckCommandParts, createTaggedLogger } from "../core";
import { lockedFileSystem } from "../fs";
import { getRuntimeHomePath } from "../state";
import { createClaudeRendererEnvironment, resolveClaudeRendererPolicy } from "./claude-renderer-policy";
import { createCodexApprovalPromptDetector } from "./codex-approval-prompt";
import { createCodexTurnInterruptionDetector } from "./codex-turn-interruption";
import { createHookRuntimeEnv } from "./hook-runtime-context";
import {
	buildPiLifecycleExtensionSource,
	QUARTERDECK_PI_HOOK_COMMAND_ENV,
	QUARTERDECK_PI_TOOL_APPROVALS_ENV,
} from "./pi-lifecycle-extension";
import { canApplyCodexRenderedTurnInterruption, type SessionTransitionEvent } from "./session-state-machine";
import { prepareTaskPromptWithImages } from "./task-image-prompt";
import type { TerminalScreenSnapshot } from "./terminal-state-mirror";
import { buildWorktreeContextPrompt } from "./worktree-context";

export interface AgentAdapterLaunchInput {
	taskId: string;
	agentId: RuntimeAgentId;
	binary?: string;
	args: string[];
	cwd: string;
	prompt: string;
	images?: RuntimeTaskImage[];
	resumeConversation?: boolean;
	resumeSessionId?: string;
	env?: Record<string, string | undefined>;
	projectId?: string;
	projectPath?: string;
	hookSessionInstanceId?: string;
	claudeFullscreenEnabled?: boolean;
	claudeLaunchPermissionMode?: ClaudeLaunchPermissionMode;
	statuslineEnabled?: boolean;
	codexApprovalsReviewer?: CodexApprovalsReviewer;
	piToolApprovalsEnabled?: boolean;
	worktreeSystemPromptTemplate?: string;
}

export type AgentOutputTransitionDetector = (
	screen: TerminalScreenSnapshot,
	summary: RuntimeTaskSessionSummary,
) => SessionTransitionEvent | null;

export type AgentOutputTransitionInspectionPredicate = (summary: RuntimeTaskSessionSummary) => boolean;

export interface PreparedAgentLaunch {
	binary?: string;
	args: string[];
	env: Record<string, string | undefined>;
	cleanup?: () => Promise<void>;
	detectOutputTransition?: AgentOutputTransitionDetector;
	shouldInspectOutputForTransition?: AgentOutputTransitionInspectionPredicate;
	resetOutputTransitionDetection?: () => void;
}

interface HookContext {
	taskId: string;
	projectId: string;
	sessionInstanceId?: string;
}

interface AgentSessionAdapter {
	prepare(input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch>;
}

function resolveHookContext(input: AgentAdapterLaunchInput): HookContext | null {
	const projectId = input.projectId?.trim();
	if (!projectId) {
		return null;
	}
	return {
		taskId: input.taskId,
		projectId,
		sessionInstanceId: input.hookSessionInstanceId,
	};
}

function hasCliOption(args: string[], optionName: string): boolean {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg) continue;
		if (arg === optionName || arg.startsWith(`${optionName}=`)) {
			return true;
		}
	}
	return false;
}

function hasCodexConfigOverride(args: string[], configKey: string): boolean {
	const prefix = `${configKey}=`;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		const nextArg = args[i + 1];
		if (!arg) continue;
		if ((arg === "-c" || arg === "--config") && nextArg?.startsWith(prefix)) {
			return true;
		}
		if (arg.startsWith("-c=") && arg.slice("-c=".length).startsWith(prefix)) {
			return true;
		}
		if (arg.startsWith("--config=") && arg.slice("--config=".length).startsWith(prefix)) {
			return true;
		}
	}
	return false;
}

function removeCliOption(args: string[], optionName: string): void {
	for (let index = args.length - 1; index >= 0; index -= 1) {
		const arg = args[index];
		if (arg === optionName || arg?.startsWith(`${optionName}=`)) {
			args.splice(index, 1);
		}
	}
}

function removeCliOptionWithValue(args: string[], optionName: string): void {
	for (let index = args.length - 1; index >= 0; index -= 1) {
		const arg = args[index];
		if (arg?.startsWith(`${optionName}=`)) {
			args.splice(index, 1);
			continue;
		}
		if (arg === optionName) {
			const nextArg = args[index + 1];
			const valueCount = nextArg && nextArg !== "--" && !nextArg.startsWith("-") ? 1 : 0;
			args.splice(index, 1 + valueCount);
		}
	}
}

function applyManagedClaudePermissionMode(args: string[], mode: ManagedClaudePermissionMode): void {
	const originalOptionTerminatorIndex = args.indexOf("--");
	const optionArgCount = originalOptionTerminatorIndex === -1 ? args.length : originalOptionTerminatorIndex;
	const optionArgs = args.slice(0, optionArgCount);
	removeCliOptionWithValue(optionArgs, "--permission-mode");
	removeCliOption(optionArgs, "--dangerously-skip-permissions");
	removeCliOption(optionArgs, "--allow-dangerously-skip-permissions");
	args.splice(0, optionArgCount, ...optionArgs);
	const optionTerminatorIndex = args.indexOf("--");
	const cliMode = mode === "default" ? "manual" : mode;
	args.splice(optionTerminatorIndex === -1 ? args.length : optionTerminatorIndex, 0, "--permission-mode", cliMode);
}

function removeCodexConfigOverrides(args: string[], configKey: string): void {
	const prefix = `${configKey}=`;
	for (let index = args.length - 1; index >= 0; index -= 1) {
		const arg = args[index];
		if ((arg === "-c" || arg === "--config") && args[index + 1]?.startsWith(prefix)) {
			args.splice(index, 2);
			continue;
		}
		if (
			(arg?.startsWith("-c=") && arg.slice("-c=".length).startsWith(prefix)) ||
			(arg?.startsWith("--config=") && arg.slice("--config=".length).startsWith(prefix))
		) {
			args.splice(index, 1);
		}
	}
}

function getHookAgentDirectory(agentId: RuntimeAgentId): string {
	return join(getRuntimeHomePath(), "hooks", agentId);
}

function getPiLifecycleExtensionPath(): string {
	return join(getHookAgentDirectory("pi"), "quarterdeck-lifecycle.js");
}

async function ensureTextFile(filePath: string, content: string, executable = false): Promise<void> {
	await lockedFileSystem.writeTextFileAtomic(filePath, content, {
		executable,
	});
}

function hasCodexFeatureEnabled(args: string[], featureName: string): boolean {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		const nextArg = args[i + 1];
		if (!arg) {
			continue;
		}
		if (arg === "--enable" && nextArg === featureName) {
			return true;
		}
		if (arg.startsWith("--enable=") && arg.slice("--enable=".length) === featureName) {
			return true;
		}
		if ((arg === "-c" || arg === "--config") && nextArg === `features.${featureName}=true`) {
			return true;
		}
		if (arg.startsWith("-c=") && arg.slice("-c=".length) === `features.${featureName}=true`) {
			return true;
		}
		if (arg.startsWith("--config=") && arg.slice("--config=".length) === `features.${featureName}=true`) {
			return true;
		}
	}
	return false;
}

function findCodexGlobalArgInsertIndex(args: string[]): number {
	const subcommandIndex = args.findIndex((arg) => arg === "resume" || arg === "fork");
	return subcommandIndex === -1 ? args.length : subcommandIndex;
}

function insertCodexGlobalArgs(args: string[], values: string[]): void {
	args.splice(findCodexGlobalArgInsertIndex(args), 0, ...values);
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

const claudeAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		if (input.claudeLaunchPermissionMode && input.claudeLaunchPermissionMode !== "inherit") {
			applyManagedClaudePermissionMode(args, input.claudeLaunchPermissionMode);
		}
		const rendererPolicy = resolveClaudeRendererPolicy({
			fullscreenEnabled: input.claudeFullscreenEnabled,
			args,
			envOverrides: input.env,
		});
		const env: Record<string, string | undefined> = {
			FORCE_HYPERLINK: "1",
			...createClaudeRendererEnvironment(rendererPolicy.mode, { envOverrides: input.env }),
		};
		if (input.resumeConversation && !hasCliOption(args, "--continue") && !hasCliOption(args, "--resume")) {
			const resumeTarget = input.resumeSessionId?.trim();
			if (resumeTarget) {
				args.push("--resume", resumeTarget);
				log.debug("claude resume using stored session id", {
					taskId: input.taskId,
					hasStoredResumeSessionId: true,
				});
			} else {
				args.push("--continue");
				log.warn("claude resume falling back to --continue (no stored resumeSessionId)", {
					taskId: input.taskId,
				});
			}
		} else if (input.resumeConversation) {
			log.debug("claude resume option already configured", {
				taskId: input.taskId,
				hasStoredResumeSessionId: Boolean(input.resumeSessionId?.trim()),
			});
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			const settingsPath = join(getHookAgentDirectory("claude"), "settings.json");
			const hooksSettings = buildClaudeHooksSettings({
				statusLineCommand: input.statuslineEnabled === true ? buildStatuslineCommand() : null,
			});
			await ensureTextFile(settingsPath, JSON.stringify(hooksSettings, null, 2));
			args.push("--settings", settingsPath);
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					projectId: hooks.projectId,
					sessionInstanceId: hooks.sessionInstanceId,
				}),
			);
		}

		// Inject worktree context so the agent knows it's in an isolated worktree,
		// not the main repo. Must go before "--" which terminates option parsing.
		if (!hasCliOption(args, "--append-system-prompt") && !hasCliOption(args, "--system-prompt")) {
			const worktreeContext = await buildWorktreeContextPrompt({
				cwd: input.cwd,
				projectPath: input.projectPath,
				template: input.worktreeSystemPromptTemplate,
			});
			if (worktreeContext) {
				args.push("--append-system-prompt", worktreeContext);
			}
		}

		// "--" terminates option parsing so the prompt positional arg can't be
		// consumed by variadic flags.
		if (input.prompt.trim()) {
			args.push("--");
		}
		const withPromptLaunch = withPrompt(args, input.prompt, "append");
		log.debug("claude adapter prepared launch", {
			taskId: input.taskId,
			claudeRendererMode: rendererPolicy.mode,
			claudeRendererReason: rendererPolicy.reason,
			claudeLaunchPermissionMode: input.claudeLaunchPermissionMode ?? "inherit",
			argCount: withPromptLaunch.args.length,
			promptLength: input.prompt.trim().length,
			resumeConversation: input.resumeConversation ?? false,
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

export async function prepareCodexLaunchConfiguration(
	input: AgentAdapterLaunchInput,
): Promise<{ args: string[]; env: Record<string, string | undefined> }> {
	const codexArgs = [...input.args];
	const env: Record<string, string | undefined> = {};

	if (input.codexApprovalsReviewer === "dangerously_bypass") {
		removeCliOption(codexArgs, "--approve-for-me");
		removeCliOption(codexArgs, "--not-so-yolo");
		removeCodexConfigOverrides(codexArgs, "approvals_reviewer");
		if (
			!hasCliOption(codexArgs, "--dangerously-bypass-approvals-and-sandbox") &&
			!hasCliOption(codexArgs, "--yolo")
		) {
			insertCodexGlobalArgs(codexArgs, ["--dangerously-bypass-approvals-and-sandbox"]);
		}
	} else if (input.codexApprovalsReviewer === "auto_review") {
		removeCliOption(codexArgs, "--dangerously-bypass-approvals-and-sandbox");
		removeCliOption(codexArgs, "--yolo");
		removeCodexConfigOverrides(codexArgs, "approvals_reviewer");
		if (!hasCliOption(codexArgs, "--approve-for-me") && !hasCliOption(codexArgs, "--not-so-yolo")) {
			insertCodexGlobalArgs(codexArgs, ["--approve-for-me"]);
		}
	} else if (input.codexApprovalsReviewer === "user") {
		removeCliOption(codexArgs, "--approve-for-me");
		removeCliOption(codexArgs, "--not-so-yolo");
		removeCliOption(codexArgs, "--dangerously-bypass-approvals-and-sandbox");
		removeCliOption(codexArgs, "--yolo");
		removeCodexConfigOverrides(codexArgs, "approvals_reviewer");
		insertCodexGlobalArgs(codexArgs, ["-c", 'approvals_reviewer="user"']);
	}

	if (input.resumeConversation) {
		if (!codexArgs.includes("resume")) codexArgs.push("resume");
		const resumeIndex = codexArgs.indexOf("resume");
		const hasResumeTarget = codexArgs.slice(resumeIndex + 1).some((arg) => arg !== "--last" && !arg.startsWith("-"));
		if (!hasResumeTarget && !hasCliOption(codexArgs, "--last")) {
			const resumeTarget = input.resumeSessionId?.trim();
			if (resumeTarget) {
				log.debug("codex resume using stored session id", { taskId: input.taskId, hasStoredResumeSessionId: true });
				codexArgs.push(resumeTarget);
			} else {
				log.warn("codex resume falling back to --last (no stored resumeSessionId)", { taskId: input.taskId });
				codexArgs.push("--last");
			}
		}
	}

	const hooks = resolveHookContext(input);
	if (hooks) {
		Object.assign(
			env,
			createHookRuntimeEnv({
				taskId: hooks.taskId,
				projectId: hooks.projectId,
				sessionInstanceId: hooks.sessionInstanceId,
			}),
		);
	}
	if (!hasCodexFeatureEnabled(codexArgs, CODEX_HOOKS_FEATURE_NAME)) {
		insertCodexGlobalArgs(codexArgs, ["--enable", CODEX_HOOKS_FEATURE_NAME]);
	}
	if (hooks) {
		const hookOverrides = buildCodexHookConfigOverrides();
		insertCodexGlobalArgs(codexArgs, hookOverrides);
		log.debug("Codex hook launch config prepared", {
			taskId: hooks.taskId,
			projectId: hooks.projectId,
			featureName: CODEX_HOOKS_FEATURE_NAME,
			hookOverrideCount: hookOverrides.length / 2,
			resumeConversation: input.resumeConversation ?? false,
			hasResumeSessionId: !!input.resumeSessionId?.trim(),
		});
	} else {
		log.debug("Codex launch has no Quarterdeck hook context", {
			taskId: input.taskId,
			featureName: CODEX_HOOKS_FEATURE_NAME,
		});
	}
	if (!hasCodexConfigOverride(codexArgs, "check_for_update_on_startup")) {
		insertCodexGlobalArgs(codexArgs, ["-c", "check_for_update_on_startup=false"]);
	}
	if (!hasCodexConfigOverride(codexArgs, "developer_instructions")) {
		const worktreeContext = await buildWorktreeContextPrompt({
			cwd: input.cwd,
			projectPath: input.projectPath,
			template: input.worktreeSystemPromptTemplate,
		});
		if (worktreeContext) {
			insertCodexGlobalArgs(codexArgs, ["-c", `developer_instructions=${serializeCodexTomlValue(worktreeContext)}`]);
		}
	}
	return { args: codexArgs, env };
}

const codexAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const { args: codexArgs, env } = await prepareCodexLaunchConfiguration(input);
		const binary = input.binary;
		const approvalPromptDetector = createCodexApprovalPromptDetector();
		const turnInterruptionDetector = createCodexTurnInterruptionDetector();

		const trimmed = input.prompt.trim();
		if (trimmed) {
			// Terminate Codex option parsing before the prompt positional. This is
			// harmless for regular prompts and required for prompts that start with "-".
			codexArgs.push("--", trimmed);
		}

		log.debug("codex adapter prepared launch", {
			taskId: input.taskId,
			resumeConversation: input.resumeConversation ?? false,
			hasResumeSessionId: Boolean(input.resumeSessionId?.trim()),
			hasResumeArg: codexArgs.includes("resume"),
			hasLastFlag: hasCliOption(codexArgs, "--last"),
			codexArgCount: codexArgs.length,
		});
		return {
			binary,
			args: codexArgs,
			env,
			detectOutputTransition: (screen, summary) =>
				turnInterruptionDetector.detect(screen, summary) ?? approvalPromptDetector.detect(screen, summary),
			shouldInspectOutputForTransition: (summary) =>
				canApplyCodexRenderedTurnInterruption(summary) ||
				(summary.state === "awaiting_review" && summary.reviewReason === "unconfirmed"),
			resetOutputTransitionDetection: approvalPromptDetector.reset,
		};
	},
};

const piAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		if (input.resumeConversation) {
			const resumeSessionId = input.resumeSessionId?.trim();
			if (resumeSessionId && !hasCliOption(args, "--session")) {
				args.push("--session", resumeSessionId);
			} else if (
				!resumeSessionId &&
				!hasCliOption(args, "--continue") &&
				!hasCliOption(args, "--session") &&
				!hasCliOption(args, "--resume")
			) {
				args.push("--continue");
			}
		}
		const env: Record<string, string | undefined> = {};
		const hooks = resolveHookContext(input);
		if (hooks) {
			const extensionPath = getPiLifecycleExtensionPath();
			await ensureTextFile(extensionPath, buildPiLifecycleExtensionSource());
			if (!args.includes(extensionPath)) {
				args.push("--extension", extensionPath);
			}
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					projectId: hooks.projectId,
					sessionInstanceId: hooks.sessionInstanceId,
				}),
				{
					[QUARTERDECK_PI_HOOK_COMMAND_ENV]: JSON.stringify(buildQuarterdeckCommandParts(["hooks", "notify"])),
					[QUARTERDECK_PI_TOOL_APPROVALS_ENV]: input.piToolApprovalsEnabled === false ? "disabled" : "enabled",
				},
			);
		}

		const launch = withPrompt(args, input.prompt, "append");
		log.debug("pi adapter prepared launch", {
			taskId: input.taskId,
			argCount: launch.args.length,
			promptLength: input.prompt.trim().length,
			hookBridge: Boolean(hooks),
		});
		return {
			...launch,
			binary: input.binary,
			env: {
				...launch.env,
				...env,
			},
		};
	},
};

const ADAPTERS: Record<RuntimeAgentId, AgentSessionAdapter> = {
	claude: claudeAdapter,
	codex: codexAdapter,
	pi: piAdapter,
};

export async function prepareAgentLaunch(input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch> {
	log.debug("prepareAgentLaunch called", {
		taskId: input.taskId,
		agentId: input.agentId,
		hasProjectPath: Boolean(input.projectPath),
		hasPrompt: input.prompt.trim().length > 0,
		imageCount: input.images?.length ?? 0,
		resumeConversation: input.resumeConversation ?? false,
		hasResumeSessionId: Boolean(input.resumeSessionId?.trim()),
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
