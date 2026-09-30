import { applyProjectOrganizationCommand } from "@runtime-project-organization";
import { useRef, useState } from "react";
import { notifyError } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { ProjectOrganization, ProjectOrganizationCommand, RuntimeProjectSummary } from "@/runtime/types";
import { toErrorMessage } from "@/utils/to-error-message";

export function useProjectGroups({
	organization,
	projects,
	currentProjectId,
	onOrganization,
}: {
	organization: ProjectOrganization | null;
	projects: RuntimeProjectSummary[];
	currentProjectId: string | null;
	onOrganization: (value: ProjectOrganization) => void;
}) {
	const [optimistic, setOptimistic] = useState<ProjectOrganization | null>(null);
	const [pending, setPending] = useState(false);
	const pendingRef = useRef(false);
	const displayed =
		optimistic && (!organization || optimistic.revision > organization.revision) ? optimistic : organization;
	const [announcement, setAnnouncement] = useState("");

	async function execute(command: ProjectOrganizationCommand): Promise<boolean> {
		if (pendingRef.current) return false;
		pendingRef.current = true;
		setPending(true);
		try {
			const initial = organization ?? {
				id: "pending",
				revision: 0,
				groups: [],
				membership: {},
				projectOrder: projects.map((project) => project.id),
			};
			setOptimistic(applyProjectOrganizationCommand(initial, command));
			const result = await getRuntimeTrpcClient(currentProjectId).projects.organize.mutate({
				expectedRevision: initial.revision,
				command,
			});
			if (result.organization) onOrganization(result.organization);
			if (!result.ok) throw new Error(result.error);
			setAnnouncement(command.type === "move" ? "Project moved." : "Project groups updated.");
			return true;
		} catch (error) {
			notifyError(toErrorMessage(error));
			return false;
		} finally {
			setOptimistic(null);
			pendingRef.current = false;
			setPending(false);
		}
	}
	return { organization: displayed, pending, execute, announcement };
}
