// Persists Quarterdeck-owned runtime preferences on disk.
// This module should store Quarterdeck settings such as selected agents
// and shortcuts.
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isRuntimeAgentLaunchSupported } from "../core/agent-catalog";
import type { RuntimeAgentId, RuntimeProjectShortcut } from "../core/api-contract";
import { type LockRequest, lockedFileSystem } from "../fs/locked-file-system";
import { getRuntimeHomePath } from "../state/workspace-state";
import { detectInstalledCommands } from "../terminal/agent-registry";
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
	audibleNotificationsEnabled?: boolean;
	audibleNotificationVolume?: number;
	audibleNotificationEvents?: AudibleNotificationEventsShape;
	audibleNotificationsOnlyWhenHidden?: boolean;
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
	audibleNotificationsEnabled: boolean;
	audibleNotificationVolume: number;
	audibleNotificationEvents: AudibleNotificationEvents;
	audibleNotificationsOnlyWhenHidden: boolean;
	shortcuts: RuntimeProjectShortcut[];
}

export interface RuntimeConfigUpdateInput {
	selectedAgentId?: RuntimeAgentId;
	selectedShortcutLabel?: string | null;
	agentAutonomousModeEnabled?: boolean;
	readyForReviewNotificationsEnabled?: boolean;
	audibleNotificationsEnabled?: boolean;
	audibleNotificationVolume?: number;
	audibleNotificationEvents?: AudibleNotificationEventsShape;
	audibleNotificationsOnlyWhenHidden?: boolean;
	shortcuts?: RuntimeProjectShortcut[];
}

const CONFIG_FILENAME = "config.json";
const PROJECT_CONFIG_DIR = ".quarterdeck";
const PROJECT_CONFIG_FILENAME = "config.json";
const DEFAULT_AGENT_ID: RuntimeAgentId = "claude";
const AUTO_SELECT_AGENT_PRIORITY: readonly RuntimeAgentId[] = ["claude", "codex"];
const DEFAULT_AGENT_AUTONOMOUS_MODE_ENABLED = false;
const DEFAULT_READY_FOR_REVIEW_NOTIFICATIONS_ENABLED = true;
const DEFAULT_AUDIBLE_NOTIFICATIONS_ENABLED = true;
const DEFAULT_AUDIBLE_NOTIFICATION_VOLUME = 0.7;
const DEFAULT_AUDIBLE_NOTIFICATIONS_ONLY_WHEN_HIDDEN = true;
const DEFAULT_AUDIBLE_NOTIFICATION_EVENTS: AudibleNotificationEvents = {
	permission: true,
	review: true,
	failure: true,
	completion: true,
};

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
		shortcuts: normalizeShortcuts(projectConfig?.shortcuts),
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
		audibleNotificationsEnabled?: boolean;
		audibleNotificationVolume?: number;
		audibleNotificationEvents?: AudibleNotificationEventsShape;
		audibleNotificationsOnlyWhenHidden?: boolean;
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
	audibleNotificationsEnabled: boolean;
	audibleNotificationVolume: number;
	audibleNotificationEvents: AudibleNotificationEvents;
	audibleNotificationsOnlyWhenHidden: boolean;
	shortcuts: RuntimeProjectShortcut[];
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
		shortcuts: normalizeShortcuts(input.shortcuts),
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
		audibleNotificationsEnabled: current.audibleNotificationsEnabled,
		audibleNotificationVolume: current.audibleNotificationVolume,
		audibleNotificationEvents: current.audibleNotificationEvents,
		audibleNotificationsOnlyWhenHidden: current.audibleNotificationsOnlyWhenHidden,
		shortcuts: [],
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
		audibleNotificationsEnabled: boolean;
		audibleNotificationVolume: number;
		audibleNotificationEvents: AudibleNotificationEvents;
		audibleNotificationsOnlyWhenHidden: boolean;
		shortcuts: RuntimeProjectShortcut[];
	},
): Promise<RuntimeConfigState> {
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(cwd);
	return await lockedFileSystem.withLocks(getRuntimeConfigLockRequests(cwd), async () => {
		await writeRuntimeGlobalConfigFile(globalConfigPath, {
			selectedAgentId: config.selectedAgentId,
			selectedShortcutLabel: config.selectedShortcutLabel,
			agentAutonomousModeEnabled: config.agentAutonomousModeEnabled,
			readyForReviewNotificationsEnabled: config.readyForReviewNotificationsEnabled,
			audibleNotificationsEnabled: config.audibleNotificationsEnabled,
			audibleNotificationVolume: config.audibleNotificationVolume,
			audibleNotificationEvents: config.audibleNotificationEvents,
			audibleNotificationsOnlyWhenHidden: config.audibleNotificationsOnlyWhenHidden,
		});
		await writeRuntimeProjectConfigFile(projectConfigPath, { shortcuts: config.shortcuts });
		return createRuntimeConfigStateFromValues({
			globalConfigPath,
			projectConfigPath,
			selectedAgentId: config.selectedAgentId,
			selectedShortcutLabel: config.selectedShortcutLabel,
			agentAutonomousModeEnabled: config.agentAutonomousModeEnabled,
			readyForReviewNotificationsEnabled: config.readyForReviewNotificationsEnabled,
			audibleNotificationsEnabled: config.audibleNotificationsEnabled,
			audibleNotificationVolume: config.audibleNotificationVolume,
			audibleNotificationEvents: config.audibleNotificationEvents,
			audibleNotificationsOnlyWhenHidden: config.audibleNotificationsOnlyWhenHidden,
			shortcuts: config.shortcuts,
		});
	});
}

