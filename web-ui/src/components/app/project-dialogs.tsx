import type { ReactElement } from "react";
import { StartupOnboardingDialog } from "@/components/app/startup-onboarding-dialog";
import { GitInitDialog } from "@/components/git/git-init-dialog";
import { useProjectContext } from "@/providers/project-provider";
import { useProjectRuntimeContext } from "@/providers/project-runtime-provider";

/**
 * Renders the startup onboarding and git-init dialogs, reading all state from
 * ProjectContext. Extracted from App.tsx to reduce its JSX surface.
 */
export function ProjectDialogs(): ReactElement {
	const {
		runtimeProjectConfig,
		isStartupOnboardingDialogOpen,
		handleCloseStartupOnboardingDialog,
		handleSelectOnboardingAgent,
	} = useProjectRuntimeContext();
	const {
		currentProjectId,
		pendingGitInitializationPath,
		isInitializingGitProject,
		handleCancelInitializeGitProject,
		handleConfirmInitializeGitProject,
	} = useProjectContext();

	return (
		<>
			<StartupOnboardingDialog
				open={isStartupOnboardingDialogOpen}
				onClose={handleCloseStartupOnboardingDialog}
				selectedAgentId={runtimeProjectConfig?.selectedAgentId ?? null}
				agents={runtimeProjectConfig?.agents ?? []}
				projectId={currentProjectId}
				runtimeConfig={runtimeProjectConfig ?? null}
				onSelectAgent={handleSelectOnboardingAgent}
			/>

			<GitInitDialog
				open={pendingGitInitializationPath !== null}
				path={pendingGitInitializationPath}
				isInitializing={isInitializingGitProject}
				onCancel={handleCancelInitializeGitProject}
				onConfirm={() => {
					void handleConfirmInitializeGitProject();
				}}
			/>
		</>
	);
}
