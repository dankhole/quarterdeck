// Settings dialog composition for Quarterdeck.
import * as RadixCheckbox from "@radix-ui/react-checkbox";
import * as RadixPopover from "@radix-ui/react-popover";
import * as RadixSwitch from "@radix-ui/react-switch";
import { getRuntimeAgentCatalogEntry, getRuntimeLaunchSupportedAgentCatalog } from "@runtime-agent-catalog";
import { areRuntimeProjectShortcutsEqual } from "@runtime-shortcuts";
import {
	Check,
	ChevronDown,
	Circle,
	CircleDot,
	ExternalLink,
	Plus,
	Settings,
	Sparkles,
	Volume2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import {
	getRuntimeShortcutIconComponent,
	getRuntimeShortcutPickerOption,
	RUNTIME_SHORTCUT_ICON_OPTIONS,
	type RuntimeShortcutIconOption,
	type RuntimeShortcutPickerIconId,
} from "@/components/shared/runtime-shortcut-icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { useLayoutCustomizations } from "@/resize/layout-customizations";
import { openFileOnHost } from "@/runtime/runtime-config-query";
import type { RuntimeAgentId, RuntimeConfigResponse, RuntimeProjectShortcut } from "@/runtime/types";
import { useRuntimeConfig } from "@/runtime/use-runtime-config";
import { resetAllTerminalRenderers } from "@/terminal/persistent-terminal-manager";
import { notificationAudioPlayer } from "@/utils/notification-audio";
import { formatPathForDisplay } from "@/utils/path-display";

interface RuntimeSettingsAgentRowModel {
	id: RuntimeAgentId;
	label: string;
	binary: string;
	command: string;
	installed: boolean | null;
}

function quoteCommandPartForDisplay(part: string): string {
	if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(part)) {
		return part;
	}
	return JSON.stringify(part);
}

function buildDisplayedAgentCommand(agentId: RuntimeAgentId, binary: string, autonomousModeEnabled: boolean): string {
	const args = autonomousModeEnabled ? (getRuntimeAgentCatalogEntry(agentId)?.autonomousArgs ?? []) : [];
	return [binary, ...args.map(quoteCommandPartForDisplay)].join(" ");
}

export type RuntimeSettingsSection = "shortcuts";

const SETTINGS_AGENT_ORDER: readonly RuntimeAgentId[] = ["claude", "codex"];

function getShortcutIconOption(icon: string | undefined): RuntimeShortcutIconOption {
	return getRuntimeShortcutPickerOption(icon);
}

function ShortcutIconComponent({ icon, size = 14 }: { icon: string | undefined; size?: number }): React.ReactElement {
	const Component = getRuntimeShortcutIconComponent(icon);
	return <Component size={size} />;
}

function getNextShortcutLabel(shortcuts: RuntimeProjectShortcut[], baseLabel: string): string {
	const normalizedTakenLabels = new Set(
		shortcuts.map((shortcut) => shortcut.label.trim().toLowerCase()).filter((label) => label.length > 0),
	);
	const normalizedBaseLabel = baseLabel.trim().toLowerCase();
	if (!normalizedTakenLabels.has(normalizedBaseLabel)) {
		return baseLabel;
	}

	let suffix = 2;
	while (normalizedTakenLabels.has(`${normalizedBaseLabel} ${suffix}`)) {
		suffix += 1;
	}
	return `${baseLabel} ${suffix}`;
}

function AgentRow({
	agent,
	isSelected,
	onSelect,
	disabled,
}: {
	agent: RuntimeSettingsAgentRowModel;
	isSelected: boolean;
	onSelect: () => void;
	disabled: boolean;
}): React.ReactElement {
	const installUrl = getRuntimeAgentCatalogEntry(agent.id)?.installUrl;
	const isInstalled = agent.installed === true;
	const isInstallStatusPending = agent.installed === null;

	return (
		<div
			role="button"
			tabIndex={0}
			onClick={() => {
				if (isInstalled && !disabled) {
					onSelect();
				}
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter" && isInstalled && !disabled) {
					onSelect();
				}
			}}
			className="flex items-center justify-between gap-3 py-1.5"
			style={{ cursor: isInstalled ? "pointer" : "default" }}
		>
			<div className="flex items-start gap-2 min-w-0">
				{isSelected ? (
					<CircleDot size={16} className="text-accent mt-0.5 shrink-0" />
				) : (
					<Circle
						size={16}
						className={cn("mt-0.5 shrink-0", !isInstalled ? "text-text-tertiary" : "text-text-secondary")}
					/>
				)}
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<span className="text-[13px] text-text-primary">{agent.label}</span>
						{isInstalled ? (
							<span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-status-green/10 text-status-green">
								Installed
							</span>
						) : isInstallStatusPending ? (
							<span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-surface-3 text-text-secondary">
								Checking...
							</span>
						) : null}
					</div>
					{agent.command ? (
						<p className="text-text-secondary font-mono text-xs mt-0.5 m-0">{agent.command}</p>
					) : null}
				</div>
			</div>
			{agent.installed === false && installUrl ? (
				<a
					href={installUrl}
					target="_blank"
					rel="noreferrer"
					onClick={(event: React.MouseEvent) => event.stopPropagation()}
					className="inline-flex items-center justify-center rounded-md font-medium duration-150 cursor-default select-none h-7 px-2 text-xs bg-surface-2 border border-border text-text-primary hover:bg-surface-3 hover:border-border-bright"
				>
					Install
				</a>
			) : agent.installed === false ? (
				<Button size="sm" disabled>
					Install
				</Button>
			) : null}
		</div>
	);
}

