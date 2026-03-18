import { TRPCError } from "@trpc/server";
import {
	getValidClineCredentials,
	getValidOcaCredentials,
	getValidOpenAICodexCredentials,
	loginClineOAuth,
	loginOcaOAuth,
	loginOpenAICodex,
	ProviderSettingsManager,
} from "../../third_party/cline-sdk/packages/core/dist/server/index.js";
import { models as llmsModels } from "../../third_party/cline-sdk/packages/llms/dist/index.js";
import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service.js";
import type { RuntimeConfigState } from "../config/runtime-config.js";
import { isHomeAgentSessionId } from "../core/home-agent-session.js";
import { updateRuntimeConfig } from "../config/runtime-config.js";
import type { RuntimeClineProviderModel, RuntimeCommandRunResponse } from "../core/api-contract.js";
import {
	parseClineOauthLoginRequest,
	parseClineProviderModelsRequest,
	parseCommandRunRequest,
	parseRuntimeConfigSaveRequest,
	parseShellSessionStartRequest,
	parseTaskChatAbortRequest,
	parseTaskChatCancelRequest,
	parseTaskChatMessagesRequest,
	parseTaskChatSendRequest,
	parseTaskSessionInputRequest,
	parseTaskSessionStartRequest,
	parseTaskSessionStopRequest,
} from "../core/api-validation.js";
import { openInBrowser } from "../server/browser.js";
import { buildRuntimeConfigResponse, resolveAgentCommand } from "../terminal/agent-registry.js";
import type { TerminalSessionManager } from "../terminal/session-manager.js";
import { resolveTaskCwd } from "../workspace/task-worktree.js";
import { captureTaskTurnCheckpoint } from "../workspace/turn-checkpoints.js";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "./app-router.js";

const DEFAULT_CLINE_OAUTH_API_BASE_URL = "https://api.cline.bot";
const WORKOS_TOKEN_PREFIX = "workos:";

function createRuntimeOauthCallbacks(providerId: "cline" | "oca" | "openai-codex") {
	let authUrl: string | null = null;
	return {
		onAuth: ({ url }: { url: string; instructions?: string }) => {
			authUrl = url;
			openInBrowser(url);
		},
		onPrompt: async () => {
			throw new Error(
				authUrl
					? `Browser callback did not complete. Open this URL and complete sign in: ${authUrl}`
					: `Browser callback did not complete for ${providerId}.`,
			);
		},
		onProgress: () => {},
	};
}

type ManagedOauthProviderId = "cline" | "oca" | "openai-codex";

interface OAuthResolution {
	providerId: ManagedOauthProviderId;
	apiKey: string;
	auth: {
		accessToken: string;
		refreshToken: string;
		accountId: string | null;
		expiresAt: number;
	};
}

function isManagedOauthProviderId(providerId: string): providerId is ManagedOauthProviderId {
	return providerId === "cline" || providerId === "oca" || providerId === "openai-codex";
}

function inferManagedOauthProviderId(runtimeConfig: RuntimeConfigState): ManagedOauthProviderId | null {
	const oauthProviderId = runtimeConfig.clineSettings.oauthProvider?.trim().toLowerCase() ?? "";
	if (isManagedOauthProviderId(oauthProviderId)) {
		return oauthProviderId;
	}
	const hasOauthTokens =
		(runtimeConfig.clineSettings.auth.accessToken?.trim().length ?? 0) > 0 &&
		(runtimeConfig.clineSettings.auth.refreshToken?.trim().length ?? 0) > 0;
	if (hasOauthTokens) {
		return "cline";
	}
	const authAccessToken = runtimeConfig.clineSettings.auth.accessToken?.trim() ?? "";
	if (authAccessToken.toLowerCase().startsWith(WORKOS_TOKEN_PREFIX)) {
		return "cline";
	}
	const apiKey = runtimeConfig.clineSettings.apiKey?.trim() ?? "";
	if (apiKey.toLowerCase().startsWith(WORKOS_TOKEN_PREFIX)) {
		return "cline";
	}
	return null;
}

function resolveManagedOauthProviderId(
	runtimeConfig: RuntimeConfigState,
	configuredProviderId: string | null,
): ManagedOauthProviderId | null {
	const normalizedProviderId = configuredProviderId?.trim().toLowerCase() ?? "";
	if (normalizedProviderId.length > 0) {
		if (!isManagedOauthProviderId(normalizedProviderId)) {
			return null;
		}
		return normalizedProviderId;
	}
	return inferManagedOauthProviderId(runtimeConfig);
}

