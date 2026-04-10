// Persists Quarterdeck-owned runtime preferences on disk.
// This module should store Quarterdeck settings such as selected agents,
// shortcuts, and prompt templates.
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isRuntimeAgentLaunchSupported } from "../core/agent-catalog";
import type { PromptShortcut, RuntimeAgentId, RuntimeProjectShortcut } from "../core/api-contract";
import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/workspace-state";
import { detectInstalledCommands } from "../terminal/agent-registry";
import {
	DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED,
	DEFAULT_AGENT_ID,
	DEFAULT_AUDIBLE_NOTIFICATION_EVENTS,
	DEFAULT_AUDIBLE_NOTIFICATION_VOLUME,
	DEFAULT_AUDIBLE_NOTIFICATIONS_ENABLED,
	DEFAULT_AUDIBLE_NOTIFICATIONS_ONLY_WHEN_HIDDEN,
	DEFAULT_AUTO_GENERATE_SUMMARY,
	DEFAULT_BACKGROUND_TASK_POLL_MS,
	DEFAULT_COMMIT_PROMPT_TEMPLATE,
	DEFAULT_FOCUSED_TASK_POLL_MS,
	DEFAULT_HOME_REPO_POLL_MS,
	DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
	DEFAULT_PROMPT_SHORTCUTS,
	DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED,
	DEFAULT_SHELL_AUTO_RESTART_ENABLED,
	DEFAULT_SHOW_SUMMARY_ON_CARDS,
	DEFAULT_SHOW_TRASH_WORKTREE_NOTICE,
	DEFAULT_SKIP_HOME_CHECKOUT_CONFIRMATION,
	DEFAULT_SKIP_TASK_CHECKOUT_CONFIRMATION,
	DEFAULT_SUMMARY_STALE_AFTER_SECONDS,
	DEFAULT_UNMERGED_CHANGES_INDICATOR_ENABLED,
} from "./config-defaults";
import { areRuntimeProjectShortcutsEqual } from "./shortcut-utils";

interface AudibleNotificationEventsShape {
	permission?: boolean;
	review?: boolean;
	failure?: boolean;
	completion?: boolean;
}

interface RuntimeGlobalConfigFileShape {
	selectedAgentId?: RuntimeAgentId;
	selectedShortcutLabel?: string;
	agentAutonomousModeEnabled?: boolean;
	readyForReviewNotificationsEnabled?: boolean;
	shellAutoRestartEnabled?: boolean;
	promptShortcuts?: Array<{ label: string; prompt: string }>;
	showSummaryOnCards?: boolean;
	autoGenerateSummary?: boolean;
	summaryStaleAfterSeconds?: number;
	showTrashWorktreeNotice?: boolean;
	unmergedChangesIndicatorEnabled?: boolean;
	skipTaskCheckoutConfirmation?: boolean;
	skipHomeCheckoutConfirmation?: boolean;
	commitPromptTemplate?: string;
	openPrPromptTemplate?: string;
	audibleNotificationsEnabled?: boolean;
	audibleNotificationVolume?: number;
	audibleNotificationEvents?: AudibleNotificationEventsShape;
	audibleNotificationsOnlyWhenHidden?: boolean;
	focusedTaskPollMs?: number;
	backgroundTaskPollMs?: number;
	homeRepoPollMs?: number;
}

interface RuntimeProjectConfigFileShape {
	shortcuts?: RuntimeProjectShortcut[];
}

export interface AudibleNotificationEvents {
	permission: boolean;
	review: boolean;
	failure: boolean;
	completion: boolean;
}

export interface RuntimeConfigState {
	globalConfigPath: string;
	projectConfigPath: string | null;
	selectedAgentId: RuntimeAgentId;
	selectedShortcutLabel: string | null;
	agentAutonomousModeEnabled: boolean;
	readyForReviewNotificationsEnabled: boolean;
	shellAutoRestartEnabled: boolean;
	showSummaryOnCards: boolean;
	autoGenerateSummary: boolean;
	summaryStaleAfterSeconds: number;
	showTrashWorktreeNotice: boolean;
	unmergedChangesIndicatorEnabled: boolean;
	skipTaskCheckoutConfirmation: boolean;
	skipHomeCheckoutConfirmation: boolean;
	audibleNotificationsEnabled: boolean;
	audibleNotificationVolume: number;
	audibleNotificationEvents: AudibleNotificationEvents;
	audibleNotificationsOnlyWhenHidden: boolean;
	focusedTaskPollMs: number;
	backgroundTaskPollMs: number;
	homeRepoPollMs: number;
	shortcuts: RuntimeProjectShortcut[];
	promptShortcuts: PromptShortcut[];
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
	shellAutoRestartEnabled?: boolean;
	showSummaryOnCards?: boolean;
	autoGenerateSummary?: boolean;
	summaryStaleAfterSeconds?: number;
	showTrashWorktreeNotice?: boolean;
	unmergedChangesIndicatorEnabled?: boolean;
	skipTaskCheckoutConfirmation?: boolean;
	skipHomeCheckoutConfirmation?: boolean;
	audibleNotificationsEnabled?: boolean;
	audibleNotificationVolume?: number;
	audibleNotificationEvents?: AudibleNotificationEventsShape;
	audibleNotificationsOnlyWhenHidden?: boolean;
	focusedTaskPollMs?: number;
	backgroundTaskPollMs?: number;
	homeRepoPollMs?: number;
	shortcuts?: RuntimeProjectShortcut[];
	promptShortcuts?: PromptShortcut[];
	commitPromptTemplate?: string;
	openPrPromptTemplate?: string;
}

const CONFIG_FILENAME = "config.json";
const PROJECT_CONFIG_DIR = ".quarterdeck";
const PROJECT_CONFIG_FILENAME = "config.json";
const AUTO_SELECT_AGENT_PRIORITY: readonly RuntimeAgentId[] = ["claude", "codex"];
const MIN_POLL_INTERVAL_MS = 500;
const MAX_POLL_INTERVAL_MS = 60_000;

