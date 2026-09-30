import { projectGroupNameSchema } from "@runtime-contract";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import type { ProjectGroupDialogState } from "@/hooks/project/project-groups";
import type { ProjectOrganization, ProjectOrganizationCommand, RuntimeProjectSummary } from "@/runtime/types";

export function ProjectGroupDialog({
	state,
	organization,
	projects,
	pending,
	onExecute,
	onClose,
	onCreateForProject,
	onReveal,
}: {
	state: ProjectGroupDialogState;
	organization: ProjectOrganization | null;
	projects: RuntimeProjectSummary[];
	pending: boolean;
	onExecute: (command: ProjectOrganizationCommand) => Promise<boolean>;
	onClose: () => void;
	onCreateForProject: (projectId: string) => void;
	onReveal: (groupId: string) => void;
}) {
	const initialFocus = useRef<HTMLInputElement>(null);
	const [name, setName] = useState(state.type === "rename" ? state.group.name : "");
	const [selected, setSelected] = useState<string[]>(
		state.type === "create" && state.projectId ? [state.projectId] : [],
	);
	const [search, setSearch] = useState("");
	const [error, setError] = useState<string | null>(null);
	const groups = organization?.groups ?? [];
	const title =
		state.type === "create"
			? "New group"
			: state.type === "rename"
				? "Rename group"
				: state.type === "remove"
					? `Remove “${state.group.name}”?`
					: `Move ${state.project.name}`;
	const filtered = projects.filter((project) =>
		`${project.name} ${project.path}`.toLowerCase().includes(search.toLowerCase()),
	);
	async function submit() {
		let command: ProjectOrganizationCommand;
		if (state.type === "move") return;
		if (state.type === "remove") command = { type: "remove", groupId: state.group.id };
		else {
			const parsed = projectGroupNameSchema.safeParse(name);
			if (!parsed.success) {
				setError(parsed.error.issues[0]?.message ?? "Enter a group name.");
				return;
			}
			if (
				groups.some(
					(group) =>
						group.name.toLowerCase() === parsed.data.toLowerCase() &&
						(state.type !== "rename" || group.id !== state.group.id),
				)
			) {
				setError("A group with this name already exists.");
				return;
			}
			command =
				state.type === "create"
					? { type: "create", id: crypto.randomUUID(), name: parsed.data, projectIds: selected }
					: { type: "rename", groupId: state.group.id, name: parsed.data };
		}
		if (await onExecute(command)) {
			if (command.type === "create") onReveal(command.id);
			onClose();
		} else setError("Could not save this change. Your entries have been kept; try again.");
	}
	return (
		<Dialog
			contentAriaLabel={title}
			onOpenAutoFocus={(event) => {
				if (initialFocus.current) {
					event.preventDefault();
					initialFocus.current.focus();
				}
			}}
			open
			onOpenChange={(open) => {
				if (!open && !pending) onClose();
			}}
		>
			<DialogHeader title={title} />
			<form
				className="flex flex-col min-h-0"
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<DialogBody className="space-y-4">
					{state.type === "create" || state.type === "rename" ? (
						<>
							<label className="block text-sm font-medium">
								Group name
								<input
									ref={initialFocus}
									value={name}
									maxLength={60}
									disabled={pending}
									onChange={(event) => {
										setName(event.target.value);
										setError(null);
									}}
									aria-invalid={Boolean(error)}
									aria-describedby={error ? "group-error" : undefined}
									className="mt-2 w-full rounded-md border border-border-bright bg-surface-2 px-3 py-2 text-sm outline-none focus:border-border-focus"
									placeholder="e.g. Work, Personal, Tools"
								/>
							</label>
							{state.type === "create" && projects.length > 0 ? (
								<fieldset disabled={pending} className="space-y-2">
									<legend className="text-sm text-text-secondary mb-2">
										Projects{" "}
										<span className="text-text-tertiary">
											· optional{selected.length ? ` · ${selected.length} selected` : ""}
										</span>
									</legend>
									<input
										aria-label="Find projects"
										placeholder="Find projects…"
										value={search}
										onChange={(event) => setSearch(event.target.value)}
										className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-border-focus"
									/>
									<div className="max-h-52 overflow-y-auto space-y-1">
										{filtered.map((project) => (
											<label
												key={project.id}
												className="flex gap-3 items-center rounded-md p-2 hover:bg-surface-2 cursor-pointer"
											>
												<input
													type="checkbox"
													checked={selected.includes(project.id)}
													onChange={(event) =>
														setSelected(
															event.target.checked
																? [...selected, project.id]
																: selected.filter((id) => id !== project.id),
														)
													}
													className="accent-accent"
												/>
												<span className="min-w-0">
													<span className="block text-sm truncate">{project.name}</span>
													<span className="block text-xs text-text-secondary truncate">
														{groups.find((group) => group.id === organization?.membership[project.id])
															?.name ?? project.path}
													</span>
												</span>
											</label>
										))}
										{filtered.length === 0 ? (
											<p className="py-3 text-sm text-text-secondary">No matching projects.</p>
										) : null}
									</div>
								</fieldset>
							) : null}
						</>
					) : null}
					{state.type === "remove" ? (
						<p className="text-sm text-text-secondary">
							Its {projects.filter((project) => organization?.membership[project.id] === state.group.id).length}{" "}
							projects will move to Ungrouped. Projects and tasks will be kept.
						</p>
					) : null}
					{state.type === "move" ? (
						<div className="space-y-2">
							<input
								ref={initialFocus}
								aria-label="Find groups"
								placeholder="Find a group…"
								value={search}
								onChange={(event) => setSearch(event.target.value)}
								className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-border-focus"
							/>
							<div className="max-h-60 overflow-y-auto">
								{[...groups, { id: "ungrouped", name: "Ungrouped" }]
									.filter((group) => group.name.toLowerCase().includes(search.toLowerCase()))
									.map((group) => {
										const current = (organization?.membership[state.project.id] ?? "ungrouped") === group.id;
										return (
											<button
												type="button"
												key={group.id}
												disabled={current || pending}
												className="w-full flex justify-between items-center rounded-md px-3 py-2 text-sm text-left hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-border-focus disabled:opacity-50"
												onClick={async () => {
													if (
														await onExecute({
															type: "move",
															projectIds: [state.project.id],
															groupId: group.id === "ungrouped" ? null : group.id,
															beforeProjectId: null,
														})
													) {
														onReveal(group.id);
														onClose();
													}
												}}
											>
												<span className="truncate">{group.name}</span>
												{current ? <span className="text-xs text-text-secondary">Current</span> : null}
											</button>
										);
									})}
							</div>
							<button
								type="button"
								disabled={pending}
								onClick={() => onCreateForProject(state.project.id)}
								className="text-sm text-accent hover:text-accent-hover px-3 py-2"
							>
								+ New group…
							</button>
						</div>
					) : null}
					{error ? (
						<p id="group-error" role="alert" className="text-sm text-status-red">
							{error}
						</p>
					) : null}
				</DialogBody>
				<DialogFooter>
					<Button type="button" disabled={pending} onClick={onClose}>
						Cancel
					</Button>
					{state.type !== "move" ? (
						<Button type="submit" variant={state.type === "remove" ? "default" : "primary"} disabled={pending}>
							{pending
								? "Saving…"
								: state.type === "create"
									? "Create group"
									: state.type === "remove"
										? "Remove group"
										: "Save name"}
						</Button>
					) : null}
				</DialogFooter>
			</form>
		</Dialog>
	);
}