function resolveConfiguredClineProviderId(
	runtimeConfig: RuntimeConfigState,
	oauthResolution: OAuthResolution | null,
): string | null {
	const explicitProviderId = runtimeConfig.clineSettings.providerId?.trim().toLowerCase() ?? "";
	if (explicitProviderId.length > 0) {
		return explicitProviderId;
	}
	if (oauthResolution?.providerId) {
		return oauthResolution.providerId;
	}
	const inferredManagedProviderId = inferManagedOauthProviderId(runtimeConfig);
	if (inferredManagedProviderId) {
		return inferredManagedProviderId;
	}
	const apiKey = runtimeConfig.clineSettings.apiKey?.trim() ?? "";
	if (apiKey.toLowerCase().startsWith(WORKOS_TOKEN_PREFIX)) {
		return "cline";
	}
	return null;
}

function normalizeEpochMs(expiresAt: number | null | undefined): number {
	if (!expiresAt || !Number.isFinite(expiresAt) || expiresAt <= 0) {
		return Date.now() - 1;
	}
	if (expiresAt >= 1_000_000_000_000) {
		return Math.floor(expiresAt);
	}
	return Math.floor(expiresAt * 1000);
}

function toConfigExpirySeconds(expiresAtMs: number): number {
	return Math.max(1, Math.floor(expiresAtMs / 1000));
}

function stripWorkosPrefix(accessToken: string): string {
	if (accessToken.toLowerCase().startsWith(WORKOS_TOKEN_PREFIX)) {
		return accessToken.slice(WORKOS_TOKEN_PREFIX.length);
	}
	return accessToken;
}

function toProviderApiKey(providerId: ManagedOauthProviderId, accessToken: string): string {
	if (providerId === "cline") {
		return `${WORKOS_TOKEN_PREFIX}${accessToken}`;
	}
	return accessToken;
}

function toStoredOauthAccessToken(providerId: ManagedOauthProviderId, accessToken: string): string {
	const normalized = stripWorkosPrefix(accessToken.trim());
	if (!normalized) {
		return "";
	}
	return toProviderApiKey(providerId, normalized);
}

function toRuntimeProviderModel(
	modelId: string,
	modelInfo: { name?: string; capabilities?: string[] },
): RuntimeClineProviderModel {
	const capabilities = new Set(modelInfo.capabilities ?? []);
	const supportsVision = capabilities.has("images");
	const supportsAttachments = capabilities.has("files") || supportsVision;
	return {
		id: modelId,
		name: modelInfo.name?.trim() || modelId,
		supportsVision: supportsVision || undefined,
		supportsAttachments: supportsAttachments || undefined,
	};
}

function resolveEffectiveProviderApiKey(input: {
	runtimeConfig: RuntimeConfigState;
	providerId: string;
	oauthResolution: OAuthResolution | null;
}): string | null {
	const oauthApiKey =
		input.oauthResolution && input.oauthResolution.providerId === input.providerId
			? input.oauthResolution.apiKey.trim()
			: "";
	if (oauthApiKey.length > 0) {
		return oauthApiKey;
	}
	const configuredApiKey = input.runtimeConfig.clineSettings.apiKey?.trim() ?? "";
	return configuredApiKey.length > 0 ? configuredApiKey : null;
}

