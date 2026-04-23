import type { ReactElement } from "react";
import { ProjectDialogs } from "@/components/app/project-dialogs";
import { DebugShelf } from "@/components/debug";
import { GitActionErrorDialog } from "@/components/git";
import {
	CheckoutConfirmationDialog,
	CreateBranchDialog,
	DeleteBranchDialog,
	MergeBranchDialog,
	RebaseBranchDialog,
	RenameBranchDialog,
	ResetToRefDialog,
} from "@/components/git/panels";
import { PromptShortcutEditorDialog, RuntimeSettingsDialog } from "@/components/settings";
import { ClearTrashDialog, HardDeleteTaskDialog, TaskCreateDialog, TaskTrashWarningDialog } from "@/components/task";
import { useDialogContext } from "@/providers/dialog-provider";
import { useGitContext } from "@/providers/git-provider";
import { useInteractionsContext } from "@/providers/interactions-provider";
import { useProjectContext } from "@/providers/project-provider";
import { useProjectRuntimeContext } from "@/providers/project-runtime-provider";
import { useTaskEditorContext } from "@/providers/task-editor-provider";
import type { PromptShortcut } from "@/runtime/types";

interface AppDialogsProps {
	savePromptShortcuts: (shortcuts: PromptShortcut[], hiddenDefaults: string[]) => Promise<boolean>;
}

