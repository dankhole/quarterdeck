import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { QuarterdeckAccessBlockedFallback } from "@/components/app/quarterdeck-access-blocked-fallback";
import { RuntimeDisconnectedFallback } from "@/components/app/runtime-disconnected-fallback";
import { useProjectRuntimeStreamContext } from "@/providers/project-provider";
import { useProjectRuntimeContext } from "@/providers/project-runtime-provider";
import { getRuntimeEnvironment } from "@/runtime/runtime-environment";

function RuntimeDisconnectedOverlay({ message }: { message?: string }): ReactNode {
	const dialogRef = useRef<HTMLDialogElement>(null);

	useEffect(() => {
		const dialog = dialogRef.current;
		// Native modality makes the entire document inert, including React portals.
		dialog?.showModal();
		// Inert background controls do not disable document/window hotkeys.
		const blockAppHotkeys = (event: KeyboardEvent): void => {
			event.stopImmediatePropagation();
			if (event.key === "Escape") event.preventDefault();
		};
		window.addEventListener("keydown", blockAppHotkeys, true);
		window.addEventListener("keyup", blockAppHotkeys, true);
		// Keep portaled dialogs from treating overlay interactions as outside clicks.
		const blockOutsidePointerDown = (event: PointerEvent): void => event.stopImmediatePropagation();
		window.addEventListener("pointerdown", blockOutsidePointerDown, true);
		return () => {
			window.removeEventListener("keydown", blockAppHotkeys, true);
			window.removeEventListener("keyup", blockAppHotkeys, true);
			window.removeEventListener("pointerdown", blockOutsidePointerDown, true);
			dialog?.close();
		};
	}, []);

	// Escape aria-hidden ancestors installed by an already-open Radix dialog.
	return createPortal(
		<dialog
			ref={dialogRef}
			aria-label="Disconnected from Quarterdeck"
			className="pointer-events-auto fixed inset-0 m-0 h-full max-h-none w-full max-w-none border-0 bg-surface-0 p-0"
			onCancel={(event) => event.preventDefault()}
		>
			<RuntimeDisconnectedFallback message={message} />
		</dialog>,
		document.body,
	);
}

export function AppRuntimeBoundary({ children }: { children: ReactNode }): ReactNode {
	const { isRuntimeDisconnected, streamError } = useProjectRuntimeStreamContext();
	const { isQuarterdeckAccessBlocked } = useProjectRuntimeContext();
	const desktop = getRuntimeEnvironment().kind === "desktop";

	if (isQuarterdeckAccessBlocked) return <QuarterdeckAccessBlockedFallback />;

	return (
		<>
			{children}
			{isRuntimeDisconnected &&
				(desktop ? (
					<RuntimeDisconnectedFallback message={streamError ?? undefined} presentation="banner" />
				) : (
					<RuntimeDisconnectedOverlay message={streamError ?? undefined} />
				))}
		</>
	);
}