async function resolveOauthApiKey(
	runtimeConfig: RuntimeConfigState,
	configuredProviderId: string | null,
): Promise<OAuthResolution | null> {
	const providerId = resolveManagedOauthProviderId(runtimeConfig, configuredProviderId);
	if (!providerId) {
		return null;
	}
	const accessToken = runtimeConfig.clineSettings.auth.accessToken?.trim() ?? "";
	const refreshToken = runtimeConfig.clineSettings.auth.refreshToken?.trim() ?? "";
	if (!accessToken || !refreshToken) {
		return null;
	}

	const normalizedAccessToken = providerId === "cline" ? stripWorkosPrefix(accessToken) : accessToken;
	if (!normalizedAccessToken) {
		return null;
	}

	const currentCredentials = {
		access: normalizedAccessToken,
		refresh: refreshToken,
		expires: normalizeEpochMs(runtimeConfig.clineSettings.auth.expiresAt),
		accountId: runtimeConfig.clineSettings.auth.accountId ?? undefined,
	};

	if (providerId === "cline") {
		const nextCredentials = await getValidClineCredentials(currentCredentials, {
			apiBaseUrl: runtimeConfig.clineSettings.baseUrl?.trim() || DEFAULT_CLINE_OAUTH_API_BASE_URL,
			provider: runtimeConfig.clineSettings.oauthProvider?.trim() || undefined,
		});
		if (!nextCredentials) {
			throw new Error('OAuth credentials for provider "cline" are invalid. Re-run OAuth login.');
		}
		return {
			providerId,
			apiKey: toProviderApiKey(providerId, nextCredentials.access),
			auth: {
				accessToken: nextCredentials.access,
				refreshToken: nextCredentials.refresh,
				accountId: nextCredentials.accountId ?? null,
				expiresAt: toConfigExpirySeconds(nextCredentials.expires),
			},
		};
	}

	if (providerId === "oca") {
		const configuredBaseUrl = runtimeConfig.clineSettings.baseUrl?.trim() || null;
		const nextCredentials = await getValidOcaCredentials(
			currentCredentials,
			undefined,
			configuredBaseUrl
				? {
						mode: configuredBaseUrl.includes("code-internal") ? "internal" : "external",
						config: {
							internal: { baseUrl: configuredBaseUrl },
							external: { baseUrl: configuredBaseUrl },
						},
					}
				: undefined,
		);
		if (!nextCredentials) {
			throw new Error('OAuth credentials for provider "oca" are invalid. Re-run OAuth login.');
		}
		return {
			providerId,
			apiKey: toProviderApiKey(providerId, nextCredentials.access),
			auth: {
				accessToken: nextCredentials.access,
				refreshToken: nextCredentials.refresh,
				accountId: nextCredentials.accountId ?? null,
				expiresAt: toConfigExpirySeconds(nextCredentials.expires),
			},
		};
	}

	const nextCredentials = await getValidOpenAICodexCredentials(currentCredentials);
	if (!nextCredentials) {
		throw new Error('OAuth credentials for provider "openai-codex" are invalid. Re-run OAuth login.');
	}
	return {
		providerId,
		apiKey: toProviderApiKey(providerId, nextCredentials.access),
		auth: {
			accessToken: nextCredentials.access,
			refreshToken: nextCredentials.refresh,
			accountId: nextCredentials.accountId ?? null,
			expiresAt: toConfigExpirySeconds(nextCredentials.expires),
		},
	};
}

async function persistResolvedOauthIfChanged(
	deps: CreateRuntimeApiDependencies,
	workspaceScope: RuntimeTrpcWorkspaceScope,
	runtimeConfig: RuntimeConfigState,
	oauthResolution: OAuthResolution,
): Promise<void> {
	const currentAuth = runtimeConfig.clineSettings.auth;
	if (
		currentAuth.accessToken === oauthResolution.auth.accessToken &&
		currentAuth.refreshToken === oauthResolution.auth.refreshToken &&
		currentAuth.accountId === oauthResolution.auth.accountId &&
		currentAuth.expiresAt === oauthResolution.auth.expiresAt
	) {
		return;
	}
	const nextRuntimeConfig = await updateRuntimeConfig(workspaceScope.workspacePath, {
		clineOauthAccessToken: oauthResolution.auth.accessToken,
		clineOauthRefreshToken: oauthResolution.auth.refreshToken,
		clineOauthAccountId: oauthResolution.auth.accountId,
		clineOauthExpiresAt: oauthResolution.auth.expiresAt,
	});
	if (workspaceScope.workspaceId === deps.getActiveWorkspaceId()) {
		deps.setActiveRuntimeConfig(nextRuntimeConfig);
	}
}

