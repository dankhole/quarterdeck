import { ArrowLeft, Plus, X } from "lucide-react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";

interface TaskCreateMultiListProps {
	taskPrompts: string[];
	onTaskPromptsChange: (prompts: string[]) => void;
	onBackToSingle: () => void;
	onCreateAll: () => void;
	onCreateAndStartAll: () => void;
}

export function TaskCreateMultiList({
	taskPrompts,
	onTaskPromptsChange,
	onBackToSingle,
	onCreateAll,
	onCreateAndStartAll,
}: TaskCreateMultiListProps): ReactElement {
	const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
	const nextFocusIndexRef = useRef<number | null>(0);

	useEffect(() => {
		if (nextFocusIndexRef.current !== null) {
			const idx = nextFocusIndexRef.current;
			nextFocusIndexRef.current = null;
			requestAnimationFrame(() => {
				inputRefs.current[idx]?.focus();
			});
		}
	});

	const handleUpdate = useCallback(
		(index: number, value: string) => {
			const next = [...taskPrompts];
			next[index] = value;
			onTaskPromptsChange(next);
		},
		[taskPrompts, onTaskPromptsChange],
	);

	const handleRemove = useCallback(
		(index: number) => {
			if (taskPrompts.length <= 1) {
				return;
			}
			nextFocusIndexRef.current = Math.min(index, taskPrompts.length - 2);
			onTaskPromptsChange(taskPrompts.filter((_, i) => i !== index));
		},
		[taskPrompts, onTaskPromptsChange],
	);

	const handleAdd = useCallback(
		(afterIndex?: number) => {
			const insertIndex = afterIndex !== undefined ? afterIndex + 1 : taskPrompts.length;
			nextFocusIndexRef.current = insertIndex;
			const next = [...taskPrompts];
			next.splice(insertIndex, 0, "");
			onTaskPromptsChange(next);
		},
		[taskPrompts, onTaskPromptsChange],
	);

	const handleKeyDown = useCallback(
		(index: number, event: React.KeyboardEvent<HTMLInputElement>) => {
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				if (event.altKey) {
					onCreateAll();
					return;
				}
				onCreateAndStartAll();
				return;
			}
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				handleAdd(index);
				return;
			}
			if (event.key === "Backspace" && taskPrompts[index] === "" && taskPrompts.length > 1) {
				event.preventDefault();
				handleRemove(index);
			}
		},
		[handleAdd, handleRemove, onCreateAll, onCreateAndStartAll, taskPrompts],
	);

	const setInputRef = useCallback((index: number, el: HTMLInputElement | null) => {
		inputRefs.current[index] = el;
	}, []);

	return (
		<div>
			<div className="flex flex-col gap-1.5">
				{taskPrompts.map((taskPrompt, index) => (
					<div key={index} className="flex items-center gap-1.5">
						<span className="text-[12px] text-text-tertiary text-right shrink-0 tabular-nums">{index + 1}.</span>
						<input
							ref={(el) => setInputRef(index, el)}
							name={`task-prompt-${index + 1}`}
							type="text"
							value={taskPrompt}
							onChange={(e) => handleUpdate(index, e.target.value)}
							onKeyDown={(e) => handleKeyDown(index, e)}
							placeholder="Describe the task..."
							className="flex-1 min-w-0 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none"
						/>
						<Button
							variant="ghost"
							size="sm"
							icon={<X size={14} />}
							onClick={() => handleRemove(index)}
							aria-label={`Remove task ${index + 1}`}
						/>
					</div>
				))}
			</div>
			<div className="flex items-center justify-between mt-3">
				<button
					type="button"
					onClick={() => handleAdd()}
					className="inline-flex items-center gap-1.5 text-[12px] text-text-secondary hover:text-text-primary cursor-pointer"
				>
					<Plus size={12} />
					Add task
				</button>
				<button
					type="button"
					onClick={onBackToSingle}
					className="inline-flex items-center gap-1.5 text-[12px] text-text-secondary hover:text-text-primary cursor-pointer"
				>
					<ArrowLeft size={12} />
					Back to single prompt
				</button>
			</div>
		</div>
	);
}