/** Assembled defaults for test fixtures — not used in production paths. */
export const DEFAULT_RUNTIME_CONFIG_STATE: RuntimeConfigState = {
	globalConfigPath: "",
	projectConfigPath: null,
	selectedAgentId: DEFAULT_AGENT_ID,
	selectedShortcutLabel: null,
	agentAutonomousModeEnabled: DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED,
	readyForReviewNotificationsEnabled: DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED,
	shellAutoRestartEnabled: DEFAULT_SHELL_AUTO_RESTART_ENABLED,
	showSummaryOnCards: DEFAULT_SHOW_SUMMARY_ON_CARDS,
	autoGenerateSummary: DEFAULT_AUTO_GENERATE_SUMMARY,
	summaryStaleAfterSeconds: DEFAULT_SUMMARY_STALE_AFTER_SECONDS,
	showTrashWorktreeNotice: DEFAULT_SHOW_TRASH_WORKTREE_NOTICE,
	unmergedChangesIndicatorEnabled: DEFAULT_UNMERGED_CHANGES_INDICATOR_ENABLED,
	skipTaskCheckoutConfirmation: DEFAULT_SKIP_TASK_CHECKOUT_CONFIRMATION,
	skipHomeCheckoutConfirmation: DEFAULT_SKIP_HOME_CHECKOUT_CONFIRMATION,
	audibleNotificationsEnabled: DEFAULT_AUDIBLE_NOTIFICATIONS_ENABLED,
	audibleNotificationVolume: DEFAULT_AUDIBLE_NOTIFICATION_VOLUME,
	audibleNotificationEvents: { ...DEFAULT_AUDIBLE_NOTIFICATION_EVENTS },
	audibleNotificationsOnlyWhenHidden: DEFAULT_AUDIBLE_NOTIFICATIONS_ONLY_WHEN_HIDDEN,
	focusedTaskPollMs: DEFAULT_FOCUSED_TASK_POLL_MS,
	backgroundTaskPollMs: DEFAULT_BACKGROUND_TASK_POLL_MS,
	homeRepoPollMs: DEFAULT_HOME_REPO_POLL_MS,
	shortcuts: [],
	promptShortcuts: [],
	commitPromptTemplate: DEFAULT_COMMIT_PROMPT_TEMPLATE,
	openPrPromptTemplate: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
	commitPromptTemplateDefault: DEFAULT_COMMIT_PROMPT_TEMPLATE,
	openPrPromptTemplateDefault: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
};

export { DEFAULT_PROMPT_SHORTCUTS } from "./config-defaults";

export function normalizePromptShortcuts(
	shortcuts: Array<{ label: string; prompt: string }> | null | undefined,
): PromptShortcut[] {
	if (!Array.isArray(shortcuts)) {
		return [...DEFAULT_PROMPT_SHORTCUTS];
	}
	const normalized: PromptShortcut[] = [];
	for (const shortcut of shortcuts) {
		if (!shortcut || typeof shortcut !== "object") {
			continue;
		}
		const label = typeof shortcut.label === "string" ? shortcut.label.trim() : "";
		const prompt = typeof shortcut.prompt === "string" ? shortcut.prompt.trim() : "";
		if (label && prompt) {
			normalized.push({ label, prompt });
		}
	}
	return normalized.length > 0 ? normalized : [...DEFAULT_PROMPT_SHORTCUTS];
}

export function pickBestInstalledAgentIdFromDetected(detectedCommands: readonly string[]): RuntimeAgentId | null {
	const detected = new Set(detectedCommands);
	for (const agentId of AUTO_SELECT_AGENT_PRIORITY) {
		if (detected.has(agentId)) {
			return agentId;
		}
	}
	return null;
}

