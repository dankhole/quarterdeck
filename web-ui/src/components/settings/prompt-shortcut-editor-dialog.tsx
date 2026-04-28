import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";
import { DEFAULT_PROMPT_SHORTCUTS } from "@runtime-config-defaults";
import { GripVertical, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogTitle,
	Dialog,
	DialogBody,
	DialogFooter,
	DialogHeader,
} from "@/components/ui/dialog";
import type { PromptShortcut } from "@/runtime/types";

interface PromptShortcutEditorDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	shortcuts: PromptShortcut[];
	hiddenDefaultPromptShortcuts: string[];
	onSave: (shortcuts: PromptShortcut[], hiddenDefaults: string[]) => Promise<boolean>;
}

/** Case-insensitive, trimmed label comparison. */
function labelsMatch(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Find the default shortcut that matches a label, if any. */
function findDefault(label: string): PromptShortcut | undefined {
	return DEFAULT_PROMPT_SHORTCUTS.find((d) => labelsMatch(d.label, label));
}

/** Check whether a shortcut is an unmodified default (same label + same prompt). */
function isUnmodifiedDefault(shortcut: PromptShortcut): boolean {
	const def = findDefault(shortcut.label);
	return def !== undefined && def.prompt === shortcut.prompt;
}

/** Check whether a shortcut is a user override of a default (same label, different prompt). */
function isOverriddenDefault(shortcut: PromptShortcut): boolean {
	const def = findDefault(shortcut.label);
	return def !== undefined && def.prompt !== shortcut.prompt;
}

type DeleteAction = { index: number; label: string; isOverride: boolean };

export function PromptShortcutEditorDialog({
	open,
	onOpenChange,
	shortcuts,
	hiddenDefaultPromptShortcuts,
	onSave,
}: PromptShortcutEditorDialogProps): React.ReactElement {
	const [editedShortcuts, setEditedShortcuts] = useState<PromptShortcut[]>([]);
	const [hiddenDefaults, setHiddenDefaults] = useState<string[]>([]);
	const [isSaving, setIsSaving] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<DeleteAction | null>(null);

	useEffect(() => {
		if (open) {
			setEditedShortcuts(shortcuts.map((s) => ({ ...s })));
			setHiddenDefaults([...hiddenDefaultPromptShortcuts]);
			setPendingDelete(null);
		}
	}, [open, shortcuts, hiddenDefaultPromptShortcuts]);

	const updateShortcut = useCallback((index: number, field: "label" | "prompt", value: string) => {
		setEditedShortcuts((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)));
	}, []);

	const addShortcut = useCallback(() => {
		setEditedShortcuts((prev) => [...prev, { label: "", prompt: "" }]);
	}, []);

	const handleDeleteClick = useCallback(
		(index: number) => {
			const shortcut = editedShortcuts[index];
			if (!shortcut) return;

			const def = findDefault(shortcut.label);
			if (def) {
				// This shortcut corresponds to a default — show confirmation dialog.
				setPendingDelete({
					index,
					label: shortcut.label,
					isOverride: def.prompt !== shortcut.prompt,
				});
			} else {
				// Purely custom shortcut — delete immediately.
				setEditedShortcuts((prev) => prev.filter((_, i) => i !== index));
			}
		},
		[editedShortcuts],
	);

	const handleRevertToDefault = useCallback(() => {
		if (!pendingDelete) return;
		const def = findDefault(pendingDelete.label);
		if (def) {
			// Replace the override with the original default text.
			setEditedShortcuts((prev) =>
				prev.map((s, i) => (i === pendingDelete.index ? { label: def.label, prompt: def.prompt } : s)),
			);
		}
		setPendingDelete(null);
	}, [pendingDelete]);

	const handleDeleteEntirely = useCallback(() => {
		if (!pendingDelete) return;
		// Remove from the list and add to hidden defaults.
		setEditedShortcuts((prev) => prev.filter((_, i) => i !== pendingDelete.index));
		setHiddenDefaults((prev) => {
			const key = pendingDelete.label.trim().toLowerCase();
			return prev.includes(key) ? prev : [...prev, key];
		});
		setPendingDelete(null);
	}, [pendingDelete]);

	const handleDragEnd = useCallback((result: DropResult) => {
		const { source, destination } = result;
		if (!destination || source.index === destination.index) return;
		setEditedShortcuts((prev) => {
			const next = [...prev];
			const moved = next.splice(source.index, 1)[0];
			if (!moved) return prev;
			next.splice(destination.index, 0, moved);
			return next;
		});
	}, []);

	const duplicateLabels = useMemo(() => {
		const seen = new Set<string>();
		const dupes = new Set<string>();
		for (const s of editedShortcuts) {
			const normalized = s.label.trim().toLowerCase();
			if (normalized && seen.has(normalized)) {
				dupes.add(normalized);
			}
			seen.add(normalized);
		}
		return dupes;
	}, [editedShortcuts]);

	const hasEmptyLabel = editedShortcuts.some((s) => s.label.trim().length === 0);
	const hasEmptyPrompt = editedShortcuts.some((s) => s.prompt.trim().length === 0);
	const hasDuplicates = duplicateLabels.size > 0;
	const isSaveDisabled = isSaving || hasEmptyLabel || hasEmptyPrompt || hasDuplicates;

	const handleSave = useCallback(async () => {
		setIsSaving(true);
		try {
			const trimmed = editedShortcuts.map((s) => ({ label: s.label.trim(), prompt: s.prompt.trim() }));
			const ok = await onSave(trimmed, hiddenDefaults);
			if (ok) {
				onOpenChange(false);
			}
		} finally {
			setIsSaving(false);
		}
	}, [editedShortcuts, hiddenDefaults, onSave, onOpenChange]);

	return (
		<>
			<Dialog
				open={open}
				onOpenChange={onOpenChange}
				contentStyle={{ maxWidth: "47rem" }}
				contentAriaDescribedBy="prompt-shortcut-editor-description"
			>
				<DialogHeader title="Prompt Shortcuts" />
				<DialogBody>
					<p id="prompt-shortcut-editor-description" className="text-text-secondary text-[13px] mb-3">
						Enter a full prompt or just invoke a skill (e.g. <code className="text-text-primary">/commit</code>).
						The text is pasted into the agent terminal and submitted.
					</p>
					<DragDropContext onDragEnd={handleDragEnd}>
						<Droppable droppableId="prompt-shortcuts">
							{(droppableProvided) => (
								<div
									className="flex flex-col gap-3"
									ref={droppableProvided.innerRef}
									{...droppableProvided.droppableProps}
								>
									{editedShortcuts.map((shortcut, index) => {
										const isDuplicate = duplicateLabels.has(shortcut.label.trim().toLowerCase());
										const isDefault = findDefault(shortcut.label) !== undefined;
										const isUnmodified = isUnmodifiedDefault(shortcut);
										return (
											<Draggable key={index} draggableId={`shortcut-${index}`} index={index}>
												{(provided, snapshot) => (
													<div
														ref={provided.innerRef}
														{...provided.draggableProps}
														className={`flex gap-2 items-start ${snapshot.isDragging ? "opacity-80 shadow-lg rounded-md bg-surface-1" : ""}`}
													>
														<div
															{...provided.dragHandleProps}
															role="button"
															className="text-text-tertiary hover:text-text-secondary cursor-grab active:cursor-grabbing shrink-0 mt-1.5"
															aria-label="Drag to reorder"
														>
															<GripVertical size={14} />
														</div>
														<div className="flex flex-col gap-1">
															<input
																name={`prompt-shortcut-label-${index}`}
																type="text"
																value={shortcut.label}
																onChange={(e) => updateShortcut(index, "label", e.target.value)}
																placeholder="Name"
																maxLength={30}
																className="h-8 w-24 rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
															/>
															{isDuplicate ? (
																<span className="text-status-red text-[11px]">Duplicate name</span>
															) : isUnmodified ? (
																<span className="text-text-tertiary text-[11px]">Default</span>
															) : isDefault ? (
																<span className="text-status-blue text-[11px]">Modified</span>
															) : null}
														</div>
														<textarea
															name={`prompt-shortcut-prompt-${index}`}
															value={shortcut.prompt}
															onChange={(e) => updateShortcut(index, "prompt", e.target.value)}
															placeholder="Prompt text..."
															rows={5}
															className="flex-1 rounded-md border border-border bg-surface-2 px-2 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary resize-y focus:border-border-focus focus:outline-none"
														/>
														<div className="flex flex-col gap-1 shrink-0 mt-1">
															<Button
																variant="ghost"
																size="sm"
																icon={<Trash2 size={14} />}
																className="text-text-tertiary hover:text-status-red"
																aria-label={`Delete shortcut "${shortcut.label}"`}
																onClick={() => handleDeleteClick(index)}
															/>
															{isOverriddenDefault(shortcut) ? (
																<Button
																	variant="ghost"
																	size="sm"
																	icon={<RotateCcw size={14} />}
																	className="text-text-tertiary hover:text-text-primary"
																	aria-label={`Revert "${shortcut.label}" to default`}
																	onClick={() => {
																		const def = findDefault(shortcut.label);
																		if (def) {
																			setEditedShortcuts((prev) =>
																				prev.map((s, i) =>
																					i === index
																						? { label: def.label, prompt: def.prompt }
																						: s,
																				),
																			);
																		}
																	}}
																/>
															) : null}
														</div>
													</div>
												)}
											</Draggable>
										);
									})}
									{droppableProvided.placeholder}
								</div>
							)}
						</Droppable>
					</DragDropContext>
					<Button variant="ghost" size="sm" icon={<Plus size={14} />} className="mt-2" onClick={addShortcut}>
						Add shortcut
					</Button>
				</DialogBody>
				<DialogFooter>
					<Button variant="default" size="sm" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button variant="primary" size="sm" disabled={isSaveDisabled} onClick={() => void handleSave()}>
						{isSaving ? "Saving..." : "Save"}
					</Button>
				</DialogFooter>
			</Dialog>

			{/* Confirmation dialog when deleting a shortcut that has a default behind it */}
			<AlertDialog open={pendingDelete !== null} onOpenChange={(o) => !o && setPendingDelete(null)}>
				<AlertDialogTitle>
					{pendingDelete?.isOverride ? "Revert or delete?" : "Hide default shortcut?"}
				</AlertDialogTitle>
				<AlertDialogDescription>
					{pendingDelete?.isOverride
						? `"${pendingDelete.label}" is a customized version of a built-in default. You can revert it to the original default prompt or delete it entirely.`
						: `"${pendingDelete?.label}" is a built-in default. Deleting it will hide it from your shortcuts. You can restore it later from Settings.`}
				</AlertDialogDescription>
				{pendingDelete?.isOverride ? (
					<>
						<AlertDialogCancel onClick={() => setPendingDelete(null)}>Cancel</AlertDialogCancel>
						<AlertDialogAction onClick={handleRevertToDefault}>Revert to default</AlertDialogAction>
						<AlertDialogAction
							className="bg-status-red hover:bg-status-red/80 text-white"
							onClick={handleDeleteEntirely}
						>
							Delete entirely
						</AlertDialogAction>
					</>
				) : (
					<>
						<AlertDialogCancel onClick={() => setPendingDelete(null)}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							className="bg-status-red hover:bg-status-red/80 text-white"
							onClick={handleDeleteEntirely}
						>
							Hide default
						</AlertDialogAction>
					</>
				)}
			</AlertDialog>
		</>
	);
}
