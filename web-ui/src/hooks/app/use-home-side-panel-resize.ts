import type { MutableRefObject, MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useRef } from "react";
import { TOOLBAR_WIDTH } from "@/components/terminal";
import { useResizeDrag } from "@/resize/use-resize-drag";

interface UseHomeSidePanelResizeInput {
	sidePanelRatio: number;
	setSidePanelRatio: (ratio: number) => void;
}

interface UseHomeSidePanelResizeResult {
	sidebarAreaRef: MutableRefObject<HTMLDivElement | null>;
	homeSidePanelPercent: string;
	handleHomeSidePanelSeparatorMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

export function useHomeSidePanelResize({
	sidePanelRatio,
	setSidePanelRatio,
}: UseHomeSidePanelResizeInput): UseHomeSidePanelResizeResult {
	const { startDrag: startHomeSidePanelResize } = useResizeDrag();
	const sidebarAreaRef = useRef<HTMLDivElement | null>(null);

	const handleHomeSidePanelSeparatorMouseDown = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			const container = sidebarAreaRef.current;
			if (!container) return;
			const containerWidth = Math.max(container.offsetWidth - TOOLBAR_WIDTH, 1);
			const startX = event.clientX;
			const startRatio = sidePanelRatio;
			startHomeSidePanelResize(event, {
				axis: "x",
				cursor: "ew-resize",
				onMove: (pointerX) => {
					const deltaRatio = (pointerX - startX) / containerWidth;
					setSidePanelRatio(startRatio + deltaRatio);
				},
				onEnd: (pointerX) => {
					const deltaRatio = (pointerX - startX) / containerWidth;
					setSidePanelRatio(startRatio + deltaRatio);
				},
			});
		},
		[setSidePanelRatio, sidePanelRatio, startHomeSidePanelResize],
	);

	return {
		sidebarAreaRef,
		homeSidePanelPercent: `${(sidePanelRatio * 100).toFixed(1)}%`,
		handleHomeSidePanelSeparatorMouseDown,
	};
}