function normalizeAgentId(agentId: RuntimeAgentId | string | null | undefined): RuntimeAgentId {
	if (
		(agentId === "claude" || agentId === "codex" || agentId === "gemini" || agentId === "opencode") &&
		isRuntimeAgentLaunchSupported(agentId)
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

function normalizeAudibleNotificationEvents(
	value: AudibleNotificationEventsShape | null | undefined,
): AudibleNotificationEvents {
	return {
		permission:
			typeof value?.permission === "boolean" ? value.permission : DEFAULT_AUDIBLE_NOTIFICATION_EVENTS.permission,
		review: typeof value?.review === "boolean" ? value.review : DEFAULT_AUDIBLE_NOTIFICATION_EVENTS.review,
		failure: typeof value?.failure === "boolean" ? value.failure : DEFAULT_AUDIBLE_NOTIFICATION_EVENTS.failure,
		completion:
			typeof value?.completion === "boolean" ? value.completion : DEFAULT_AUDIBLE_NOTIFICATION_EVENTS.completion,
	};
}

function normalizeVolume(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.max(0, Math.min(1, value));
	}
	return fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	return fallback;
}

function normalizeNumber(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	return fallback;
}

function normalizePollInterval(value: unknown, fallback: number): number {
	const normalized = normalizeNumber(value, fallback);
	return Math.max(MIN_POLL_INTERVAL_MS, Math.min(MAX_POLL_INTERVAL_MS, Math.round(normalized)));
}

function normalizeShortcutLabel(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
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

interface RuntimeConfigPaths {
	globalConfigPath: string;
	projectConfigPath: string | null;
}

function normalizePathForComparison(path: string): string {
	const normalized = resolve(path).replaceAll("\\", "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function resolveRuntimeConfigPaths(cwd: string | null): RuntimeConfigPaths {
	const globalConfigPath = getRuntimeGlobalConfigPath();
	if (cwd === null) {
		return {
			globalConfigPath,
			projectConfigPath: null,
		};
	}

	const normalizedCwd = normalizePathForComparison(cwd);
	const normalizedHome = normalizePathForComparison(homedir());
	if (normalizedCwd === normalizedHome) {
		return {
			globalConfigPath,
			projectConfigPath: null,
		};
	}

	return {
		globalConfigPath,
		projectConfigPath: getRuntimeProjectConfigPath(cwd),
	};
}

function getRuntimeConfigLockRequests(cwd: string | null): LockRequest[] {
	const paths = resolveRuntimeConfigPaths(cwd);
	const requests: LockRequest[] = [
		{
			path: paths.globalConfigPath,
			type: "file",
		},
	];
	if (paths.projectConfigPath) {
		requests.push({
			path: paths.projectConfigPath,
			type: "file",
		});
	}
	return requests;
}

function toRuntimeConfigState({
	globalConfigPath,
	projectConfigPath,
	globalConfig,
	projectConfig,
}: {
	globalConfigPath: string;
	projectConfigPath: string | null;
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
		shellAutoRestartEnabled: normalizeBoolean(
			globalConfig?.shellAutoRestartEnabled,
			DEFAULT_SHELL_AUTO_RESTART_ENABLED,
		),
		showSummaryOnCards: normalizeBoolean(globalConfig?.showSummaryOnCards, DEFAULT_SHOW_SUMMARY_ON_CARDS),
		autoGenerateSummary: normalizeBoolean(globalConfig?.autoGenerateSummary, DEFAULT_AUTO_GENERATE_SUMMARY),
		summaryStaleAfterSeconds: normalizeNumber(
			globalConfig?.summaryStaleAfterSeconds,
			DEFAULT_SUMMARY_STALE_AFTER_SECONDS,
		),
		showTrashWorktreeNotice: normalizeBoolean(
			globalConfig?.showTrashWorktreeNotice,
			DEFAULT_SHOW_TRASH_WORKTREE_NOTICE,
		),
		unmergedChangesIndicatorEnabled: normalizeBoolean(
			globalConfig?.unmergedChangesIndicatorEnabled,
			DEFAULT_UNMERGED_CHANGES_INDICATOR_ENABLED,
		),
		skipTaskCheckoutConfirmation: normalizeBoolean(
			globalConfig?.skipTaskCheckoutConfirmation,
			DEFAULT_SKIP_TASK_CHECKOUT_CONFIRMATION,
		),
		skipHomeCheckoutConfirmation: normalizeBoolean(
			globalConfig?.skipHomeCheckoutConfirmation,
			DEFAULT_SKIP_HOME_CHECKOUT_CONFIRMATION,
		),
		audibleNotificationsEnabled: normalizeBoolean(
			globalConfig?.audibleNotificationsEnabled,
			DEFAULT_AUDIBLE_NOTIFICATIONS_ENABLED,
		),
		audibleNotificationVolume: normalizeVolume(
			globalConfig?.audibleNotificationVolume,
			DEFAULT_AUDIBLE_NOTIFICATION_VOLUME,
		),
		audibleNotificationEvents: normalizeAudibleNotificationEvents(globalConfig?.audibleNotificationEvents),
		audibleNotificationsOnlyWhenHidden: normalizeBoolean(
			globalConfig?.audibleNotificationsOnlyWhenHidden,
			DEFAULT_AUDIBLE_NOTIFICATIONS_ONLY_WHEN_HIDDEN,
		),
		focusedTaskPollMs: normalizePollInterval(globalConfig?.focusedTaskPollMs, DEFAULT_FOCUSED_TASK_POLL_MS),
		backgroundTaskPollMs: normalizePollInterval(globalConfig?.backgroundTaskPollMs, DEFAULT_BACKGROUND_TASK_POLL_MS),
		homeRepoPollMs: normalizePollInterval(globalConfig?.homeRepoPollMs, DEFAULT_HOME_REPO_POLL_MS),
		shortcuts: normalizeShortcuts(projectConfig?.shortcuts),
		promptShortcuts: normalizePromptShortcuts(globalConfig?.promptShortcuts),
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
		shellAutoRestartEnabled?: boolean;
		promptShortcuts?: PromptShortcut[];
		showSummaryOnCards?: boolean;
		autoGenerateSummary?: boolean;
		summaryStaleAfterSeconds?: number;
		showTrashWorktreeNotice?: boolean;
		unmergedChangesIndicatorEnabled?: boolean;
		skipTaskCheckoutConfirmation?: boolean;
		skipHomeCheckoutConfirmation?: boolean;
		commitPromptTemplate?: string;
		openPrPromptTemplate?: string;
		audibleNotificationsEnabled?: boolean;
		audibleNotificationVolume?: number;
		audibleNotificationEvents?: AudibleNotificationEventsShape;
		audibleNotificationsOnlyWhenHidden?: boolean;
		focusedTaskPollMs?: number;
		backgroundTaskPollMs?: number;
		homeRepoPollMs?: number;
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
	const shellAutoRestartEnabled =
		config.shellAutoRestartEnabled === undefined
			? DEFAULT_SHELL_AUTO_RESTART_ENABLED
			: normalizeBoolean(config.shellAutoRestartEnabled, DEFAULT_SHELL_AUTO_RESTART_ENABLED);
	const showSummaryOnCards =
		config.showSummaryOnCards === undefined
			? DEFAULT_SHOW_SUMMARY_ON_CARDS
			: normalizeBoolean(config.showSummaryOnCards, DEFAULT_SHOW_SUMMARY_ON_CARDS);
	const autoGenerateSummary =
		config.autoGenerateSummary === undefined
			? DEFAULT_AUTO_GENERATE_SUMMARY
			: normalizeBoolean(config.autoGenerateSummary, DEFAULT_AUTO_GENERATE_SUMMARY);
	const summaryStaleAfterSeconds =
		config.summaryStaleAfterSeconds === undefined
			? DEFAULT_SUMMARY_STALE_AFTER_SECONDS
			: normalizeNumber(config.summaryStaleAfterSeconds, DEFAULT_SUMMARY_STALE_AFTER_SECONDS);
	const showTrashWorktreeNotice =
		config.showTrashWorktreeNotice === undefined
			? DEFAULT_SHOW_TRASH_WORKTREE_NOTICE
			: normalizeBoolean(config.showTrashWorktreeNotice, DEFAULT_SHOW_TRASH_WORKTREE_NOTICE);
	const unmergedChangesIndicatorEnabled =
		config.unmergedChangesIndicatorEnabled === undefined
			? DEFAULT_UNMERGED_CHANGES_INDICATOR_ENABLED
			: normalizeBoolean(config.unmergedChangesIndicatorEnabled, DEFAULT_UNMERGED_CHANGES_INDICATOR_ENABLED);
	const skipTaskCheckoutConfirmation =
		config.skipTaskCheckoutConfirmation === undefined
			? DEFAULT_SKIP_TASK_CHECKOUT_CONFIRMATION
			: normalizeBoolean(config.skipTaskCheckoutConfirmation, DEFAULT_SKIP_TASK_CHECKOUT_CONFIRMATION);
	const skipHomeCheckoutConfirmation =
		config.skipHomeCheckoutConfirmation === undefined
			? DEFAULT_SKIP_HOME_CHECKOUT_CONFIRMATION
			: normalizeBoolean(config.skipHomeCheckoutConfirmation, DEFAULT_SKIP_HOME_CHECKOUT_CONFIRMATION);
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
	if (
		hasOwnKey(existing, "shellAutoRestartEnabled") ||
		shellAutoRestartEnabled !== DEFAULT_SHELL_AUTO_RESTART_ENABLED
	) {
		payload.shellAutoRestartEnabled = shellAutoRestartEnabled;
	}
	if (config.promptShortcuts !== undefined) {
		payload.promptShortcuts = config.promptShortcuts;
	} else if (hasOwnKey(existing, "promptShortcuts")) {
		payload.promptShortcuts = existing?.promptShortcuts;
	}
	if (hasOwnKey(existing, "showSummaryOnCards") || showSummaryOnCards !== DEFAULT_SHOW_SUMMARY_ON_CARDS) {
		payload.showSummaryOnCards = showSummaryOnCards;
	}
	if (hasOwnKey(existing, "autoGenerateSummary") || autoGenerateSummary !== DEFAULT_AUTO_GENERATE_SUMMARY) {
		payload.autoGenerateSummary = autoGenerateSummary;
	}
	if (
		hasOwnKey(existing, "summaryStaleAfterSeconds") ||
		summaryStaleAfterSeconds !== DEFAULT_SUMMARY_STALE_AFTER_SECONDS
	) {
		payload.summaryStaleAfterSeconds = summaryStaleAfterSeconds;
	}
	if (
		hasOwnKey(existing, "showTrashWorktreeNotice") ||
		showTrashWorktreeNotice !== DEFAULT_SHOW_TRASH_WORKTREE_NOTICE
	) {
		payload.showTrashWorktreeNotice = showTrashWorktreeNotice;
	}
	if (
		hasOwnKey(existing, "unmergedChangesIndicatorEnabled") ||
		unmergedChangesIndicatorEnabled !== DEFAULT_UNMERGED_CHANGES_INDICATOR_ENABLED
	) {
		payload.unmergedChangesIndicatorEnabled = unmergedChangesIndicatorEnabled;
	}
	if (
		hasOwnKey(existing, "skipTaskCheckoutConfirmation") ||
		skipTaskCheckoutConfirmation !== DEFAULT_SKIP_TASK_CHECKOUT_CONFIRMATION
	) {
		payload.skipTaskCheckoutConfirmation = skipTaskCheckoutConfirmation;
	}
	if (
		hasOwnKey(existing, "skipHomeCheckoutConfirmation") ||
		skipHomeCheckoutConfirmation !== DEFAULT_SKIP_HOME_CHECKOUT_CONFIRMATION
	) {
		payload.skipHomeCheckoutConfirmation = skipHomeCheckoutConfirmation;
	}
	if (hasOwnKey(existing, "commitPromptTemplate") || commitPromptTemplate !== DEFAULT_COMMIT_PROMPT_TEMPLATE) {
		payload.commitPromptTemplate = commitPromptTemplate;
	}
	if (hasOwnKey(existing, "openPrPromptTemplate") || openPrPromptTemplate !== DEFAULT_OPEN_PR_PROMPT_TEMPLATE) {
		payload.openPrPromptTemplate = openPrPromptTemplate;
	}

	const audibleNotificationsEnabled =
		config.audibleNotificationsEnabled === undefined
			? DEFAULT_AUDIBLE_NOTIFICATIONS_ENABLED
			: normalizeBoolean(config.audibleNotificationsEnabled, DEFAULT_AUDIBLE_NOTIFICATIONS_ENABLED);
	const audibleNotificationVolume =
		config.audibleNotificationVolume === undefined
			? DEFAULT_AUDIBLE_NOTIFICATION_VOLUME
			: normalizeVolume(config.audibleNotificationVolume, DEFAULT_AUDIBLE_NOTIFICATION_VOLUME);
	const audibleNotificationEvents = normalizeAudibleNotificationEvents(
		config.audibleNotificationEvents ?? existing?.audibleNotificationEvents,
	);
	if (
		hasOwnKey(existing, "audibleNotificationsEnabled") ||
		audibleNotificationsEnabled !== DEFAULT_AUDIBLE_NOTIFICATIONS_ENABLED
	) {
		payload.audibleNotificationsEnabled = audibleNotificationsEnabled;
	}
	if (
		hasOwnKey(existing, "audibleNotificationVolume") ||
		audibleNotificationVolume !== DEFAULT_AUDIBLE_NOTIFICATION_VOLUME
	) {
		payload.audibleNotificationVolume = audibleNotificationVolume;
	}
	if (
		hasOwnKey(existing, "audibleNotificationEvents") ||
		audibleNotificationEvents.permission !== DEFAULT_AUDIBLE_NOTIFICATION_EVENTS.permission ||
		audibleNotificationEvents.review !== DEFAULT_AUDIBLE_NOTIFICATION_EVENTS.review ||
		audibleNotificationEvents.failure !== DEFAULT_AUDIBLE_NOTIFICATION_EVENTS.failure ||
		audibleNotificationEvents.completion !== DEFAULT_AUDIBLE_NOTIFICATION_EVENTS.completion
	) {
		payload.audibleNotificationEvents = audibleNotificationEvents;
	}
	const audibleNotificationsOnlyWhenHidden =
		config.audibleNotificationsOnlyWhenHidden === undefined
			? DEFAULT_AUDIBLE_NOTIFICATIONS_ONLY_WHEN_HIDDEN
			: normalizeBoolean(config.audibleNotificationsOnlyWhenHidden, DEFAULT_AUDIBLE_NOTIFICATIONS_ONLY_WHEN_HIDDEN);
	if (
		hasOwnKey(existing, "audibleNotificationsOnlyWhenHidden") ||
		audibleNotificationsOnlyWhenHidden !== DEFAULT_AUDIBLE_NOTIFICATIONS_ONLY_WHEN_HIDDEN
	) {
		payload.audibleNotificationsOnlyWhenHidden = audibleNotificationsOnlyWhenHidden;
	}

	const focusedTaskPollMs =
		config.focusedTaskPollMs === undefined
			? DEFAULT_FOCUSED_TASK_POLL_MS
			: normalizePollInterval(config.focusedTaskPollMs, DEFAULT_FOCUSED_TASK_POLL_MS);
	const backgroundTaskPollMs =
		config.backgroundTaskPollMs === undefined
			? DEFAULT_BACKGROUND_TASK_POLL_MS
			: normalizePollInterval(config.backgroundTaskPollMs, DEFAULT_BACKGROUND_TASK_POLL_MS);
	const homeRepoPollMs =
		config.homeRepoPollMs === undefined
			? DEFAULT_HOME_REPO_POLL_MS
			: normalizePollInterval(config.homeRepoPollMs, DEFAULT_HOME_REPO_POLL_MS);
	if (hasOwnKey(existing, "focusedTaskPollMs") || focusedTaskPollMs !== DEFAULT_FOCUSED_TASK_POLL_MS) {
		payload.focusedTaskPollMs = focusedTaskPollMs;
	}
	if (hasOwnKey(existing, "backgroundTaskPollMs") || backgroundTaskPollMs !== DEFAULT_BACKGROUND_TASK_POLL_MS) {
		payload.backgroundTaskPollMs = backgroundTaskPollMs;
	}
	if (hasOwnKey(existing, "homeRepoPollMs") || homeRepoPollMs !== DEFAULT_HOME_REPO_POLL_MS) {
		payload.homeRepoPollMs = homeRepoPollMs;
	}

	await lockedFileSystem.writeJsonFileAtomic(configPath, payload, {
		lock: null,
	});
}

async function writeRuntimeProjectConfigFile(
	configPath: string | null,
	config: { shortcuts: RuntimeProjectShortcut[] },
): Promise<void> {
	const normalizedShortcuts = normalizeShortcuts(config.shortcuts);
	if (!configPath) {
		if (normalizedShortcuts.length > 0) {
			throw new Error("Cannot save project shortcuts without a selected project.");
		}
		return;
	}
	if (normalizedShortcuts.length === 0) {
		await rm(configPath, { force: true });
		try {
			await rm(dirname(configPath));
		} catch {
			// Ignore missing or non-empty project config directories.
		}
		return;
	}
	await lockedFileSystem.writeJsonFileAtomic(
		configPath,
		{
			shortcuts: normalizedShortcuts,
		} satisfies RuntimeProjectConfigFileShape,
		{
			lock: null,
		},
	);
}

interface RuntimeConfigFiles {
	globalConfigPath: string;
	projectConfigPath: string | null;
	globalConfig: RuntimeGlobalConfigFileShape | null;
	projectConfig: RuntimeProjectConfigFileShape | null;
}

async function readRuntimeConfigFiles(cwd: string | null): Promise<RuntimeConfigFiles> {
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(cwd);
	return {
		globalConfigPath,
		projectConfigPath,
		globalConfig: await readRuntimeConfigFile<RuntimeGlobalConfigFileShape>(globalConfigPath),
		projectConfig: projectConfigPath
			? await readRuntimeConfigFile<RuntimeProjectConfigFileShape>(projectConfigPath)
			: null,
	};
}

async function loadRuntimeConfigLocked(cwd: string | null): Promise<RuntimeConfigState> {
	const configFiles = await readRuntimeConfigFiles(cwd);
	if (configFiles.globalConfig === null) {
		const autoSelectedAgentId = pickBestInstalledAgentId();
		if (autoSelectedAgentId) {
			await writeRuntimeGlobalConfigFile(configFiles.globalConfigPath, {
				selectedAgentId: autoSelectedAgentId,
			});
			configFiles.globalConfig = {
				selectedAgentId: autoSelectedAgentId,
			};
		}
	}
	return toRuntimeConfigState(configFiles);
}

function createRuntimeConfigStateFromValues(input: {
	globalConfigPath: string;
	projectConfigPath: string | null;
	selectedAgentId: RuntimeAgentId;
	selectedShortcutLabel: string | null;
	agentAutonomousModeEnabled: boolean;
	readyForReviewNotificationsEnabled: boolean;
	shellAutoRestartEnabled: boolean;
	showSummaryOnCards: boolean;
	autoGenerateSummary: boolean;
	summaryStaleAfterSeconds: number;
	showTrashWorktreeNotice: boolean;
	unmergedChangesIndicatorEnabled: boolean;
	skipTaskCheckoutConfirmation: boolean;
	skipHomeCheckoutConfirmation: boolean;
	audibleNotificationsEnabled: boolean;
	audibleNotificationVolume: number;
	audibleNotificationEvents: AudibleNotificationEvents;
	audibleNotificationsOnlyWhenHidden: boolean;
	focusedTaskPollMs: number;
	backgroundTaskPollMs: number;
	homeRepoPollMs: number;
	shortcuts: RuntimeProjectShortcut[];
	promptShortcuts: PromptShortcut[];
}): RuntimeConfigState {
	return {
		globalConfigPath: input.globalConfigPath,
		projectConfigPath: input.projectConfigPath,
		selectedAgentId: normalizeAgentId(input.selectedAgentId),
		selectedShortcutLabel: normalizeShortcutLabel(input.selectedShortcutLabel),
		agentAutonomousModeEnabled: normalizeBoolean(
			input.agentAutonomousModeEnabled,
			DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED,
		),
		readyForReviewNotificationsEnabled: normalizeBoolean(
			input.readyForReviewNotificationsEnabled,
			DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED,
		),
		shellAutoRestartEnabled: normalizeBoolean(input.shellAutoRestartEnabled, DEFAULT_SHELL_AUTO_RESTART_ENABLED),
		showSummaryOnCards: normalizeBoolean(input.showSummaryOnCards, DEFAULT_SHOW_SUMMARY_ON_CARDS),
		autoGenerateSummary: normalizeBoolean(input.autoGenerateSummary, DEFAULT_AUTO_GENERATE_SUMMARY),
		summaryStaleAfterSeconds: normalizeNumber(input.summaryStaleAfterSeconds, DEFAULT_SUMMARY_STALE_AFTER_SECONDS),
		showTrashWorktreeNotice: normalizeBoolean(input.showTrashWorktreeNotice, DEFAULT_SHOW_TRASH_WORKTREE_NOTICE),
		unmergedChangesIndicatorEnabled: normalizeBoolean(
			input.unmergedChangesIndicatorEnabled,
			DEFAULT_UNMERGED_CHANGES_INDICATOR_ENABLED,
		),
		skipTaskCheckoutConfirmation: normalizeBoolean(
			input.skipTaskCheckoutConfirmation,
			DEFAULT_SKIP_TASK_CHECKOUT_CONFIRMATION,
		),
		skipHomeCheckoutConfirmation: normalizeBoolean(
			input.skipHomeCheckoutConfirmation,
			DEFAULT_SKIP_HOME_CHECKOUT_CONFIRMATION,
		),
		audibleNotificationsEnabled: normalizeBoolean(
			input.audibleNotificationsEnabled,
			DEFAULT_AUDIBLE_NOTIFICATIONS_ENABLED,
		),
		audibleNotificationVolume: normalizeVolume(input.audibleNotificationVolume, DEFAULT_AUDIBLE_NOTIFICATION_VOLUME),
		audibleNotificationEvents: normalizeAudibleNotificationEvents(input.audibleNotificationEvents),
		audibleNotificationsOnlyWhenHidden: normalizeBoolean(
			input.audibleNotificationsOnlyWhenHidden,
			DEFAULT_AUDIBLE_NOTIFICATIONS_ONLY_WHEN_HIDDEN,
		),
		focusedTaskPollMs: normalizePollInterval(input.focusedTaskPollMs, DEFAULT_FOCUSED_TASK_POLL_MS),
		backgroundTaskPollMs: normalizePollInterval(input.backgroundTaskPollMs, DEFAULT_BACKGROUND_TASK_POLL_MS),
		homeRepoPollMs: normalizePollInterval(input.homeRepoPollMs, DEFAULT_HOME_REPO_POLL_MS),
		shortcuts: normalizeShortcuts(input.shortcuts),
		promptShortcuts: normalizePromptShortcuts(input.promptShortcuts),
		commitPromptTemplate: DEFAULT_COMMIT_PROMPT_TEMPLATE,
		openPrPromptTemplate: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
		commitPromptTemplateDefault: DEFAULT_COMMIT_PROMPT_TEMPLATE,
		openPrPromptTemplateDefault: DEFAULT_OPEN_PR_PROMPT_TEMPLATE,
	};
}

export function toGlobalRuntimeConfigState(current: RuntimeConfigState): RuntimeConfigState {
	return createRuntimeConfigStateFromValues({
		globalConfigPath: current.globalConfigPath,
		projectConfigPath: null,
		selectedAgentId: current.selectedAgentId,
		selectedShortcutLabel: current.selectedShortcutLabel,
		agentAutonomousModeEnabled: current.agentAutonomousModeEnabled,
		readyForReviewNotificationsEnabled: current.readyForReviewNotificationsEnabled,
		shellAutoRestartEnabled: current.shellAutoRestartEnabled,
		showSummaryOnCards: current.showSummaryOnCards,
		autoGenerateSummary: current.autoGenerateSummary,
		summaryStaleAfterSeconds: current.summaryStaleAfterSeconds,
		showTrashWorktreeNotice: current.showTrashWorktreeNotice,
		unmergedChangesIndicatorEnabled: current.unmergedChangesIndicatorEnabled,
		skipTaskCheckoutConfirmation: current.skipTaskCheckoutConfirmation,
		skipHomeCheckoutConfirmation: current.skipHomeCheckoutConfirmation,
		audibleNotificationsEnabled: current.audibleNotificationsEnabled,
		audibleNotificationVolume: current.audibleNotificationVolume,
		audibleNotificationEvents: current.audibleNotificationEvents,
		audibleNotificationsOnlyWhenHidden: current.audibleNotificationsOnlyWhenHidden,
		focusedTaskPollMs: current.focusedTaskPollMs,
		backgroundTaskPollMs: current.backgroundTaskPollMs,
		homeRepoPollMs: current.homeRepoPollMs,
		shortcuts: [],
		promptShortcuts: current.promptShortcuts,
	});
}

export async function loadRuntimeConfig(cwd: string): Promise<RuntimeConfigState> {
	const configFiles = await readRuntimeConfigFiles(cwd);
	if (configFiles.globalConfig !== null) {
		return toRuntimeConfigState(configFiles);
	}
	return await lockedFileSystem.withLocks(
		getRuntimeConfigLockRequests(cwd),
		async () => await loadRuntimeConfigLocked(cwd),
	);
}

export async function loadGlobalRuntimeConfig(): Promise<RuntimeConfigState> {
	const configFiles = await readRuntimeConfigFiles(null);
	if (configFiles.globalConfig !== null) {
		return toRuntimeConfigState(configFiles);
	}
	return await lockedFileSystem.withLocks(
		getRuntimeConfigLockRequests(null),
		async () => await loadRuntimeConfigLocked(null),
	);
}

export async function saveRuntimeConfig(
	cwd: string,
	config: {
		selectedAgentId: RuntimeAgentId;
		selectedShortcutLabel: string | null;
		agentAutonomousModeEnabled: boolean;
		readyForReviewNotificationsEnabled: boolean;
		shellAutoRestartEnabled: boolean;
		showSummaryOnCards: boolean;
		autoGenerateSummary: boolean;
		summaryStaleAfterSeconds: number;
		showTrashWorktreeNotice: boolean;
		unmergedChangesIndicatorEnabled: boolean;
		skipTaskCheckoutConfirmation: boolean;
		skipHomeCheckoutConfirmation: boolean;
		audibleNotificationsEnabled: boolean;
		audibleNotificationVolume: number;
		audibleNotificationEvents: AudibleNotificationEvents;
		audibleNotificationsOnlyWhenHidden: boolean;
		focusedTaskPollMs: number;
		backgroundTaskPollMs: number;
		homeRepoPollMs: number;
		shortcuts: RuntimeProjectShortcut[];
		promptShortcuts: PromptShortcut[];
	},
): Promise<RuntimeConfigState> {
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(cwd);
	return await lockedFileSystem.withLocks(getRuntimeConfigLockRequests(cwd), async () => {
		await writeRuntimeGlobalConfigFile(globalConfigPath, {
			selectedAgentId: config.selectedAgentId,
			selectedShortcutLabel: config.selectedShortcutLabel,
			agentAutonomousModeEnabled: config.agentAutonomousModeEnabled,
			readyForReviewNotificationsEnabled: config.readyForReviewNotificationsEnabled,
			shellAutoRestartEnabled: config.shellAutoRestartEnabled,
			promptShortcuts: config.promptShortcuts,
			showSummaryOnCards: config.showSummaryOnCards,
			autoGenerateSummary: config.autoGenerateSummary,
			summaryStaleAfterSeconds: config.summaryStaleAfterSeconds,
			showTrashWorktreeNotice: config.showTrashWorktreeNotice,
			unmergedChangesIndicatorEnabled: config.unmergedChangesIndicatorEnabled,
			skipTaskCheckoutConfirmation: config.skipTaskCheckoutConfirmation,
			skipHomeCheckoutConfirmation: config.skipHomeCheckoutConfirmation,
			audibleNotificationsEnabled: config.audibleNotificationsEnabled,
			audibleNotificationVolume: config.audibleNotificationVolume,
			audibleNotificationEvents: config.audibleNotificationEvents,
			audibleNotificationsOnlyWhenHidden: config.audibleNotificationsOnlyWhenHidden,
			focusedTaskPollMs: config.focusedTaskPollMs,
			backgroundTaskPollMs: config.backgroundTaskPollMs,
			homeRepoPollMs: config.homeRepoPollMs,
		});
		await writeRuntimeProjectConfigFile(projectConfigPath, { shortcuts: config.shortcuts });
		return createRuntimeConfigStateFromValues({
			globalConfigPath,
			projectConfigPath,
			selectedAgentId: config.selectedAgentId,
			selectedShortcutLabel: config.selectedShortcutLabel,
			agentAutonomousModeEnabled: config.agentAutonomousModeEnabled,
			readyForReviewNotificationsEnabled: config.readyForReviewNotificationsEnabled,
			shellAutoRestartEnabled: config.shellAutoRestartEnabled,
			showSummaryOnCards: config.showSummaryOnCards,
			autoGenerateSummary: config.autoGenerateSummary,
			summaryStaleAfterSeconds: config.summaryStaleAfterSeconds,
			showTrashWorktreeNotice: config.showTrashWorktreeNotice,
			unmergedChangesIndicatorEnabled: config.unmergedChangesIndicatorEnabled,
			skipTaskCheckoutConfirmation: config.skipTaskCheckoutConfirmation,
			skipHomeCheckoutConfirmation: config.skipHomeCheckoutConfirmation,
			audibleNotificationsEnabled: config.audibleNotificationsEnabled,
			audibleNotificationVolume: config.audibleNotificationVolume,
			audibleNotificationEvents: config.audibleNotificationEvents,
			audibleNotificationsOnlyWhenHidden: config.audibleNotificationsOnlyWhenHidden,
			focusedTaskPollMs: config.focusedTaskPollMs,
			backgroundTaskPollMs: config.backgroundTaskPollMs,
			homeRepoPollMs: config.homeRepoPollMs,
			shortcuts: config.shortcuts,
			promptShortcuts: config.promptShortcuts,
		});
	});
}

async function applyConfigUpdates({
	globalConfigPath,
	projectConfigPath,
	current,
	updates,
}: {
	globalConfigPath: string;
	projectConfigPath: string | null;
	current: RuntimeConfigState;
	updates: RuntimeConfigUpdateInput;
}): Promise<RuntimeConfigState> {
	const nextConfig = {
		selectedAgentId: updates.selectedAgentId ?? current.selectedAgentId,
		selectedShortcutLabel:
			updates.selectedShortcutLabel === undefined ? current.selectedShortcutLabel : updates.selectedShortcutLabel,
		agentAutonomousModeEnabled: updates.agentAutonomousModeEnabled ?? current.agentAutonomousModeEnabled,
		readyForReviewNotificationsEnabled:
			updates.readyForReviewNotificationsEnabled ?? current.readyForReviewNotificationsEnabled,
		shellAutoRestartEnabled: updates.shellAutoRestartEnabled ?? current.shellAutoRestartEnabled,
		showSummaryOnCards: updates.showSummaryOnCards ?? current.showSummaryOnCards,
		autoGenerateSummary: updates.autoGenerateSummary ?? current.autoGenerateSummary,
		summaryStaleAfterSeconds: updates.summaryStaleAfterSeconds ?? current.summaryStaleAfterSeconds,
		showTrashWorktreeNotice: updates.showTrashWorktreeNotice ?? current.showTrashWorktreeNotice,
		unmergedChangesIndicatorEnabled:
			updates.unmergedChangesIndicatorEnabled ?? current.unmergedChangesIndicatorEnabled,
		skipTaskCheckoutConfirmation: updates.skipTaskCheckoutConfirmation ?? current.skipTaskCheckoutConfirmation,
		skipHomeCheckoutConfirmation: updates.skipHomeCheckoutConfirmation ?? current.skipHomeCheckoutConfirmation,
		commitPromptTemplate: updates.commitPromptTemplate ?? current.commitPromptTemplate,
		openPrPromptTemplate: updates.openPrPromptTemplate ?? current.openPrPromptTemplate,
		audibleNotificationsEnabled: updates.audibleNotificationsEnabled ?? current.audibleNotificationsEnabled,
		audibleNotificationVolume: updates.audibleNotificationVolume ?? current.audibleNotificationVolume,
		audibleNotificationEvents: updates.audibleNotificationEvents
			? normalizeAudibleNotificationEvents({
					...current.audibleNotificationEvents,
					...updates.audibleNotificationEvents,
				})
			: current.audibleNotificationEvents,
		audibleNotificationsOnlyWhenHidden:
			updates.audibleNotificationsOnlyWhenHidden ?? current.audibleNotificationsOnlyWhenHidden,
		focusedTaskPollMs: updates.focusedTaskPollMs ?? current.focusedTaskPollMs,
		backgroundTaskPollMs: updates.backgroundTaskPollMs ?? current.backgroundTaskPollMs,
		homeRepoPollMs: updates.homeRepoPollMs ?? current.homeRepoPollMs,
		shortcuts: projectConfigPath ? (updates.shortcuts ?? current.shortcuts) : current.shortcuts,
		promptShortcuts: updates.promptShortcuts ?? current.promptShortcuts,
	};

	const hasChanges =
		nextConfig.selectedAgentId !== current.selectedAgentId ||
		nextConfig.selectedShortcutLabel !== current.selectedShortcutLabel ||
		nextConfig.agentAutonomousModeEnabled !== current.agentAutonomousModeEnabled ||
		nextConfig.readyForReviewNotificationsEnabled !== current.readyForReviewNotificationsEnabled ||
		nextConfig.shellAutoRestartEnabled !== current.shellAutoRestartEnabled ||
		JSON.stringify(nextConfig.promptShortcuts) !== JSON.stringify(current.promptShortcuts) ||
		nextConfig.showSummaryOnCards !== current.showSummaryOnCards ||
		nextConfig.autoGenerateSummary !== current.autoGenerateSummary ||
		nextConfig.summaryStaleAfterSeconds !== current.summaryStaleAfterSeconds ||
		nextConfig.showTrashWorktreeNotice !== current.showTrashWorktreeNotice ||
		nextConfig.unmergedChangesIndicatorEnabled !== current.unmergedChangesIndicatorEnabled ||
		nextConfig.skipTaskCheckoutConfirmation !== current.skipTaskCheckoutConfirmation ||
		nextConfig.skipHomeCheckoutConfirmation !== current.skipHomeCheckoutConfirmation ||
		nextConfig.commitPromptTemplate !== current.commitPromptTemplate ||
		nextConfig.openPrPromptTemplate !== current.openPrPromptTemplate ||
		nextConfig.audibleNotificationsEnabled !== current.audibleNotificationsEnabled ||
		nextConfig.audibleNotificationVolume !== current.audibleNotificationVolume ||
		nextConfig.audibleNotificationEvents.permission !== current.audibleNotificationEvents.permission ||
		nextConfig.audibleNotificationEvents.review !== current.audibleNotificationEvents.review ||
		nextConfig.audibleNotificationEvents.failure !== current.audibleNotificationEvents.failure ||
		nextConfig.audibleNotificationEvents.completion !== current.audibleNotificationEvents.completion ||
		nextConfig.audibleNotificationsOnlyWhenHidden !== current.audibleNotificationsOnlyWhenHidden ||
		nextConfig.focusedTaskPollMs !== current.focusedTaskPollMs ||
		nextConfig.backgroundTaskPollMs !== current.backgroundTaskPollMs ||
		nextConfig.homeRepoPollMs !== current.homeRepoPollMs ||
		(projectConfigPath !== null && !areRuntimeProjectShortcutsEqual(nextConfig.shortcuts, current.shortcuts));

	if (!hasChanges) {
		return current;
	}

	await writeRuntimeGlobalConfigFile(globalConfigPath, {
		selectedAgentId: nextConfig.selectedAgentId,
		selectedShortcutLabel: nextConfig.selectedShortcutLabel,
		agentAutonomousModeEnabled: nextConfig.agentAutonomousModeEnabled,
		readyForReviewNotificationsEnabled: nextConfig.readyForReviewNotificationsEnabled,
		shellAutoRestartEnabled: nextConfig.shellAutoRestartEnabled,
		promptShortcuts: nextConfig.promptShortcuts,
		showSummaryOnCards: nextConfig.showSummaryOnCards,
		autoGenerateSummary: nextConfig.autoGenerateSummary,
		summaryStaleAfterSeconds: nextConfig.summaryStaleAfterSeconds,
		showTrashWorktreeNotice: nextConfig.showTrashWorktreeNotice,
		unmergedChangesIndicatorEnabled: nextConfig.unmergedChangesIndicatorEnabled,
		skipTaskCheckoutConfirmation: nextConfig.skipTaskCheckoutConfirmation,
		skipHomeCheckoutConfirmation: nextConfig.skipHomeCheckoutConfirmation,
		commitPromptTemplate: nextConfig.commitPromptTemplate,
		openPrPromptTemplate: nextConfig.openPrPromptTemplate,
		audibleNotificationsEnabled: nextConfig.audibleNotificationsEnabled,
		audibleNotificationVolume: nextConfig.audibleNotificationVolume,
		audibleNotificationEvents: nextConfig.audibleNotificationEvents,
		audibleNotificationsOnlyWhenHidden: nextConfig.audibleNotificationsOnlyWhenHidden,
		focusedTaskPollMs: nextConfig.focusedTaskPollMs,
		backgroundTaskPollMs: nextConfig.backgroundTaskPollMs,
		homeRepoPollMs: nextConfig.homeRepoPollMs,
	});
	if (projectConfigPath !== null) {
		await writeRuntimeProjectConfigFile(projectConfigPath, {
			shortcuts: nextConfig.shortcuts,
		});
	}
	return createRuntimeConfigStateFromValues({
		globalConfigPath,
		projectConfigPath,
		selectedAgentId: nextConfig.selectedAgentId,
		selectedShortcutLabel: nextConfig.selectedShortcutLabel,
		agentAutonomousModeEnabled: nextConfig.agentAutonomousModeEnabled,
		readyForReviewNotificationsEnabled: nextConfig.readyForReviewNotificationsEnabled,
		shellAutoRestartEnabled: nextConfig.shellAutoRestartEnabled,
		showSummaryOnCards: nextConfig.showSummaryOnCards,
		autoGenerateSummary: nextConfig.autoGenerateSummary,
		summaryStaleAfterSeconds: nextConfig.summaryStaleAfterSeconds,
		showTrashWorktreeNotice: nextConfig.showTrashWorktreeNotice,
		unmergedChangesIndicatorEnabled: nextConfig.unmergedChangesIndicatorEnabled,
		skipTaskCheckoutConfirmation: nextConfig.skipTaskCheckoutConfirmation,
		skipHomeCheckoutConfirmation: nextConfig.skipHomeCheckoutConfirmation,
		audibleNotificationsEnabled: nextConfig.audibleNotificationsEnabled,
		audibleNotificationVolume: nextConfig.audibleNotificationVolume,
		audibleNotificationEvents: nextConfig.audibleNotificationEvents,
		audibleNotificationsOnlyWhenHidden: nextConfig.audibleNotificationsOnlyWhenHidden,
		focusedTaskPollMs: nextConfig.focusedTaskPollMs,
		backgroundTaskPollMs: nextConfig.backgroundTaskPollMs,
		homeRepoPollMs: nextConfig.homeRepoPollMs,
		shortcuts: nextConfig.shortcuts,
		promptShortcuts: nextConfig.promptShortcuts,
	});
}

export async function updateRuntimeConfig(cwd: string, updates: RuntimeConfigUpdateInput): Promise<RuntimeConfigState> {
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(cwd);
	return await lockedFileSystem.withLocks(getRuntimeConfigLockRequests(cwd), async () => {
		const current = await loadRuntimeConfigLocked(cwd);
		if (projectConfigPath === null && normalizeShortcuts(updates.shortcuts).length > 0) {
			throw new Error("Cannot save project shortcuts without a selected project.");
		}
		return applyConfigUpdates({ globalConfigPath, projectConfigPath, current, updates });
	});
}

export async function updateGlobalRuntimeConfig(
	current: RuntimeConfigState,
	updates: RuntimeConfigUpdateInput,
): Promise<RuntimeConfigState> {
	const globalConfigPath = getRuntimeGlobalConfigPath();
	return await lockedFileSystem.withLocks([{ path: globalConfigPath, type: "file" }], async () => {
		const result = await applyConfigUpdates({
			globalConfigPath,
			projectConfigPath: null,
			current,
			updates,
		});
		if (result === current) {
			return current;
		}
		return { ...result, projectConfigPath: current.projectConfigPath };
	});
}