function syncSdkProviderSettings(input: {
	runtimeConfig: RuntimeConfigState;
	oauthResolution: OAuthResolution | null;
}): void {
	const providerId = resolveConfiguredClineProviderId(input.runtimeConfig, input.oauthResolution) ?? "";
	if (!providerId) {
		return;
	}

	try {
		const manager = new ProviderSettingsManager();
		const modelId = input.runtimeConfig.clineSettings.modelId?.trim() ?? "";
		const baseUrl = input.runtimeConfig.clineSettings.baseUrl?.trim() ?? "";
		const oauthAuth =
			isManagedOauthProviderId(providerId) &&
			input.oauthResolution &&
			input.oauthResolution.providerId === providerId
				? input.oauthResolution.auth
				: input.runtimeConfig.clineSettings.auth;

		const storedOauthAccessToken =
			isManagedOauthProviderId(providerId) && oauthAuth.accessToken?.trim()
				? toStoredOauthAccessToken(providerId, oauthAuth.accessToken)
				: "";
		const oauthRefreshToken = oauthAuth.refreshToken?.trim() ?? "";
		const hasOauth = storedOauthAccessToken.length > 0 && oauthRefreshToken.length > 0;

		const payload: Record<string, unknown> = {
			provider: providerId,
		};
		if (modelId) {
			payload.model = modelId;
		}
		if (baseUrl) {
			payload.baseUrl = baseUrl;
		}
		if (providerId === "oca") {
			payload.oca = {
				mode: baseUrl.includes("code-internal") ? "internal" : "external",
			};
		}
		if (hasOauth) {
			payload.auth = {
				accessToken: storedOauthAccessToken,
				refreshToken: oauthRefreshToken,
				accountId: oauthAuth.accountId?.trim() || undefined,
				expiresAt: normalizeEpochMs(oauthAuth.expiresAt),
			};
		}
		const effectiveApiKey = resolveEffectiveProviderApiKey({
			runtimeConfig: input.runtimeConfig,
			providerId,
			oauthResolution: input.oauthResolution,
		});
		if (effectiveApiKey) {
			payload.apiKey = effectiveApiKey;
		}

		manager.saveProviderSettings(payload, {
			setLastUsed: false,
			tokenSource: hasOauth ? "oauth" : "manual",
		});
	} catch {
		// Best effort sync only.
	}
}

export interface CreateRuntimeApiDependencies {
	getActiveWorkspaceId: () => string | null;
	loadScopedRuntimeConfig: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeConfigState>;
	setActiveRuntimeConfig: (config: RuntimeConfigState) => void;
	getScopedTerminalManager: (scope: RuntimeTrpcWorkspaceScope) => Promise<TerminalSessionManager>;
	getScopedClineTaskSessionService: (scope: RuntimeTrpcWorkspaceScope) => Promise<ClineTaskSessionService>;
	resolveInteractiveShellCommand: () => { binary: string; args: string[] };
	runCommand: (command: string, cwd: string) => Promise<RuntimeCommandRunResponse>;
}

interface ResolvedClineLaunchConfig {
	providerId: string;
	modelId: string | null;
	apiKey: string | null;
	baseUrl: string | null;
}

async function resolveClineLaunchConfig(
	deps: CreateRuntimeApiDependencies,
	workspaceScope: RuntimeTrpcWorkspaceScope,
	runtimeConfig: RuntimeConfigState,
): Promise<ResolvedClineLaunchConfig> {
	const configuredProviderId = resolveConfiguredClineProviderId(runtimeConfig, null);
	const oauthResolution = await resolveOauthApiKey(runtimeConfig, configuredProviderId);
	const providerId = resolveConfiguredClineProviderId(runtimeConfig, oauthResolution) ?? "cline";
	const apiKey = resolveEffectiveProviderApiKey({
		runtimeConfig,
		providerId,
		oauthResolution,
	});

	if (oauthResolution) {
		await persistResolvedOauthIfChanged(deps, workspaceScope, runtimeConfig, oauthResolution);
	}

	syncSdkProviderSettings({
		runtimeConfig,
		oauthResolution,
	});

	return {
		providerId,
		modelId: runtimeConfig.clineSettings.modelId,
		apiKey,
		baseUrl: runtimeConfig.clineSettings.baseUrl,
	};
}

async function resolveExistingTaskCwdOrEnsure(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
}): Promise<string> {
	try {
		return await resolveTaskCwd({
			cwd: options.cwd,
			taskId: options.taskId,
			baseRef: options.baseRef,
			ensure: false,
		});
	} catch {
		return await resolveTaskCwd({
			cwd: options.cwd,
			taskId: options.taskId,
			baseRef: options.baseRef,
			ensure: true,
		});
	}
}

