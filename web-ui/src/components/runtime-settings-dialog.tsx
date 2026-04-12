// Settings dialog composition for Quarterdeck.
import * as RadixCheckbox from "@radix-ui/react-checkbox";
import * as RadixPopover from "@radix-ui/react-popover";
import * as RadixSwitch from "@radix-ui/react-switch";
import { getRuntimeAgentCatalogEntry, getRuntimeLaunchSupportedAgentCatalog } from "@runtime-agent-catalog";
import { DEFAULT_PROMPT_SHORTCUTS } from "@runtime-config-defaults";
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
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogTitle,
	Dialog,
	DialogBody,
	DialogFooter,
	DialogHeader,
} from "@/components/ui/dialog";
import { useSettingsForm } from "@/hooks/use-settings-form";
import { useLayoutCustomizations } from "@/resize/layout-customizations";
import { openFileOnHost, saveRuntimeConfig } from "@/runtime/runtime-config-query";
import type { RuntimeAgentId, RuntimeConfigResponse, RuntimeProjectShortcut } from "@/runtime/types";
import { useRuntimeConfig } from "@/runtime/use-runtime-config";
import { resetAllTerminalRenderers } from "@/terminal/persistent-terminal-manager";
import { notificationAudioPlayer } from "@/utils/notification-audio";
import { formatPathForDisplay } from "@/utils/path-display";

function clampPollInterval(value: string): number {
	return Math.max(500, Math.min(60000, Number(value)));
}

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