export function AppDialogs({ savePromptShortcuts }: AppDialogsProps): ReactElement {
	const project = useProjectContext();
	const projectRuntime = useProjectRuntimeContext();
	const { createTaskBranchOptions, taskEditor } = useTaskEditorContext();
	const git = useGitContext();
	const interactions = useInteractionsContext();
	const dialog = useDialogContext();

	const {
		isInlineTaskCreateOpen,
		newTaskPrompt,
		setNewTaskPrompt,
		newTaskImages,
		setNewTaskImages,
		newTaskAutoReviewEnabled,
		setNewTaskAutoReviewEnabled,
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
				projectId={projectRuntime.settingsProjectId}
				initialConfig={projectRuntime.settingsRuntimeProjectConfig}
				initialSection={dialog.settingsInitialSection}
				onOpenChange={(nextOpen) => {
					dialog.setIsSettingsOpen(nextOpen);
					if (!nextOpen) dialog.setSettingsInitialSection(null);
				}}
				onSaved={() => {
					projectRuntime.refreshRuntimeProjectConfig();
					projectRuntime.refreshSettingsRuntimeProjectConfig();
				}}
			/>
			<PromptShortcutEditorDialog
				open={dialog.promptShortcutEditorOpen}
				onOpenChange={dialog.setPromptShortcutEditorOpen}
				shortcuts={projectRuntime.runtimeProjectConfig?.promptShortcuts ?? []}
				hiddenDefaultPromptShortcuts={projectRuntime.runtimeProjectConfig?.hiddenDefaultPromptShortcuts ?? []}
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
				autoReviewEnabled={newTaskAutoReviewEnabled}
				onAutoReviewEnabledChange={setNewTaskAutoReviewEnabled}
				useWorktree={newTaskUseWorktree}
				onUseWorktreeChange={setNewTaskUseWorktree}
				currentBranch={project.projectGit?.currentBranch ?? null}
				createFeatureBranch={createFeatureBranch}
				onCreateFeatureBranchChange={setCreateFeatureBranch}
				branchName={branchName}
				onBranchNameEdit={handleBranchNameEdit}
				onGenerateBranchName={generateBranchNameFromPrompt}
				isGeneratingBranchName={isGeneratingBranchName}
				isLlmGenerationDisabled={projectRuntime.isLlmGenerationDisabled}
				projectId={project.currentProjectId}
				branchRef={newTaskBranchRef}
				branchOptions={createTaskBranchOptions}
				onBranchRefChange={setNewTaskBranchRef}
				defaultBaseRef={projectRuntime.configDefaultBaseRef}
				onSetDefaultBaseRef={projectRuntime.handleSetDefaultBaseRef}
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
				onSkipTaskConfirmationChange={projectRuntime.handleSkipTaskCheckoutConfirmationChange}
				onStashAndCheckout={git.topbarBranchActions.handleStashAndCheckout}
				isStashingAndCheckingOut={git.topbarBranchActions.isStashingAndCheckingOut}
			/>
			<CreateBranchDialog
				state={git.fileBrowserBranchActions.createBranchDialogState}
				projectId={project.currentProjectId}
				onClose={git.fileBrowserBranchActions.closeCreateBranchDialog}
				onBranchCreated={git.fileBrowserBranchActions.handleBranchCreated}
			/>
			<CreateBranchDialog
				state={git.topbarBranchActions.createBranchDialogState}
				projectId={project.currentProjectId}
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
			<RebaseBranchDialog
				open={git.fileBrowserBranchActions.rebaseBranchDialogState.type === "open"}
				onto={
					git.fileBrowserBranchActions.rebaseBranchDialogState.type === "open"
						? git.fileBrowserBranchActions.rebaseBranchDialogState.onto
						: ""
				}
				currentBranch={git.fileBrowserBranchActions.currentBranch ?? "current branch"}
				onCancel={git.fileBrowserBranchActions.closeRebaseBranchDialog}
				onConfirm={git.fileBrowserBranchActions.handleConfirmRebaseBranch}
			/>
			<RebaseBranchDialog
				open={git.topbarBranchActions.rebaseBranchDialogState.type === "open"}
				onto={
					git.topbarBranchActions.rebaseBranchDialogState.type === "open"
						? git.topbarBranchActions.rebaseBranchDialogState.onto
						: ""
				}
				currentBranch={git.topbarBranchActions.currentBranch ?? "current branch"}
				onCancel={git.topbarBranchActions.closeRebaseBranchDialog}
				onConfirm={git.topbarBranchActions.handleConfirmRebaseBranch}
			/>
			<RenameBranchDialog
				open={git.fileBrowserBranchActions.renameBranchDialogState.type === "open"}
				branchName={
					git.fileBrowserBranchActions.renameBranchDialogState.type === "open"
						? git.fileBrowserBranchActions.renameBranchDialogState.branchName
						: ""
				}
				onCancel={git.fileBrowserBranchActions.closeRenameBranchDialog}
				onConfirm={git.fileBrowserBranchActions.handleConfirmRenameBranch}
			/>
			<RenameBranchDialog
				open={git.topbarBranchActions.renameBranchDialogState.type === "open"}
				branchName={
					git.topbarBranchActions.renameBranchDialogState.type === "open"
						? git.topbarBranchActions.renameBranchDialogState.branchName
						: ""
				}
				onCancel={git.topbarBranchActions.closeRenameBranchDialog}
				onConfirm={git.topbarBranchActions.handleConfirmRenameBranch}
			/>
			<ResetToRefDialog
				open={git.fileBrowserBranchActions.resetToRefDialogState.type === "open"}
				targetRef={
					git.fileBrowserBranchActions.resetToRefDialogState.type === "open"
						? git.fileBrowserBranchActions.resetToRefDialogState.ref
						: ""
				}
				onCancel={git.fileBrowserBranchActions.closeResetToRefDialog}
				onConfirm={git.fileBrowserBranchActions.handleConfirmResetToRef}
			/>
			<ResetToRefDialog
				open={git.topbarBranchActions.resetToRefDialogState.type === "open"}
				targetRef={
					git.topbarBranchActions.resetToRefDialogState.type === "open"
						? git.topbarBranchActions.resetToRefDialogState.ref
						: ""
				}
				onCancel={git.topbarBranchActions.closeResetToRefDialog}
				onConfirm={git.topbarBranchActions.handleConfirmResetToRef}
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