export async function updateRuntimeConfig(cwd: string, updates: RuntimeConfigUpdateInput): Promise<RuntimeConfigState> {
	const { globalConfigPath, projectConfigPath } = resolveRuntimeConfigPaths(cwd);
	return await lockedFileSystem.withLocks(getRuntimeConfigLockRequests(cwd), async () => {
		const current = await loadRuntimeConfigLocked(cwd);
		if (projectConfigPath === null && normalizeShortcuts(updates.shortcuts).length > 0) {
			throw new Error("Cannot save project shortcuts without a selected project.");
		}
		const nextAudibleEvents = updates.audibleNotificationEvents
			? normalizeAudibleNotificationEvents({
					...current.audibleNotificationEvents,
					...updates.audibleNotificationEvents,
				})
			: current.audibleNotificationEvents;
		const nextConfig = {
			selectedAgentId: updates.selectedAgentId ?? current.selectedAgentId,
			selectedShortcutLabel:
				updates.selectedShortcutLabel === undefined ? current.selectedShortcutLabel : updates.selectedShortcutLabel,
			agentAutonomousModeEnabled: updates.agentAutonomousModeEnabled ?? current.agentAutonomousModeEnabled,
			readyForReviewNotificationsEnabled:
				updates.readyForReviewNotificationsEnabled ?? current.readyForReviewNotificationsEnabled,
			audibleNotificationsEnabled: updates.audibleNotificationsEnabled ?? current.audibleNotificationsEnabled,
			audibleNotificationVolume: updates.audibleNotificationVolume ?? current.audibleNotificationVolume,
			audibleNotificationEvents: nextAudibleEvents,
			audibleNotificationsOnlyWhenHidden:
				updates.audibleNotificationsOnlyWhenHidden ?? current.audibleNotificationsOnlyWhenHidden,
			shortcuts: projectConfigPath ? (updates.shortcuts ?? current.shortcuts) : current.shortcuts,
		};

		const hasChanges =
			nextConfig.selectedAgentId !== current.selectedAgentId ||
			nextConfig.selectedShortcutLabel !== current.selectedShortcutLabel ||
			nextConfig.agentAutonomousModeEnabled !== current.agentAutonomousModeEnabled ||
			nextConfig.readyForReviewNotificationsEnabled !== current.readyForReviewNotificationsEnabled ||
			nextConfig.audibleNotificationsEnabled !== current.audibleNotificationsEnabled ||
			nextConfig.audibleNotificationVolume !== current.audibleNotificationVolume ||
			nextConfig.audibleNotificationEvents.permission !== current.audibleNotificationEvents.permission ||
			nextConfig.audibleNotificationEvents.review !== current.audibleNotificationEvents.review ||
			nextConfig.audibleNotificationEvents.failure !== current.audibleNotificationEvents.failure ||
			nextConfig.audibleNotificationEvents.completion !== current.audibleNotificationEvents.completion ||
			nextConfig.audibleNotificationsOnlyWhenHidden !== current.audibleNotificationsOnlyWhenHidden ||
			!areRuntimeProjectShortcutsEqual(nextConfig.shortcuts, current.shortcuts);

		if (!hasChanges) {
			return current;
		}

		await writeRuntimeGlobalConfigFile(globalConfigPath, {
			selectedAgentId: nextConfig.selectedAgentId,
			selectedShortcutLabel: nextConfig.selectedShortcutLabel,
			agentAutonomousModeEnabled: nextConfig.agentAutonomousModeEnabled,
			readyForReviewNotificationsEnabled: nextConfig.readyForReviewNotificationsEnabled,
			audibleNotificationsEnabled: nextConfig.audibleNotificationsEnabled,
			audibleNotificationVolume: nextConfig.audibleNotificationVolume,
			audibleNotificationEvents: nextConfig.audibleNotificationEvents,
			audibleNotificationsOnlyWhenHidden: nextConfig.audibleNotificationsOnlyWhenHidden,
		});
		await writeRuntimeProjectConfigFile(projectConfigPath, {
			shortcuts: nextConfig.shortcuts,
		});
		return createRuntimeConfigStateFromValues({
			globalConfigPath,
			projectConfigPath,
			selectedAgentId: nextConfig.selectedAgentId,
			selectedShortcutLabel: nextConfig.selectedShortcutLabel,
			agentAutonomousModeEnabled: nextConfig.agentAutonomousModeEnabled,
			readyForReviewNotificationsEnabled: nextConfig.readyForReviewNotificationsEnabled,
			audibleNotificationsEnabled: nextConfig.audibleNotificationsEnabled,
			audibleNotificationVolume: nextConfig.audibleNotificationVolume,
			audibleNotificationEvents: nextConfig.audibleNotificationEvents,
			audibleNotificationsOnlyWhenHidden: nextConfig.audibleNotificationsOnlyWhenHidden,
			shortcuts: nextConfig.shortcuts,
		});
	});
}

