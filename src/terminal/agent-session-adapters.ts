import { join, resolve } from "node:path";

import { buildCodexHookConfigOverrides, CODEX_HOOKS_FEATURE_NAME, serializeCodexTomlValue } from "../codex-hooks";
import { buildStatuslineCommand } from "../commands/statusline";
import type { RuntimeAgentId, RuntimeHookEvent, RuntimeTaskImage, RuntimeTaskSessionSummary } from "../core";
import { buildQuarterdeckCommandParts, createTaggedLogger, quoteShellArg } from "../core";
import { lockedFileSystem } from "../fs";
import { getRuntimeHomePath } from "../state";
import { createHookRuntimeEnv } from "./hook-runtime-context";
import type { SessionTransitionEvent } from "./session-state-machine";
import { prepareTaskPromptWithImages } from "./task-image-prompt";
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
	detectOutputTransition?: AgentOutputTransitionDetector;
	shouldInspectOutputForTransition?: AgentOutputTransitionInspectionPredicate;
}

interface HookContext {
	taskId: string;
	projectId: string;
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
	const projectId = input.projectId?.trim();
	if (!projectId) {
		return null;
	}
	return {
		taskId: input.taskId,
		projectId,
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

function getHookAgentDirectory(agentId: RuntimeAgentId): string {
	return join(getRuntimeHomePath(), "hooks", agentId);
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
		const env: Record<string, string | undefined> = {
			FORCE_HYPERLINK: "1",
		};
		if (input.resumeConversation && !hasCliOption(args, "--continue")) {
			args.push("--continue");
			log.debug("claude resume via --continue (relies on cwd match)", {
				taskId: input.taskId,
				cwd: input.cwd,
				projectPath: input.projectPath ?? null,
			});
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
					projectId: hooks.projectId,
				}),
			);
		}

		// When running in a worktree, optionally give the agent access to the
		// parent repo directory and/or the ~/.quarterdeck state directory via --add-dir.
		const isWorktree = input.projectPath && resolve(input.cwd) !== resolve(input.projectPath);
		log.debug("claude adapter --add-dir check", {
			cwd: input.cwd,
			projectPath: input.projectPath ?? null,
			isWorktree,
			worktreeAddParentGitDir: input.worktreeAddParentGitDir ?? false,
			worktreeAddQuarterdeckDir: input.worktreeAddQuarterdeckDir ?? false,
		});
		if (isWorktree && input.projectPath) {
			if (input.worktreeAddParentGitDir) {
				const gitDir = join(input.projectPath, ".git");
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
				projectPath: input.projectPath,
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

const codexAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const codexArgs = [...input.args];
		const env: Record<string, string | undefined> = {};
		const binary = input.binary;

		if (input.resumeConversation) {
			if (!codexArgs.includes("resume")) {
				codexArgs.push("resume");
			}
			const resumeIndex = codexArgs.indexOf("resume");
			const hasResumeTarget = codexArgs
				.slice(resumeIndex + 1)
				.some((arg) => arg !== "--last" && !arg.startsWith("-"));
			if (!hasResumeTarget && !hasCliOption(codexArgs, "--last")) {
				const resumeTarget = input.resumeSessionId?.trim();
				if (resumeTarget) {
					log.debug("codex resume using stored session id", {
						taskId: input.taskId,
						cwd: input.cwd,
						resumeSessionId: resumeTarget,
					});
					codexArgs.push(resumeTarget);
				} else {
					log.warn("codex resume falling back to --last (no stored resumeSessionId)", {
						taskId: input.taskId,
						cwd: input.cwd,
					});
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
				}),
			);
		}
		if (!hasCodexFeatureEnabled(codexArgs, CODEX_HOOKS_FEATURE_NAME)) {
			codexArgs.push("--enable", CODEX_HOOKS_FEATURE_NAME);
		}
		if (hooks) {
			// Keep Quarterdeck's Codex hooks launch-scoped so standalone Codex app/GUI
			// sessions are unaffected. Codex supports inline [hooks] config via -c.
			const hookOverrides = buildCodexHookConfigOverrides();
			codexArgs.push(...hookOverrides);
			log.debug("Codex hook launch config prepared", {
				taskId: hooks.taskId,
				projectId: hooks.projectId,
				featureName: CODEX_HOOKS_FEATURE_NAME,
				hookEventCount: hookOverrides.length / 2,
				resumeConversation: input.resumeConversation ?? false,
				hasResumeSessionId: !!input.resumeSessionId?.trim(),
			});
		} else {
			log.debug("Codex launch has no Quarterdeck hook context", {
				taskId: input.taskId,
				featureName: CODEX_HOOKS_FEATURE_NAME,
			});
		}

		if (!hasCodexConfigOverride(codexArgs, "developer_instructions")) {
			const worktreeContext = await buildWorktreeContextPrompt({
				cwd: input.cwd,
				projectPath: input.projectPath,
				template: input.worktreeSystemPromptTemplate,
			});
			if (worktreeContext) {
				codexArgs.push("-c", `developer_instructions=${serializeCodexTomlValue(worktreeContext)}`);
			}
		}

		const trimmed = input.prompt.trim();
		if (trimmed) {
			codexArgs.push(trimmed);
		}

		log.debug("codex adapter prepared launch", {
			taskId: input.taskId,
			binary: binary ?? null,
			resumeConversation: input.resumeConversation ?? false,
			resumeSessionId: input.resumeSessionId ?? null,
			hasResumeArg: codexArgs.includes("resume"),
			hasLastFlag: hasCliOption(codexArgs, "--last"),
			codexArgCount: codexArgs.length,
			codexArgsPreview: codexArgs.map((arg) => (arg.length > 200 ? `${arg.slice(0, 200)}...(${arg.length})` : arg)),
		});
		return {
			binary,
			args: codexArgs,
			env,
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
		projectPath: input.projectPath ?? null,
		worktreeAddParentGitDir: input.worktreeAddParentGitDir ?? false,
		worktreeAddQuarterdeckDir: input.worktreeAddQuarterdeckDir ?? false,
		hasPrompt: input.prompt.trim().length > 0,
		imageCount: input.images?.length ?? 0,
		resumeConversation: input.resumeConversation ?? false,
		resumeSessionId: input.resumeSessionId ?? null,
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
