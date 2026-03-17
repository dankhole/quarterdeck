import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { RuntimeAgentId, RuntimeProjectShortcut } from "../core/api-contract.js";
import { detectInstalledCommands } from "../terminal/agent-registry.js";
import { areRuntimeProjectShortcutsEqual } from "./shortcut-utils.js";

type RuntimeClineOauthProvider = "cline" | "oca" | "openai-codex";

interface RuntimeClineSettingsFileShape {
	providerId?: string;
	modelId?: string;
	apiKey?: string;
	baseUrl?: string;
	oauthProvider?: RuntimeClineOauthProvider;
	auth?: {
		accessToken?: string;
		refreshToken?: string;
		accountId?: string;
		expiresAt?: number;
	};
}

interface RuntimeGlobalConfigFileShape {
	selectedAgentId?: RuntimeAgentId;
	selectedShortcutLabel?: string;
	agentAutonomousModeEnabled?: boolean;
	readyForReviewNotificationsEnabled?: boolean;
	clineSettings?: RuntimeClineSettingsFileShape;
	commitPromptTemplate?: string;
	openPrPromptTemplate?: string;
}

interface RuntimeProjectConfigFileShape {
	shortcuts?: RuntimeProjectShortcut[];
}

export interface RuntimeConfigState {
	globalConfigPath: string;
	projectConfigPath: string;
	selectedAgentId: RuntimeAgentId;
	selectedShortcutLabel: string | null;
	agentAutonomousModeEnabled: boolean;
	readyForReviewNotificationsEnabled: boolean;
	shortcuts: RuntimeProjectShortcut[];
	clineSettings: {
		providerId: string | null;
		modelId: string | null;
		apiKey: string | null;
		baseUrl: string | null;
		oauthProvider: RuntimeClineOauthProvider | null;
		auth: {
			accessToken: string | null;
			refreshToken: string | null;
			accountId: string | null;
			expiresAt: number | null;
		};
	};
	commitPromptTemplate: string;
	openPrPromptTemplate: string;
	commitPromptTemplateDefault: string;
	openPrPromptTemplateDefault: string;
}

export interface RuntimeConfigUpdateInput {
	selectedAgentId?: RuntimeAgentId;
	selectedShortcutLabel?: string | null;
	agentAutonomousModeEnabled?: boolean;
	readyForReviewNotificationsEnabled?: boolean;
	shortcuts?: RuntimeProjectShortcut[];
	clineProviderId?: string | null;
	clineModelId?: string | null;
	clineApiKey?: string | null;
	clineBaseUrl?: string | null;
	clineOauthProvider?: RuntimeClineOauthProvider | null;
	clineOauthAccessToken?: string | null;
	clineOauthRefreshToken?: string | null;
	clineOauthAccountId?: string | null;
	clineOauthExpiresAt?: number | null;
	commitPromptTemplate?: string;
	openPrPromptTemplate?: string;
}

const RUNTIME_HOME_DIR = ".kanban";
const CONFIG_FILENAME = "config.json";
const PROJECT_CONFIG_DIR = ".kanban";
const PROJECT_CONFIG_FILENAME = "config.json";
const DEFAULT_AGENT_ID: RuntimeAgentId = "cline";
const AUTO_SELECT_AGENT_PRIORITY: RuntimeAgentId[] = ["cline", "claude", "codex", "opencode", "droid", "gemini"];
const DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED = true;
const DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED = true;
const DEFAULT_COMMIT_PROMPT_TEMPLATE = `You are in a worktree on a detached HEAD. When you are finished with the task, commit the working changes onto {{base_ref}}.

- Do not run destructive commands: git reset --hard, git clean -fdx, git worktree remove, rm/mv on repository paths.
- Do not edit files outside git workflows unless required for conflict resolution.
- Preserve any pre-existing user uncommitted changes in the base worktree.

Steps:
1. In the current task worktree, stage and create a commit for the pending task changes.
2. Find where {{base_ref}} is checked out:
   - Run: git worktree list --porcelain
   - If branch {{base_ref}} is checked out in path P, use that P.
   - If not checked out anywhere, use current worktree as P by checking out {{base_ref}} there.
3. In P, verify current branch is {{base_ref}}.
4. If P has uncommitted changes, stash them: git -C P stash push -u -m "kanban-pre-cherry-pick"
5. Cherry-pick the task commit into P.
6. If cherry-pick conflicts, resolve carefully, preserving both the intended task changes and existing user edits.
7. If a stash was created, restore it with: git -C P stash pop
8. If stash pop conflicts, resolve them while preserving pre-existing user edits.
9. Report:
   - Final commit hash
   - Final commit message
   - Whether stash was used
   - Whether conflicts were resolved
   - Any remaining manual follow-up needed`;
