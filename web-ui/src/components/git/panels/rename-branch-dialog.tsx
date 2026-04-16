import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";

export function RenameBranchDialog({
	open,
	branchName,
	onCancel,
	onConfirm,
}: {
	open: boolean;
	branchName: string;
	onCancel: () => void;
	onConfirm: (newName: string) => void;
}): ReactElement {
	const [newName, setNewName] = useState(branchName);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (open) {
			setNewName(branchName);
			requestAnimationFrame(() => inputRef.current?.focus());
		}
	}, [open, branchName]);

	const isValid = newName.trim().length > 0 && newName.trim() !== branchName;

	const handleConfirm = useCallback(() => {
		if (isValid) onConfirm(newName.trim());
	}, [isValid, newName, onConfirm]);

	return (
		<AlertDialog
			open={open}
			onOpenChange={(isOpen) => {
				if (!isOpen) onCancel();
			}}
		>
			<AlertDialogHeader>
				<AlertDialogTitle>Rename branch</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogBody>
				<AlertDialogDescription className="mb-3">
					Rename <code className="rounded bg-surface-3 px-1 py-0.5 text-text-primary">{branchName}</code> to:
				</AlertDialogDescription>
				<input
					type="text"
					value={newName}
					onChange={(e) => setNewName(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && isValid) handleConfirm();
					}}
					ref={inputRef}
					className="w-full rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none font-mono"
				/>
			</AlertDialogBody>
			<AlertDialogFooter>
				<AlertDialogCancel asChild>
					<Button variant="default" onClick={onCancel}>
						Cancel
					</Button>
				</AlertDialogCancel>
				<AlertDialogAction asChild>
					<Button variant="primary" disabled={!isValid} onClick={handleConfirm}>
						Rename
					</Button>
				</AlertDialogAction>
			</AlertDialogFooter>
		</AlertDialog>
	);
}
