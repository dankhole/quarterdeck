import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

export interface SearchOverlayShellProps {
	children: ReactNode;
	onDismiss: () => void;
}

export function SearchOverlayShell({ children, onDismiss }: SearchOverlayShellProps): React.ReactElement {
	const onDismissRef = useRef(onDismiss);
	onDismissRef.current = onDismiss;

	useEffect(() => {
		function handleKeyDown(e: KeyboardEvent): void {
			if (e.key === "Escape") {
				e.stopPropagation();
				e.preventDefault();
				onDismissRef.current();
			}
		}
		document.addEventListener("keydown", handleKeyDown, { capture: true });
		return () => document.removeEventListener("keydown", handleKeyDown, { capture: true });
	}, []);

	return (
		<div
			className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/50"
			onClick={onDismiss}
			onKeyDown={undefined}
		>
			<div
				className="w-full max-w-2xl max-h-[70vh] flex flex-col rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl overflow-hidden"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={undefined}
			>
				{children}
			</div>
		</div>
	);
}
