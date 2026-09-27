import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

export interface DependencyLinkDraft {
	sourceTaskId: string;
	targetTaskId: string | null;
	pointerClientX: number;
	pointerClientY: number;
}

const CARD_GAP_CAPTURE_PX = 16;

function getNearestCardTaskIdInColumn(columnElement: HTMLElement, clientX: number, clientY: number): string | null {
	let nearest: { taskId: string; distance: number } | null = null;
	for (const card of columnElement.querySelectorAll<HTMLElement>("[data-task-id]")) {
		if (!card.dataset.taskId) continue;
		const rect = card.getBoundingClientRect();
		const distance = Math.hypot(
			Math.max(rect.left - clientX, 0, clientX - rect.right),
			Math.max(rect.top - clientY, 0, clientY - rect.bottom),
		);
		if (distance <= CARD_GAP_CAPTURE_PX && (!nearest || distance < nearest.distance))
			nearest = { taskId: card.dataset.taskId, distance };
	}
	return nearest?.taskId ?? null;
}

function getTaskIdFromPoint(clientX: number, clientY: number): string | null {
	if (typeof document === "undefined") {
		return null;
	}
	const elementsAtPoint = document.elementsFromPoint(clientX, clientY);
	let columnElement: HTMLElement | null = null;
	for (const element of elementsAtPoint) {
		const card = element.closest("[data-task-id]");
		if (card instanceof HTMLElement) {
			return card.dataset.taskId ?? null;
		}
		if (!columnElement) {
			const column = element.closest("[data-column-id]");
			if (column instanceof HTMLElement) {
				columnElement = column;
			}
		}
	}

	if (columnElement) {
		return getNearestCardTaskIdInColumn(columnElement, clientX, clientY);
	}
	return null;
}