export async function updateGlobalRuntimeConfig(
	current: RuntimeConfigState,
	updates: RuntimeConfigUpdateInput,
): Promise<RuntimeConfigState> {
	const globalConfigPath = getRuntimeGlobalConfigPath();
	return await lockedFileSystem.withLocks(
		[
			{
				path: globalConfigPath,
				type: "file",
			},
		],
		async () => {
			const nextConfig = {
				selectedAgentId: updates.selectedAgentId ?? current.selectedAgentId,
				selectedShortcutLabel:
					updates.selectedShortcutLabel === undefined
						? current.selectedShortcutLabel
						: updates.selectedShortcutLabel,
				agentAutonomousModeEnabled: updates.agentAutonomousModeEnabled ?? current.agentAutonomousModeEnabled,
				readyForReviewNotificationsEnabled:
					updates.readyForReviewNotificationsEnabled ?? current.readyForReviewNotificationsEnabled,
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
				shortcuts: current.shortcuts,
			};

			const hasChanges =
				nextConfig.selectedAgentId !== current.selectedAgentId ||
				nextConfig.selectedShortcutLabel !== current.selectedShortcutLabel ||
				nextConfig.agentAutonomousModeEnabled !== current.agentAutonomousModeEnabled ||
				nextConfig.readyForReviewNotificationsEnabled !== current.readyForReviewNotificationsEnabled ||
				nextConfig.audibleNotificationsEnabled !== current.audibleNotificationsEnabled ||
				nextConfig.audibleNotificationVolume !== current.audibleNotificationVolume ||
				nextConfig.audibleNotificationEvents.permission !== current.audibleNotificationEvents.permission ||
				nextConfig.audibleNotificationEvents.review !== current.audibleNotificationEvents.review ||
				nextConfig.audibleNotificationEvents.failure !== current.audibleNotificationEvents.failure ||
				nextConfig.audibleNotificationEvents.completion !== current.audibleNotificationEvents.completion ||
				nextConfig.audibleNotificationsOnlyWhenHidden !== current.audibleNotificationsOnlyWhenHidden;

			if (!hasChanges) {
				return current;
			}

			await writeRuntimeGlobalConfigFile(globalConfigPath, {
				selectedAgentId: nextConfig.selectedAgentId,
				selectedShortcutLabel: nextConfig.selectedShortcutLabel,
				agentAutonomousModeEnabled: nextConfig.agentAutonomousModeEnabled,
				readyForReviewNotificationsEnabled: nextConfig.readyForReviewNotificationsEnabled,
				audibleNotificationsEnabled: nextConfig.audibleNotificationsEnabled,
				audibleNotificationVolume: nextConfig.audibleNotificationVolume,
				audibleNotificationEvents: nextConfig.audibleNotificationEvents,
				audibleNotificationsOnlyWhenHidden: nextConfig.audibleNotificationsOnlyWhenHidden,
			});

			return createRuntimeConfigStateFromValues({
				globalConfigPath,
				projectConfigPath: current.projectConfigPath,
				selectedAgentId: nextConfig.selectedAgentId,
				selectedShortcutLabel: nextConfig.selectedShortcutLabel,
				agentAutonomousModeEnabled: nextConfig.agentAutonomousModeEnabled,
				readyForReviewNotificationsEnabled: nextConfig.readyForReviewNotificationsEnabled,
				audibleNotificationsEnabled: nextConfig.audibleNotificationsEnabled,
				audibleNotificationVolume: nextConfig.audibleNotificationVolume,
				audibleNotificationEvents: nextConfig.audibleNotificationEvents,
				audibleNotificationsOnlyWhenHidden: nextConfig.audibleNotificationsOnlyWhenHidden,
				shortcuts: nextConfig.shortcuts,
			});
		},
	);
}