const DEFAULT_OPEN_PR_PROMPT_TEMPLATE = `You are in a worktree on a detached HEAD. When you are finished with the task, open a pull request against {{base_ref}}.

- Do not run destructive commands: git reset --hard, git clean -fdx, git worktree remove, rm/mv on repository paths.
- Do not modify the base worktree.
- Keep all PR preparation in the current task worktree.

Steps:
1. Ensure all intended changes are committed in the current task worktree.
2. If currently on detached HEAD, create a branch at the current commit in this worktree.
3. Push the branch to origin and set upstream.
4. Create a pull request with base {{base_ref}} and head as the pushed branch (use gh CLI if available).
5. If a pull request already exists for the same head and base, return that existing PR URL instead of creating a duplicate.
6. If PR creation is blocked, explain exactly why and provide the exact commands to complete it manually.
7. Report:
   - PR title: PR URL
   - Base branch
   - Head branch
   - Any follow-up needed`;

export function pickBestInstalledAgentIdFromDetected(detectedCommands: readonly string[]): RuntimeAgentId | null {
	const detected = new Set(detectedCommands);
	for (const agentId of AUTO_SELECT_AGENT_PRIORITY) {
		if (detected.has(agentId)) {
			return agentId;
		}
	}
	return null;
}

function getRuntimeHomePath(): string {
	return join(homedir(), RUNTIME_HOME_DIR);
}

function normalizeAgentId(agentId: RuntimeAgentId | string | null | undefined): RuntimeAgentId {
	if (
		agentId === "claude" ||
		agentId === "codex" ||
		agentId === "gemini" ||
		agentId === "opencode" ||
		agentId === "droid" ||
		agentId === "cline"
	) {
		return agentId;
	}
	return DEFAULT_AGENT_ID;
}

function pickBestInstalledAgentId(): RuntimeAgentId | null {
	return pickBestInstalledAgentIdFromDetected(detectInstalledCommands());
}

function normalizeShortcut(shortcut: RuntimeProjectShortcut): RuntimeProjectShortcut | null {
	if (!shortcut || typeof shortcut !== "object") {
		return null;
	}

	const label = typeof shortcut.label === "string" ? shortcut.label.trim() : "";
	const command = typeof shortcut.command === "string" ? shortcut.command.trim() : "";
	const icon = typeof shortcut.icon === "string" ? shortcut.icon.trim() : "";

	if (!label || !command) {
		return null;
	}

	return {
		label,
		command,
		icon: icon || undefined,
	};
}

function normalizeShortcuts(shortcuts: RuntimeProjectShortcut[] | null | undefined): RuntimeProjectShortcut[] {
	if (!Array.isArray(shortcuts)) {
		return [];
	}
	const normalized: RuntimeProjectShortcut[] = [];
	for (const shortcut of shortcuts) {
		const parsed = normalizeShortcut(shortcut);
		if (parsed) {
			normalized.push(parsed);
		}
	}
	return normalized;
}

