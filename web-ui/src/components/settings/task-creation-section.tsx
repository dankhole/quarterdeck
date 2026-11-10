import { useId } from "react";
import type { SettingsSectionProps } from "./settings-section-props";

export function TaskCreationSection({
	fields,
	setField,
	disabled,
	projectName,
	folderOnly = false,
}: SettingsSectionProps & { projectName: string; folderOnly?: boolean }): React.ReactElement {
	const id = useId();
	const workspaceDescriptionId = `${id}-workspace-description`;
	const sharedDescriptionId = `${id}-shared-description`;
	const isolatedDescriptionId = `${id}-isolated-description`;
	const warningId = `${id}-shared-warning`;
	const showSharedWarning = folderOnly || !fields.defaultUseWorktree;

	return (
		<>
			<fieldset
				disabled={disabled}
				aria-describedby={workspaceDescriptionId}
				className="settings-group m-0 min-w-0 border-0 p-0"
			>
				<legend className="p-0 text-base font-semibold text-text-primary">Default task workspace</legend>
				<p id={workspaceDescriptionId} className="mt-1 mb-4 text-sm leading-6 text-text-secondary">
					{folderOnly ? (
						<>New tasks in {projectName} always use this project’s folder. Existing tasks are unchanged.</>
					) : (
						<>
							Applies only to new tasks in {projectName}. You can override this choice for each new task.
							Existing tasks are unchanged.
						</>
					)}
				</p>
				{folderOnly ? (
					<div className="rounded-md border border-border bg-surface-1 p-3">
						<p className="m-0 text-sm font-medium text-text-primary">Shared project folder (fixed)</p>
						<p className="mt-1 mb-0 text-sm leading-6 text-text-secondary">
							This folder project does not support isolated Git worktrees. Its saved worktree preference is
							unchanged.
						</p>
					</div>
				) : (
					<div className="space-y-4">
						<label className="flex items-start gap-3 cursor-pointer has-disabled:cursor-default">
							<input
								type="radio"
								name={`${id}-workspace`}
								value="shared"
								checked={!fields.defaultUseWorktree}
								onChange={() => setField("defaultUseWorktree", false)}
								aria-labelledby={`${id}-shared-label`}
								aria-describedby={
									showSharedWarning ? `${sharedDescriptionId} ${warningId}` : sharedDescriptionId
								}
								className="mt-1 h-4 w-4 shrink-0 accent-accent focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-border-focus disabled:opacity-40"
							/>
							<span className="min-w-0">
								<span id={`${id}-shared-label`} className="block text-sm font-medium text-text-primary">
									Shared project checkout
								</span>
								<span id={sharedDescriptionId} className="mt-1 block text-sm leading-6 text-text-secondary">
									Work directly in {projectName}’s main checkout. Tasks share the same files and current
									branch. Concurrent changes can cause conflicts.
								</span>
							</span>
						</label>
						<label className="flex items-start gap-3 cursor-pointer has-disabled:cursor-default">
							<input
								type="radio"
								name={`${id}-workspace`}
								value="isolated"
								checked={fields.defaultUseWorktree}
								onChange={() => setField("defaultUseWorktree", true)}
								aria-labelledby={`${id}-isolated-label`}
								aria-describedby={isolatedDescriptionId}
								className="mt-1 h-4 w-4 shrink-0 accent-accent focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-border-focus disabled:opacity-40"
							/>
							<span className="min-w-0">
								<span id={`${id}-isolated-label`} className="block text-sm font-medium text-text-primary">
									Isolated worktree
								</span>
								<span id={isolatedDescriptionId} className="mt-1 block text-sm leading-6 text-text-secondary">
									Give each task a separate working copy, isolated from the main checkout.
								</span>
							</span>
						</label>
					</div>
				)}
				{showSharedWarning ? (
					<p
						id={warningId}
						className="mt-4 mb-0 rounded-md border border-status-orange/40 p-3 text-sm leading-6 text-text-secondary"
					>
						<strong className="font-medium text-text-primary">Shared workspace warning:</strong> Concurrent tasks
						can overwrite each other’s changes or cause file conflicts when they use the same checkout or folder.
					</p>
				) : null}
			</fieldset>

			<section aria-labelledby={`${id}-setup-heading`} className="settings-group">
				<h3 id={`${id}-setup-heading`} className="mt-0 mb-1 text-base font-semibold text-text-primary">
					Worktree setup
				</h3>
				{folderOnly ? (
					<p
						id="runtime-settings-worktree-setup-description"
						className="mt-0 mb-4 text-sm leading-6 text-text-secondary"
					>
						Worktree setup does not run for folder projects. The saved script is kept unchanged and cannot be
						edited here.
					</p>
				) : (
					<p
						id="runtime-settings-worktree-setup-description"
						className="mt-0 mb-4 text-sm leading-6 text-text-secondary"
					>
						Runs only in a new isolated worktree, after copying .worktreeinclude files and before the agent
						starts. Use it to install local dependencies. Leave blank to skip setup.
					</p>
				)}
				<label
					htmlFor="runtime-settings-worktree-setup"
					className="mb-1 block text-sm font-medium text-text-primary"
				>
					Worktree setup script
				</label>
				<textarea
					id="runtime-settings-worktree-setup"
					aria-describedby="runtime-settings-worktree-setup-description"
					value={fields.worktreeSetupScript}
					onChange={(event) => setField("worktreeSetupScript", event.currentTarget.value)}
					disabled={disabled || folderOnly}
					rows={4}
					spellCheck={false}
					placeholder="npm ci"
					className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-sm leading-6 text-text-primary focus:border-border-focus focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-border-focus disabled:opacity-40"
				/>
				<details className="mt-3 text-sm leading-6 text-text-secondary">
					<summary className="cursor-pointer text-text-primary">How worktree setup runs</summary>
					<p className="mt-2 mb-0">
						For isolated Git worktrees only: uses sh on macOS/Linux and PowerShell on Windows, with a 10-minute
						limit. A failed setup blocks agent launch until you retry. Successful setup does not run again on
						resume.
					</p>
				</details>
			</section>
		</>
	);
}
