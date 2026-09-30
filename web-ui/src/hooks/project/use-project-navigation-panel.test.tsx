import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type UseProjectNavigationPanelResult,
	useProjectNavigationPanel,
} from "@/hooks/project/use-project-navigation-panel";
import type { RuntimeProjectSummary } from "@/runtime/types";

function makeProject(id: string, name = id): RuntimeProjectSummary {
	return {
		id,
		name,
		path: `/tmp/${id}`,
		boardRevision: 0,
		taskCounts: {
			in_progress: 2,
			review: 4,
			trash: 4,
		},
	};
}

function HookHarness({
	props,
	onValue,
}: {
	props: Parameters<typeof useProjectNavigationPanel>[0];
	onValue: (result: UseProjectNavigationPanelResult) => void;
}): null {
	const value = useProjectNavigationPanel(props);
	useEffect(() => {
		onValue(value);
	}, [onValue, value]);
	return null;
}

describe("useProjectNavigationPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let latestValue: UseProjectNavigationPanelResult;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		latestValue = null as unknown as UseProjectNavigationPanelResult;
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function renderHook(props: Parameters<typeof useProjectNavigationPanel>[0]): void {
		act(() => {
			root.render(createElement(HookHarness, { props, onValue: (value) => (latestValue = value) }));
		});
	}

	it("tracks removal dialog state and confirms project removal", async () => {
		const onRemoveProject = vi.fn(async () => true);

		renderHook({
			projects: [makeProject("project-1"), makeProject("project-2")],
			removingProjectId: null,
			onRemoveProject,
		});

		act(() => {
			latestValue.requestProjectRemoval("project-2");
		});

		expect(latestValue.pendingProjectRemoval?.id).toBe("project-2");
		expect(latestValue.pendingProjectTaskCount).toBe(10);

		await act(async () => {
			await latestValue.confirmProjectRemoval();
		});

		expect(onRemoveProject).toHaveBeenCalledWith("project-2");
		expect(latestValue.pendingProjectRemoval).toBeNull();
	});
});
