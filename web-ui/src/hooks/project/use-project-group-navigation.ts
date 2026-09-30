import {
	type CollisionDetection,
	closestCenter,
	KeyboardSensor,
	PointerSensor,
	pointerWithin,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { useEffect, useRef, useState } from "react";
import type { ProjectGroupDialogState } from "@/hooks/project/project-groups";
import { projectSections } from "@/hooks/project/project-groups";
import { useProjectGroupCollapse } from "@/hooks/project/use-project-group-collapse";
import { useProjectGroups } from "@/hooks/project/use-project-groups";
import type { ProjectOrganization, ProjectOrganizationCommand, RuntimeProjectSummary } from "@/runtime/types";

export function useProjectGroupNavigation({
	organization,
	projects,
	currentProjectId,
	onOrganization,
	organizationDisabled,
	removingProjectId,
	isLoadingProjects,
}: {
	organization: ProjectOrganization | null;
	projects: RuntimeProjectSummary[];
	currentProjectId: string | null;
	onOrganization: (value: ProjectOrganization) => void;
	organizationDisabled: boolean;
	removingProjectId: string | null;
	isLoadingProjects: boolean;
}) {
	const groups = useProjectGroups({ organization, projects, currentProjectId, onOrganization });
	const sections = projectSections(projects, groups.organization);
	const hasGroups = sections.length > 1;
	const collapse = useProjectGroupCollapse(organization?.id ?? "initial");
	const [dialog, setDialog] = useState<ProjectGroupDialogState | null>(null);
	const [dragId, setDragId] = useState<string | null>(null);
	const [revealId, setRevealId] = useState<string | null>(null);
	const previousProject = useRef(currentProjectId);
	const listRef = useRef<HTMLDivElement>(null);
	const addRef = useRef<HTMLButtonElement>(null);
	const returnFocus = useRef<HTMLElement | null>(null);
	const disabled = organizationDisabled || groups.pending || removingProjectId !== null || isLoadingProjects;
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(KeyboardSensor),
	);
	const collision: CollisionDetection = (args) => {
		const isGroup = String(args.active.id).startsWith("group:");
		const candidates = args.droppableContainers.filter((item) =>
			isGroup ? String(item.id).startsWith("section:") : !String(item.id).startsWith("group:"),
		);
		const filtered = { ...args, droppableContainers: candidates };
		return args.pointerCoordinates ? pointerWithin(filtered) : closestCenter(filtered);
	};

	useEffect(() => {
		if (previousProject.current !== currentProjectId) {
			previousProject.current = currentProjectId;
			if (currentProjectId) setRevealId(currentProjectId);
		}
	}, [currentProjectId]);
	useEffect(() => {
		if (!revealId) return;
		const section = sections.find((section) => section.projects.some((project) => project.id === revealId));
		if (!section) return;
		if (collapse.collapsed.includes(section.id)) {
			collapse.expand(section.id);
			return;
		}
		const button = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-project-id]") ?? []).find(
			(item) => item.dataset.projectId === revealId,
		);
		button?.scrollIntoView?.({ block: "nearest" });
		setRevealId(null);
	}, [revealId, sections, collapse]);
	useEffect(() => {
		setDragId(null);
	}, [organization?.revision]);

	function openDialog(state: ProjectGroupDialogState) {
		returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		setDialog(state);
	}
	function closeDialog() {
		setDialog(null);
		requestAnimationFrame(() => {
			const focus = returnFocus.current;
			if (focus?.isConnected) focus.focus();
			else addRef.current?.focus();
		});
	}
	const execute = async (command: ProjectOrganizationCommand) => {
		if (disabled) return false;
		return groups.execute(command);
	};

	return {
		groups,
		sections,
		hasGroups,
		collapse,
		dialog,
		setDialog,
		dragId,
		setDragId,
		setRevealId,
		listRef,
		addRef,
		disabled,
		sensors,
		collision,
		openDialog,
		closeDialog,
		execute,
	};
}
