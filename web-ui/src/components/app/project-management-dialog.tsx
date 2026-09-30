import { FolderOpen } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import type { UseProjectManagementResult } from "@/hooks/project/use-project-management";

export function ProjectManagementDialog({ management }: { management: UseProjectManagementResult }) {
	const inputId = useId();
	const errorId = useId();
	const { dialog, error, pendingProjectId, isPickingFolder, setValue, close, confirm, pickFolder } = management;
	if (!dialog) return null;
	const { project, action, value } = dialog;
	const isRename = action === "rename";
	const isLocate = action === "locate";
	const pending = pendingProjectId !== null;
	const title = isRename ? "Rename project" : isLocate ? "Locate folder" : "Rename folder on disk";
	const fieldLabel = isRename ? "Project name" : isLocate ? "Project folder" : "New folder name";
	const destination = project.path.replace(/[^\\/]+[\\/]*$/, () => value.trim());
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) close();
			}}
			contentAriaLabel={title}
		>
			<DialogHeader title={title} />
			<form
				className="contents"
				onSubmit={(event) => {
					event.preventDefault();
					void confirm();
				}}
			>
				<DialogBody className="space-y-4">
					<DialogDescription className="text-sm text-text-secondary">
						{isRename
							? "Choose the name shown in Quarterdeck."
							: isLocate
								? `Reconnect “${project.name}” to its folder on this machine.`
								: `Rename the folder containing “${project.name}”.`}
					</DialogDescription>
					{!isRename ? (
						<div className="space-y-1 text-xs text-text-secondary">
							<span>Current folder</span>
							<p className="break-all font-mono text-text-primary">{project.path}</p>
						</div>
					) : null}
					<div className="space-y-2">
						<label htmlFor={inputId} className="block text-sm font-medium">
							{fieldLabel}
						</label>
						<div className="flex items-center gap-2">
							<input
								id={inputId}
								value={value}
								onChange={(event) => setValue(event.target.value)}
								disabled={pending}
								maxLength={isRename ? 120 : undefined}
								autoComplete="off"
								autoFocus
								aria-invalid={Boolean(error)}
								aria-describedby={error ? errorId : undefined}
								className="h-9 min-w-0 flex-1 rounded-md border border-border-bright bg-surface-2 px-3 text-sm outline-none focus:border-border-focus disabled:opacity-50"
							/>
							{isLocate ? (
								<Button
									disabled={pending}
									icon={<FolderOpen size={14} />}
									onClick={() => {
										void pickFolder();
									}}
								>
									{isPickingFolder ? "Opening…" : "Browse…"}
								</Button>
							) : null}
						</div>
						{isRename ? (
							<div className="flex items-center justify-between gap-3 text-xs text-text-secondary">
								<span>Leave blank to use the folder name.</span>
								<Button variant="ghost" size="sm" disabled={pending || !value} onClick={() => setValue("")}>
									Use folder name
								</Button>
							</div>
						) : null}
					</div>
					{action === "rename_folder" ? (
						<p className="break-all font-mono text-xs text-text-secondary">New location: {destination}</p>
					) : null}
					{!isRename ? (
						<p className="text-sm text-text-secondary">
							Task agents and shells will stop. Your tasks and session history will stay in this project.
						</p>
					) : null}
					{error ? (
						<p id={errorId} role="alert" className="text-sm text-status-red">
							{error}
						</p>
					) : null}
				</DialogBody>
				<DialogFooter>
					<Button disabled={pending} onClick={close}>
						Cancel
					</Button>
					<Button type="submit" variant="primary" disabled={pending || (!isRename && !value.trim())}>
						{pending && !isPickingFolder
							? "Saving…"
							: isRename
								? "Save name"
								: isLocate
									? "Reconnect folder"
									: "Rename folder"}
					</Button>
				</DialogFooter>
			</form>
		</Dialog>
	);
}