function ShortcutIconPicker({
	value,
	onSelect,
}: {
	value: string | undefined;
	onSelect: (icon: RuntimeShortcutPickerIconId) => void;
}): React.ReactElement {
	const [open, setOpen] = useState(false);
	const selectedOption = getShortcutIconOption(value);

	return (
		<RadixPopover.Root open={open} onOpenChange={setOpen}>
			<RadixPopover.Trigger asChild>
				<button
					type="button"
					aria-label={`Shortcut icon: ${selectedOption.label}`}
					className="inline-flex items-center gap-1 h-7 px-1.5 rounded-md border border-border bg-surface-2 text-text-primary hover:bg-surface-3"
				>
					<ShortcutIconComponent icon={value} size={14} />
					<ChevronDown size={12} />
				</button>
			</RadixPopover.Trigger>
			<RadixPopover.Portal>
				<RadixPopover.Content
					side="bottom"
					align="start"
					sideOffset={4}
					className="z-50 rounded-md border border-border bg-surface-2 p-1 shadow-lg"
					style={{ animation: "kb-tooltip-show 100ms ease" }}
				>
					<div className="flex gap-0.5">
						{RUNTIME_SHORTCUT_ICON_OPTIONS.map((option) => {
							const IconComponent = getRuntimeShortcutIconComponent(option.value);
							return (
								<button
									key={option.value}
									type="button"
									aria-label={option.label}
									className={cn(
										"p-1.5 rounded hover:bg-surface-3",
										selectedOption.value === option.value && "bg-surface-3",
									)}
									onClick={() => {
										onSelect(option.value);
										setOpen(false);
									}}
								>
									<IconComponent size={14} />
								</button>
							);
						})}
					</div>
				</RadixPopover.Content>
			</RadixPopover.Portal>
		</RadixPopover.Root>
	);
}

