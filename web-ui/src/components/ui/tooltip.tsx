import * as RadixTooltip from "@radix-ui/react-tooltip";
import { type ReactNode, useCallback, useRef, useState } from "react";

export function TooltipProvider({ children }: { children: ReactNode }): React.ReactElement {
	return <RadixTooltip.Provider delayDuration={400}>{children}</RadixTooltip.Provider>;
}

export function Tooltip({
	content,
	children,
	side,
	delayDuration,
}: {
	content: ReactNode;
	children: ReactNode;
	side?: "top" | "right" | "bottom" | "left";
	delayDuration?: number;
}): React.ReactElement {
	if (!content) {
		return <>{children}</>;
	}

	return (
		<RadixTooltip.Root delayDuration={delayDuration}>
			<RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
			<RadixTooltip.Portal>
				<RadixTooltip.Content
					side={side}
					className="z-50 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text-primary shadow-lg"
					style={{ animation: "kb-tooltip-show 100ms ease" }}
					sideOffset={5}
				>
					{content}
				</RadixTooltip.Content>
			</RadixTooltip.Portal>
		</RadixTooltip.Root>
	);
}

/**
 * Tooltip that only appears when the child text is truncated (scrollWidth > clientWidth).
 * Uses a fast 150ms delay so it feels responsive when scanning a list.
 */
export function TruncateTooltip({
	content,
	children,
	side = "top",
}: {
	content: ReactNode;
	children: ReactNode;
	side?: "top" | "right" | "bottom" | "left";
}): React.ReactElement {
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLElement | null>(null);
	const truncatedRef = useRef(false);

	/** Snapshot truncation state on pointer-enter so it's ready before the delay fires. */
	const checkTruncation = useCallback(() => {
		const el = triggerRef.current;
		truncatedRef.current = el ? el.scrollWidth > el.clientWidth : false;
	}, []);

	/** Stay fully controlled — only allow open when the element is actually truncated. */
	const handleOpenChange = useCallback((nextOpen: boolean) => {
		if (nextOpen && !truncatedRef.current) return;
		setOpen(nextOpen);
	}, []);

	return (
		<RadixTooltip.Root delayDuration={150} open={open} onOpenChange={handleOpenChange}>
			<RadixTooltip.Trigger
				asChild
				ref={triggerRef as React.Ref<HTMLButtonElement>}
				onPointerEnter={checkTruncation}
			>
				{children}
			</RadixTooltip.Trigger>
			<RadixTooltip.Portal>
				<RadixTooltip.Content
					side={side}
					className="z-50 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text-primary shadow-lg"
					style={{ animation: "kb-tooltip-show 100ms ease" }}
					sideOffset={5}
				>
					{content}
				</RadixTooltip.Content>
			</RadixTooltip.Portal>
		</RadixTooltip.Root>
	);
}
