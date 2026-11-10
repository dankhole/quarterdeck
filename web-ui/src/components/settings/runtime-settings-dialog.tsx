// Settings navigation and one draft/save session, pinned to its opening project.
import { ExternalLink, Settings } from "lucide-react";
import { type ReactElement, type ReactNode, useCallback, useRef, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import { HarnessSection } from "@/components/settings/agent-section";
import { CodeNavigationSection } from "@/components/settings/code-navigation-section";
import { DesktopEnvironmentSection } from "@/components/settings/desktop-environment-section";
import { AiFeaturesSection, NotificationsSection, TerminalSection } from "@/components/settings/display-sections";
import { DiagnosticsSection, EditorSection, TroubleshootingSection } from "@/components/settings/general-sections";
import { PromptShortcutDefaultsSection } from "@/components/settings/prompt-shortcut-defaults-section";
import {
	getSettingsCategory,
	getSettingsNavigationGroups,
	getSettingsProjectName,
	getSettingsScopeDescription,
	resolveSettingsProject,
	type SettingsCategoryId,
	type SettingsProject,
} from "@/components/settings/settings-navigation";
import { ShortcutsSection } from "@/components/settings/shortcuts-section";
import { TaskCreationSection } from "@/components/settings/task-creation-section";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { useDesktopDraftProtection } from "@/hooks/app";
import { buildSettingsSaveRequest } from "@/hooks/settings/settings-form";
import { useSettingsForm } from "@/hooks/settings/use-settings-form";
import { useLayoutCustomizations } from "@/resize/layout-customizations";
import { openFileOnHost } from "@/runtime/runtime-config-query";
import { getRuntimeEnvironment } from "@/runtime/runtime-environment";
import type { RuntimeConfigResponse } from "@/runtime/types";
import { useRuntimeConfig } from "@/runtime/use-runtime-config";
import { formatPathForDisplay } from "@/utils/path-display";
import { toErrorMessage } from "@/utils/to-error-message";

export type RuntimeSettingsSection = "shortcuts";

interface RuntimeSettingsDialogProps {
	open: boolean;
	projectId: string | null;
	/** Live registry; the session resolves its locked project ID from this list. */
	projects: readonly SettingsProject[];
	initialConfig?: RuntimeConfigResponse | null;
	onOpenChange: (open: boolean) => void;
	onSaved?: () => void;
	initialSection?: RuntimeSettingsSection | null;
}

/** Closing ends the draft session; reopening mounts a fresh identity and selection. */
export function RuntimeSettingsDialog(props: RuntimeSettingsDialogProps): ReactElement | null {
	return props.open ? <SettingsDialogSession {...props} /> : null;
}

function SettingsDialogSession({
	projectId: incomingProjectId,
	projects,
	initialConfig: incomingConfig = null,
	onOpenChange,
	onSaved,
	initialSection,
}: RuntimeSettingsDialogProps): ReactElement {
	// Never retarget an open form. useRuntimeConfig can retain data during a project
	// change, and edited project fields must not reconcile into another destination.
	const [target] = useState(() => ({
		projectId: incomingProjectId,
		initialConfig: incomingConfig,
	}));
	const projectId = target.projectId;
	const scopeChanged = incomingProjectId !== projectId;
	const project = resolveSettingsProject(projects, projectId);
	const projectName = getSettingsProjectName(project, projectId);
	const { config, isLoading, isSaving, save, refresh } = useRuntimeConfig(
		true,
		projectId,
		scopeChanged ? target.initialConfig : incomingConfig,
	);
	const { resetLayoutCustomizations } = useLayoutCustomizations();
	const [saveError, setSaveError] = useState<string | null>(null);
	const [selectedCategory, setSelectedCategory] = useState<SettingsCategoryId>(initialSection ?? "agents");
	const pageRef = useRef<HTMLDivElement | null>(null);
	const desktop = getRuntimeEnvironment().kind === "desktop";
	const groups = getSettingsNavigationGroups(projectName, desktop);
	const category = getSettingsCategory(selectedCategory);
	const destinationError = !projectId
		? null
		: !project
			? "This settings project is not registered. All-project settings are also disabled in this project-bound session. Cancel and reopen Settings for an available project. Your drafts have not been transferred or saved."
			: project.availability?.status === "unavailable"
				? "This project folder is unavailable. All-project settings are also disabled in this project-bound session. Locate the folder or check its availability outside Settings before saving. Your drafts are preserved."
				: null;
	const loadFailed = config === null && !isLoading;
	const blockingError =
		destinationError ??
		(loadFailed
			? "Could not load runtime settings. No form changes can be saved until settings are available."
			: null);
	const controlsDisabled = isLoading || isSaving || config === null || destinationError !== null;
	const canEditProject = Boolean(project && config?.projectConfigPath && destinationError === null);
	const { fields, setField, hasUnsavedChanges, changedScopes } = useSettingsForm(config, true);
	useDesktopDraftProtection("Settings", hasUnsavedChanges || isSaving);

	const selectCategory = (next: SettingsCategoryId) => {
		setSelectedCategory(next);
		if (pageRef.current) pageRef.current.scrollTop = 0;
	};

	const handleSave = async () => {
		setSaveError(null);
		if (!config || isSaving || destinationError) {
			setSaveError(blockingError ?? "Runtime settings are still loading. Try again in a moment.");
			return;
		}
		if (changedScopes.includes("project") && !canEditProject) {
			setSaveError("Project changes need an available project destination. Your changes have not been saved.");
			return;
		}
		const saved = await save(buildSettingsSaveRequest(fields, canEditProject));
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
			void openFileOnHost(projectId, filePath).then(
				(response) => {
					if (response.outcome === "simulated") {
						showAppToast({
							intent: "success",
							message: "Agent Lab recorded the file-open request; no desktop window was opened.",
						});
					}
				},
				(error) => setSaveError(`Could not open file on host: ${toErrorMessage(error)}`),
			);
		},
		[projectId],
	);

	const sectionProps = { fields, setField, disabled: controlsDisabled } as const;
	const projectSectionProps = { ...sectionProps, disabled: controlsDisabled || !canEditProject };
	const pages: Record<SettingsCategoryId, ReactNode> = {
		agents: <HarnessSection {...sectionProps} config={config} />,
		notifications: <NotificationsSection {...sectionProps} />,
		"terminal-editor": (
			<>
				<TerminalSection {...sectionProps} />
				<EditorSection {...sectionProps} />
			</>
		),
		"code-navigation": <CodeNavigationSection {...sectionProps} projectId={projectId} />,
		"prompt-shortcuts": (
			<PromptShortcutDefaultsSection
				config={config}
				disabled={controlsDisabled}
				onRestored={() => {
					refresh();
					onSaved?.();
				}}
			/>
		),
		"task-creation": canEditProject ? (
			<TaskCreationSection {...projectSectionProps} projectName={projectName} folderOnly={project?.folderOnly} />
		) : (
			<ProjectSettingsEmptyState projectId={projectId} reason={destinationError} />
		),
		shortcuts: canEditProject ? (
			<ShortcutsSection {...projectSectionProps} />
		) : (
			<ProjectSettingsEmptyState projectId={projectId} reason={destinationError} />
		),
		"runtime-environment": <DesktopEnvironmentSection open />,
		diagnostics: (
			<>
				<DiagnosticsSection />
				<AiFeaturesSection llmConfigured={config?.llmConfigured ?? false} />
			</>
		),
		troubleshooting: <TroubleshootingSection onResetLayout={resetLayoutCustomizations} />,
	};
	const configPath =
		category.scope === "global"
			? config?.globalConfigPath
			: category.scope === "project"
				? config?.projectConfigPath
				: null;
	const changedScopeLabels = changedScopes.map((scope) =>
		scope === "global" ? "All projects" : `Project: ${projectName}`,
	);

	return (
		<Dialog
			open
			onOpenChange={(next) => !isSaving && onOpenChange(next)}
			contentStyle={{ maxWidth: "1060px", height: "min(760px, 90dvh)", maxHeight: "90dvh" }}
		>
			<DialogHeader title="Settings" icon={<Settings size={16} />} />
			{blockingError ? (
				<div className="shrink-0 border-b border-border px-4 py-2 text-sm leading-5">
					<p role="alert" className="m-0 text-status-red">
						{blockingError}
					</p>
					{loadFailed && !destinationError ? (
						<Button size="sm" className="mt-2" onClick={refresh}>
							Retry loading settings
						</Button>
					) : null}
				</div>
			) : null}
			<DialogBody className="runtime-settings !p-0 !overflow-hidden flex flex-col md:flex-row">
				<div className="shrink-0 border-b border-border px-3 py-2 md:hidden">
					<label htmlFor="settings-category" className="sr-only">
						Settings category
					</label>
					<select
						id="settings-category"
						value={selectedCategory}
						onChange={(event) => selectCategory(event.target.value as SettingsCategoryId)}
						className="w-full min-w-0 rounded-md border border-border-bright bg-surface-2 px-2 py-1.5 text-sm text-text-primary focus:outline-2 focus:outline-border-focus"
					>
						{groups.map((group) => (
							<optgroup key={group.id} label={group.label}>
								{group.categories.map((item) => (
									<option key={item.id} value={item.id}>
										{item.title}
									</option>
								))}
							</optgroup>
						))}
					</select>
				</div>
				<nav
					aria-label="Settings categories"
					className="hidden md:block w-60 shrink-0 overflow-y-auto border-r border-border p-4 space-y-6"
				>
					{groups.map((group) => (
						<div key={group.id}>
							<p
								id={`settings-group-${group.id}`}
								className="m-0 mb-2 break-words text-sm font-semibold text-text-secondary"
							>
								{group.label}
							</p>
							<ul aria-labelledby={`settings-group-${group.id}`} className="list-none m-0 p-0 space-y-1">
								{group.categories.map((item) => (
									<li key={item.id}>
										<button
											type="button"
											aria-current={selectedCategory === item.id ? "page" : undefined}
											aria-controls={`settings-page-${item.id}`}
											onClick={() => selectCategory(item.id)}
											className={cn(
												"w-full rounded-md px-3 py-2 text-left text-sm leading-5 focus-visible:outline-2 focus-visible:outline-border-focus",
												selectedCategory === item.id
													? "bg-surface-3 font-semibold text-text-primary border-l-2 border-accent"
													: "text-text-secondary hover:bg-surface-2 hover:text-text-primary",
											)}
										>
											{item.title}
										</button>
									</li>
								))}
							</ul>
						</div>
					))}
				</nav>
				<div ref={pageRef} className="min-w-0 min-h-0 flex-1 overflow-y-auto p-3 md:p-6">
					<header className="mb-4 border-b border-border pb-3 md:mb-6 md:pb-4">
						<h2 id="settings-category-heading" className="m-0 text-xl font-semibold leading-7 text-text-primary">
							{category.title}
						</h2>
						<p className="mt-1 mb-0 text-sm leading-6 text-text-secondary">
							{category.scope === "project" && !projectId
								? "Select a project to edit its settings. All-project settings remain available."
								: getSettingsScopeDescription(category.scope, projectName)}
						</p>
						<div className="mt-1 flex flex-wrap items-start gap-x-4 gap-y-1">
							{category.scope === "project" && project?.path ? (
								<details className="min-w-0 max-w-full text-xs leading-5 text-text-secondary">
									<summary
										className="cursor-pointer w-fit focus-visible:outline-2 focus-visible:outline-border-focus"
										title={project.path}
									>
										Project folder
									</summary>
									<p className="mt-1 mb-0 break-all font-mono">{formatPathForDisplay(project.path)}</p>
								</details>
							) : null}
							{configPath ? (
								<button
									type="button"
									onClick={() => handleOpenFilePath(configPath)}
									className="inline-flex max-w-full items-start gap-1 text-left text-xs leading-5 text-text-secondary hover:text-text-primary focus-visible:outline-2 focus-visible:outline-border-focus"
									aria-label={`Open configuration file for ${category.scope === "global" ? "all projects" : projectName}`}
									title={configPath}
								>
									<span>Open configuration file</span>
									<ExternalLink size={12} className="mt-1 shrink-0" />
								</button>
							) : null}
						</div>
					</header>
					{isLoading ? (
						<p role="status" className="text-sm text-text-secondary">
							Loading settings…
						</p>
					) : null}
					{scopeChanged ? (
						<p
							role="status"
							className="mb-4 rounded-md border border-status-orange/40 p-3 text-sm leading-6 text-text-primary"
						>
							Settings remain for {projectName}. Save or cancel these changes, then reopen Settings to edit the
							newly selected project.
						</p>
					) : null}
					{/* Keep sections mounted across category changes so nested editor drafts survive. */}
					{groups
						.flatMap((group) => group.categories)
						.map((item) => (
							<section
								key={item.id}
								id={`settings-page-${item.id}`}
								aria-label={item.title}
								hidden={selectedCategory !== item.id}
							>
								{pages[item.id]}
							</section>
						))}
				</div>
			</DialogBody>
			<div
				className={cn(
					"shrink-0 text-sm leading-5",
					(saveError || changedScopeLabels.length > 0) && "border-t border-border px-4 py-2",
				)}
			>
				{saveError ? (
					<p role="alert" className="m-0 text-status-red">
						{saveError}
					</p>
				) : null}
				<p id="settings-unsaved-changes" className="m-0 text-text-secondary" aria-live="polite" aria-atomic="true">
					{changedScopeLabels.length > 0
						? `Unsaved changes: ${changedScopeLabels.join("; ")} (all categories).`
						: ""}
				</p>
			</div>
			<p id="settings-form-save-description" className="sr-only">
				Save changes includes every category. Cancel discards form changes, not actions labelled “now” or described
				as immediate.
			</p>
			<DialogFooter>
				<div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
					<Button
						size="sm"
						variant="ghost"
						className="mr-auto"
						icon={<ExternalLink size={14} />}
						onClick={() =>
							window.open("https://github.com/dankhole/quarterdeck", "_blank", "noopener,noreferrer")
						}
					>
						Read the docs
					</Button>
					<Button
						onClick={() => onOpenChange(false)}
						disabled={isSaving}
						aria-describedby="settings-form-save-description"
					>
						Cancel
					</Button>
					<Button
						variant="primary"
						onClick={() => void handleSave()}
						disabled={controlsDisabled || !hasUnsavedChanges}
						aria-describedby="settings-form-save-description"
					>
						Save changes
					</Button>
				</div>
			</DialogFooter>
		</Dialog>
	);
}

function ProjectSettingsEmptyState({
	projectId,
	reason,
}: {
	projectId: string | null;
	reason: string | null;
}): ReactElement {
	return (
		<p className="text-sm leading-6 text-text-secondary">
			{!projectId
				? "No project selected. Select a project, then reopen Settings to edit its task creation and command shortcuts."
				: (reason ??
					"Project settings are loading or unavailable. No project changes can be saved until a destination is ready.")}
		</p>
	);
}
