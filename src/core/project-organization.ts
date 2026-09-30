import type { ProjectOrganization, ProjectOrganizationCommand } from "./api/project-organization.js";
import { projectGroupNameSchema } from "./api/project-organization.js";

/** One order for projects; groups are a projection of that order, never a second copy. */
export function applyProjectOrganizationCommand(
	current: ProjectOrganization,
	command: ProjectOrganizationCommand,
): ProjectOrganization {
	const next: ProjectOrganization = {
		...current,
		groups: current.groups.map((group) => ({ ...group })),
		membership: { ...current.membership },
		projectOrder: [...current.projectOrder],
		revision: current.revision + 1,
	};
	const requireGroup = (id: string) => {
		const group = next.groups.find((item) => item.id === id);
		if (!group) throw new Error("This group no longer exists.");
		return group;
	};
	const validateName = (name: string, except?: string) => {
		const parsed = projectGroupNameSchema.safeParse(name);
		if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid group name.");
		if (next.groups.some((group) => group.id !== except && group.name.toLowerCase() === parsed.data.toLowerCase())) {
			throw new Error("A group with this name already exists.");
		}
		return parsed.data;
	};
	const move = (ids: string[], groupId: string | null, beforeId: string | null) => {
		if (groupId !== null) requireGroup(groupId);
		const selected = new Set(ids);
		if (ids.some((id) => !next.projectOrder.includes(id))) throw new Error("A selected project no longer exists.");
		const moving = next.projectOrder.filter((id) => selected.has(id));
		const remaining = next.projectOrder.filter((id) => !selected.has(id));
		if (beforeId !== null && (!remaining.includes(beforeId) || (next.membership[beforeId] ?? null) !== groupId)) {
			throw new Error("The destination changed. Try moving the project again.");
		}
		for (const id of moving) {
			if (groupId === null) delete next.membership[id];
			else next.membership[id] = groupId;
		}
		let position = beforeId === null ? -1 : remaining.indexOf(beforeId);
		if (position < 0) {
			let lastMember = -1;
			remaining.forEach((id, index) => {
				if ((next.membership[id] ?? null) === groupId) lastMember = index;
			});
			position = lastMember < 0 ? remaining.length : lastMember + 1;
		}
		remaining.splice(position, 0, ...moving);
		next.projectOrder = remaining;
	};
	switch (command.type) {
		case "create": {
			if (next.groups.some((group) => group.id === command.id)) throw new Error("This group already exists.");
			next.groups.push({ id: command.id, name: validateName(command.name) });
			move(command.projectIds, command.id, null);
			break;
		}
		case "rename":
			requireGroup(command.groupId).name = validateName(command.name, command.groupId);
			break;
		case "remove": {
			requireGroup(command.groupId);
			move(
				next.projectOrder.filter((id) => next.membership[id] === command.groupId),
				null,
				null,
			);
			next.groups = next.groups.filter((group) => group.id !== command.groupId);
			break;
		}
		case "move":
			move(command.projectIds, command.groupId, command.beforeProjectId);
			break;
		case "reorder_group": {
			const group = requireGroup(command.groupId);
			if (command.beforeGroupId === command.groupId) break;
			if (command.beforeGroupId !== null) requireGroup(command.beforeGroupId);
			next.groups = next.groups.filter((item) => item.id !== group.id);
			const position =
				command.beforeGroupId === null
					? next.groups.length
					: next.groups.findIndex((item) => item.id === command.beforeGroupId);
			next.groups.splice(position, 0, group);
			break;
		}
	}
	return next;
}
