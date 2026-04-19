import { Bug, Play, RotateCcw, RotateCw, Trash2 } from "lucide-react";
import type { MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { BoardColumnId } from "@/types";

function stopEvent(event: MouseEvent<HTMLElement>) {
	event.preventDefault();
	event.stopPropagation();
}

export function BoardCardActions({
	cardId,
	columnId,
	isHovered,
	isSessionDead,
	isSessionRestartable,
	showRunningTaskEmergencyActions,
	isMoveToTrashLoading,
	onStart,
	onRestartSession,
	onMoveToTrash,
	onRestoreFromTrash,
	onHardDelete,
	onFlagForDebug,
}: {
	cardId: string;
	columnId: BoardColumnId;
	isHovered: boolean;
	isSessionDead: boolean;
	isSessionRestartable: boolean;
	showRunningTaskEmergencyActions: boolean;
	isMoveToTrashLoading: boolean;
	onStart?: (taskId: string) => void;
	onRestartSession?: (taskId: string) => void;
	onMoveToTrash?: (taskId: string) => void;
	onRestoreFromTrash?: (taskId: string) => void;
	onHardDelete?: (taskId: string) => void;
	onFlagForDebug?: (taskId: string) => void;
}): React.ReactElement | null {
	if (columnId === "in_progress") {
		return (
			<>
				{onFlagForDebug && isHovered ? (
					<Tooltip content="Flag for debug log">
						<Button
							icon={<Bug size={12} />}
							variant="ghost"
							size="sm"
							className="text-text-tertiary hover:text-status-purple"
							aria-label="Flag task state for debug log"
							onMouseDown={stopEvent}
							onClick={(event) => {
								stopEvent(event);
								onFlagForDebug(cardId);
							}}
						/>
					</Tooltip>
				) : null}
				{showRunningTaskEmergencyActions && !isSessionDead && isHovered ? (
					<>
						{onRestartSession ? (
							<Tooltip content="Force restart session">
								<Button
									icon={<RotateCw size={12} />}
									variant="ghost"
									size="sm"
									className="text-status-orange hover:text-text-primary"
									aria-label="Force restart agent session"
									onMouseDown={stopEvent}
									onClick={(event) => {
										stopEvent(event);
										onRestartSession(cardId);
									}}
								/>
							</Tooltip>
						) : null}
						<Tooltip content="Force trash task">
							<Button
								icon={isMoveToTrashLoading ? <Spinner size={13} /> : <Trash2 size={13} />}
								variant="ghost"
								size="sm"
								className="text-status-red hover:text-text-primary"
								disabled={isMoveToTrashLoading}
								aria-label="Force move task to trash"
								onMouseDown={stopEvent}
								onClick={(event) => {
									stopEvent(event);
									onMoveToTrash?.(cardId);
								}}
							/>
						</Tooltip>
					</>
				) : null}
			</>
		);
	}

	if (columnId === "backlog") {
		return (
			<Button
				icon={<Play size={14} />}
				variant="ghost"
				size="sm"
				aria-label="Start task"
				onMouseDown={stopEvent}
				onClick={(event) => {
					stopEvent(event);
					onStart?.(cardId);
				}}
			/>
		);
	}

	if (columnId === "review") {
		return (
			<>
				{onFlagForDebug ? (
					<Tooltip content="Flag for debug log">
						<Button
							icon={<Bug size={12} />}
							variant="ghost"
							size="sm"
							className="text-text-tertiary hover:text-status-purple"
							aria-label="Flag task state for debug log"
							onMouseDown={stopEvent}
							onClick={(event) => {
								stopEvent(event);
								onFlagForDebug(cardId);
							}}
						/>
					</Tooltip>
				) : null}
				{(isSessionRestartable || (isHovered && !isSessionDead)) && onRestartSession ? (
					<Tooltip content="Restart session">
						<Button
							icon={<RotateCw size={12} />}
							variant="ghost"
							size="sm"
							aria-label="Restart agent session"
							onMouseDown={stopEvent}
							onClick={(event) => {
								stopEvent(event);
								onRestartSession(cardId);
							}}
						/>
					</Tooltip>
				) : null}
				<Button
					icon={isMoveToTrashLoading ? <Spinner size={13} /> : <Trash2 size={13} />}
					variant="ghost"
					size="sm"
					disabled={isMoveToTrashLoading}
					aria-label="Move task to trash"
					onMouseDown={stopEvent}
					onClick={(event) => {
						stopEvent(event);
						onMoveToTrash?.(cardId);
					}}
				/>
			</>
		);
	}

	if (columnId === "trash") {
		return (
			<>
				<Tooltip
					side="bottom"
					content={
						<>
							Restore session
							<br />
							in new worktree
						</>
					}
				>
					<Button
						icon={<RotateCcw size={12} />}
						variant="ghost"
						size="sm"
						aria-label="Restore task from trash"
						onMouseDown={stopEvent}
						onClick={(event) => {
							stopEvent(event);
							onRestoreFromTrash?.(cardId);
						}}
					/>
				</Tooltip>
				<Tooltip side="bottom" content="Delete permanently">
					<Button
						icon={<Trash2 size={12} />}
						variant="ghost"
						size="sm"
						className="text-status-red hover:text-status-red"
						aria-label="Delete task permanently"
						onMouseDown={stopEvent}
						onClick={(event) => {
							stopEvent(event);
							onHardDelete?.(cardId);
						}}
					/>
				</Tooltip>
			</>
		);
	}

	return null;
}
