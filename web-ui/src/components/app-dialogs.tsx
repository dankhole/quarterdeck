import type { ReactElement } from "react";
import { ClearTrashDialog } from "@/components/clear-trash-dialog";
import { DebugShelf } from "@/components/debug-shelf";
import { CheckoutConfirmationDialog } from "@/components/detail-panels/checkout-confirmation-dialog";
import { CreateBranchDialog } from "@/components/detail-panels/create-branch-dialog";
import { DeleteBranchDialog } from "@/components/detail-panels/delete-branch-dialog";
import { MergeBranchDialog } from "@/components/detail-panels/merge-branch-dialog";
import { GitActionErrorDialog } from "@/components/git-action-error-dialog";
import { HardDeleteTaskDialog } from "@/components/hard-delete-task-dialog";
import { MigrateWorkingDirectoryDialog } from "@/components/migrate-working-directory-dialog";
import { ProjectDialogs } from "@/components/project-dialogs";
import { PromptShortcutEditorDialog } from "@/components/prompt-shortcut-editor-dialog";
import { RuntimeSettingsDialog } from "@/components/runtime-settings-dialog";
import { TaskCreateDialog } from "@/components/task-create-dialog";
import { TaskTrashWarningDialog } from "@/components/task-trash-warning-dialog";
import type { MigrateDirection } from "@/hooks/terminal/use-migrate-working-directory";
import { useBoardContext } from "@/providers/board-provider";
import { useDialogContext } from "@/providers/dialog-provider";
import { useGitContext } from "@/providers/git-provider";
import { useInteractionsContext } from "@/providers/interactions-provider";
import { useProjectContext } from "@/providers/project-provider";
import type { PromptShortcut } from "@/runtime/types";

interface AppDialogsProps {
	savePromptShortcuts: (shortcuts: PromptShortcut[], hiddenDefaults: string[]) => Promise<boolean>;
	pendingMigrate: { taskId: string; direction: MigrateDirection } | null;
	migratingTaskId: string | null;
	cancelMigrate: () => void;
	handleConfirmMigrate: () => void;
}

