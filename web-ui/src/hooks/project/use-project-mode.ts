import { useState } from "react";
import { notifyError } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeProjectSummary } from "@/runtime/types";
import { toErrorMessage } from "@/utils/to-error-message";

export function useProjectMode(project: RuntimeProjectSummary) {
	const [open, setOpen] = useState(false);
	const [saving, setSaving] = useState(false);
	const [requiresInitialization, setRequiresInitialization] = useState(false);
	const close = () => {
		if (!saving) {
			setOpen(false);
			setRequiresInitialization(false);
		}
	};
	const confirm = async () => {
		if (saving) return;
		setSaving(true);
		try {
			const result = await getRuntimeTrpcClient(project.id).projects.add.mutate({
				path: project.path,
				folderOnly: !project.folderOnly,
				initializeGit: requiresInitialization,
			});
			if (result.requiresGitInitialization) {
				setRequiresInitialization(true);
				return;
			}
			if (!result.ok) throw new Error(result.error ?? "Could not change project mode.");
			setOpen(false);
			setRequiresInitialization(false);
		} catch (error) {
			notifyError(toErrorMessage(error));
		} finally {
			setSaving(false);
		}
	};
	return { open, saving, requiresInitialization, request: () => setOpen(true), close, confirm };
}
