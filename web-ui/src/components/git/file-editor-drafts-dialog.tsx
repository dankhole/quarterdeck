import { useState, useSyncExternalStore } from "react";
import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import {
	canRestoreFileEditorDraft,
	discardFileEditorDraft,
	type FileEditorDraft,
	getFileEditorCacheRevision,
	getFileEditorDrafts,
	getFileEditorRecoveryStatus,
	getFileEditorReviewTarget,
	restoreFileEditorDraft,
	setFileEditorReviewTarget,
	subscribeFileEditorCache,
} from "@/hooks/git/file-editor-cache";
import { exportFileEditorDraft } from "@/hooks/git/file-editor-draft-export";
import { useDesktopFileEditorRecovery } from "@/hooks/git/use-desktop-file-editor-recovery";
import { getRuntimeEnvironment } from "@/runtime/runtime-environment";

/** Mounted outside the runtime boundary so orphan drafts stay accessible after removal/disconnection. */
export function FileEditorDraftsDialog(): React.ReactElement | null {
	const { retryRecovery, resetRecovery, commitStatus } = useDesktopFileEditorRecovery();
	const [confirmRecoveryReset, setConfirmRecoveryReset] = useState(false);
	const [recoveryAction, setRecoveryAction] = useState<"retry" | "reset" | null>(null);
	useSyncExternalStore(subscribeFileEditorCache, getFileEditorCacheRevision);
	const [discardCandidate, setDiscardCandidate] = useState<FileEditorDraft | null>(null);
	const [exportingDraftId, setExportingDraftId] = useState<string | null>(null);
	const desktop = getRuntimeEnvironment().kind === "desktop";
	const target = getFileEditorReviewTarget();
	const drafts = target ? getFileEditorDrafts(target) : [];
	const detached = getFileEditorDrafts("detached");
	const recovery = getFileEditorRecoveryStatus();
	const recoveryBusy = commitStatus.busy || recoveryAction !== null;
	const recoveryState = commitStatus.problem
		? "error"
		: !commitStatus.loaded
			? "loading"
			: commitStatus.ready
				? "ready"
				: "pending";
	async function runRecoveryAction(action: "retry" | "reset"): Promise<void> {
		if (recoveryBusy) return;
		setRecoveryAction(action);
		let succeeded = false;
		try {
			succeeded = await (action === "retry" ? retryRecovery() : resetRecovery());
			if (succeeded && action === "reset") setConfirmRecoveryReset(false);
		} catch {
			// A missing ACK must not discard current drafts or dismiss reset confirmation.
		} finally {
			setRecoveryAction(null);
		}
		if (!succeeded)
			showAppToast({
				intent: "danger",
				message:
					"Could not confirm the latest recovery copy. Your unsaved drafts remain in this window; save or export them.",
				timeout: 6_000,
			});
	}
	if (!desktop && !target && detached.length === 0 && !recovery.problem && recovery.expired === 0) return null;
	return (
		<>
			{desktop ? (
				<span
					data-testid="file-editor-recovery-status"
					data-state={recoveryState}
					aria-hidden="true"
					className="sr-only"
				/>
			) : null}
			{desktop && (recovery.problem || recovery.expired > 0) ? (
				<div
					role="alert"
					className="fixed bottom-16 right-4 z-40 max-w-md rounded-md border border-border bg-surface-1 p-3 text-sm text-text-primary"
				>
					{recovery.problem
						? `${recovery.paused ? "The saved recovery snapshot could not be read. New recovery writes are paused to preserve it." : recovery.problem === "limit" ? "Crash recovery could not retain the latest drafts. Local recovery is limited to 32 files, 512 KiB per file and 2 MiB total." : "Could not confirm the latest recovery copy."} Your current unsaved text remains in this window. Save files in Files, save a copy, or retry recovery. Quit, reload, and update are blocked until recovery storage is ready.`
						: `${recovery.expired} local recovery draft${recovery.expired === 1 ? "" : "s"} older than 30 days expired.`}
					<Button size="sm" className="mt-2" onClick={() => setFileEditorReviewTarget("all")}>
						Review drafts
					</Button>
					{recovery.problem ? (
						<Button
							size="sm"
							className="ml-2 mt-2"
							disabled={recoveryBusy}
							aria-busy={recoveryAction === "retry"}
							onClick={() => runRecoveryAction("retry")}
						>
							{recoveryAction === "retry" ? "Retrying recovery…" : "Retry recovery"}
						</Button>
					) : null}
					{recovery.problem ? (
						<Button
							size="sm"
							className="ml-2 mt-2"
							disabled={recoveryBusy}
							onClick={() => setConfirmRecoveryReset(true)}
						>
							Reset saved recovery…
						</Button>
					) : null}
					{confirmRecoveryReset ? (
						<div className="mt-2 space-y-2">
							<p>
								Discard the previously saved recovery snapshot? Current drafts remain open and must fit the
								recovery limits before reset can succeed.
							</p>
							<Button
								size="sm"
								variant="danger"
								disabled={recoveryBusy}
								aria-busy={recoveryAction === "reset"}
								onClick={() => runRecoveryAction("reset")}
							>
								{recoveryAction === "reset" ? "Resetting recovery…" : "Confirm reset"}
							</Button>
							<Button
								size="sm"
								className="ml-2"
								disabled={recoveryBusy}
								onClick={() => setConfirmRecoveryReset(false)}
							>
								Keep saved recovery
							</Button>
						</div>
					) : null}
				</div>
			) : null}
			{!target && detached.length > 0 ? (
				<div className="fixed bottom-4 right-4 z-40">
					<Button onClick={() => setFileEditorReviewTarget("detached")}>
						Recover unsaved files ({detached.length})
					</Button>
				</div>
			) : null}
			<Dialog
				open={target !== null}
				onOpenChange={(open) => {
					if (!open) {
						setDiscardCandidate(null);
						setFileEditorReviewTarget(null);
					}
				}}
				contentAriaDescribedBy="file-editor-drafts-description"
			>
				<DialogHeader title="Unsaved files" />
				<DialogBody className="space-y-4">
					<DialogDescription id="file-editor-drafts-description" className="text-sm text-text-secondary">
						{target === "detached"
							? "These drafts were recovered after reopening, or belonged to a removed project, task, or worktree. Restore into a matching Files workspace, or save a copy. Recovery never writes the original file automatically. Desktop copies are local to this app profile and expire after 30 days."
							: "The action was stopped because these files have unsaved changes. Save them in Files, or save a copy and discard the drafts here, then retry the action."}
					</DialogDescription>
					{drafts.length === 0 ? (
						<p className="text-sm text-text-secondary">
							All drafts are resolved. Close this dialog and retry the action.
						</p>
					) : null}
					{drafts.map((draft) => (
						<div key={draft.id} className="space-y-2 rounded-md border border-border p-3">
							<p className="break-all text-sm text-text-primary">{draft.tab.path}</p>
							<p className="break-all text-xs text-text-tertiary">
								{draft.scope.rootPath ?? draft.scope.projectId}
								{draft.scope.taskId ? ` · ${draft.scope.taskId}` : ""}
							</p>
							<textarea
								aria-label={`Unsaved contents of ${draft.tab.path}`}
								readOnly
								value={draft.tab.value}
								className="h-28 w-full resize-y rounded-sm bg-surface-0 p-2 font-mono text-xs text-text-primary"
							/>
							<div className="flex flex-wrap gap-2">
								{draft.detached ? (
									<Button
										size="sm"
										className="h-auto min-h-7 py-1 whitespace-normal"
										disabled={!canRestoreFileEditorDraft(draft)}
										onClick={() => {
											if (restoreFileEditorDraft(draft))
												showAppToast({
													intent: "success",
													message:
														"Draft restored in Files. Open its tab and choose Save when ready; autosave is paused for this recovery.",
													timeout: 6_000,
												});
										}}
									>
										Restore in Files
									</Button>
								) : null}
								<Button
									size="sm"
									className="h-auto min-h-7 py-1 whitespace-normal"
									aria-busy={exportingDraftId === draft.id}
									disabled={exportingDraftId !== null}
									onClick={async () => {
										setExportingDraftId(draft.id);
										const outcome = await exportFileEditorDraft(draft);
										setExportingDraftId(null);
										if (outcome === "failed")
											showAppToast({
												intent: "danger",
												message: "Could not save this draft. Your unsaved text is still available to copy.",
												timeout: 6_000,
											});
									}}
								>
									{desktop ? "Save draft…" : "Download draft"}
								</Button>
								<Button
									size="sm"
									className="h-auto min-h-7 py-1 whitespace-normal"
									variant="danger"
									disabled={draft.tab.isSaving}
									onClick={() => setDiscardCandidate(draft)}
								>
									Discard draft…
								</Button>
							</div>
							{draft.detached && !canRestoreFileEditorDraft(draft) ? (
								<p className="text-xs text-text-secondary">
									Open Files in the original project and worktree to restore. Existing unsaved changes and
									replaced worktrees are protected; save a copy if the original workspace is unavailable.
								</p>
							) : null}
							{discardCandidate?.id === draft.id ? (
								<div
									role="group"
									aria-label={`Discard draft ${draft.tab.path}`}
									className="flex flex-wrap items-center gap-2 text-xs text-text-secondary"
								>
									<span>Discard this unsaved draft?</span>
									<Button
										size="sm"
										className="h-auto min-h-7 py-1 whitespace-normal"
										variant="danger"
										onClick={() => {
											discardFileEditorDraft(discardCandidate);
											setDiscardCandidate(null);
										}}
									>
										Confirm discard
									</Button>
									<Button
										size="sm"
										className="h-auto min-h-7 py-1 whitespace-normal"
										onClick={() => setDiscardCandidate(null)}
									>
										Keep draft
									</Button>
								</div>
							) : null}
						</div>
					))}
				</DialogBody>
				<DialogFooter>
					<Button
						onClick={() => {
							setDiscardCandidate(null);
							setFileEditorReviewTarget(null);
						}}
					>
						Close
					</Button>
				</DialogFooter>
			</Dialog>
		</>
	);
}
