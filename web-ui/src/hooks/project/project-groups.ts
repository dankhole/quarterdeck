import type {
	ProjectGroup,
	ProjectOrganization,
	ProjectOrganizationCommand,
	RuntimeProjectSummary,
} from "@/runtime/types";

export const UNGROUPED = "ungrouped";
export interface ProjectSection {
	id: string;
	name: string;
	projects: RuntimeProjectSummary[];
}

export function projectSections(
	projects: RuntimeProjectSummary[],
	organization: ProjectOrganization | null,
): ProjectSection[] {
	const byId = new Map(projects.map((project) => [project.id, project]));
	const ordered = organization
		? [
				...organization.projectOrder.flatMap((id) => byId.get(id) ?? []),
				...projects.filter((project) => !organization.projectOrder.includes(project.id)),
			]
		: projects;
	const groups: ProjectSection[] = (organization?.groups ?? []).map((group) => ({ ...group, projects: [] }));
	const ungrouped: ProjectSection = { id: UNGROUPED, name: "Ungrouped", projects: [] };
	const sections = new Map(groups.map((group) => [group.id, group]));
	for (const project of ordered) {
		const section = sections.get(organization?.membership[project.id] ?? "") ?? ungrouped;
		section.projects.push(project);
	}
	return [...groups, ungrouped];
}

export function projectDropCommand(
	activeId: string,
	targetId: string,
	sections: ProjectSection[],
): ProjectOrganizationCommand | null {
	if (activeId.startsWith("group:")) {
		if (!targetId.startsWith("section:")) return null;
		const groupId = activeId.slice(6);
		const destination = targetId.slice(8);
		if (groupId === destination) return null;
		const sourceIndex = sections.findIndex((section) => section.id === groupId);
		const targetIndex = sections.findIndex((section) => section.id === destination);
		if (sourceIndex < 0 || targetIndex < 0) return null;
		const before = sourceIndex < targetIndex ? sections[targetIndex + 1]?.id : destination;
		return { type: "reorder_group", groupId, beforeGroupId: !before || before === UNGROUPED ? null : before };
	}
	if (!activeId.startsWith("project:")) return null;
	const projectId = activeId.slice(8);
	if (targetId === `before:${projectId}`) return null;
	const beforeProjectId = targetId.startsWith("before:") ? targetId.slice(7) : null;
	const section = beforeProjectId
		? sections.find((group) => group.projects.some((project) => project.id === beforeProjectId))
		: sections.find((group) => `section:${group.id}` === targetId || `end:${group.id}` === targetId);
	if (!section) return null;
	return {
		type: "move",
		projectIds: [projectId],
		groupId: section.id === UNGROUPED ? null : section.id,
		beforeProjectId,
	};
}

export function moveProjectOneStep(
	section: ProjectSection,
	projectId: string,
	direction: -1 | 1,
): ProjectOrganizationCommand | null {
	const index = section.projects.findIndex((project) => project.id === projectId);
	if (index < 0 || index + direction < 0 || index + direction >= section.projects.length) return null;
	return {
		type: "move",
		projectIds: [projectId],
		groupId: section.id === UNGROUPED ? null : section.id,
		beforeProjectId: section.projects[index + (direction === 1 ? 2 : -1)]?.id ?? null,
	};
}
export type ProjectGroupDialogState =
	| { type: "create"; projectId?: string }
	| { type: "rename"; group: ProjectGroup }
	| { type: "remove"; group: ProjectGroup }
	| { type: "move"; project: RuntimeProjectSummary };
