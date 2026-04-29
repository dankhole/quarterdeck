// Settings dialog composition for Quarterdeck.
import { getRuntimeLaunchSupportedAgentCatalog } from "@runtime-agent-catalog";
import { DEFAULT_PROMPT_SHORTCUTS } from "@runtime-config-defaults";
import { ExternalLink, Settings } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import { type AgentRowModel, AgentSection } from "@/components/settings/agent-section";
import { AiFeaturesSection, NotificationsSection, TerminalSection } from "@/components/settings/display-sections";
import {
	AdvancedSection,
	ConfirmationsSection,
	GitSection,
	TroubleshootingSection,
} from "@/components/settings/general-sections";
import { ShortcutsSection } from "@/components/settings/shortcuts-section";
import { Button } from "@/components/ui/button";
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
import { useSettingsForm } from "@/hooks/settings/use-settings-form";
import { useLayoutCustomizations } from "@/resize/layout-customizations";
import { openFileOnHost, saveRuntimeConfig } from "@/runtime/runtime-config-query";
import type { RuntimeAgentId, RuntimeConfigResponse } from "@/runtime/types";
import { useRuntimeConfig } from "@/runtime/use-runtime-config";
import { formatPathForDisplay } from "@/utils/path-display";
import { toErrorMessage } from "@/utils/to-error-message";

export type RuntimeSettingsSection = "shortcuts";

const SETTINGS_AGENT_ORDER: readonly RuntimeAgentId[] = ["claude", "codex", "pi"];

export function RuntimeSettingsDialog({
	open,
	projectId,
	initialConfig = null,
	onOpenChange,
	onSaved,
	initialSection,
}: {
	open: boolean;
	projectId: string | null;
	initialConfig?: RuntimeConfigResponse | null;
	onOpenChange: (open: boolean) => void;
	onSaved?: () => void;
	initialSection?: RuntimeSettingsSection | null;
}): React.ReactElement {
	const { config, isLoading, isSaving, save } = useRuntimeConfig(open, projectId, initialConfig);
	const { resetLayoutCustomizations } = useLayoutCustomizations();
	const [saveError, setSaveError] = useState<string | null>(null);
	useEffect(() => {
		if (open) setSaveError(null);
	}, [open]);
	const [resetDefaultShortcutsDialogOpen, setResetDefaultShortcutsDialogOpen] = useState(false);
	const [isResettingDefaultShortcuts, setIsResettingDefaultShortcuts] = useState(false);

	const shortcutsSectionRef = useRef<HTMLHeadingElement | null>(null);
	const controlsDisabled = isLoading || isSaving || config === null;

	// Ordered agent list (no dependency on form state — needed to compute fallbackAgentId)
	const orderedAgents = useMemo(() => {
		const agents =
			config?.agents.map((agent) => ({
				id: agent.id,
				label: agent.label,
				binary: agent.binary,
				command: agent.command,
				status: agent.status,
				statusMessage: agent.statusMessage,
				installed: agent.installed,
			})) ??
			getRuntimeLaunchSupportedAgentCatalog().map((agent) => ({
				id: agent.id,
				label: agent.label,
				binary: agent.binary,
				command: agent.binary,
				status: "missing" as const,
				statusMessage: null,
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

	// Agent display models
	const supportedAgents = useMemo<AgentRowModel[]>(
		() =>
			orderedAgents.map((agent) => ({
				...agent,
			})),
		[orderedAgents],
	);

	// Reset default prompt shortcuts — visibility
	const hasHiddenDefaults = (config?.hiddenDefaultPromptShortcuts ?? []).length > 0;
	const hasOverriddenDefaults = useMemo(() => {
		const shortcuts = config?.promptShortcuts ?? [];
		return DEFAULT_PROMPT_SHORTCUTS.some((def) => {
			const match = shortcuts.find((s) => s.label.trim().toLowerCase() === def.label.trim().toLowerCase());
			return match !== undefined && match.prompt !== def.prompt;
		});
	}, [config?.promptShortcuts]);
	const showResetDefaultShortcuts = hasHiddenDefaults || hasOverriddenDefaults;

	// Reset default prompt shortcuts — handler (separate save path, bypasses form save)
	const handleResetDefaultShortcuts = useCallback(async () => {
		if (!projectId) return;
		setIsResettingDefaultShortcuts(true);
		try {
			const defaultLabelSet = new Set(DEFAULT_PROMPT_SHORTCUTS.map((d) => d.label.trim().toLowerCase()));
			const userOnlyShortcuts = (config?.promptShortcuts ?? []).filter(
				(s) => !defaultLabelSet.has(s.label.trim().toLowerCase()),
			);
			await saveRuntimeConfig(projectId, {
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
			const message = toErrorMessage(error);
			showAppToast({
				intent: "danger",
				icon: "error",
				message: `Failed to reset default shortcuts: ${message}`,
				timeout: 7000,
			});
		} finally {
			setIsResettingDefaultShortcuts(false);
		}
	}, [projectId, config?.promptShortcuts, onSaved]);

	// Scroll to shortcuts section when opened with initialSection
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
			void openFileOnHost(projectId, filePath).catch((error) => {
				const message = toErrorMessage(error);
				setSaveError(`Could not open file on host: ${message}`);
			});
		},
		[projectId],
	);

	const sectionProps = { fields, setField, disabled: controlsDisabled } as const;

	return (
		<>
			<Dialog open={open} onOpenChange={onOpenChange} contentStyle={{ width: "960px" }}>
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

					<AgentSection
						{...sectionProps}
						agents={supportedAgents}
						configLoaded={config !== null}
						config={config}
					/>
					<AiFeaturesSection {...sectionProps} llmConfigured={config?.llmConfigured ?? false} />
					<NotificationsSection {...sectionProps} />
					<TerminalSection {...sectionProps} />
					<GitSection {...sectionProps} />
					<ConfirmationsSection {...sectionProps} />
					<TroubleshootingSection {...sectionProps} onResetLayout={resetLayoutCustomizations} />
					<AdvancedSection {...sectionProps} />

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

					<ShortcutsSection
						{...sectionProps}
						sectionRef={shortcutsSectionRef}
						showResetDefaultShortcuts={showResetDefaultShortcuts}
						isResettingDefaultShortcuts={isResettingDefaultShortcuts}
						onResetDefaultShortcuts={() => setResetDefaultShortcutsDialogOpen(true)}
					/>

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
