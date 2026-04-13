import { X } from "lucide-react";
import type { RefObject } from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { DependencyLinkDraft } from "@/components/dependencies/use-dependency-linking";
import type { BoardColumnId, BoardDependency } from "@/types";

import { computePath, type RenderedDependency, type TaskAnchor } from "./dependency-geometry";
import { useDependencyLayout } from "./use-dependency-layout";
import { useSideTransitions } from "./use-side-transitions";

export function DependencyOverlay({
	containerRef,
	dependencies,
	draft,
	activeTaskId,
	activeTaskEffectiveColumnId,
	isMotionActive = false,
	onDeleteDependency,
}: {
	containerRef: RefObject<HTMLElement>;
	dependencies: BoardDependency[];
	draft: DependencyLinkDraft | null;
	activeTaskId?: string | null;
	activeTaskEffectiveColumnId?: BoardColumnId | null;
	isMotionActive?: boolean;
	onDeleteDependency?: (dependencyId: string) => void;
}): React.ReactElement | null {
	const layout = useDependencyLayout({
		containerRef,
		dependencies,
		draft,
		activeTaskId,
		activeTaskEffectiveColumnId,
		isMotionActive: isMotionActive ?? false,
	});

	const [hoveredDependencyId, setHoveredDependencyId] = useState<string | null>(null);
	const markerId = useId().replaceAll(":", "");
	const hoverClearTimeoutRef = useRef<number | null>(null);
	const previousDependenciesByIdRef = useRef<Record<string, BoardDependency>>({});
	const transientRemovedDependencyByIdRef = useRef<Record<string, BoardDependency>>({});

	// Clear stale hover when dependencies change
	useEffect(() => {
		setHoveredDependencyId((current) => {
			if (!current) {
				return null;
			}
			const isCurrentDependency = dependencies.some((dependency) => dependency.id === current);
			const isTransientDependency = transientRemovedDependencyByIdRef.current[current] !== undefined;
			return isCurrentDependency || isTransientDependency ? current : null;
		});
	}, [dependencies]);

	// Track transient (removed-while-dragging) dependencies for smooth visual removal
	useLayoutEffect(() => {
		const currentDependenciesById = Object.fromEntries(dependencies.map((dependency) => [dependency.id, dependency]));
		if (!isMotionActive || !activeTaskId) {
			transientRemovedDependencyByIdRef.current = {};
			previousDependenciesByIdRef.current = currentDependenciesById;
			return;
		}

		const previousDependenciesById = previousDependenciesByIdRef.current;
		for (const [dependencyId, dependency] of Object.entries(previousDependenciesById)) {
			if (currentDependenciesById[dependencyId]) {
				continue;
			}
			if (dependency.fromTaskId !== activeTaskId && dependency.toTaskId !== activeTaskId) {
				continue;
			}
			transientRemovedDependencyByIdRef.current[dependencyId] = dependency;
		}
		for (const [dependencyId, transientDependency] of Object.entries(transientRemovedDependencyByIdRef.current)) {
			if (
				currentDependenciesById[dependencyId] ||
				(transientDependency.fromTaskId !== activeTaskId && transientDependency.toTaskId !== activeTaskId)
			) {
				delete transientRemovedDependencyByIdRef.current[dependencyId];
			}
		}
		previousDependenciesByIdRef.current = currentDependenciesById;
	}, [activeTaskId, dependencies, isMotionActive]);

	const clearPendingHoverClear = useCallback(() => {
		if (hoverClearTimeoutRef.current !== null) {
			window.clearTimeout(hoverClearTimeoutRef.current);
			hoverClearTimeoutRef.current = null;
		}
	}, []);

	const scheduleHoverClear = useCallback(
		(dependencyId: string) => {
			clearPendingHoverClear();
			hoverClearTimeoutRef.current = window.setTimeout(() => {
				setHoveredDependencyId((current) => (current === dependencyId ? null : current));
				hoverClearTimeoutRef.current = null;
			}, 80);
		},
		[clearPendingHoverClear],
	);

	useEffect(
		() => () => {
			clearPendingHoverClear();
		},
		[clearPendingHoverClear],
	);

	const renderedDependencies = useMemo((): RenderedDependency[] => {
		const displayedDependencies = new Map<string, { dependency: BoardDependency; isTransient: boolean }>();
		for (const dependency of dependencies) {
			displayedDependencies.set(dependency.id, {
				dependency,
				isTransient: false,
			});
		}
		for (const [dependencyId, transientDependency] of Object.entries(transientRemovedDependencyByIdRef.current)) {
			if (displayedDependencies.has(dependencyId)) {
				continue;
			}
			displayedDependencies.set(dependencyId, {
				dependency: transientDependency,
				isTransient: true,
			});
		}

		const candidates = Array.from(displayedDependencies.values())
			.map(({ dependency, isTransient }) => {
				const sourceAnchor = layout.anchors[dependency.fromTaskId];
				const targetAnchor = layout.anchors[dependency.toTaskId];
				if (!sourceAnchor || !targetAnchor) {
					return null;
				}
				const touchesActiveTask =
					activeTaskId !== null && activeTaskId !== undefined
						? dependency.fromTaskId === activeTaskId || dependency.toTaskId === activeTaskId
						: false;
				if (!isTransient && sourceAnchor.columnId !== "backlog" && targetAnchor.columnId !== "backlog") {
					return null;
				}
				if (isTransient && !touchesActiveTask) {
					return null;
				}
				return {
					dependency,
					sourceAnchor,
					targetAnchor,
					isTransient,
				};
			})
			.filter(
				(
					candidate,
				): candidate is {
					dependency: BoardDependency;
					sourceAnchor: TaskAnchor;
					targetAnchor: TaskAnchor;
					isTransient: boolean;
				} => candidate !== null,
			);

		const laneOrderByTaskId = new Map<string, Array<{ dependencyId: string; oppositeCenterY: number }>>();
		for (const candidate of candidates) {
			const sourceLanes = laneOrderByTaskId.get(candidate.dependency.fromTaskId) ?? [];
			sourceLanes.push({
				dependencyId: candidate.dependency.id,
				oppositeCenterY: candidate.targetAnchor.centerY,
			});
			laneOrderByTaskId.set(candidate.dependency.fromTaskId, sourceLanes);

			const targetLanes = laneOrderByTaskId.get(candidate.dependency.toTaskId) ?? [];
			targetLanes.push({
				dependencyId: candidate.dependency.id,
				oppositeCenterY: candidate.sourceAnchor.centerY,
			});
			laneOrderByTaskId.set(candidate.dependency.toTaskId, targetLanes);
		}

		for (const lanes of laneOrderByTaskId.values()) {
			lanes.sort((first, second) => first.oppositeCenterY - second.oppositeCenterY);
		}

		return candidates.map((candidate) => {
			const sourceLanes = laneOrderByTaskId.get(candidate.dependency.fromTaskId) ?? [
				{ dependencyId: candidate.dependency.id, oppositeCenterY: candidate.targetAnchor.centerY },
			];
			const targetLanes = laneOrderByTaskId.get(candidate.dependency.toTaskId) ?? [
				{ dependencyId: candidate.dependency.id, oppositeCenterY: candidate.sourceAnchor.centerY },
			];
			const sourceLaneIndex = sourceLanes.findIndex((lane) => lane.dependencyId === candidate.dependency.id);
			const targetLaneIndex = targetLanes.findIndex((lane) => lane.dependencyId === candidate.dependency.id);
			const sourceLaneOffset = ((sourceLaneIndex === -1 ? 0 : sourceLaneIndex) - (sourceLanes.length - 1) / 2) * 9;
			const targetLaneOffset = ((targetLaneIndex === -1 ? 0 : targetLaneIndex) - (targetLanes.length - 1) / 2) * 9;
			const geometry = computePath(
				candidate.sourceAnchor,
				candidate.targetAnchor,
				sourceLaneOffset,
				targetLaneOffset,
				{ width: layout.width, height: layout.height },
			);
			return {
				dependency: candidate.dependency,
				geometry: geometry.geometry,
				path: geometry.path,
				midpointX: geometry.midpointX,
				midpointY: geometry.midpointY,
				startSide: geometry.startSide,
				endSide: geometry.endSide,
				isTransient: candidate.isTransient,
			};
		});
	}, [activeTaskId, dependencies, layout.anchors, layout.height, layout.width]);

	const { getDisplayedPath } = useSideTransitions(renderedDependencies);

	const draftPath = useMemo(() => {
		if (!draft) {
			return null;
		}
		const sourceAnchor = layout.anchors[draft.sourceTaskId];
		if (!sourceAnchor) {
			return null;
		}
		const targetAnchor = draft.targetTaskId ? layout.anchors[draft.targetTaskId] : null;
		const container = containerRef.current;
		if (!container) {
			return null;
		}
		const containerRect = container.getBoundingClientRect();
		const pointerTarget: TaskAnchor = {
			left: draft.pointerClientX - containerRect.left,
			right: draft.pointerClientX - containerRect.left,
			top: draft.pointerClientY - containerRect.top,
			bottom: draft.pointerClientY - containerRect.top,
			centerX: draft.pointerClientX - containerRect.left,
			centerY: draft.pointerClientY - containerRect.top,
			columnId: null,
		};
		const geometry = computePath(sourceAnchor, targetAnchor ?? pointerTarget, 0, 0, {
			width: layout.width,
			height: layout.height,
		});
		return geometry.path;
	}, [containerRef, draft, layout.anchors, layout.height, layout.width]);

	const hoveredDependency = useMemo(
		() =>
			hoveredDependencyId
				? (renderedDependencies.find((rendered) => rendered.dependency.id === hoveredDependencyId) ?? null)
				: null,
		[hoveredDependencyId, renderedDependencies],
	);

	if (layout.width <= 0 || layout.height <= 0) {
		return null;
	}

	return (
		<>
			<svg
				className="kb-dependency-overlay"
				width={layout.width}
				height={layout.height}
				viewBox={`0 0 ${layout.width} ${layout.height}`}
			>
				<defs>
					<marker
						id={`${markerId}-dependency-arrow`}
						viewBox="0 0 10 10"
						refX="7"
						refY="5"
						markerWidth="5"
						markerHeight="5"
						orient="auto-start-reverse"
					>
						<path
							d="M 0 0 L 10 5 L 0 10 z"
							fill="var(--color-accent)"
							stroke="var(--color-accent)"
							strokeWidth="1.2"
							strokeLinejoin="round"
						/>
					</marker>
					<marker
						id={`${markerId}-dependency-arrow-hover`}
						viewBox="0 0 10 10"
						refX="7"
						refY="5"
						markerWidth="5"
						markerHeight="5"
						orient="auto-start-reverse"
					>
						<path
							d="M 0 0 L 10 5 L 0 10 z"
							fill="var(--color-status-red)"
							stroke="var(--color-status-red)"
							strokeWidth="1.2"
							strokeLinejoin="round"
						/>
					</marker>
				</defs>
				{renderedDependencies.map((rendered) => {
					const displayedPath = getDisplayedPath(rendered);
					return (
						<g key={rendered.dependency.id}>
							<path
								d={displayedPath}
								className={`kb-dependency-path${hoveredDependencyId === rendered.dependency.id ? " kb-dependency-path-hover" : ""}`}
								markerEnd={`url(#${hoveredDependencyId === rendered.dependency.id ? `${markerId}-dependency-arrow-hover` : `${markerId}-dependency-arrow`})`}
							/>
							{onDeleteDependency && !rendered.isTransient ? (
								<path
									d={displayedPath}
									className="kb-dependency-hit-path"
									onMouseEnter={() => {
										clearPendingHoverClear();
										setHoveredDependencyId(rendered.dependency.id);
									}}
									onMouseMove={() => {
										clearPendingHoverClear();
										setHoveredDependencyId((current) =>
											current === rendered.dependency.id ? current : rendered.dependency.id,
										);
									}}
									onMouseLeave={() => {
										scheduleHoverClear(rendered.dependency.id);
									}}
									onMouseDown={(event) => {
										event.preventDefault();
										event.stopPropagation();
									}}
									onClick={(event) => {
										event.preventDefault();
										event.stopPropagation();
										onDeleteDependency(rendered.dependency.id);
										clearPendingHoverClear();
										setHoveredDependencyId(null);
									}}
								/>
							) : null}
						</g>
					);
				})}
			</svg>
			{draftPath ? (
				<svg
					className="kb-dependency-draft-overlay"
					width={layout.width}
					height={layout.height}
					viewBox={`0 0 ${layout.width} ${layout.height}`}
				>
					<defs>
						<marker
							id={`${markerId}-draft-arrow`}
							viewBox="0 0 10 10"
							refX="7"
							refY="5"
							markerWidth="5"
							markerHeight="5"
							orient="auto-start-reverse"
						>
							<path
								d="M 0 0 L 10 5 L 0 10 z"
								fill="var(--color-accent)"
								stroke="var(--color-accent)"
								strokeWidth="1.2"
								strokeLinejoin="round"
							/>
						</marker>
					</defs>
					<path d={draftPath} className="kb-dependency-draft-path" markerEnd={`url(#${markerId}-draft-arrow)`} />
				</svg>
			) : null}
			{onDeleteDependency && hoveredDependency && !hoveredDependency.isTransient ? (
				<div
					key={`${hoveredDependency.dependency.id}-delete`}
					className="kb-dependency-delete-control"
					style={{ left: hoveredDependency.midpointX, top: hoveredDependency.midpointY }}
				>
					<X size={10} color="var(--color-text-primary)" />
				</div>
			) : null}
		</>
	);
}