export function createRuntimeApi(deps: CreateRuntimeApiDependencies): RuntimeTrpcContext["runtimeApi"] {
	return {
		loadConfig: async (workspaceScope) => {
			const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
			return buildRuntimeConfigResponse(scopedRuntimeConfig);
		},
		saveConfig: async (workspaceScope, input) => {
			const parsed = parseRuntimeConfigSaveRequest(input);
			const nextRuntimeConfig = await updateRuntimeConfig(workspaceScope.workspacePath, parsed);
			if (workspaceScope.workspaceId === deps.getActiveWorkspaceId()) {
				deps.setActiveRuntimeConfig(nextRuntimeConfig);
			}
			return buildRuntimeConfigResponse(nextRuntimeConfig);
		},
		startTaskSession: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionStartRequest(input);
				const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
				const taskCwd = isHomeAgentSessionId(body.taskId)
					? workspaceScope.workspacePath
					: await resolveExistingTaskCwdOrEnsure({
							cwd: workspaceScope.workspacePath,
							taskId: body.taskId,
							baseRef: body.baseRef,
						});
				const shouldCaptureTurnCheckpoint = !body.resumeFromTrash && !isHomeAgentSessionId(body.taskId);

				if (scopedRuntimeConfig.selectedAgentId === "cline") {
					const clineLaunchConfig = await resolveClineLaunchConfig(deps, workspaceScope, scopedRuntimeConfig);
					const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
					const summary = await clineTaskSessionService.startTaskSession({
						taskId: body.taskId,
						cwd: taskCwd,
						prompt: body.prompt,
						resumeFromTrash: body.resumeFromTrash,
						providerId: clineLaunchConfig.providerId,
						modelId: clineLaunchConfig.modelId,
						apiKey: clineLaunchConfig.apiKey,
						baseUrl: clineLaunchConfig.baseUrl,
					});

					let nextSummary = summary;
					if (shouldCaptureTurnCheckpoint) {
						try {
							const nextTurn = (summary.latestTurnCheckpoint?.turn ?? 0) + 1;
							const checkpoint = await captureTaskTurnCheckpoint({
								cwd: taskCwd,
								taskId: body.taskId,
								turn: nextTurn,
							});
							nextSummary = clineTaskSessionService.applyTurnCheckpoint(body.taskId, checkpoint) ?? summary;
						} catch {
							// Best effort checkpointing only.
						}
					}

					return {
						ok: true,
						summary: nextSummary,
					};
				}

				const resolved = resolveAgentCommand(scopedRuntimeConfig);
				if (!resolved) {
					return {
						ok: false,
						summary: null,
						error: "No runnable agent command is configured. Open Settings, install a supported CLI, and select it.",
					};
				}
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const summary = await terminalManager.startTaskSession({
					taskId: body.taskId,
					agentId: resolved.agentId,
					binary: resolved.binary,
					args: resolved.args,
					autonomousModeEnabled: scopedRuntimeConfig.agentAutonomousModeEnabled,
					cwd: taskCwd,
					prompt: body.prompt,
					startInPlanMode: body.startInPlanMode,
					resumeFromTrash: body.resumeFromTrash,
					cols: body.cols,
					rows: body.rows,
					workspaceId: workspaceScope.workspaceId,
				});

				let nextSummary = summary;
				if (shouldCaptureTurnCheckpoint) {
					try {
						const nextTurn = (summary.latestTurnCheckpoint?.turn ?? 0) + 1;
						const checkpoint = await captureTaskTurnCheckpoint({
							cwd: taskCwd,
							taskId: body.taskId,
							turn: nextTurn,
						});
						nextSummary = terminalManager.applyTurnCheckpoint(body.taskId, checkpoint) ?? summary;
					} catch {
						// Best effort checkpointing only.
					}
				}
				return {
					ok: true,
					summary: nextSummary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		stopTaskSession: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionStopRequest(input);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const clineSummary = await clineTaskSessionService.stopTaskSession(body.taskId);
				if (clineSummary) {
					return {
						ok: true,
						summary: clineSummary,
					};
				}
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const summary = terminalManager.stopTaskSession(body.taskId);
				return {
					ok: Boolean(summary),
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		sendTaskSessionInput: async (workspaceScope, input) => {
			try {
				const body = parseTaskSessionInputRequest(input);
				const payloadText = body.appendNewline ? `${body.text}\n` : body.text;
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const clineSummary = await clineTaskSessionService.sendTaskSessionInput(body.taskId, payloadText);
				if (clineSummary) {
					return {
						ok: true,
						summary: clineSummary,
					};
				}
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const summary = terminalManager.writeInput(body.taskId, Buffer.from(payloadText, "utf8"));
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task session is not running.",
					};
				}
				return {
					ok: true,
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		getTaskChatMessages: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatMessagesRequest(input);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const summary = clineTaskSessionService.getSummary(body.taskId);
				const messages = clineTaskSessionService.listMessages(body.taskId);
				if (!summary && messages.length === 0) {
					return {
						ok: false,
						messages: [],
						error: "Task chat session is not available.",
					};
				}
				return {
					ok: true,
					messages,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					messages: [],
					error: message,
				};
			}
		},
		abortTaskChatTurn: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatAbortRequest(input);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const summary = await clineTaskSessionService.abortTaskSession(body.taskId);
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task chat session is not running.",
					};
				}
				return {
					ok: true,
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		cancelTaskChatTurn: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatCancelRequest(input);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				const summary = await clineTaskSessionService.cancelTaskTurn(body.taskId);
				if (!summary) {
					return {
						ok: false,
						summary: null,
						error: "Task chat session turn is not running.",
					};
				}
				return {
					ok: true,
					summary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		getClineProviderCatalog: async (workspaceScope) => {
			const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
			const selectedProviderId = scopedRuntimeConfig.clineSettings.providerId?.trim().toLowerCase() ?? "";
			const providers: Array<{
				id: string;
				name: string;
				oauthSupported: boolean;
				enabled: boolean;
				defaultModelId: string | null;
			}> = await llmsModels
				.getAllProviders()
				.then(
					(
						sdkProviders: Array<{
							id: string;
							name: string;
							defaultModelId?: string;
							capabilities?: string[];
						}>,
					) =>
						sdkProviders
							.map((provider) => ({
								id: provider.id,
								name: provider.name,
								oauthSupported: (provider.capabilities ?? []).includes("oauth"),
								enabled:
									selectedProviderId.length > 0 ? selectedProviderId === provider.id : provider.id === "cline",
								defaultModelId: provider.defaultModelId ?? null,
							}))
							.sort((left, right) => {
								if (left.id === "cline") {
									return -1;
								}
								if (right.id === "cline") {
									return 1;
								}
								return left.name.localeCompare(right.name);
							}),
				)
				.catch(() => []);
			if (selectedProviderId.length > 0 && !providers.some((provider) => provider.id === selectedProviderId)) {
				providers.unshift({
					id: selectedProviderId,
					name: selectedProviderId,
					oauthSupported: false,
					enabled: true,
					defaultModelId: scopedRuntimeConfig.clineSettings.modelId,
				});
			}
			return {
				providers,
			};
		},
		getClineProviderModels: async (workspaceScope, input) => {
			const body = parseClineProviderModelsRequest(input);
			const normalizedProviderId = body.providerId.trim().toLowerCase();
			const providerModels =
				normalizedProviderId.length > 0
					? await llmsModels
							.getModelsForProvider(normalizedProviderId)
							.then((sdkModels: Record<string, { name?: string; capabilities?: string[] } | unknown>) =>
								Object.entries(sdkModels)
									.map(([modelId, modelInfo]) => {
										const parsedModelInfo =
											typeof modelInfo === "object" && modelInfo !== null
												? (modelInfo as {
														name?: unknown;
														capabilities?: unknown;
													})
												: null;
										return toRuntimeProviderModel(modelId, {
											name: typeof parsedModelInfo?.name === "string" ? parsedModelInfo.name : undefined,
											capabilities: Array.isArray(parsedModelInfo?.capabilities)
												? parsedModelInfo.capabilities.filter(
														(value): value is string => typeof value === "string",
													)
												: undefined,
										});
									})
									.sort((left, right) => left.name.localeCompare(right.name)),
							)
							.catch(() => [])
					: [];
			if (providerModels.length > 0) {
				return {
					providerId: normalizedProviderId,
					models: providerModels,
				};
			}
			const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
			const configuredModel = scopedRuntimeConfig.clineSettings.modelId?.trim() ?? "";
			if (configuredModel.length > 0) {
				return {
					providerId: normalizedProviderId || body.providerId,
					models: [{ id: configuredModel, name: configuredModel }],
				};
			}
			return {
				providerId: normalizedProviderId || body.providerId,
				models: [],
			};
		},
		runClineProviderOAuthLogin: async (workspaceScope, input) => {
			const body = parseClineOauthLoginRequest(input);
			const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
			try {
				if (body.provider === "cline") {
					const credentials = await loginClineOAuth({
						apiBaseUrl: scopedRuntimeConfig.clineSettings.baseUrl?.trim() || DEFAULT_CLINE_OAUTH_API_BASE_URL,
						provider: scopedRuntimeConfig.clineSettings.oauthProvider?.trim() || undefined,
						callbacks: createRuntimeOauthCallbacks("cline"),
					});
					return {
						ok: true,
						provider: body.provider,
						accessToken: credentials.access,
						refreshToken: credentials.refresh,
						accountId: credentials.accountId ?? null,
						expiresAt: Math.max(1, Math.floor(credentials.expires / 1000)),
					};
				}

				if (body.provider === "oca") {
					const configuredBaseUrl = scopedRuntimeConfig.clineSettings.baseUrl?.trim() || null;
					const credentials = await loginOcaOAuth({
						mode: configuredBaseUrl?.includes("code-internal") ? "internal" : "external",
						config: configuredBaseUrl
							? {
									internal: { baseUrl: configuredBaseUrl },
									external: { baseUrl: configuredBaseUrl },
								}
							: undefined,
						callbacks: createRuntimeOauthCallbacks("oca"),
					});
					return {
						ok: true,
						provider: body.provider,
						accessToken: credentials.access,
						refreshToken: credentials.refresh,
						accountId: credentials.accountId ?? null,
						expiresAt: Math.max(1, Math.floor(credentials.expires / 1000)),
					};
				}

				const credentials = await loginOpenAICodex({
					...createRuntimeOauthCallbacks("openai-codex"),
					originator: "kanban-runtime",
				});
				return {
					ok: true,
					provider: body.provider,
					accessToken: credentials.access,
					refreshToken: credentials.refresh,
					accountId: credentials.accountId ?? null,
					expiresAt: Math.max(1, Math.floor(credentials.expires / 1000)),
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					provider: body.provider,
					error: message,
				};
			}
		},
		sendTaskChatMessage: async (workspaceScope, input) => {
			try {
				const body = parseTaskChatSendRequest(input);
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
				let summary = await clineTaskSessionService.sendTaskSessionInput(body.taskId, body.text);
				if (!summary) {
					if (!isHomeAgentSessionId(body.taskId)) {
						return {
							ok: false,
							summary: null,
							error: "Task chat session is not running.",
						};
					}
					const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
					const clineLaunchConfig = await resolveClineLaunchConfig(deps, workspaceScope, scopedRuntimeConfig);
					summary = await clineTaskSessionService.startTaskSession({
						taskId: body.taskId,
						cwd: workspaceScope.workspacePath,
						prompt: body.text,
						providerId: clineLaunchConfig.providerId,
						modelId: clineLaunchConfig.modelId,
						apiKey: clineLaunchConfig.apiKey,
						baseUrl: clineLaunchConfig.baseUrl,
					});
				}
				const latestMessage = clineTaskSessionService.listMessages(body.taskId).at(-1) ?? null;
				return {
					ok: true,
					summary,
					message: latestMessage,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					error: message,
				};
			}
		},
		startShellSession: async (workspaceScope, input) => {
			try {
				const body = parseShellSessionStartRequest(input);
				const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
				const shell = deps.resolveInteractiveShellCommand();
				const shellCwd = body.workspaceTaskId
					? await resolveTaskCwd({
							cwd: workspaceScope.workspacePath,
							taskId: body.workspaceTaskId,
							baseRef: body.baseRef,
							ensure: true,
						})
					: workspaceScope.workspacePath;
				const summary = await terminalManager.startShellSession({
					taskId: body.taskId,
					cwd: shellCwd,
					cols: body.cols,
					rows: body.rows,
					binary: shell.binary,
					args: shell.args,
				});
				return {
					ok: true,
					summary,
					shellBinary: shell.binary,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					ok: false,
					summary: null,
					shellBinary: null,
					error: message,
				};
			}
		},
		runCommand: async (workspaceScope, input) => {
			try {
				const body = parseCommandRunRequest(input);
				return await deps.runCommand(body.command, workspaceScope.workspacePath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message,
				});
			}
		},
	};
}