export function RuntimeSettingsDialog({
	open,
	workspaceId,
	initialConfig = null,
	onOpenChange,
	onSaved,
	initialSection,
}: {
	open: boolean;
	workspaceId: string | null;
	initialConfig?: RuntimeConfigResponse | null;
	onOpenChange: (open: boolean) => void;
	onSaved?: () => void;
	initialSection?: RuntimeSettingsSection | null;
}): React.ReactElement {
	const { config, isLoading, isSaving, save } = useRuntimeConfig(open, workspaceId, initialConfig);
	const { resetLayoutCustomizations } = useLayoutCustomizations();
	const [selectedAgentId, setSelectedAgentId] = useState<RuntimeAgentId>("claude");
	const [agentAutonomousModeEnabled, setAgentAutonomousModeEnabled] = useState(true);
	const [showSummaryOnCards, setShowSummaryOnCards] = useState(false);
	const [autoGenerateSummary, setAutoGenerateSummary] = useState(false);
	const [summaryStaleAfterSeconds, setSummaryStaleAfterSeconds] = useState(300);
	const [shellAutoRestartEnabled, setShellAutoRestartEnabled] = useState(true);
	const [showTrashWorktreeNotice, setShowTrashWorktreeNotice] = useState(true);
	const [unmergedChangesIndicatorEnabled, setUnmergedChangesIndicatorEnabled] = useState(false);
	const [audibleNotificationsEnabled, setAudibleNotificationsEnabled] = useState(true);
	const [audibleNotificationVolume, setAudibleNotificationVolume] = useState(0.7);
	const [audibleNotificationEvents, setAudibleNotificationEvents] = useState({
		permission: true,
		review: true,
		failure: true,
		completion: true,
	});
	const [audibleNotificationsOnlyWhenHidden, setAudibleNotificationsOnlyWhenHidden] = useState(true);
	const [shortcuts, setShortcuts] = useState<RuntimeProjectShortcut[]>([]);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [pendingShortcutScrollIndex, setPendingShortcutScrollIndex] = useState<number | null>(null);
	const shortcutsSectionRef = useRef<HTMLHeadingElement | null>(null);
	const shortcutRowRefs = useRef<Array<HTMLDivElement | null>>([]);
	const controlsDisabled = isLoading || isSaving || config === null;
	const bypassPermissionsCheckboxId = "runtime-settings-bypass-permissions";
	const supportedAgents = useMemo<RuntimeSettingsAgentRowModel[]>(() => {
		const agents =
			config?.agents.map((agent) => ({
				id: agent.id,
				label: agent.label,
				binary: agent.binary,
				installed: agent.installed,
			})) ??
			getRuntimeLaunchSupportedAgentCatalog().map((agent) => ({
				id: agent.id,
				label: agent.label,
				binary: agent.binary,
				installed: null,
			}));
		const orderIndexByAgentId = new Map(SETTINGS_AGENT_ORDER.map((agentId, index) => [agentId, index] as const));
		const orderedAgents = [...agents].sort((left, right) => {
			const leftOrderIndex = orderIndexByAgentId.get(left.id) ?? Number.MAX_SAFE_INTEGER;
			const rightOrderIndex = orderIndexByAgentId.get(right.id) ?? Number.MAX_SAFE_INTEGER;
			return leftOrderIndex - rightOrderIndex;
		});
		return orderedAgents.map((agent) => ({
			...agent,
			command: buildDisplayedAgentCommand(agent.id, agent.binary, agentAutonomousModeEnabled),
		}));
	}, [agentAutonomousModeEnabled, config?.agents]);
	const firstInstalledAgentId = supportedAgents.find((agent) => agent.installed)?.id;
	const fallbackAgentId = firstInstalledAgentId ?? supportedAgents[0]?.id ?? "claude";
	const initialSelectedAgentId = config?.selectedAgentId ?? fallbackAgentId;
	const initialAgentAutonomousModeEnabled = config?.agentAutonomousModeEnabled ?? true;
	const initialShowSummaryOnCards = config?.showSummaryOnCards ?? false;
	const initialAutoGenerateSummary = config?.autoGenerateSummary ?? false;
	const initialSummaryStaleAfterSeconds = config?.summaryStaleAfterSeconds ?? 300;
	const llmConfigured = config?.llmConfigured ?? false;
	const initialShellAutoRestartEnabled = config?.shellAutoRestartEnabled ?? true;
	const initialShowTrashWorktreeNotice = config?.showTrashWorktreeNotice ?? true;
	const initialUnmergedChangesIndicatorEnabled = config?.unmergedChangesIndicatorEnabled ?? false;
	const initialAudibleNotificationsEnabled = config?.audibleNotificationsEnabled ?? true;
	const initialAudibleNotificationVolume = config?.audibleNotificationVolume ?? 0.7;
	const initialAudibleNotificationEvents = config?.audibleNotificationEvents ?? {
		permission: true,
		review: true,
		failure: true,
		completion: true,
	};
	const initialAudibleNotificationsOnlyWhenHidden = config?.audibleNotificationsOnlyWhenHidden ?? true;
	const initialShortcuts = config?.shortcuts ?? [];
	const hasUnsavedChanges = useMemo(() => {
		if (!config) {
			return false;
		}
		if (selectedAgentId !== initialSelectedAgentId) {
			return true;
		}
		if (agentAutonomousModeEnabled !== initialAgentAutonomousModeEnabled) {
			return true;
		}
		if (showSummaryOnCards !== initialShowSummaryOnCards) {
			return true;
		}
		if (autoGenerateSummary !== initialAutoGenerateSummary) {
			return true;
		}
		if (summaryStaleAfterSeconds !== initialSummaryStaleAfterSeconds) {
			return true;
		}
		if (shellAutoRestartEnabled !== initialShellAutoRestartEnabled) {
			return true;
		}
		if (showTrashWorktreeNotice !== initialShowTrashWorktreeNotice) {
			return true;
		}
		if (unmergedChangesIndicatorEnabled !== initialUnmergedChangesIndicatorEnabled) {
			return true;
		}
		if (audibleNotificationsEnabled !== initialAudibleNotificationsEnabled) {
			return true;
		}
		if (audibleNotificationVolume !== initialAudibleNotificationVolume) {
			return true;
		}
		if (
			audibleNotificationEvents.permission !== initialAudibleNotificationEvents.permission ||
			audibleNotificationEvents.review !== initialAudibleNotificationEvents.review ||
			audibleNotificationEvents.failure !== initialAudibleNotificationEvents.failure ||
			audibleNotificationEvents.completion !== initialAudibleNotificationEvents.completion
		) {
			return true;
		}
		if (audibleNotificationsOnlyWhenHidden !== initialAudibleNotificationsOnlyWhenHidden) {
			return true;
		}
		return !areRuntimeProjectShortcutsEqual(shortcuts, initialShortcuts);
	}, [
		agentAutonomousModeEnabled,
		autoGenerateSummary,
		audibleNotificationEvents,
		audibleNotificationVolume,
		audibleNotificationsEnabled,
		audibleNotificationsOnlyWhenHidden,
		config,
		initialAgentAutonomousModeEnabled,
		initialAutoGenerateSummary,
		initialAudibleNotificationEvents,
		initialAudibleNotificationVolume,
		initialAudibleNotificationsEnabled,
		initialAudibleNotificationsOnlyWhenHidden,
		initialSelectedAgentId,
		initialShellAutoRestartEnabled,
		initialShowSummaryOnCards,
		initialShowTrashWorktreeNotice,
		initialUnmergedChangesIndicatorEnabled,
		initialShortcuts,
		initialSummaryStaleAfterSeconds,
		selectedAgentId,
		shellAutoRestartEnabled,
		shortcuts,
		showSummaryOnCards,
		showTrashWorktreeNotice,
		summaryStaleAfterSeconds,
		unmergedChangesIndicatorEnabled,
	]);

	useEffect(() => {
		if (!open) {
			return;
		}
		setSelectedAgentId(config?.selectedAgentId ?? fallbackAgentId);
		setAgentAutonomousModeEnabled(config?.agentAutonomousModeEnabled ?? true);
		setShowSummaryOnCards(config?.showSummaryOnCards ?? false);
		setAutoGenerateSummary(config?.autoGenerateSummary ?? false);
		setSummaryStaleAfterSeconds(config?.summaryStaleAfterSeconds ?? 300);
		setShellAutoRestartEnabled(config?.shellAutoRestartEnabled ?? true);
		setShowTrashWorktreeNotice(config?.showTrashWorktreeNotice ?? true);
		setUnmergedChangesIndicatorEnabled(config?.unmergedChangesIndicatorEnabled ?? false);
		setAudibleNotificationsEnabled(config?.audibleNotificationsEnabled ?? true);
		setAudibleNotificationVolume(config?.audibleNotificationVolume ?? 0.7);
		setAudibleNotificationEvents(
			config?.audibleNotificationEvents ?? { permission: true, review: true, failure: true, completion: true },
		);
		setAudibleNotificationsOnlyWhenHidden(config?.audibleNotificationsOnlyWhenHidden ?? true);
		setShortcuts(config?.shortcuts ?? []);
		setSaveError(null);
	}, [
		config?.agentAutonomousModeEnabled,
		config?.autoGenerateSummary,
		config?.audibleNotificationEvents,
		config?.audibleNotificationVolume,
		config?.audibleNotificationsEnabled,
		config?.audibleNotificationsOnlyWhenHidden,
		config?.showTrashWorktreeNotice,
		config?.unmergedChangesIndicatorEnabled,
		config?.selectedAgentId,
		config?.shellAutoRestartEnabled,
		config?.shortcuts,
		config?.showSummaryOnCards,
		config?.summaryStaleAfterSeconds,
		fallbackAgentId,
		open,
	]);

	useEffect(() => {
		if (!open || initialSection !== "shortcuts") {
			return;
		}
		const timeout = window.setTimeout(() => {
			shortcutsSectionRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
		}, 500);
		return () => {
			window.clearTimeout(timeout);
		};
	}, [initialSection, open]);

	useEffect(() => {
		if (pendingShortcutScrollIndex === null) {
			return;
		}
		const frame = window.requestAnimationFrame(() => {
			const target = shortcutRowRefs.current[pendingShortcutScrollIndex] ?? null;
			if (target) {
				target.scrollIntoView({ block: "nearest", behavior: "smooth" });
				const firstInput = target.querySelector("input");
				firstInput?.focus();
				setPendingShortcutScrollIndex(null);
			}
		});
		return () => {
			window.cancelAnimationFrame(frame);
		};
	}, [pendingShortcutScrollIndex, shortcuts]);

	const handleSave = async () => {
		setSaveError(null);
		if (!config) {
			setSaveError("Runtime settings are still loading. Try again in a moment.");
			return;
		}
		const selectedAgent = supportedAgents.find((agent) => agent.id === selectedAgentId);
		if (!selectedAgent || selectedAgent.installed !== true) {
			setSaveError("Selected agent is not installed. Install it first or choose an installed agent.");
			return;
		}
		const saved = await save({
			selectedAgentId,
			agentAutonomousModeEnabled,
			showSummaryOnCards,
			autoGenerateSummary,
			summaryStaleAfterSeconds,
			shellAutoRestartEnabled,
			showTrashWorktreeNotice,
			unmergedChangesIndicatorEnabled,
			audibleNotificationsEnabled,
			audibleNotificationVolume,
			audibleNotificationEvents,
			audibleNotificationsOnlyWhenHidden,
			shortcuts,
		});
		if (!saved) {
			setSaveError("Could not save runtime settings. Check runtime logs and try again.");
			return;
		}
		onSaved?.();
		onOpenChange(false);
	};

	const handleOpenFilePath = useCallback(
		(filePath: string) => {
			setSaveError(null);
			void openFileOnHost(workspaceId, filePath).catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				setSaveError(`Could not open file on host: ${message}`);
			});
		},
		[workspaceId],
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange} contentStyle={{ width: "600px" }}>
			<DialogHeader title="Settings" icon={<Settings size={16} />} />
			<DialogBody>
				<h5 className="font-semibold text-text-primary m-0">Global</h5>
				<p
					className="text-text-secondary font-mono text-xs m-0 break-all"
					style={{ cursor: config?.globalConfigPath ? "pointer" : undefined }}
					onClick={() => {
						if (config?.globalConfigPath) {
							handleOpenFilePath(config.globalConfigPath);
						}
					}}
				>
					{config?.globalConfigPath ? formatPathForDisplay(config.globalConfigPath) : "~/.quarterdeck/config.json"}
					{config?.globalConfigPath ? <ExternalLink size={12} className="inline ml-1.5 align-middle" /> : null}
				</p>

				<h6 className="font-semibold text-text-primary mt-3 mb-0">Agent</h6>
				{supportedAgents.map((agent) => (
					<AgentRow
						key={agent.id}
						agent={agent}
						isSelected={agent.id === selectedAgentId}
						onSelect={() => setSelectedAgentId(agent.id)}
						disabled={controlsDisabled}
					/>
				))}
				{config === null ? (
					<p className="text-text-secondary py-2">Checking which CLIs are installed for this project...</p>
				) : null}
				<label
					htmlFor={bypassPermissionsCheckboxId}
					className="flex items-center gap-2 text-[13px] text-text-primary mt-2 cursor-pointer"
				>
					<RadixCheckbox.Root
						id={bypassPermissionsCheckboxId}
						aria-label="Enable bypass permissions flag"
						checked={agentAutonomousModeEnabled}
						disabled={controlsDisabled}
						onCheckedChange={(checked) => setAgentAutonomousModeEnabled(checked === true)}
						className="flex h-4 w-4 cursor-pointer items-center justify-center rounded border border-border bg-surface-2 data-[state=checked]:bg-accent data-[state=checked]:border-accent disabled:cursor-default disabled:opacity-40"
					>
						<RadixCheckbox.Indicator>
							<Check size={12} className="text-white" />
						</RadixCheckbox.Indicator>
					</RadixCheckbox.Root>
					<span>Enable bypass permissions flag</span>
				</label>
				<p className="text-text-secondary text-[13px] ml-6 mt-0 mb-0">
					Allows agents to use tools without stopping for permission. Use at your own risk.
				</p>

				<h6 className="font-semibold text-text-primary mt-4 mb-1 flex items-center gap-1.5">
					<Sparkles size={14} />
					LLM Generation
				</h6>
				{!llmConfigured ? (
					<div className="rounded-md border border-status-orange/30 bg-status-orange/5 px-3 py-2 text-[13px] text-status-orange mb-2">
						LLM features are unavailable. Set <code className="text-[12px]">ANTHROPIC_BEDROCK_BASE_URL</code> and{" "}
						<code className="text-[12px]">ANTHROPIC_AUTH_TOKEN</code> in the shell that launches Quarterdeck to
						enable auto-generated titles, branch names, and summaries.
					</div>
				) : (
					<p className="text-text-secondary text-[13px] mt-0 mb-2">
						Titles, branch names, and summaries are generated via a lightweight LLM call.
					</p>
				)}

				<label
					htmlFor="runtime-settings-show-summary-on-cards"
					className="flex items-center gap-2 text-[13px] text-text-primary cursor-pointer"
				>
					<RadixCheckbox.Root
						id="runtime-settings-show-summary-on-cards"
						aria-label="Show conversation summary on cards"
						checked={showSummaryOnCards}
						disabled={controlsDisabled}
						onCheckedChange={(checked) => setShowSummaryOnCards(checked === true)}
						className="flex h-4 w-4 cursor-pointer items-center justify-center rounded border border-border bg-surface-2 data-[state=checked]:bg-accent data-[state=checked]:border-accent disabled:cursor-default disabled:opacity-40"
					>
						<RadixCheckbox.Indicator>
							<Check size={12} className="text-white" />
						</RadixCheckbox.Indicator>
					</RadixCheckbox.Root>
					<span>Show conversation summary on cards</span>
				</label>
				<p className="text-text-secondary text-[13px] ml-6 mt-0 mb-0">
					Display a truncated preview of the agent's latest summary below the title.
				</p>

				<label
					htmlFor="runtime-settings-auto-generate-summary"
					className="flex items-center gap-2 text-[13px] text-text-primary mt-2 cursor-pointer"
				>
					<RadixCheckbox.Root
						id="runtime-settings-auto-generate-summary"
						aria-label="Auto-generate summary with LLM"
						checked={autoGenerateSummary}
						disabled={controlsDisabled}
						onCheckedChange={(checked) => setAutoGenerateSummary(checked === true)}
						className="flex h-4 w-4 cursor-pointer items-center justify-center rounded border border-border bg-surface-2 data-[state=checked]:bg-accent data-[state=checked]:border-accent disabled:cursor-default disabled:opacity-40"
					>
						<RadixCheckbox.Indicator>
							<Check size={12} className="text-white" />
						</RadixCheckbox.Indicator>
					</RadixCheckbox.Root>
					<span>Auto-generate summary with LLM</span>
				</label>
				<p className="text-text-secondary text-[13px] ml-6 mt-0 mb-0">
					Uses a fast model to condense agent conversation excerpts into a short summary for card tooltips.
				</p>
				{autoGenerateSummary ? (
					<div className="flex items-center gap-2 ml-6 mt-1.5">
						<label htmlFor="runtime-settings-summary-stale-seconds" className="text-[13px] text-text-secondary">
							Regenerate after
						</label>
						<input
							id="runtime-settings-summary-stale-seconds"
							type="text"
							inputMode="numeric"
							pattern="[0-9]*"
							value={summaryStaleAfterSeconds}
							disabled={controlsDisabled}
							onChange={(event) => {
								const raw = event.target.value.replace(/\D/g, "");
								if (raw === "") {
									return;
								}
								const value = Number.parseInt(raw, 10);
								if (Number.isFinite(value)) {
									setSummaryStaleAfterSeconds(Math.max(5, Math.min(3600, value)));
								}
							}}
							className="w-20 rounded border border-border bg-surface-2 px-2 py-1 text-[13px] text-text-primary disabled:opacity-40"
						/>
						<span className="text-[13px] text-text-secondary">seconds</span>
					</div>
				) : null}

				<h6 className="font-semibold text-text-primary mt-4 mb-2">Terminal</h6>
				<div className="flex items-center gap-2">
					<RadixSwitch.Root
						checked={shellAutoRestartEnabled}
						disabled={controlsDisabled}
						onCheckedChange={setShellAutoRestartEnabled}
						className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer disabled:opacity-40"
					>
						<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
					</RadixSwitch.Root>
					<span className="text-[13px] text-text-primary">Auto-restart shell terminals on unexpected exit</span>
				</div>
				<p className="text-text-secondary text-[13px] mt-1 mb-0">
					When enabled, shell terminals that crash or exit unexpectedly will automatically restart.
				</p>

				<h6 className="font-semibold text-text-primary mt-4 mb-2">Changes</h6>
				<div className="flex items-center gap-2">
					<RadixSwitch.Root
						checked={unmergedChangesIndicatorEnabled}
						disabled={controlsDisabled}
						onCheckedChange={setUnmergedChangesIndicatorEnabled}
						className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer disabled:opacity-40"
					>
						<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
					</RadixSwitch.Root>
					<span className="text-[13px] text-text-primary">Show unmerged changes indicator</span>
				</div>
				<p className="text-text-secondary text-[13px] mt-1 mb-0">
					Show a blue dot on the Changes icon when a task branch has committed changes not yet merged into the base
					branch.
				</p>

				<h6 className="font-semibold text-text-primary mt-4 mb-2">Trash</h6>
				<div className="flex items-center gap-2">
					<RadixSwitch.Root
						checked={showTrashWorktreeNotice}
						disabled={controlsDisabled}
						onCheckedChange={setShowTrashWorktreeNotice}
						className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer disabled:opacity-40"
					>
						<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
					</RadixSwitch.Root>
					<span className="text-[13px] text-text-primary">Show worktree notice when trashing tasks</span>
				</div>

				<h6 className="font-semibold text-text-primary mt-4 mb-2">Sound notifications</h6>
				<div className="flex items-center gap-2">
					<RadixSwitch.Root
						checked={audibleNotificationsEnabled}
						disabled={controlsDisabled}
						onCheckedChange={setAudibleNotificationsEnabled}
						className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer disabled:opacity-40"
					>
						<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
					</RadixSwitch.Root>
					<span className="text-[13px] text-text-primary">Play sounds when tasks need attention</span>
				</div>
				<div
					className={cn(
						"flex items-center gap-2 mt-2 text-[13px]",
						(!audibleNotificationsEnabled || controlsDisabled) && "opacity-40",
					)}
				>
					<RadixCheckbox.Root
						id="audible-notification-only-when-hidden"
						checked={audibleNotificationsOnlyWhenHidden}
						disabled={!audibleNotificationsEnabled || controlsDisabled}
						onCheckedChange={(checked) => setAudibleNotificationsOnlyWhenHidden(checked === true)}
						className="flex h-4 w-4 items-center justify-center rounded border border-border bg-surface-2 data-[state=checked]:border-accent data-[state=checked]:bg-accent"
					>
						<RadixCheckbox.Indicator>
							<Check size={12} className="text-white" />
						</RadixCheckbox.Indicator>
					</RadixCheckbox.Root>
					<label htmlFor="audible-notification-only-when-hidden" className="cursor-pointer">
						<span className="text-text-primary">Only when tab is hidden</span>
						<span className="text-text-tertiary"> — skip sounds while you're looking at the board</span>
					</label>
				</div>
				<div className="flex items-center gap-3 mt-3">
					<Volume2
						size={14}
						className={cn(
							"text-text-secondary",
							(!audibleNotificationsEnabled || controlsDisabled) && "opacity-40",
						)}
					/>
					<input
						type="range"
						min={0}
						max={100}
						step={1}
						value={Math.round(audibleNotificationVolume * 100)}
						onChange={(e) => setAudibleNotificationVolume(Number(e.target.value) / 100)}
						disabled={!audibleNotificationsEnabled || controlsDisabled}
						className="flex-1 h-1.5 accent-accent disabled:opacity-40"
					/>
					<span
						className={cn(
							"text-[13px] text-text-secondary w-8 text-right tabular-nums",
							(!audibleNotificationsEnabled || controlsDisabled) && "opacity-40",
						)}
					>
						{Math.round(audibleNotificationVolume * 100)}%
					</span>
				</div>
				<div className="flex flex-col gap-2 mt-3">
					{(
						[
							["permission", "Permissions", "Task is waiting for approval"],
							["review", "Review", "Task is ready for review"],
							["failure", "Failure", "Agent session failed or errored"],
							["completion", "Completion", "Task completed successfully"],
						] as const
					).map(([key, label, description]) => (
						<div
							key={key}
							className={cn(
								"flex items-center gap-2 text-[13px]",
								(!audibleNotificationsEnabled || controlsDisabled) && "opacity-40",
							)}
						>
							<RadixCheckbox.Root
								id={`audible-notification-${key}`}
								checked={audibleNotificationEvents[key]}
								disabled={!audibleNotificationsEnabled || controlsDisabled}
								onCheckedChange={(checked) =>
									setAudibleNotificationEvents((prev) => ({ ...prev, [key]: checked === true }))
								}
								className="flex h-4 w-4 items-center justify-center rounded border border-border bg-surface-2 data-[state=checked]:border-accent data-[state=checked]:bg-accent"
							>
								<RadixCheckbox.Indicator>
									<Check size={12} className="text-white" />
								</RadixCheckbox.Indicator>
							</RadixCheckbox.Root>
							<label htmlFor={`audible-notification-${key}`} className="flex items-center gap-1 cursor-pointer">
								<span className="text-text-primary">{label}</span>
								<span className="text-text-tertiary">— {description}</span>
							</label>
						</div>
					))}
				</div>
				<div className="mt-3">
					<Button
						size="sm"
						disabled={!audibleNotificationsEnabled || controlsDisabled}
						onClick={() => {
							notificationAudioPlayer.ensureContext();
							notificationAudioPlayer.play("permission", audibleNotificationVolume);
						}}
					>
						Test sound
					</Button>
				</div>

				<h6 className="font-semibold text-text-primary mt-4 mb-2">Layout</h6>
				<Button size="sm" onClick={resetLayoutCustomizations}>
					Reset layout
				</Button>
				<p className="text-text-secondary text-[13px] mt-2 mb-0">
					Reset sidebar, split pane, and terminal resize customizations back to their defaults.
				</p>

				<h6 className="font-semibold text-text-primary mt-4 mb-2">Terminal rendering</h6>
				<Button
					size="sm"
					onClick={() => {
						const count = resetAllTerminalRenderers();
						showAppToast({
							intent: "success",
							message: `Reset rendering for ${count} terminal${count === 1 ? "" : "s"}`,
							timeout: 3000,
						});
					}}
				>
					Reset terminal rendering
				</Button>
				<p className="text-text-secondary text-[13px] mt-2 mb-0">
					Clear cached font textures and re-render all terminals. Use this if terminal text looks blurry or
					distorted after moving between monitors.
				</p>

				<h5 className="font-semibold text-text-primary mt-4 mb-0">Project</h5>
				<p
					className="text-text-secondary font-mono text-xs m-0 break-all"
					style={{ cursor: config?.projectConfigPath ? "pointer" : undefined }}
					onClick={() => {
						if (config?.projectConfigPath) {
							handleOpenFilePath(config.projectConfigPath);
						}
					}}
				>
					{config?.projectConfigPath
						? formatPathForDisplay(config.projectConfigPath)
						: "<project>/.quarterdeck/config.json"}
					{config?.projectConfigPath ? <ExternalLink size={12} className="inline ml-1.5 align-middle" /> : null}
				</p>

				<div className="flex items-center justify-between mt-3 mb-2">
					<h6 ref={shortcutsSectionRef} className="font-semibold text-text-primary m-0">
						Script shortcuts
					</h6>
					<Button
						variant="ghost"
						size="sm"
						icon={<Plus size={14} />}
						onClick={() => {
							setShortcuts((current) => {
								const nextLabel = getNextShortcutLabel(current, "Run");
								setPendingShortcutScrollIndex(current.length);
								return [
									...current,
									{
										label: nextLabel,
										command: "",
										icon: "play",
									},
								];
							});
						}}
						disabled={controlsDisabled}
					>
						Add
					</Button>
				</div>

				{shortcuts.map((shortcut, shortcutIndex) => (
					<div
						key={shortcutIndex}
						ref={(node) => {
							shortcutRowRefs.current[shortcutIndex] = node;
						}}
						className="grid gap-2 mb-1"
						style={{ gridTemplateColumns: "max-content 1fr 2fr auto" }}
					>
						<ShortcutIconPicker
							value={shortcut.icon}
							onSelect={(icon) =>
								setShortcuts((current) =>
									current.map((item, itemIndex) => (itemIndex === shortcutIndex ? { ...item, icon } : item)),
								)
							}
						/>
						<input
							value={shortcut.label}
							onChange={(event) =>
								setShortcuts((current) =>
									current.map((item, itemIndex) =>
										itemIndex === shortcutIndex ? { ...item, label: event.target.value } : item,
									),
								)
							}
							placeholder="Label"
							className="h-7 w-full rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
						/>
						<input
							value={shortcut.command}
							onChange={(event) =>
								setShortcuts((current) =>
									current.map((item, itemIndex) =>
										itemIndex === shortcutIndex ? { ...item, command: event.target.value } : item,
									),
								)
							}
							placeholder="Command"
							className="h-7 w-full rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
						/>
						<Button
							variant="ghost"
							size="sm"
							icon={<X size={14} />}
							aria-label={`Remove shortcut ${shortcut.label}`}
							onClick={() =>
								setShortcuts((current) => current.filter((_, itemIndex) => itemIndex !== shortcutIndex))
							}
						/>
					</div>
				))}
				{shortcuts.length === 0 ? (
					<p className="text-text-secondary text-[13px]">No shortcuts configured.</p>
				) : null}

				{saveError ? (
					<div className="flex gap-2 rounded-md border border-status-red/30 bg-status-red/5 p-3 text-[13px] mt-3">
						<span className="text-text-primary">{saveError}</span>
					</div>
				) : null}
			</DialogBody>
			<DialogFooter>
				<Button
					size="sm"
					variant="ghost"
					className="mr-auto mt-[3px]"
					icon={<ExternalLink size={14} />}
					onClick={() => window.open("https://github.com/dankhole/quarterdeck", "_blank")}
				>
					Read the docs
				</Button>
				<Button onClick={() => onOpenChange(false)} disabled={controlsDisabled}>
					Cancel
				</Button>
				<Button
					variant="primary"
					onClick={() => void handleSave()}
					disabled={controlsDisabled || !hasUnsavedChanges}
				>
					Save
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
