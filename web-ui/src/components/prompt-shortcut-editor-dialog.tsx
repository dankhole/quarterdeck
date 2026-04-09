import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import type { PromptShortcut } from "@/runtime/types";

interface PromptShortcutEditorDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	shortcuts: PromptShortcut[];
	onSave: (shortcuts: PromptShortcut[]) => Promise<boolean>;
}

export function PromptShortcutEditorDialog({
	open,
	onOpenChange,
	shortcuts,
	onSave,
}: PromptShortcutEditorDialogProps): React.ReactElement {
	const [editedShortcuts, setEditedShortcuts] = useState<PromptShortcut[]>([]);
	const [isSaving, setIsSaving] = useState(false);

	useEffect(() => {
		if (open) {
			setEditedShortcuts(shortcuts.map((s) => ({ ...s })));
		}
	}, [open, shortcuts]);

	const updateShortcut = useCallback((index: number, field: "label" | "prompt", value: string) => {
		setEditedShortcuts((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)));
	}, []);

	const addShortcut = useCallback(() => {
		setEditedShortcuts((prev) => [...prev, { label: "", prompt: "" }]);
	}, []);

	const removeShortcut = useCallback((index: number) => {
		setEditedShortcuts((prev) => prev.filter((_, i) => i !== index));
	}, []);

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
			const ok = await onSave(trimmed);
			if (ok) {
				onOpenChange(false);
			}
		} finally {
			setIsSaving(false);
		}
	}, [editedShortcuts, onSave, onOpenChange]);

	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
			contentStyle={{ maxWidth: "47rem" }}
			contentAriaDescribedBy="prompt-shortcut-editor-description"
		>
			<DialogHeader title="Prompt Shortcuts" />
			<DialogBody>
				<p id="prompt-shortcut-editor-description" className="text-text-secondary text-[13px] mb-3">
					Enter a full prompt or just invoke a skill (e.g. <code className="text-text-primary">/commit</code>). The
					text is pasted into the agent terminal and submitted.
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
															type="text"
															value={shortcut.label}
															onChange={(e) => updateShortcut(index, "label", e.target.value)}
															placeholder="Name"
															maxLength={30}
															className="h-8 w-24 rounded-md border border-border bg-surface-2 px-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
														/>
														{isDuplicate ? (
															<span className="text-status-red text-[11px]">Duplicate name</span>
														) : null}
													</div>
													<textarea
														value={shortcut.prompt}
														onChange={(e) => updateShortcut(index, "prompt", e.target.value)}
														placeholder="Prompt text..."
														rows={5}
														className="flex-1 rounded-md border border-border bg-surface-2 px-2 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary resize-y focus:border-border-focus focus:outline-none"
													/>
													<Button
														variant="ghost"
														size="sm"
														icon={<Trash2 size={14} />}
														className="text-text-tertiary hover:text-status-red shrink-0 mt-1"
														aria-label={`Delete shortcut "${shortcut.label}"`}
														onClick={() => removeShortcut(index)}
													/>
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
	);
}