function FontWeightInput({
	value,
	onChange,
	disabled,
}: {
	value: number;
	onChange: (v: number) => void;
	disabled: boolean;
}) {
	const [draft, setDraft] = useState(String(value));
	const inputRef = useRef<HTMLInputElement>(null);

	// Sync draft when value changes externally (e.g. config load)
	useEffect(() => {
		if (document.activeElement !== inputRef.current) {
			setDraft(String(value));
		}
	}, [value]);

	const commit = () => {
		const parsed = Number(draft);
		if (Number.isFinite(parsed) && parsed >= 100 && parsed <= 900) {
			onChange(parsed);
			setDraft(String(parsed));
		} else {
			// Revert to current value on invalid input
			setDraft(String(value));
		}
	};

	return (
		<div className="flex items-center justify-between gap-3 mt-3">
			<label htmlFor="terminal-font-weight" className="text-text-primary text-[13px] shrink-0">
				Font weight
			</label>
			<input
				ref={inputRef}
				id="terminal-font-weight"
				type="text"
				inputMode="numeric"
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						commit();
						inputRef.current?.blur();
					}
				}}
				disabled={disabled}
				className="h-7 w-14 rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary text-right tabular-nums focus:border-border-focus focus:outline-none"
			/>
		</div>
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
	const [saveError, setSaveError] = useState<string | null>(null);
	useEffect(() => {
		if (open) setSaveError(null);
	}, [open]);
	const [pendingShortcutScrollIndex, setPendingShortcutScrollIndex] = useState<number | null>(null);
	const [resetDefaultShortcutsDialogOpen, setResetDefaultShortcutsDialogOpen] = useState(false);
	const [isResettingDefaultShortcuts, setIsResettingDefaultShortcuts] = useState(false);

	const hasHiddenDefaults = (config?.hiddenDefaultPromptShortcuts ?? []).length > 0;
	const hasOverriddenDefaults = useMemo(() => {
		const shortcuts = config?.promptShortcuts ?? [];
		return DEFAULT_PROMPT_SHORTCUTS.some((def) => {
			const match = shortcuts.find((s) => s.label.trim().toLowerCase() === def.label.trim().toLowerCase());
			return match !== undefined && match.prompt !== def.prompt;
		});
	}, [config?.promptShortcuts]);
	const showResetDefaultShortcuts = hasHiddenDefaults || hasOverriddenDefaults;

	const handleResetDefaultShortcuts = useCallback(async () => {
		if (!workspaceId) return;
		setIsResettingDefaultShortcuts(true);
		try {
			const defaultLabelSet = new Set(DEFAULT_PROMPT_SHORTCUTS.map((d) => d.label.trim().toLowerCase()));
			const userOnlyShortcuts = (config?.promptShortcuts ?? []).filter(
				(s) => !defaultLabelSet.has(s.label.trim().toLowerCase()),
			);
			await saveRuntimeConfig(workspaceId, {
				promptShortcuts: userOnlyShortcuts,
				hiddenDefaultPromptShortcuts: [],
			});
			onSaved?.();
			setResetDefaultShortcutsDialogOpen(false);
			showAppToast({
				intent: "success",
				icon: "tick",
				message: "Default prompt shortcuts restored.",
				timeout: 3000,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			showAppToast({
				intent: "danger",
				icon: "error",
				message: `Failed to reset default shortcuts: ${message}`,
				timeout: 7000,
			});
		} finally {
			setIsResettingDefaultShortcuts(false);
		}
	}, [workspaceId, config?.promptShortcuts, onSaved]);
	const shortcutsSectionRef = useRef<HTMLHeadingElement | null>(null);
	const shortcutRowRefs = useRef<Array<HTMLDivElement | null>>([]);
	const controlsDisabled = isLoading || isSaving || config === null;
	const bypassPermissionsCheckboxId = "runtime-settings-bypass-permissions";
	// Ordered agent list (no dependency on form state — needed to compute fallbackAgentId)
	const orderedAgents = useMemo(() => {
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
		return [...agents].sort((left, right) => {
			const leftOrderIndex = orderIndexByAgentId.get(left.id) ?? Number.MAX_SAFE_INTEGER;
			const rightOrderIndex = orderIndexByAgentId.get(right.id) ?? Number.MAX_SAFE_INTEGER;
			return leftOrderIndex - rightOrderIndex;
		});
	}, [config?.agents]);
	const firstInstalledAgentId = orderedAgents.find((agent) => agent.installed)?.id;
	const fallbackAgentId = firstInstalledAgentId ?? orderedAgents[0]?.id ?? "claude";

	// Consolidated form state — dirty check, reset, and save payload are automatic
	const { fields, setField, hasUnsavedChanges } = useSettingsForm(config, open, fallbackAgentId);

	// Add command display string (depends on form state)
	const supportedAgents = useMemo<RuntimeSettingsAgentRowModel[]>(
		() =>
			orderedAgents.map((agent) => ({
				...agent,
				command: buildDisplayedAgentCommand(agent.id, agent.binary, fields.agentAutonomousModeEnabled),
			})),
		[orderedAgents, fields.agentAutonomousModeEnabled],
	);
	const llmConfigured = config?.llmConfigured ?? false;

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
	}, [pendingShortcutScrollIndex, fields.shortcuts]);

	const handleSave = async () => {
		setSaveError(null);
		if (!config) {
			setSaveError("Runtime settings are still loading. Try again in a moment.");
			return;
		}
		const selectedAgent = supportedAgents.find((agent) => agent.id === fields.selectedAgentId);
		if (!selectedAgent || selectedAgent.installed !== true) {
			setSaveError("Selected agent is not installed. Install it first or choose an installed agent.");
			return;
		}
		const saved = await save(fields);
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
		<>
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
						{config?.globalConfigPath
							? formatPathForDisplay(config.globalConfigPath)
							: "~/.quarterdeck/config.json"}
						{config?.globalConfigPath ? <ExternalLink size={12} className="inline ml-1.5 align-middle" /> : null}
					</p>

					<h6 className="font-semibold text-text-primary mt-3 mb-0">Agent</h6>
					{supportedAgents.map((agent) => (
						<AgentRow
							key={agent.id}
							agent={agent}
							isSelected={agent.id === fields.selectedAgentId}
							onSelect={() => setField("selectedAgentId", agent.id)}
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
							checked={fields.agentAutonomousModeEnabled}
							disabled={controlsDisabled}
							onCheckedChange={(checked) => setField("agentAutonomousModeEnabled", checked === true)}
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
							LLM features are unavailable. Set <code className="text-[12px]">ANTHROPIC_BEDROCK_BASE_URL</code>{" "}
							and <code className="text-[12px]">ANTHROPIC_AUTH_TOKEN</code> in the shell that launches
							Quarterdeck to enable auto-generated titles, branch names, and summaries.
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
							checked={fields.showSummaryOnCards}
							disabled={controlsDisabled}
							onCheckedChange={(checked) => setField("showSummaryOnCards", checked === true)}
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
							checked={fields.autoGenerateSummary}
							disabled={controlsDisabled}
							onCheckedChange={(checked) => setField("autoGenerateSummary", checked === true)}
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
					{fields.autoGenerateSummary ? (
						<div className="flex items-center gap-2 ml-6 mt-1.5">
							<label
								htmlFor="runtime-settings-summary-stale-seconds"
								className="text-[13px] text-text-secondary"
							>
								Regenerate after
							</label>
							<input
								id="runtime-settings-summary-stale-seconds"
								type="text"
								inputMode="numeric"
								pattern="[0-9]*"
								value={fields.summaryStaleAfterSeconds}
								disabled={controlsDisabled}
								onChange={(event) => {
									const raw = event.target.value.replace(/\D/g, "");
									if (raw === "") {
										return;
									}
									const value = Number.parseInt(raw, 10);
									if (Number.isFinite(value)) {
										setField("summaryStaleAfterSeconds", Math.max(5, Math.min(3600, value)));
									}
								}}
								className="w-20 rounded border border-border bg-surface-2 px-2 py-1 text-[13px] text-text-primary disabled:opacity-40"
							/>
							<span className="text-[13px] text-text-secondary">seconds</span>
						</div>
					) : null}

					<h6 className="font-semibold text-text-primary mt-4 mb-2">Sound notifications</h6>
					<div className="flex items-center gap-2">
						<RadixSwitch.Root
							checked={fields.audibleNotificationsEnabled}
							disabled={controlsDisabled}
							onCheckedChange={(v) => setField("audibleNotificationsEnabled", v)}
							className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer disabled:opacity-40"
						>
							<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
						</RadixSwitch.Root>
						<span className="text-[13px] text-text-primary">Play sounds when tasks need attention</span>
					</div>
					<div
						className={cn(
							"flex items-center gap-2 mt-2 text-[13px]",
							(!fields.audibleNotificationsEnabled || controlsDisabled) && "opacity-40",
						)}
					>
						<RadixCheckbox.Root
							id="audible-notification-only-when-hidden"
							checked={fields.audibleNotificationsOnlyWhenHidden}
							disabled={!fields.audibleNotificationsEnabled || controlsDisabled}
							onCheckedChange={(checked) => setField("audibleNotificationsOnlyWhenHidden", checked === true)}
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
								(!fields.audibleNotificationsEnabled || controlsDisabled) && "opacity-40",
							)}
						/>
						<input
							type="range"
							min={0}
							max={100}
							step={1}
							value={Math.round(fields.audibleNotificationVolume * 100)}
							onChange={(e) => setField("audibleNotificationVolume", Number(e.target.value) / 100)}
							disabled={!fields.audibleNotificationsEnabled || controlsDisabled}
							className="flex-1 h-1.5 accent-accent disabled:opacity-40"
						/>
						<span
							className={cn(
								"text-[13px] text-text-secondary w-8 text-right tabular-nums",
								(!fields.audibleNotificationsEnabled || controlsDisabled) && "opacity-40",
							)}
						>
							{Math.round(fields.audibleNotificationVolume * 100)}%
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
									(!fields.audibleNotificationsEnabled || controlsDisabled) && "opacity-40",
								)}
							>
								<RadixCheckbox.Root
									id={`audible-notification-${key}`}
									checked={fields.audibleNotificationEvents[key]}
									disabled={!fields.audibleNotificationsEnabled || controlsDisabled}
									onCheckedChange={(checked) =>
										setField("audibleNotificationEvents", {
											...fields.audibleNotificationEvents,
											[key]: checked === true,
										})
									}
									className="flex h-4 w-4 items-center justify-center rounded border border-border bg-surface-2 data-[state=checked]:border-accent data-[state=checked]:bg-accent"
								>
									<RadixCheckbox.Indicator>
										<Check size={12} className="text-white" />
									</RadixCheckbox.Indicator>
								</RadixCheckbox.Root>
								<label
									htmlFor={`audible-notification-${key}`}
									className="flex items-center gap-1 cursor-pointer"
								>
									<span className="text-text-primary">{label}</span>
									<span className="text-text-tertiary">— {description}</span>
								</label>
							</div>
						))}
					</div>
					<div className="mt-3">
						<Button
							size="sm"
							disabled={!fields.audibleNotificationsEnabled || controlsDisabled}
							onClick={() => {
								notificationAudioPlayer.ensureContext();
								notificationAudioPlayer.play("permission", fields.audibleNotificationVolume);
							}}
						>
							Test sound
						</Button>
					</div>

					<h6 className="font-semibold text-text-primary mt-4 mb-2">Terminal</h6>
					<div className="flex items-center gap-2">
						<RadixSwitch.Root
							checked={fields.shellAutoRestartEnabled}
							disabled={controlsDisabled}
							onCheckedChange={(v) => setField("shellAutoRestartEnabled", v)}
							className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer disabled:opacity-40"
						>
							<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
						</RadixSwitch.Root>
						<span className="text-[13px] text-text-primary">Auto-restart shell terminals on unexpected exit</span>
					</div>
					<p className="text-text-secondary text-[13px] mt-1 mb-0">
						When enabled, shell terminals that crash or exit unexpectedly will automatically restart.
					</p>
					<FontWeightInput
						value={fields.terminalFontWeight}
						onChange={(v) => setField("terminalFontWeight", v)}
						disabled={controlsDisabled}
					/>
					<p className="text-text-secondary text-[13px] mt-1 mb-0">
						CSS font weight for terminal text. Lower values are thinner. Typical range: 300–400.
					</p>
					<div className="flex items-center gap-2 mt-3">
						<RadixSwitch.Root
							checked={fields.terminalWebGLRenderer}
							disabled={controlsDisabled}
							onCheckedChange={(v) => setField("terminalWebGLRenderer", v)}
							className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer disabled:opacity-40"
						>
							<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
						</RadixSwitch.Root>
						<span className="text-[13px] text-text-primary">Use WebGL renderer</span>
					</div>
					<p className="text-text-secondary text-[13px] mt-1 mb-0">
						Uses GPU-accelerated WebGL for terminal rendering. Disable for crisper text via the browser's native
						canvas 2D renderer.
					</p>
					<Button
						size="sm"
						className="mt-3"
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

					<h6 className="font-semibold text-text-primary mt-4 mb-2">Git & Worktrees</h6>
					<div className="flex items-center gap-2">
						<RadixSwitch.Root
							checked={fields.uncommittedChangesOnCardsEnabled}
							disabled={controlsDisabled}
							onCheckedChange={(v) => setField("uncommittedChangesOnCardsEnabled", v)}
							className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer disabled:opacity-40"
						>
							<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
						</RadixSwitch.Root>
						<span className="text-[13px] text-text-primary">Show uncommitted changes dot on cards</span>
					</div>
					<p className="text-text-secondary text-[13px] mt-1 mb-0">
						Show a red dot on task cards when the worktree has uncommitted file changes.
					</p>
					<div className="flex items-center gap-2 mt-3">
						<RadixSwitch.Root
							checked={fields.unmergedChangesIndicatorEnabled}
							disabled={controlsDisabled}
							onCheckedChange={(v) => setField("unmergedChangesIndicatorEnabled", v)}
							className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer disabled:opacity-40"
						>
							<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
						</RadixSwitch.Root>
						<span className="text-[13px] text-text-primary">Show unmerged changes indicator</span>
					</div>
					<p className="text-text-secondary text-[13px] mt-1 mb-0">
						Show a blue dot on the Changes icon when a task branch has committed changes not yet merged into the
						base branch.
					</p>
					<div className="flex items-center gap-2 mt-3">
						<RadixSwitch.Root
							checked={fields.behindBaseIndicatorEnabled}
							disabled={controlsDisabled}
							onCheckedChange={(v) => setField("behindBaseIndicatorEnabled", v)}
							className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer disabled:opacity-40"
						>
							<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
						</RadixSwitch.Root>
						<span className="text-[13px] text-text-primary">Show behind-base indicator</span>
					</div>
					<p className="text-text-secondary text-[13px] mt-1 mb-0">
						Show a blue dot on the Files icon when the base branch has advanced since the task branched off.
					</p>
					<h6 className="font-semibold text-text-primary mt-4 mb-1">Developer / Experimental</h6>
					<p className="text-text-secondary text-[13px] mt-1 mb-3">
						These settings let agents escape their worktree sandbox. Enabling either one means the agent can{" "}
						<code className="text-xs bg-surface-3 px-1 rounded">cd</code> out of the task worktree into shared
						directories, which breaks worktree isolation — the status bar, branch display, and "shared" indicators
						may desync because they assume the agent stays in its assigned worktree.
					</p>
					<div className="flex items-center gap-2">
						<RadixSwitch.Root
							checked={fields.worktreeAddParentRepoDir}
							disabled={controlsDisabled}
							onCheckedChange={(v) => setField("worktreeAddParentRepoDir", v)}
							className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer disabled:opacity-40"
						>
							<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
						</RadixSwitch.Root>
						<span className="text-[13px] text-text-primary">
							Allow agents to access the parent repo from worktrees
						</span>
					</div>
					<p className="text-text-secondary text-[13px] mt-1 mb-0">
						Passes the parent repository path via{" "}
						<code className="text-xs bg-surface-3 px-1 rounded">--add-dir</code> so agents in task worktrees can
						read and write files in the original repo. The agent can navigate to the home repo, which means its
						working directory may drift — UI elements that track the agent's location (status bar branch, card
						branch pill) will show the home repo state instead of the worktree. Claude Code only.
					</p>
					<div className="flex items-center gap-2 mt-3">
						<RadixSwitch.Root
							checked={fields.worktreeAddQuarterdeckDir}
							disabled={controlsDisabled}
							onCheckedChange={(v) => setField("worktreeAddQuarterdeckDir", v)}
							className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer disabled:opacity-40"
						>
							<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
						</RadixSwitch.Root>
						<span className="text-[13px] text-text-primary">
							Allow agents to access the{" "}
							<code className="text-xs bg-surface-3 px-1 rounded">~/.quarterdeck</code> directory
						</span>
					</div>
					<p className="text-text-secondary text-[13px] mt-1 mb-0">
						Gives agents read/write access to Quarterdeck state files (board data, session state, other
						worktrees). Rogue writes can corrupt workspace state and cause revision conflicts. The agent can also
						navigate into other task worktrees, breaking isolation. Claude Code only.
					</p>
					<div className="flex items-center gap-2 mt-3">
						<RadixSwitch.Root
							checked={fields.eventLogEnabled}
							disabled={controlsDisabled}
							onCheckedChange={(v) => setField("eventLogEnabled", v)}
							className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer disabled:opacity-40"
						>
							<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
						</RadixSwitch.Root>
						<span className="text-[13px] text-text-primary">Session event log</span>
					</div>
					<p className="text-text-secondary text-[13px] mt-1 mb-0">
						Writes session lifecycle events to a JSONL file on disk (
						<code className="text-xs bg-surface-3 px-1 rounded">~/.quarterdeck/logs/events.jsonl</code>). Intended
						for developer debugging — helps diagnose stuck sessions and state tracking issues. The file grows up
						to 10 MB before rotating. Leave this off unless you are actively investigating a problem.
					</p>

					<h6 className="font-semibold text-text-primary mt-4 mb-1">Git Polling</h6>
					<p className="text-text-secondary text-[13px] mt-1 mb-3">
						How often to check for git changes in task worktrees. Lower values show changes faster but use more
						resources when many tasks are active.
					</p>
					<div className="flex flex-col gap-2">
						<div className="flex items-center justify-between gap-3">
							<label htmlFor="focused-task-poll" className="text-text-primary text-[13px] shrink-0">
								Selected task
							</label>
							<div className="flex items-center gap-1.5">
								<input
									id="focused-task-poll"
									type="number"
									min={500}
									max={60000}
									step={500}
									value={fields.focusedTaskPollMs}
									onChange={(event) => setField("focusedTaskPollMs", clampPollInterval(event.target.value))}
									disabled={controlsDisabled}
									className="h-7 w-20 rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary text-right focus:border-border-focus focus:outline-none"
								/>
								<span className="text-text-secondary text-[11px]">ms</span>
							</div>
						</div>
						<div className="flex items-center justify-between gap-3">
							<label htmlFor="background-task-poll" className="text-text-primary text-[13px] shrink-0">
								Background tasks
							</label>
							<div className="flex items-center gap-1.5">
								<input
									id="background-task-poll"
									type="number"
									min={500}
									max={60000}
									step={500}
									value={fields.backgroundTaskPollMs}
									onChange={(event) => setField("backgroundTaskPollMs", clampPollInterval(event.target.value))}
									disabled={controlsDisabled}
									className="h-7 w-20 rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary text-right focus:border-border-focus focus:outline-none"
								/>
								<span className="text-text-secondary text-[11px]">ms</span>
							</div>
						</div>
						<div className="flex items-center justify-between gap-3">
							<label htmlFor="home-repo-poll" className="text-text-primary text-[13px] shrink-0">
								Home repository
							</label>
							<div className="flex items-center gap-1.5">
								<input
									id="home-repo-poll"
									type="number"
									min={500}
									max={60000}
									step={500}
									value={fields.homeRepoPollMs}
									onChange={(event) => setField("homeRepoPollMs", clampPollInterval(event.target.value))}
									disabled={controlsDisabled}
									className="h-7 w-20 rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary text-right focus:border-border-focus focus:outline-none"
								/>
								<span className="text-text-secondary text-[11px]">ms</span>
							</div>
						</div>
					</div>

					<h6 className="font-semibold text-text-primary mt-4 mb-2">Session Recovery</h6>
					<div className="flex items-center gap-2">
						<RadixSwitch.Root
							checked={fields.showRunningTaskEmergencyActions}
							disabled={controlsDisabled}
							onCheckedChange={(v) => setField("showRunningTaskEmergencyActions", v)}
							className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer disabled:opacity-40"
						>
							<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
						</RadixSwitch.Root>
						<span className="text-[13px] text-text-primary">Show stop & trash buttons on running tasks</span>
					</div>
					<p className="text-text-secondary text-[12px] mt-1 mb-0">
						Adds emergency stop and trash actions to in-progress cards when a task is stuck.
					</p>

					<h6 className="font-semibold text-text-primary mt-4 mb-2">Layout & Debug</h6>
					<Button size="sm" onClick={resetLayoutCustomizations}>
						Reset layout
					</Button>
					<p className="text-text-secondary text-[13px] mt-2 mb-0">
						Reset sidebar, split pane, and terminal resize customizations back to their defaults.
					</p>
					<p className="text-text-secondary text-[13px] mt-3 mb-0">
						Press <kbd className="font-mono text-xs bg-surface-3 px-1 rounded">Cmd+Shift+D</kbd> to toggle the
						debug log panel. Debug logging activates automatically when the panel is opened.
					</p>

					<h6 className="font-semibold text-text-primary mt-4 mb-2">Suppressed Dialogs</h6>
					<p className="text-text-secondary text-[13px] mt-0 mb-2">
						Re-enable dialogs and confirmations you've previously dismissed.
					</p>
					<div className="flex items-center gap-2">
						<RadixSwitch.Root
							checked={fields.showTrashWorktreeNotice}
							disabled={controlsDisabled}
							onCheckedChange={(v) => setField("showTrashWorktreeNotice", v)}
							className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer disabled:opacity-40"
						>
							<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
						</RadixSwitch.Root>
						<span className="text-[13px] text-text-primary">Show worktree notice when trashing tasks</span>
					</div>
					<div className="flex items-center gap-2 mt-3">
						<RadixSwitch.Root
							checked={!fields.skipTaskCheckoutConfirmation}
							disabled={controlsDisabled}
							onCheckedChange={(checked) => setField("skipTaskCheckoutConfirmation", !checked)}
							className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer disabled:opacity-40"
						>
							<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
						</RadixSwitch.Root>
						<span className="text-[13px] text-text-primary">Show task worktree checkout confirmation</span>
					</div>
					<div className="flex items-center gap-2 mt-3">
						<RadixSwitch.Root
							checked={!fields.skipHomeCheckoutConfirmation}
							disabled={controlsDisabled}
							onCheckedChange={(checked) => setField("skipHomeCheckoutConfirmation", !checked)}
							className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer disabled:opacity-40"
						>
							<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
						</RadixSwitch.Root>
						<span className="text-[13px] text-text-primary">Show home checkout confirmation</span>
					</div>
					<div className="flex items-center gap-2 mt-3">
						<RadixSwitch.Root
							checked={!fields.skipCherryPickConfirmation}
							disabled={controlsDisabled}
							onCheckedChange={(checked) => setField("skipCherryPickConfirmation", !checked)}
							className="relative h-5 w-9 rounded-full bg-surface-4 data-[state=checked]:bg-accent cursor-pointer disabled:opacity-40"
						>
							<RadixSwitch.Thumb className="block h-4 w-4 rounded-full bg-white shadow-sm transition-transform translate-x-0.5 data-[state=checked]:translate-x-[18px]" />
						</RadixSwitch.Root>
						<span className="text-[13px] text-text-primary">Show cherry-pick landing confirmation</span>
					</div>

					{showResetDefaultShortcuts ? (
						<>
							<h6 className="font-semibold text-text-primary mt-4 mb-2">Default Prompt Shortcuts</h6>
							<p className="text-text-secondary text-[13px] mt-0 mb-2">
								Restore the built-in default prompt shortcuts (Commit and Squash Merge), replacing any
								customizations.
							</p>
							<Button
								variant="default"
								size="sm"
								disabled={controlsDisabled || isResettingDefaultShortcuts}
								onClick={() => setResetDefaultShortcutsDialogOpen(true)}
							>
								{isResettingDefaultShortcuts ? "Restoring..." : "Restore defaults"}
							</Button>
						</>
					) : null}

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
								const current = fields.shortcuts;
								const nextLabel = getNextShortcutLabel(current, "Run");
								setPendingShortcutScrollIndex(current.length);
								setField("shortcuts", [
									...current,
									{
										label: nextLabel,
										command: "",
										icon: "play",
									},
								]);
							}}
							disabled={controlsDisabled}
						>
							Add
						</Button>
					</div>

					{fields.shortcuts.map((shortcut, shortcutIndex) => (
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
									setField(
										"shortcuts",
										fields.shortcuts.map((item, itemIndex) =>
											itemIndex === shortcutIndex ? { ...item, icon } : item,
										),
									)
								}
							/>
							<input
								value={shortcut.label}
								onChange={(event) =>
									setField(
										"shortcuts",
										fields.shortcuts.map((item, itemIndex) =>
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
									setField(
										"shortcuts",
										fields.shortcuts.map((item, itemIndex) =>
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
									setField(
										"shortcuts",
										fields.shortcuts.filter((_, itemIndex) => itemIndex !== shortcutIndex),
									)
								}
							/>
						</div>
					))}
					{fields.shortcuts.length === 0 ? (
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

			<AlertDialog open={resetDefaultShortcutsDialogOpen} onOpenChange={setResetDefaultShortcutsDialogOpen}>
				<AlertDialogTitle>Restore default prompt shortcuts?</AlertDialogTitle>
				<AlertDialogDescription>
					This will restore the built-in defaults (Commit and Squash Merge), overwriting any customizations you've
					made to those shortcuts. Your other custom prompt shortcuts will not be affected.
				</AlertDialogDescription>
				<AlertDialogCancel onClick={() => setResetDefaultShortcutsDialogOpen(false)}>Cancel</AlertDialogCancel>
				<AlertDialogAction onClick={() => void handleResetDefaultShortcuts()}>Restore defaults</AlertDialogAction>
			</AlertDialog>
		</>
	);
}
