import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import {
	discardFileEditorDraft,
	type FileEditorDraft,
	getFileEditorCacheRevision,
	getFileEditorDrafts,
	getFileEditorReviewTarget,
	setFileEditorReviewTarget,
	subscribeFileEditorCache,
} from "@/hooks/git/file-editor-cache";

function downloadDraft(draft: FileEditorDraft): void {
	const url = URL.createObjectURL(new Blob([draft.tab.value], { type: "text/plain;charset=utf-8" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = draft.tab.path.split("/").at(-1) ?? "draft.txt";
	link.click();
	URL.revokeObjectURL(url);
}

/** Mounted outside the runtime boundary so orphan drafts stay accessible after removal/disconnection. */
export function FileEditorDraftsDialog(): React.ReactElement | null {
	useSyncExternalStore(subscribeFileEditorCache, getFileEditorCacheRevision);
	const [discardCandidate, setDiscardCandidate] = useState<FileEditorDraft | null>(null);
	const target = getFileEditorReviewTarget();
	const drafts = target ? getFileEditorDrafts(target) : [];
	const detached = getFileEditorDrafts("detached");
	if (!target && detached.length === 0) return null;
	return (
		<>
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
							? "These files belonged to a removed project, task, or worktree. Download or copy your drafts before closing this window."
							: "The action was stopped because these files have unsaved changes. Save them in Files, or download and discard the drafts here, then retry the action."}
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
							<div className="flex gap-2">
								<Button size="sm" onClick={() => downloadDraft(draft)}>
									Download draft
								</Button>
								<Button
									size="sm"
									variant="danger"
									disabled={draft.tab.isSaving}
									onClick={() => setDiscardCandidate(draft)}
								>
									Discard draft…
								</Button>
							</div>
							{discardCandidate?.id === draft.id ? (
								<div className="flex items-center gap-2 text-xs text-text-secondary">
									<span>Discard this unsaved draft?</span>
									<Button
										size="sm"
										variant="danger"
										onClick={() => {
											discardFileEditorDraft(discardCandidate);
											setDiscardCandidate(null);
										}}
									>
										Confirm discard
									</Button>
									<Button size="sm" onClick={() => setDiscardCandidate(null)}>
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
