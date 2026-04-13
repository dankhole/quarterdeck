import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
	type AnchorSide,
	buildPathFromGeometry,
	type DependencyGeometry,
	interpolateDependencyGeometry,
	type RenderedDependency,
} from "./dependency-geometry";

interface SideTransition {
	from: DependencyGeometry;
	startTime: number;
	durationMs: number;
	targetStartSide: AnchorSide;
	targetEndSide: AnchorSide;
}

export function useSideTransitions(renderedDependencies: RenderedDependency[]): {
	getDisplayedPath: (rendered: RenderedDependency) => string;
} {
	const previousRenderedDependencyByIdRef = useRef<
		Record<string, Pick<RenderedDependency, "geometry" | "startSide" | "endSide">>
	>({});
	const sideTransitionByDependencyIdRef = useRef<Record<string, SideTransition>>({});
	const animationFrameIdRef = useRef<number | null>(null);
	const [, setAnimationFrameTick] = useState(0);

	// Detect side changes and start transitions
	useLayoutEffect(() => {
		const now = performance.now();
		const nextPreviousRenderedDependencyById: Record<
			string,
			Pick<RenderedDependency, "geometry" | "startSide" | "endSide">
		> = {};
		const nextRenderedDependencyIds = new Set(renderedDependencies.map((rendered) => rendered.dependency.id));
		for (const rendered of renderedDependencies) {
			const existingTransition = sideTransitionByDependencyIdRef.current[rendered.dependency.id];
			const previousRendered = previousRenderedDependencyByIdRef.current[rendered.dependency.id];
			const transitionProgress = existingTransition
				? Math.min((now - existingTransition.startTime) / existingTransition.durationMs, 1)
				: 1;
			const transitionFromGeometry = existingTransition
				? interpolateDependencyGeometry(existingTransition.from, rendered.geometry, transitionProgress)
				: previousRendered?.geometry;
			const shouldAnimateSideTransition =
				previousRendered != null &&
				(previousRendered.startSide !== rendered.startSide || previousRendered.endSide !== rendered.endSide);
			if (shouldAnimateSideTransition && transitionFromGeometry) {
				sideTransitionByDependencyIdRef.current[rendered.dependency.id] = {
					from: transitionFromGeometry,
					startTime: now,
					durationMs: 150,
					targetStartSide: rendered.startSide,
					targetEndSide: rendered.endSide,
				};
			} else if (
				existingTransition &&
				transitionProgress < 1 &&
				existingTransition.targetStartSide === rendered.startSide &&
				existingTransition.targetEndSide === rendered.endSide
			) {
				sideTransitionByDependencyIdRef.current[rendered.dependency.id] = existingTransition;
			} else {
				delete sideTransitionByDependencyIdRef.current[rendered.dependency.id];
			}
			nextPreviousRenderedDependencyById[rendered.dependency.id] = {
				geometry: rendered.geometry,
				startSide: rendered.startSide,
				endSide: rendered.endSide,
			};
		}
		for (const dependencyId of Object.keys(sideTransitionByDependencyIdRef.current)) {
			if (!nextRenderedDependencyIds.has(dependencyId)) {
				delete sideTransitionByDependencyIdRef.current[dependencyId];
			}
		}
		previousRenderedDependencyByIdRef.current = nextPreviousRenderedDependencyById;
	}, [renderedDependencies]);

	// Drive animation frame loop for active transitions
	useEffect(() => {
		if (Object.keys(sideTransitionByDependencyIdRef.current).length === 0) {
			if (animationFrameIdRef.current !== null) {
				window.cancelAnimationFrame(animationFrameIdRef.current);
				animationFrameIdRef.current = null;
			}
			return;
		}
		const tick = () => {
			const now = performance.now();
			let hasActiveTransition = false;
			for (const [dependencyId, transition] of Object.entries(sideTransitionByDependencyIdRef.current)) {
				if (now - transition.startTime >= transition.durationMs) {
					delete sideTransitionByDependencyIdRef.current[dependencyId];
					continue;
				}
				hasActiveTransition = true;
			}
			setAnimationFrameTick((current) => current + 1);
			if (hasActiveTransition) {
				animationFrameIdRef.current = window.requestAnimationFrame(tick);
				return;
			}
			animationFrameIdRef.current = null;
		};
		animationFrameIdRef.current = window.requestAnimationFrame(tick);
		return () => {
			if (animationFrameIdRef.current !== null) {
				window.cancelAnimationFrame(animationFrameIdRef.current);
				animationFrameIdRef.current = null;
			}
		};
	}, [renderedDependencies]);

	const getDisplayedPath = (rendered: RenderedDependency): string => {
		const sideTransition = sideTransitionByDependencyIdRef.current[rendered.dependency.id];
		const displayedGeometry = sideTransition
			? interpolateDependencyGeometry(
					sideTransition.from,
					rendered.geometry,
					Math.min((performance.now() - sideTransition.startTime) / sideTransition.durationMs, 1),
				)
			: rendered.geometry;
		return buildPathFromGeometry(displayedGeometry);
	};

	return { getDisplayedPath };
}
