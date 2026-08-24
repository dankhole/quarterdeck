import { FolderOpen } from "lucide-react";
import { type FormEvent, type ReactElement, useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogDescription, DialogFooter, DialogHeader } from "@/components/ui/dialog";

export function ManualProjectPathDialog({
	open,
	isAdding,
	onCancel,
	onConfirm,
}: {
	open: boolean;
	isAdding: boolean;
	onCancel: () => void;
	onConfirm: (path: string) => void;
}): ReactElement {
	const inputId = useId();
	const [path, setPath] = useState("");

	useEffect(() => {
		if (!open) {
			setPath("");
		}
	}, [open]);

	const normalizedPath = path.trim();
	const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!normalizedPath || isAdding) {
			return;
		}
		onConfirm(normalizedPath);
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen && !isAdding) {
					onCancel();
				}
			}}
		>
			<DialogHeader title="Add project by path" icon={<FolderOpen size={16} />} />
			<form onSubmit={handleSubmit} className="contents">
				<DialogBody className="space-y-3">
					<DialogDescription className="text-[13px] text-text-secondary">
						This Quarterdeck runtime cannot open a native folder picker. Enter the absolute path to the project
						folder on the machine running Quarterdeck.
					</DialogDescription>
					<label htmlFor={inputId} className="block text-xs font-medium text-text-primary">
						Project path
					</label>
					<input
						id={inputId}
						type="text"
						value={path}
						onChange={(event) => setPath(event.target.value)}
						placeholder="/home/user/projects/my-project"
						autoComplete="off"
						autoFocus
						disabled={isAdding}
						className="h-9 w-full rounded-md border border-border bg-surface-2 px-3 font-mono text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-50"
					/>
				</DialogBody>
				<DialogFooter>
					<Button variant="default" onClick={onCancel} disabled={isAdding}>
						Cancel
					</Button>
					<Button variant="primary" type="submit" disabled={!normalizedPath || isAdding}>
						{isAdding ? "Adding..." : "Add project"}
					</Button>
				</DialogFooter>
			</form>
		</Dialog>
	);
}