function normalizePromptTemplate(value: unknown, fallback: string): string {
	if (typeof value !== "string") {
		return fallback;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? value : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	return fallback;
}

function normalizeShortcutLabel(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalStringValue(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function normalizeClineOauthProvider(value: unknown): RuntimeClineOauthProvider | null {
	if (value === "cline" || value === "oca" || value === "openai-codex") {
		return value;
	}
	return null;
}

function normalizeOptionalPositiveInteger(value: unknown): number | null {
	if (typeof value !== "number") {
		return null;
	}
	if (!Number.isInteger(value) || value <= 0) {
		return null;
	}
	return value;
}

function hasOwnKey<T extends object>(value: T | null, key: keyof T): boolean {
	if (!value) {
		return false;
	}
	return Object.hasOwn(value, key);
}

export function getRuntimeGlobalConfigPath(): string {
	return join(getRuntimeHomePath(), CONFIG_FILENAME);
}

export function getRuntimeProjectConfigPath(cwd: string): string {
	return join(resolve(cwd), PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILENAME);
}

function toRuntimeConfigState({
	globalConfigPath,
	projectConfigPath,
	globalConfig,
	projectConfig,
}: {
	globalConfigPath: string;
	projectConfigPath: string;
	globalConfig: RuntimeGlobalConfigFileShape | null;
	projectConfig: RuntimeProjectConfigFileShape | null;
}): RuntimeConfigState {
	return {
		globalConfigPath,
		projectConfigPath,
		selectedAgentId: normalizeAgentId(globalConfig?.selectedAgentId),
		selectedShortcutLabel: normalizeShortcutLabel(globalConfig?.selectedShortcutLabel),
		agentAutonomousModeEnabled: normalizeBoolean(
			globalConfig?.agentAutonomousModeEnabled,
			DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED,
		),
		readyForReviewNotificationsEnabled: normalizeBoolean(
			globalConfig?.readyForReviewNotificationsEnabled,
			DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED,
		),
		shortcuts: normalizeShortcuts(projectConfig?.shortcuts),
		clineSettings: {
			providerId: normalizeOptionalStringValue(globalConfig?.clineSettings?.providerId),
			modelId: normalizeOptionalStringValue(globalConfig?.clineSettings?.modelId),
			apiKey: normalizeOptionalStringValue(globalConfig?.clineSettings?.apiKey),
			baseUrl: normalizeOptionalStringValue(globalConfig?.clineSettings?.baseUrl),
			oauthProvider: normalizeClineOauthProvider(globalConfig?.clineSettings?.oauthProvider),
			auth: {
				accessToken: normalizeOptionalStringValue(globalConfig?.clineSettings?.auth?.accessToken),
				refreshToken: normalizeOptionalStringValue(globalConfig?.clineSettings?.auth?.refreshToken),
				accountId: normalizeOptionalStringValue(globalConfig?.clineSettings?.auth?.accountId),
				expiresAt: normalizeOptionalPositiveInteger(globalConfig?.clineSettings?.auth?.expiresAt),
			},
		},
		commitPromptTemplate: normalizePromptTemplate(globalConfig?.commitPromptTemplate, DEFAULT_COMMIT_PROMPT_TEMPLATE),
		openPrPromptTemplate: normalizePromptTemplate(
			globalConfig?.openPrPromptTemplate,
			DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
		),
		commitPromptTemplateDefault: DEFAULT_COMMIT_PROMPT_TEMPLATE,
		openPrPromptTemplateDefault: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
	};
}

async function readRuntimeConfigFile<T>(configPath: string): Promise<T | null> {
	try {
		const raw = await readFile(configPath, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

async function writeRuntimeGlobalConfigFile(
	configPath: string,
	config: {
		selectedAgentId?: RuntimeAgentId;
		selectedShortcutLabel?: string | null;
		agentAutonomousModeEnabled?: boolean;
		readyForReviewNotificationsEnabled?: boolean;
		clineProviderId?: string | null;
		clineModelId?: string | null;
		clineApiKey?: string | null;
		clineBaseUrl?: string | null;
		clineOauthProvider?: RuntimeClineOauthProvider | null;
		clineOauthAccessToken?: string | null;
		clineOauthRefreshToken?: string | null;
		clineOauthAccountId?: string | null;
		clineOauthExpiresAt?: number | null;
		commitPromptTemplate?: string;
		openPrPromptTemplate?: string;
	},
): Promise<void> {
	const existing = await readRuntimeConfigFile<RuntimeGlobalConfigFileShape>(configPath);
	const selectedAgentId = config.selectedAgentId === undefined ? undefined : normalizeAgentId(config.selectedAgentId);
	const existingSelectedAgentId = hasOwnKey(existing, "selectedAgentId")
		? normalizeAgentId(existing?.selectedAgentId)
		: undefined;
	const selectedShortcutLabel =
		config.selectedShortcutLabel === undefined ? undefined : normalizeShortcutLabel(config.selectedShortcutLabel);
	const existingSelectedShortcutLabel = hasOwnKey(existing, "selectedShortcutLabel")
		? normalizeShortcutLabel(existing?.selectedShortcutLabel)
		: undefined;
	const agentAutonomousModeEnabled =
		config.agentAutonomousModeEnabled === undefined
			? DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED
			: normalizeBoolean(config.agentAutonomousModeEnabled, DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED);
	const readyForReviewNotificationsEnabled =
		config.readyForReviewNotificationsEnabled === undefined
			? DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED
			: normalizeBoolean(config.readyForReviewNotificationsEnabled, DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED);
	const clineProviderId =
		config.clineProviderId === undefined ? undefined : normalizeOptionalStringValue(config.clineProviderId);
	const existingClineProviderId = normalizeOptionalStringValue(existing?.clineSettings?.providerId);
	const clineModelId =
		config.clineModelId === undefined ? undefined : normalizeOptionalStringValue(config.clineModelId);
	const existingClineModelId = normalizeOptionalStringValue(existing?.clineSettings?.modelId);
	const clineApiKey =
		config.clineApiKey === undefined ? undefined : normalizeOptionalStringValue(config.clineApiKey);
	const existingClineApiKey = normalizeOptionalStringValue(existing?.clineSettings?.apiKey);
	const clineBaseUrl =
		config.clineBaseUrl === undefined ? undefined : normalizeOptionalStringValue(config.clineBaseUrl);
	const existingClineBaseUrl = normalizeOptionalStringValue(existing?.clineSettings?.baseUrl);
	const clineOauthProvider =
		config.clineOauthProvider === undefined ? undefined : normalizeClineOauthProvider(config.clineOauthProvider);
	const existingClineOauthProvider = normalizeClineOauthProvider(existing?.clineSettings?.oauthProvider);
	const clineOauthAccessToken =
		config.clineOauthAccessToken === undefined
			? undefined
			: normalizeOptionalStringValue(config.clineOauthAccessToken);
	const existingClineOauthAccessToken = normalizeOptionalStringValue(existing?.clineSettings?.auth?.accessToken);
	const clineOauthRefreshToken =
		config.clineOauthRefreshToken === undefined
			? undefined
			: normalizeOptionalStringValue(config.clineOauthRefreshToken);
	const existingClineOauthRefreshToken = normalizeOptionalStringValue(existing?.clineSettings?.auth?.refreshToken);
	const clineOauthAccountId =
		config.clineOauthAccountId === undefined
			? undefined
			: normalizeOptionalStringValue(config.clineOauthAccountId);
	const existingClineOauthAccountId = normalizeOptionalStringValue(existing?.clineSettings?.auth?.accountId);
	const clineOauthExpiresAt =
		config.clineOauthExpiresAt === undefined
			? undefined
			: normalizeOptionalPositiveInteger(config.clineOauthExpiresAt);
	const existingClineOauthExpiresAt = normalizeOptionalPositiveInteger(existing?.clineSettings?.auth?.expiresAt);
	const commitPromptTemplate =
		config.commitPromptTemplate === undefined
			? DEFAULT_COMMIT_PROMPT_TEMPLATE
			: normalizePromptTemplate(config.commitPromptTemplate, DEFAULT_COMMIT_PROMPT_TEMPLATE);
	const openPrPromptTemplate =
		config.openPrPromptTemplate === undefined
			? DEFAULT_OPEN_PR_PROMPT_TEMPLATE
			: normalizePromptTemplate(config.openPrPromptTemplate, DEFAULT_OPEN_PR_PROMPT_TEMPLATE);

	const payload: RuntimeGlobalConfigFileShape = {};
	if (selectedAgentId !== undefined) {
		if (hasOwnKey(existing, "selectedAgentId") || selectedAgentId !== DEFAULT_AGENT_ID) {
			payload.selectedAgentId = selectedAgentId;
		}
	} else if (existingSelectedAgentId !== undefined) {
		payload.selectedAgentId = existingSelectedAgentId;
	}
	if (selectedShortcutLabel !== undefined) {
		if (selectedShortcutLabel) {
			payload.selectedShortcutLabel = selectedShortcutLabel;
		}
	} else if (existingSelectedShortcutLabel) {
		payload.selectedShortcutLabel = existingSelectedShortcutLabel;
	}
	if (
		hasOwnKey(existing, "agentAutonomousModeEnabled") ||
		agentAutonomousModeEnabled !== DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED
	) {
		payload.agentAutonomousModeEnabled = agentAutonomousModeEnabled;
	}
	if (
		hasOwnKey(existing, "readyForReviewNotificationsEnabled") ||
		readyForReviewNotificationsEnabled !== DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED
	) {
		payload.readyForReviewNotificationsEnabled = readyForReviewNotificationsEnabled;
	}
	const nextClineProviderId = clineProviderId === undefined ? existingClineProviderId : clineProviderId;
	const nextClineModelId = clineModelId === undefined ? existingClineModelId : clineModelId;
	const nextClineApiKey = clineApiKey === undefined ? existingClineApiKey : clineApiKey;
	const nextClineBaseUrl = clineBaseUrl === undefined ? existingClineBaseUrl : clineBaseUrl;
	const nextClineOauthProvider =
		clineOauthProvider === undefined ? existingClineOauthProvider : clineOauthProvider;
	const nextClineOauthAccessToken =
		clineOauthAccessToken === undefined ? existingClineOauthAccessToken : clineOauthAccessToken;
	const nextClineOauthRefreshToken =
		clineOauthRefreshToken === undefined ? existingClineOauthRefreshToken : clineOauthRefreshToken;
	const nextClineOauthAccountId =
		clineOauthAccountId === undefined ? existingClineOauthAccountId : clineOauthAccountId;
	const nextClineOauthExpiresAt =
		clineOauthExpiresAt === undefined ? existingClineOauthExpiresAt : clineOauthExpiresAt;
	if (
		nextClineProviderId ||
		nextClineModelId ||
		nextClineApiKey ||
		nextClineBaseUrl ||
		nextClineOauthProvider ||
		nextClineOauthAccessToken ||
		nextClineOauthRefreshToken ||
		nextClineOauthAccountId ||
		nextClineOauthExpiresAt
	) {
		payload.clineSettings = {
			...(nextClineProviderId ? { providerId: nextClineProviderId } : {}),
			...(nextClineModelId ? { modelId: nextClineModelId } : {}),
			...(nextClineApiKey ? { apiKey: nextClineApiKey } : {}),
			...(nextClineBaseUrl ? { baseUrl: nextClineBaseUrl } : {}),
			...(nextClineOauthProvider ? { oauthProvider: nextClineOauthProvider } : {}),
			...((nextClineOauthAccessToken ||
				nextClineOauthRefreshToken ||
				nextClineOauthAccountId ||
				nextClineOauthExpiresAt) && {
				auth: {
					...(nextClineOauthAccessToken ? { accessToken: nextClineOauthAccessToken } : {}),
					...(nextClineOauthRefreshToken ? { refreshToken: nextClineOauthRefreshToken } : {}),
					...(nextClineOauthAccountId ? { accountId: nextClineOauthAccountId } : {}),
					...(nextClineOauthExpiresAt ? { expiresAt: nextClineOauthExpiresAt } : {}),
				},
			}),
		};
	}
	if (hasOwnKey(existing, "commitPromptTemplate") || commitPromptTemplate !== DEFAULT_COMMIT_PROMPT_TEMPLATE) {
		payload.commitPromptTemplate = commitPromptTemplate;
	}
	if (hasOwnKey(existing, "openPrPromptTemplate") || openPrPromptTemplate !== DEFAULT_OPEN_PR_PROMPT_TEMPLATE) {
		payload.openPrPromptTemplate = openPrPromptTemplate;
	}

	await mkdir(dirname(configPath), { recursive: true });
	await writeFile(configPath, JSON.stringify(payload, null, 2), "utf8");
}

async function writeRuntimeProjectConfigFile(
	configPath: string,
	config: { shortcuts: RuntimeProjectShortcut[] },
): Promise<void> {
	const normalizedShortcuts = normalizeShortcuts(config.shortcuts);
	if (normalizedShortcuts.length === 0) {
		await rm(configPath, { force: true });
		try {
			await rm(dirname(configPath));
		} catch {
			// Ignore missing or non-empty project config directories.
		}
		return;
	}
	await mkdir(dirname(configPath), { recursive: true });
	await writeFile(
		configPath,
		JSON.stringify(
			{
				shortcuts: normalizedShortcuts,
			} satisfies RuntimeProjectConfigFileShape,
			null,
			2,
		),
		"utf8",
	);
}

export async function loadRuntimeConfig(cwd: string): Promise<RuntimeConfigState> {
	const globalConfigPath = getRuntimeGlobalConfigPath();
	const projectConfigPath = getRuntimeProjectConfigPath(cwd);
	let globalConfig = await readRuntimeConfigFile<RuntimeGlobalConfigFileShape>(globalConfigPath);
	const projectConfig = await readRuntimeConfigFile<RuntimeProjectConfigFileShape>(projectConfigPath);
	if (globalConfig === null) {
		const autoSelectedAgentId = pickBestInstalledAgentId();
		if (autoSelectedAgentId) {
			await writeRuntimeGlobalConfigFile(globalConfigPath, {
				selectedAgentId: autoSelectedAgentId,
			});
			globalConfig = {
				...(globalConfig ?? {}),
				selectedAgentId: autoSelectedAgentId,
			};
		}
	}
	return toRuntimeConfigState({
		globalConfigPath,
		projectConfigPath,
		globalConfig,
		projectConfig,
	});
}

export async function saveRuntimeConfig(
	cwd: string,
	config: {
		selectedAgentId: RuntimeAgentId;
		selectedShortcutLabel: string | null;
		agentAutonomousModeEnabled: boolean;
		readyForReviewNotificationsEnabled: boolean;
		shortcuts: RuntimeProjectShortcut[];
		clineProviderId?: string | null;
		clineModelId?: string | null;
		clineApiKey?: string | null;
		clineBaseUrl?: string | null;
		clineOauthProvider?: RuntimeClineOauthProvider | null;
		clineOauthAccessToken?: string | null;
		clineOauthRefreshToken?: string | null;
		clineOauthAccountId?: string | null;
		clineOauthExpiresAt?: number | null;
		commitPromptTemplate: string;
		openPrPromptTemplate: string;
	},
): Promise<RuntimeConfigState> {
	const globalConfigPath = getRuntimeGlobalConfigPath();
	const projectConfigPath = getRuntimeProjectConfigPath(cwd);
	await writeRuntimeGlobalConfigFile(globalConfigPath, {
		selectedAgentId: config.selectedAgentId,
		selectedShortcutLabel: config.selectedShortcutLabel,
		agentAutonomousModeEnabled: config.agentAutonomousModeEnabled,
		readyForReviewNotificationsEnabled: config.readyForReviewNotificationsEnabled,
		clineProviderId: config.clineProviderId,
		clineModelId: config.clineModelId,
		clineApiKey: config.clineApiKey,
		clineBaseUrl: config.clineBaseUrl,
		clineOauthProvider: config.clineOauthProvider,
		clineOauthAccessToken: config.clineOauthAccessToken,
		clineOauthRefreshToken: config.clineOauthRefreshToken,
		clineOauthAccountId: config.clineOauthAccountId,
		clineOauthExpiresAt: config.clineOauthExpiresAt,
		commitPromptTemplate: config.commitPromptTemplate,
		openPrPromptTemplate: config.openPrPromptTemplate,
	});
	await writeRuntimeProjectConfigFile(projectConfigPath, { shortcuts: config.shortcuts });
	return {
		globalConfigPath,
		projectConfigPath,
		selectedAgentId: normalizeAgentId(config.selectedAgentId),
		selectedShortcutLabel: normalizeShortcutLabel(config.selectedShortcutLabel),
		agentAutonomousModeEnabled: normalizeBoolean(
			config.agentAutonomousModeEnabled,
			DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED,
		),
		readyForReviewNotificationsEnabled: normalizeBoolean(
			config.readyForReviewNotificationsEnabled,
			DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED,
		),
		shortcuts: normalizeShortcuts(config.shortcuts),
		clineSettings: {
			providerId: normalizeOptionalStringValue(config.clineProviderId),
			modelId: normalizeOptionalStringValue(config.clineModelId),
			apiKey: normalizeOptionalStringValue(config.clineApiKey),
			baseUrl: normalizeOptionalStringValue(config.clineBaseUrl),
			oauthProvider: normalizeClineOauthProvider(config.clineOauthProvider),
			auth: {
				accessToken: normalizeOptionalStringValue(config.clineOauthAccessToken),
				refreshToken: normalizeOptionalStringValue(config.clineOauthRefreshToken),
				accountId: normalizeOptionalStringValue(config.clineOauthAccountId),
				expiresAt: normalizeOptionalPositiveInteger(config.clineOauthExpiresAt),
			},
		},
		commitPromptTemplate: normalizePromptTemplate(config.commitPromptTemplate, DEFAULT_COMMIT_PROMPT_TEMPLATE),
		openPrPromptTemplate: normalizePromptTemplate(config.openPrPromptTemplate, DEFAULT_OPEN_PR_PROMPT_TEMPLATE),
		commitPromptTemplateDefault: DEFAULT_COMMIT_PROMPT_TEMPLATE,
		openPrPromptTemplateDefault: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
	};
}

export async function updateRuntimeConfig(cwd: string, updates: RuntimeConfigUpdateInput): Promise<RuntimeConfigState> {
	const current = await loadRuntimeConfig(cwd);
	const nextConfig = {
		selectedAgentId: updates.selectedAgentId ?? current.selectedAgentId,
		selectedShortcutLabel:
			updates.selectedShortcutLabel === undefined ? current.selectedShortcutLabel : updates.selectedShortcutLabel,
		agentAutonomousModeEnabled: updates.agentAutonomousModeEnabled ?? current.agentAutonomousModeEnabled,
		readyForReviewNotificationsEnabled:
			updates.readyForReviewNotificationsEnabled ?? current.readyForReviewNotificationsEnabled,
		shortcuts: updates.shortcuts ?? current.shortcuts,
		clineProviderId:
			updates.clineProviderId === undefined ? current.clineSettings.providerId : updates.clineProviderId,
		clineModelId: updates.clineModelId === undefined ? current.clineSettings.modelId : updates.clineModelId,
		clineApiKey: updates.clineApiKey === undefined ? current.clineSettings.apiKey : updates.clineApiKey,
		clineBaseUrl: updates.clineBaseUrl === undefined ? current.clineSettings.baseUrl : updates.clineBaseUrl,
		clineOauthProvider:
			updates.clineOauthProvider === undefined ? current.clineSettings.oauthProvider : updates.clineOauthProvider,
		clineOauthAccessToken:
			updates.clineOauthAccessToken === undefined
				? current.clineSettings.auth.accessToken
				: updates.clineOauthAccessToken,
		clineOauthRefreshToken:
			updates.clineOauthRefreshToken === undefined
				? current.clineSettings.auth.refreshToken
				: updates.clineOauthRefreshToken,
		clineOauthAccountId:
			updates.clineOauthAccountId === undefined
				? current.clineSettings.auth.accountId
				: updates.clineOauthAccountId,
		clineOauthExpiresAt:
			updates.clineOauthExpiresAt === undefined
				? current.clineSettings.auth.expiresAt
				: updates.clineOauthExpiresAt,
		commitPromptTemplate: updates.commitPromptTemplate ?? current.commitPromptTemplate,
		openPrPromptTemplate: updates.openPrPromptTemplate ?? current.openPrPromptTemplate,
	};

	const hasChanges =
		nextConfig.selectedAgentId !== current.selectedAgentId ||
		nextConfig.selectedShortcutLabel !== current.selectedShortcutLabel ||
		nextConfig.agentAutonomousModeEnabled !== current.agentAutonomousModeEnabled ||
		nextConfig.readyForReviewNotificationsEnabled !== current.readyForReviewNotificationsEnabled ||
		nextConfig.clineProviderId !== current.clineSettings.providerId ||
		nextConfig.clineModelId !== current.clineSettings.modelId ||
		nextConfig.clineApiKey !== current.clineSettings.apiKey ||
		nextConfig.clineBaseUrl !== current.clineSettings.baseUrl ||
		nextConfig.clineOauthProvider !== current.clineSettings.oauthProvider ||
		nextConfig.clineOauthAccessToken !== current.clineSettings.auth.accessToken ||
		nextConfig.clineOauthRefreshToken !== current.clineSettings.auth.refreshToken ||
		nextConfig.clineOauthAccountId !== current.clineSettings.auth.accountId ||
		nextConfig.clineOauthExpiresAt !== current.clineSettings.auth.expiresAt ||
		nextConfig.commitPromptTemplate !== current.commitPromptTemplate ||
		nextConfig.openPrPromptTemplate !== current.openPrPromptTemplate ||
		!areRuntimeProjectShortcutsEqual(nextConfig.shortcuts, current.shortcuts);

	if (!hasChanges) {
		return current;
	}

	return await saveRuntimeConfig(cwd, nextConfig);
}
