import { RefreshCw } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";

interface InlineTitleEditorProps {
	cardId: string;
	currentTitle: string | null;
	onSave: (taskId: string, title: string) => void;
	onClose: () => void;
	onRegenerate?: (taskId: string) => void;
	/** Stop mouse/click events from bubbling to the card's click handler. */
	stopEvent: (event: React.MouseEvent<HTMLElement>) => void;
}

export function InlineTitleEditor({
	cardId,
	currentTitle,
	onSave,
	onClose,
	onRegenerate,
	stopEvent,
}: InlineTitleEditorProps): React.ReactElement {
	const [value, setValue] = useState(currentTitle || "");
	const inputRef = useRef<HTMLInputElement | null>(null);
	const isClickingGenerateRef = useRef(false);

	// Auto-focus and select on mount.
	useEffect(() => {
		requestAnimationFrame(() => {
			inputRef.current?.focus();
			inputRef.current?.select();
		});
	}, []);

	const submit = useCallback(() => {
		// Skip save when the user is clicking the auto-generate button — that mouseDown
		// sets the ref so blur doesn't race with the generate action.
		if (isClickingGenerateRef.current) {
			return;
		}
		const trimmed = value.trim();
		if (trimmed && trimmed !== (currentTitle || "")) {
			onSave(cardId, trimmed);
		}
		onClose();
	}, [cardId, currentTitle, value, onSave, onClose]);

	const handleKeyDown = useCallback(
		(event: ReactKeyboardEvent<HTMLInputElement>) => {
			if (event.key === "Enter") {
				event.preventDefault();
				submit();
			} else if (event.key === "Escape") {
				event.preventDefault();
				onClose();
			}
		},
		[submit, onClose],
	);

	return (
		<div
			className="flex flex-1 items-center gap-1 min-w-0"
			onMouseDown={(event) => {
				// Only preventDefault when the mousedown target is NOT the input itself.
				// Preventing default on the input blocks the browser's native click-to-place-cursor behavior.
				if (event.target !== inputRef.current) {
					stopEvent(event);
				} else {
					event.stopPropagation();
				}
			}}
			onClick={stopEvent}
		>
			<input
				ref={inputRef}
				type="text"
				value={value}
				onChange={(event) => setValue(event.target.value)}
				onKeyDown={handleKeyDown}
				onBlur={submit}
				className="flex-1 min-w-0 rounded border border-border-focus bg-surface-0 px-1.5 py-0.5 text-sm text-text-primary outline-none"
				placeholder="Task title…"
			/>
			{onRegenerate ? (
				<Tooltip content="Auto-generate title" side="top">
					<Button
						icon={<RefreshCw size={12} />}
						variant="ghost"
						size="sm"
						aria-label="Auto-generate title"
						onMouseDown={(event) => {
							stopEvent(event);
							// Flag so the input's onBlur skips the save — we're about to regenerate.
							isClickingGenerateRef.current = true;
						}}
						onClick={(event) => {
							stopEvent(event);
							isClickingGenerateRef.current = false;
							onClose();
							onRegenerate(cardId);
						}}
					/>
				</Tooltip>
			) : null}
		</div>
	);
}