export function AppDialogs({
	savePromptShortcuts,
	pendingMigrate,
	migratingTaskId,
	cancelMigrate,
	handleConfirmMigrate,
}: AppDialogsProps): ReactElement {
	const project = useProjectContext();
	const { createTaskBranchOptions, taskEditor } = useBoardContext();
	const git = useGitContext();
	const interactions = useInteractionsContext();
	const dialog = useDialogContext();

	const {
		isInlineTaskCreateOpen,
		newTaskPrompt,
		setNewTaskPrompt,
		newTaskImages,
		setNewTaskImages,
		newTaskStartInPlanMode,
		setNewTaskStartInPlanMode,
		newTaskAutoReviewEnabled,
		setNewTaskAutoReviewEnabled,
		isNewTaskStartInPlanModeDisabled,
		newTaskUseWorktree,
		setNewTaskUseWorktree,
		createFeatureBranch,
		setCreateFeatureBranch,
		branchName,
		handleBranchNameEdit,
		generateBranchNameFromPrompt,
		isGeneratingBranchName,
		newTaskBranchRef,
		setNewTaskBranchRef,
		handleCreateTask,
		handleCreateTasks,
	} = taskEditor;

	return (
		<>
			<DebugShelf />
			<RuntimeSettingsDialog
				open={dialog.isSettingsOpen}
				workspaceId={project.settingsWorkspaceId}
				initialConfig={project.settingsRuntimeProjectConfig}
				initialSection={dialog.settingsInitialSection}
				onOpenChange={(nextOpen) => {
					dialog.setIsSettingsOpen(nextOpen);
					if (!nextOpen) dialog.setSettingsInitialSection(null);
				}}
				onSaved={() => {
					project.refreshRuntimeProjectConfig();
					project.refreshSettingsRuntimeProjectConfig();
				}}
			/>
			<PromptShortcutEditorDialog
				open={dialog.promptShortcutEditorOpen}
				onOpenChange={dialog.setPromptShortcutEditorOpen}
				shortcuts={project.runtimeProjectConfig?.promptShortcuts ?? []}
				hiddenDefaultPromptShortcuts={project.runtimeProjectConfig?.hiddenDefaultPromptShortcuts ?? []}
				onSave={savePromptShortcuts}
			/>
			<TaskCreateDialog
				open={isInlineTaskCreateOpen}
				onOpenChange={dialog.handleCreateDialogOpenChange}
				prompt={newTaskPrompt}
				onPromptChange={setNewTaskPrompt}
				images={newTaskImages}
				onImagesChange={setNewTaskImages}
				onCreate={handleCreateTask}
				onCreateAndStart={interactions.handleCreateAndStartTask}
				onCreateStartAndOpen={interactions.handleCreateStartAndOpenTask}
				onCreateMultiple={handleCreateTasks}
				onCreateAndStartMultiple={interactions.handleCreateAndStartTasks}
				startInPlanMode={newTaskStartInPlanMode}
				onStartInPlanModeChange={setNewTaskStartInPlanMode}
				startInPlanModeDisabled={isNewTaskStartInPlanModeDisabled}
				autoReviewEnabled={newTaskAutoReviewEnabled}
				onAutoReviewEnabledChange={setNewTaskAutoReviewEnabled}
				useWorktree={newTaskUseWorktree}
				onUseWorktreeChange={setNewTaskUseWorktree}
				currentBranch={project.workspaceGit?.currentBranch ?? null}
				createFeatureBranch={createFeatureBranch}
				onCreateFeatureBranchChange={setCreateFeatureBranch}
				branchName={branchName}
				onBranchNameEdit={handleBranchNameEdit}
				onGenerateBranchName={generateBranchNameFromPrompt}
				isGeneratingBranchName={isGeneratingBranchName}
				isLlmGenerationDisabled={project.isLlmGenerationDisabled}
				workspaceId={project.currentProjectId}
				branchRef={newTaskBranchRef}
				branchOptions={createTaskBranchOptions}
				onBranchRefChange={setNewTaskBranchRef}
				defaultBaseRef={project.configDefaultBaseRef}
				onSetDefaultBaseRef={project.handleSetDefaultBaseRef}
			/>
			<ClearTrashDialog
				open={dialog.isClearTrashDialogOpen}
				taskCount={interactions.trashTaskCount}
				onCancel={() => dialog.setIsClearTrashDialogOpen(false)}
				onConfirm={interactions.handleConfirmClearTrash}
			/>
			<HardDeleteTaskDialog
				open={interactions.hardDeleteDialogState.open}
				taskTitle={interactions.hardDeleteDialogState.taskTitle}
				onCancel={interactions.handleCancelHardDelete}
				onConfirm={interactions.handleConfirmHardDelete}
			/>
			<TaskTrashWarningDialog
				open={interactions.trashWarningState.open}
				warning={interactions.trashWarningState.warning}
				onCancel={interactions.handleCancelTrashWarning}
				onConfirm={interactions.handleConfirmTrashWarning}
			/>
			<CheckoutConfirmationDialog
				state={git.fileBrowserBranchActions.checkoutDialogState}
				onClose={git.fileBrowserBranchActions.closeCheckoutDialog}
				onConfirmCheckout={git.fileBrowserBranchActions.handleConfirmCheckout}
				onStashAndCheckout={git.fileBrowserBranchActions.handleStashAndCheckout}
				isStashingAndCheckingOut={git.fileBrowserBranchActions.isStashingAndCheckingOut}
			/>
			<CheckoutConfirmationDialog
				state={git.topbarBranchActions.checkoutDialogState}
				onClose={git.topbarBranchActions.closeCheckoutDialog}
				onConfirmCheckout={git.topbarBranchActions.handleConfirmCheckout}
				onSkipTaskConfirmationChange={project.handleSkipTaskCheckoutConfirmationChange}
				onStashAndCheckout={git.topbarBranchActions.handleStashAndCheckout}
				isStashingAndCheckingOut={git.topbarBranchActions.isStashingAndCheckingOut}
			/>
			<CreateBranchDialog
				state={git.fileBrowserBranchActions.createBranchDialogState}
				workspaceId={project.currentProjectId}
				onClose={git.fileBrowserBranchActions.closeCreateBranchDialog}
				onBranchCreated={git.fileBrowserBranchActions.handleBranchCreated}
			/>
			<CreateBranchDialog
				state={git.topbarBranchActions.createBranchDialogState}
				workspaceId={project.currentProjectId}
				onClose={git.topbarBranchActions.closeCreateBranchDialog}
				onBranchCreated={git.topbarBranchActions.handleBranchCreated}
			/>
			<DeleteBranchDialog
				open={git.fileBrowserBranchActions.deleteBranchDialogState.type === "open"}
				branchName={
					git.fileBrowserBranchActions.deleteBranchDialogState.type === "open"
						? git.fileBrowserBranchActions.deleteBranchDialogState.branchName
						: ""
				}
				onCancel={git.fileBrowserBranchActions.closeDeleteBranchDialog}
				onConfirm={git.fileBrowserBranchActions.handleConfirmDeleteBranch}
			/>
			<DeleteBranchDialog
				open={git.topbarBranchActions.deleteBranchDialogState.type === "open"}
				branchName={
					git.topbarBranchActions.deleteBranchDialogState.type === "open"
						? git.topbarBranchActions.deleteBranchDialogState.branchName
						: ""
				}
				onCancel={git.topbarBranchActions.closeDeleteBranchDialog}
				onConfirm={git.topbarBranchActions.handleConfirmDeleteBranch}
			/>
			<MergeBranchDialog
				open={git.fileBrowserBranchActions.mergeBranchDialogState.type === "open"}
				branchName={
					git.fileBrowserBranchActions.mergeBranchDialogState.type === "open"
						? git.fileBrowserBranchActions.mergeBranchDialogState.branchName
						: ""
				}
				currentBranch={git.fileBrowserBranchActions.currentBranch ?? "current branch"}
				onCancel={git.fileBrowserBranchActions.closeMergeBranchDialog}
				onConfirm={git.fileBrowserBranchActions.handleConfirmMergeBranch}
			/>
			<MergeBranchDialog
				open={git.topbarBranchActions.mergeBranchDialogState.type === "open"}
				branchName={
					git.topbarBranchActions.mergeBranchDialogState.type === "open"
						? git.topbarBranchActions.mergeBranchDialogState.branchName
						: ""
				}
				currentBranch={git.topbarBranchActions.currentBranch ?? "current branch"}
				onCancel={git.topbarBranchActions.closeMergeBranchDialog}
				onConfirm={git.topbarBranchActions.handleConfirmMergeBranch}
			/>
			<MigrateWorkingDirectoryDialog
				open={pendingMigrate !== null}
				direction={pendingMigrate?.direction ?? "isolate"}
				isMigrating={migratingTaskId !== null}
				onCancel={cancelMigrate}
				onConfirm={handleConfirmMigrate}
			/>
			<ProjectDialogs />
			<GitActionErrorDialog
				open={git.gitActionError !== null}
				title={git.gitActionErrorTitle}
				message={git.gitActionError?.message ?? ""}
				output={git.gitActionError?.output ?? null}
				onClose={git.clearGitActionError}
				onStashAndRetry={git.onStashAndRetry}
				isStashAndRetrying={git.isStashAndRetryingPull}
			/>
		</>
	);
}