export function useDependencyLinking({
	canLinkTasks,
	onCreateDependency,
}: {
	canLinkTasks?: (fromTaskId: string, toTaskId: string) => boolean;
	onCreateDependency?: (fromTaskId: string, toTaskId: string) => void;
}): {
	draft: DependencyLinkDraft | null;
	onDependencyPointerDown: (taskId: string, event: ReactMouseEvent<HTMLElement>) => void;
	onDependencyPointerEnter: (taskId: string) => void;
} {
	const [draft, setDraft] = useState<DependencyLinkDraft | null>(null);
	const draftRef = useRef<DependencyLinkDraft | null>(null);
	const modifierPressedRef = useRef(false);

	const getValidTargetTaskId = useCallback(
		(sourceTaskId: string, targetTaskId: string | null): string | null => {
			if (!targetTaskId || targetTaskId === sourceTaskId) {
				return null;
			}
			if (canLinkTasks && !canLinkTasks(sourceTaskId, targetTaskId)) {
				return null;
			}
			return targetTaskId;
		},
		[canLinkTasks],
	);

	const completeDependencyLink = useCallback(
		(taskId: string | null): boolean => {
			const current = draftRef.current;
			const validTaskId = current ? getValidTargetTaskId(current.sourceTaskId, taskId) : null;
			if (!current || !validTaskId) {
				return false;
			}
			onCreateDependency?.(current.sourceTaskId, validTaskId);
			draftRef.current = null;
			setDraft(null);
			return true;
		},
		[getValidTargetTaskId, onCreateDependency],
	);

	useEffect(() => {
		draftRef.current = draft;
	}, [draft]);

	useEffect(() => {
		const handleKeyStateChange = (event: KeyboardEvent) => {
			modifierPressedRef.current = event.metaKey || event.ctrlKey;
		};
		const handleWindowBlur = () => {
			modifierPressedRef.current = false;
			draftRef.current = null;
			setDraft(null);
		};
		window.addEventListener("keydown", handleKeyStateChange);
		window.addEventListener("keyup", handleKeyStateChange);
		window.addEventListener("blur", handleWindowBlur);
		return () => {
			window.removeEventListener("keydown", handleKeyStateChange);
			window.removeEventListener("keyup", handleKeyStateChange);
			window.removeEventListener("blur", handleWindowBlur);
		};
	}, []);

	const isLinking = draft !== null;

	useEffect(() => {
		if (!isLinking) {
			if (typeof document !== "undefined") {
				document.body.classList.remove("kb-dependency-link-mode");
			}
			return;
		}

		document.body.classList.add("kb-dependency-link-mode");

		const handleMouseMove = (event: MouseEvent) => {
			setDraft((current) => {
				if (!current) {
					return current;
				}
				const targetTaskId = getValidTargetTaskId(
					current.sourceTaskId,
					getTaskIdFromPoint(event.clientX, event.clientY),
				);
				return {
					...current,
					pointerClientX: event.clientX,
					pointerClientY: event.clientY,
					targetTaskId,
				};
			});
		};

		const handleMouseUp = (event: MouseEvent) => {
			setDraft(() => {
				const current = draftRef.current;
				if (!current) {
					return null;
				}
				const resolvedTargetTaskId = getValidTargetTaskId(
					current.sourceTaskId,
					getTaskIdFromPoint(event.clientX, event.clientY) ?? current.targetTaskId,
				);
				if (modifierPressedRef.current && completeDependencyLink(resolvedTargetTaskId ?? null)) {
					return null;
				}
				if (!modifierPressedRef.current) {
					draftRef.current = null;
					return null;
				}
				const nextDraft = {
					...current,
					targetTaskId: resolvedTargetTaskId ?? null,
					pointerClientX: event.clientX,
					pointerClientY: event.clientY,
				};
				draftRef.current = nextDraft;
				return nextDraft;
			});
		};

		const handleModifierRelease = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey) {
				return;
			}
			modifierPressedRef.current = false;
			const current = draftRef.current;
			if (!current) {
				return;
			}
			const resolvedTargetTaskId = getValidTargetTaskId(
				current.sourceTaskId,
				current.targetTaskId ?? getTaskIdFromPoint(current.pointerClientX, current.pointerClientY),
			);
			if (completeDependencyLink(resolvedTargetTaskId)) {
				return;
			}
			draftRef.current = null;
			setDraft(null);
		};

		window.addEventListener("mousemove", handleMouseMove);
		window.addEventListener("mouseup", handleMouseUp);
		window.addEventListener("keyup", handleModifierRelease);
		return () => {
			document.body.classList.remove("kb-dependency-link-mode");
			window.removeEventListener("mousemove", handleMouseMove);
			window.removeEventListener("mouseup", handleMouseUp);
			window.removeEventListener("keyup", handleModifierRelease);
		};
	}, [completeDependencyLink, getValidTargetTaskId, isLinking]);

	const handleDependencyPointerDown = useCallback((taskId: string, event: ReactMouseEvent<HTMLElement>) => {
		modifierPressedRef.current = event.metaKey || event.ctrlKey;
		setDraft((current) => {
			if (current?.sourceTaskId === taskId) {
				draftRef.current = null;
				return null;
			}
			const nextDraft = {
				sourceTaskId: taskId,
				targetTaskId: null,
				pointerClientX: event.clientX,
				pointerClientY: event.clientY,
			};
			draftRef.current = nextDraft;
			return nextDraft;
		});
	}, []);

	const handleDependencyPointerEnter = useCallback(
		(taskId: string) => {
			setDraft((current) => {
				if (!current) {
					return current;
				}
				const nextDraft = {
					...current,
					targetTaskId: getValidTargetTaskId(current.sourceTaskId, taskId),
				};
				draftRef.current = nextDraft;
				return nextDraft;
			});
		},
		[getValidTargetTaskId],
	);

	return {
		draft,
		onDependencyPointerDown: handleDependencyPointerDown,
		onDependencyPointerEnter: handleDependencyPointerEnter,
	};
}
