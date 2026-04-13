import type { ReactNode } from "react";
import { useCallback, useRef } from "react";

import { Button, type ButtonVariant } from "@/components/ui/button";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

interface ConfirmationDialogProps {
	open: boolean;
	title: string;
	children: ReactNode;
	confirmLabel: string;
	confirmVariant?: ButtonVariant;
	cancelLabel?: string;
	onCancel: () => void;
	onConfirm: () => void;
	/** Shows spinner inside confirm button and disables both buttons. */
	isLoading?: boolean;
	/** Disables both buttons without showing a spinner. */
	disabled?: boolean;
}

/**
 * Reusable confirmation dialog built on AlertDialog. Handles the Radix
 * AlertDialog double-fire gotcha internally — callers don't need a
 * `confirmFiredRef` guard.
 */
export function ConfirmationDialog({
	open,
	title,
	children,
	confirmLabel,
	confirmVariant = "danger",
	cancelLabel = "Cancel",
	onCancel,
	onConfirm,
	isLoading,
	disabled,
}: ConfirmationDialogProps): React.ReactElement {
	const isDisabled = isLoading || disabled;
	// Guard against Radix AlertDialog's onOpenChange(false) firing after Action onClick.
	// The ref prevents the cancel path from running after a confirm click.
	const confirmFiredRef = useRef(false);

	const handleConfirm = useCallback(() => {
		confirmFiredRef.current = true;
		onConfirm();
	}, [onConfirm]);

	const handleCancel = useCallback(() => {
		if (confirmFiredRef.current) {
			confirmFiredRef.current = false;
			return;
		}
		if (!isDisabled) {
			onCancel();
		}
	}, [isDisabled, onCancel]);

	return (
		<AlertDialog
			open={open}
			onOpenChange={(isOpen) => {
				if (!isOpen) handleCancel();
			}}
		>
			<AlertDialogHeader>
				<AlertDialogTitle>{title}</AlertDialogTitle>
			</AlertDialogHeader>
			<AlertDialogBody>{children}</AlertDialogBody>
			<AlertDialogFooter>
				<AlertDialogCancel asChild>
					<Button variant="default" disabled={isDisabled} onClick={handleCancel}>
						{cancelLabel}
					</Button>
				</AlertDialogCancel>
				<AlertDialogAction asChild>
					<Button variant={confirmVariant} disabled={isDisabled} onClick={handleConfirm}>
						{isLoading ? (
							<>
								<Spinner size={14} />
								{confirmLabel}
							</>
						) : (
							confirmLabel
						)}
					</Button>
				</AlertDialogAction>
			</AlertDialogFooter>
		</AlertDialog>
	);
}
