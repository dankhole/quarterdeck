import { Pause, SendHorizontal } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, type ReactElement } from "react";

import { SearchSelectDropdown, type SearchSelectOption } from "@/components/search-select-dropdown";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";

const CLINE_CHAT_COMPOSER_MAX_HEIGHT = 160;

export function ClineChatComposer({
	taskId,
	draft,
	onDraftChange,
	placeholder,
	canSend,
	canCancel,
	onSend,
	onCancel,
	modelOptions,
	selectedModelId,
	selectedModelButtonText,
	onSelectModel,
	isModelLoading = false,
	isModelSaving = false,
	modelPickerDisabled = false,
	isSending = false,
}: {
	taskId: string;
	draft: string;
	onDraftChange: (draft: string) => void;
	placeholder: string;
	canSend: boolean;
	canCancel: boolean;
	onSend: () => void | Promise<void>;
	onCancel: () => void;
	modelOptions: readonly SearchSelectOption[];
	selectedModelId: string;
	selectedModelButtonText: string;
	onSelectModel: (value: string) => void;
	isModelLoading?: boolean;
	isModelSaving?: boolean;
	modelPickerDisabled?: boolean;
	isSending?: boolean;
}): ReactElement {
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const canSubmit = canSend && !isModelSaving && draft.trim().length > 0;

	useLayoutEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) {
			return;
		}
		textarea.style.height = "auto";
		textarea.style.height = `${Math.min(textarea.scrollHeight, CLINE_CHAT_COMPOSER_MAX_HEIGHT)}px`;
		textarea.style.overflowY = textarea.scrollHeight > CLINE_CHAT_COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
	}, [draft]);

	useEffect(() => {
		if (!canSend) {
			return;
		}
		textareaRef.current?.focus();
	}, [canSend, taskId]);

	return (
		<div className="rounded-xl border border-border bg-surface-2 px-3 py-2 focus-within:border-border-focus">
			<textarea
				ref={textareaRef}
				value={draft}
				onChange={(event) => onDraftChange(event.target.value)}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing) {
						return;
					}
					if (event.key === "Escape") {
						if (!canCancel) {
							return;
						}
						event.preventDefault();
						onCancel();
						return;
					}
					if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
						return;
					}
					if (!canSubmit) {
						return;
					}
					event.preventDefault();
					void onSend();
				}}
				placeholder={placeholder}
				disabled={!canSend}
				rows={1}
				className="w-full min-h-6 resize-none bg-transparent p-0 text-sm leading-5 text-text-primary placeholder:text-text-tertiary focus:outline-none disabled:opacity-50"
				style={{ maxHeight: CLINE_CHAT_COMPOSER_MAX_HEIGHT }}
			/>
			<div className="mt-2 flex items-center justify-between gap-2">
				<SearchSelectDropdown
					id="cline-chat-model-picker"
					options={modelOptions}
					selectedValue={selectedModelId}
					onSelect={onSelectModel}
					disabled={modelPickerDisabled}
					size="sm"
					buttonText={selectedModelButtonText}
					emptyText="Select model"
					noResultsText="No matching models"
					placeholder="Search models..."
						showSelectedIndicator
						matchTargetWidth={false}
						collisionPadding={12}
						dropdownStyle={{ minWidth: "240px", maxWidth: "320px" }}
						buttonClassName={cn(
						"max-w-[220px] rounded-full border-transparent bg-surface-3 px-2.5 text-text-secondary shadow-none hover:bg-surface-4 hover:text-text-primary",
						(isModelLoading || isModelSaving) && "text-text-tertiary",
					)}
				/>
					<Button
						variant="default"
						size="sm"
						className="h-7 w-7 rounded-full border-border-bright bg-surface-4 p-0 text-text-primary hover:bg-surface-3"
						aria-label={canCancel ? "Cancel request" : "Send message"}
						disabled={canCancel ? false : !canSubmit}
						onClick={() => {
							if (canCancel) {
								onCancel();
								return;
							}
							void onSend();
						}}
						icon={
							isSending ? (
								<Spinner size={12} />
							) : canCancel ? (
								<Pause size={14} />
							) : (
								<SendHorizontal size={14} />
							)
						}
					/>
				</div>
			</div>
	);
}
