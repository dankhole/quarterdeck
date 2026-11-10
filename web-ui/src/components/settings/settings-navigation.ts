import type { RuntimeProjectSummary } from "@/runtime/types";

export type SettingsCategoryId =
	| "agents"
	| "notifications"
	| "terminal-editor"
	| "code-navigation"
	| "prompt-shortcuts"
	| "task-creation"
	| "shortcuts"
	| "runtime-environment"
	| "diagnostics"
	| "troubleshooting";

export type SettingsCategoryScope = "global" | "project" | "desktop" | "tools";

export interface SettingsCategory {
	id: SettingsCategoryId;
	title: string;
	scope: SettingsCategoryScope;
}

export interface SettingsNavigationGroup {
	id: SettingsCategoryScope;
	label: string;
	categories: readonly SettingsCategory[];
}

const CATEGORIES: readonly SettingsCategory[] = [
	{ id: "agents", title: "Agents", scope: "global" },
	{ id: "notifications", title: "Notifications", scope: "global" },
	{ id: "terminal-editor", title: "Terminal & editor", scope: "global" },
	{ id: "code-navigation", title: "Code navigation", scope: "global" },
	{ id: "prompt-shortcuts", title: "Prompt shortcuts", scope: "global" },
	{ id: "task-creation", title: "Task creation", scope: "project" },
	{ id: "shortcuts", title: "Command shortcuts", scope: "project" },
	{ id: "runtime-environment", title: "Runtime environment", scope: "desktop" },
	{ id: "diagnostics", title: "Diagnostics & AI setup", scope: "tools" },
	{ id: "troubleshooting", title: "Troubleshooting", scope: "tools" },
];

export type SettingsProject = Pick<
	RuntimeProjectSummary,
	"id" | "name" | "displayName" | "path" | "folderOnly" | "availability"
>;

/** Resolve only the settings target, never the board or selected task's project. */
export function resolveSettingsProject(
	projects: readonly SettingsProject[],
	projectId: string | null,
): SettingsProject | null {
	return projects.find((project) => project.id === projectId) ?? null;
}

export function getSettingsProjectName(project: SettingsProject | null, projectId: string | null): string {
	return project?.displayName ?? project?.name ?? (projectId ? "Unknown project" : "No project selected");
}

export function getSettingsNavigationGroups(projectName: string, desktop: boolean): SettingsNavigationGroup[] {
	const labels: Record<SettingsCategoryScope, string> = {
		global: "All projects",
		project: `Project: ${projectName}`,
		desktop: "This desktop",
		tools: "Tools",
	};
	return (["global", "project", ...(desktop ? ["desktop" as const] : []), "tools"] as const).map((scope) => ({
		id: scope,
		label: labels[scope],
		categories: CATEGORIES.filter((category) => category.scope === scope),
	}));
}

export function getSettingsCategory(id: SettingsCategoryId): SettingsCategory {
	// Every id is defined in the static catalog above.
	return CATEGORIES.find((category) => category.id === id)!;
}

export function getSettingsScopeDescription(scope: SettingsCategoryScope, projectName: string): string {
	switch (scope) {
		case "global":
			return "Applies to all projects in this Quarterdeck runtime.";
		case "project":
			return `Applies only to ${projectName}. Other projects are unchanged.`;
		case "desktop":
			return "Launch preferences for this desktop app only. Changes save immediately, separately from Save changes.";
		case "tools":
			return "Setup guidance and troubleshooting tools. Each action explains its scope and takes effect immediately, not through Save changes.";
	}
}
