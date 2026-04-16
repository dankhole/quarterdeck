import type { ReactElement } from "react";
import { StartupOnboardingDialog } from "@/components/app/startup-onboarding-dialog";
import { GitInitDialog } from "@/components/git/git-init-dialog";
import { useProjectContext } from "@/providers/project-provider";

/**
 * Renders the startup onboarding and git-init dialogs, reading all state from
 * ProjectContext. Extracted from App.tsx to reduce its JSX surface.
 */
export function ProjectDialogs(): ReactElement {
	const {
		isStartupOnboardingDialogOpen,
		handleCloseStartupOnboardingDialog,
		handleSelectOnboardingAgent,
		runtimeProjectConfig,
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
				workspaceId={currentProjectId}
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
