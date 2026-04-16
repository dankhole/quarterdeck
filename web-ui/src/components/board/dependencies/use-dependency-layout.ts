import type { RefObject } from "react";
import { useCallback, useEffect, useState } from "react";

import type { DependencyLinkDraft } from "@/components/board/dependencies/use-dependency-linking";
import type { BoardColumnId, BoardDependency } from "@/types";

import {
	areLayoutsEqual,
	createEmptyLayout,
	type DependencyLayout,
	normalizeColumnId,
	type TaskAnchor,
} from "./dependency-geometry";

export function useDependencyLayout({
	containerRef,
	dependencies,
	draft,
	activeTaskId,
	activeTaskEffectiveColumnId,
	isMotionActive,
}: {
	containerRef: RefObject<HTMLElement>;
	dependencies: BoardDependency[];
	draft: DependencyLinkDraft | null;
	activeTaskId?: string | null;
	activeTaskEffectiveColumnId?: BoardColumnId | null;
	isMotionActive: boolean;
}): DependencyLayout {
	const [layout, setLayout] = useState<DependencyLayout>(() => createEmptyLayout());

	const refreshLayout = useCallback(() => {
		const container = containerRef.current;
		if (!container) {
			setLayout((current) => {
				const empty = createEmptyLayout();
				return areLayoutsEqual(current, empty) ? current : empty;
			});
			return;
		}

		const containerRect = container.getBoundingClientRect();
		const anchors: Record<string, TaskAnchor> = {};
		const setAnchorFromElement = (cardElement: HTMLElement) => {
			const taskId = cardElement.dataset.taskId;
			if (!taskId) {
				return;
			}
			const rect = cardElement.getBoundingClientRect();
			const left = rect.left - containerRect.left;
			const right = rect.right - containerRect.left;
			const top = rect.top - containerRect.top;
			const bottom = rect.bottom - containerRect.top;
			anchors[taskId] = {
				left,
				right,
				top,
				bottom,
				centerX: (left + right) / 2,
				centerY: (top + bottom) / 2,
				columnId:
					taskId === activeTaskId && activeTaskEffectiveColumnId
						? activeTaskEffectiveColumnId
						: normalizeColumnId(
								cardElement.dataset.columnId ??
									cardElement.closest<HTMLElement>("[data-column-id]")?.dataset.columnId,
							),
			};
		};
		for (const cardElement of container.querySelectorAll<HTMLElement>("[data-task-id]")) {
			setAnchorFromElement(cardElement);
		}
		if (activeTaskId && typeof document !== "undefined") {
			const activeCardElements = Array.from(
				document.querySelectorAll<HTMLElement>(`[data-task-id="${activeTaskId}"]`),
			);
			const liveActiveCardElement =
				activeCardElements.find((element) => !container.contains(element)) ?? activeCardElements[0];
			if (liveActiveCardElement) {
				setAnchorFromElement(liveActiveCardElement);
			}
		}

		const nextLayout: DependencyLayout = {
			width: containerRect.width,
			height: containerRect.height,
			anchors,
		};
		setLayout((current) => (areLayoutsEqual(current, nextLayout) ? current : nextLayout));
	}, [activeTaskEffectiveColumnId, activeTaskId, containerRef]);

	// Re-measure when dependencies or draft change
	useEffect(() => {
		refreshLayout();
	}, [dependencies, draft, refreshLayout]);

	// Observe container for DOM/resize/scroll changes
	useEffect(() => {
		const container = containerRef.current;
		if (!container) {
			return;
		}
		let animationFrameId = 0;
		const scheduleRefresh = () => {
			window.cancelAnimationFrame(animationFrameId);
			animationFrameId = window.requestAnimationFrame(() => {
				animationFrameId = 0;
				refreshLayout();
			});
		};
		scheduleRefresh();
		window.addEventListener("resize", scheduleRefresh);
		container.addEventListener("scroll", scheduleRefresh, true);
		const resizeObserver =
			typeof ResizeObserver !== "undefined"
				? new ResizeObserver(() => {
						scheduleRefresh();
					})
				: null;
		if (resizeObserver) {
			resizeObserver.observe(container);
		}
		const mutationObserver = new MutationObserver(() => {
			scheduleRefresh();
		});
		mutationObserver.observe(container, {
			subtree: true,
			childList: true,
			attributes: true,
		});
		return () => {
			window.removeEventListener("resize", scheduleRefresh);
			container.removeEventListener("scroll", scheduleRefresh, true);
			mutationObserver.disconnect();
			resizeObserver?.disconnect();
			window.cancelAnimationFrame(animationFrameId);
		};
	}, [containerRef, refreshLayout]);

	// Continuous refresh during draft linking or drag motion
	useEffect(() => {
		let animationFrameId = 0;
		if (!draft && !isMotionActive) {
			return;
		}
		const tick = () => {
			refreshLayout();
			animationFrameId = window.requestAnimationFrame(tick);
		};
		animationFrameId = window.requestAnimationFrame(tick);
		return () => {
			window.cancelAnimationFrame(animationFrameId);
		};
	}, [draft, isMotionActive, refreshLayout]);

	return layout;
}
