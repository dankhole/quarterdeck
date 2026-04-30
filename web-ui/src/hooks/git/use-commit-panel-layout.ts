import type { MutableRefObject, MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useRef, useState } from "react";

import {
	COMMIT_CONTROLS_DEFAULT_HEIGHT,
	calculateCommitControlsDragHeight,
	clampCommitControlsHeight,
	getCommitControlsResizeBounds,
} from "@/hooks/git/commit-panel-layout";
import { useLayoutResetEffect } from "@/resize/layout-customizations";
import {
	getResizePreferenceDefaultValue,
	loadResizePreference,
	persistResizePreference,
	type ResizeNumberPreference,
} from "@/resize/resize-preferences";
import { useResizeDrag } from "@/resize/use-resize-drag";
import { LocalStorageKey } from "@/storage/local-storage-store";

const COMMIT_CONTROLS_HEIGHT_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.CommitPanelControlsHeight,
	defaultValue: COMMIT_CONTROLS_DEFAULT_HEIGHT,
	normalize: clampCommitControlsHeight,
};

export interface UseCommitPanelLayoutResult {
	changesListRef: MutableRefObject<HTMLDivElement | null>;
	commitControlsRef: MutableRefObject<HTMLDivElement | null>;
	commitControlsHeight: number;
	handleCommitControlsResizeMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

export function useCommitPanelLayout(): UseCommitPanelLayoutResult {
	const changesListRef = useRef<HTMLDivElement | null>(null);
	const commitControlsRef = useRef<HTMLDivElement | null>(null);
	const { startDrag: startCommitControlsResize } = useResizeDrag();
	const [commitControlsHeight, setCommitControlsHeightState] = useState(() =>
		loadResizePreference(COMMIT_CONTROLS_HEIGHT_PREFERENCE),
	);

	const setCommitControlsHeight = useCallback((height: number) => {
		setCommitControlsHeightState(persistResizePreference(COMMIT_CONTROLS_HEIGHT_PREFERENCE, height));
	}, []);

	const handleCommitControlsResizeMouseDown = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			const controls = commitControlsRef.current;
			if (!controls) return;

			const startPointerY = event.clientY;
			const startHeight = controls.getBoundingClientRect().height || commitControlsHeight;
			const changesListHeight = changesListRef.current?.getBoundingClientRect().height ?? 0;
			const bounds = getCommitControlsResizeBounds({ startHeight, changesListHeight });

			startCommitControlsResize(event, {
				axis: "y",
				cursor: "ns-resize",
				onMove: (pointerY) => {
					setCommitControlsHeight(
						calculateCommitControlsDragHeight({ startHeight, startPointerY, pointerY, bounds }),
					);
				},
				onEnd: (pointerY) => {
					setCommitControlsHeight(
						calculateCommitControlsDragHeight({ startHeight, startPointerY, pointerY, bounds }),
					);
				},
			});
		},
		[commitControlsHeight, setCommitControlsHeight, startCommitControlsResize],
	);

	useLayoutResetEffect(() => {
		setCommitControlsHeightState(getResizePreferenceDefaultValue(COMMIT_CONTROLS_HEIGHT_PREFERENCE));
	});

	return {
		changesListRef,
		commitControlsRef,
		commitControlsHeight,
		handleCommitControlsResizeMouseDown,
	};
}
