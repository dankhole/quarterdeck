import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mutateMock = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		workspace: {
			generateDisplaySummary: {
				mutate: mutateMock,
			},
		},
	}),
}));

import { useDisplaySummaryOnHover } from "@/hooks/use-display-summary";

function HookHarness({
	currentProjectId,
	autoGenerateSummary,
	staleAfterSeconds,
	llmConfigured = true,
	onCallback,
}: {
	currentProjectId: string | null;
	autoGenerateSummary: boolean;
	staleAfterSeconds: number;
	llmConfigured?: boolean;
	onCallback: (cb: (taskId: string) => void) => void;
}): null {
	const callback = useDisplaySummaryOnHover(currentProjectId, autoGenerateSummary, staleAfterSeconds, llmConfigured);
	useEffect(() => {
		onCallback(callback);
	}, [callback, onCallback]);
	return null;
}

describe("useDisplaySummaryOnHover", () => {
	let container: HTMLDivElement;
	let root: Root;
	let latestCallback: (taskId: string) => void;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		mutateMock.mockClear();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		latestCallback = () => {};
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.useRealTimers();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function renderHook(props: {
		currentProjectId: string | null;
		autoGenerateSummary: boolean;
		staleAfterSeconds: number;
		llmConfigured?: boolean;
	}): void {
		act(() => {
			root.render(
				createElement(HookHarness, {
					...props,
					onCallback: (cb: (taskId: string) => void) => {
						latestCallback = cb;
					},
				}),
			);
		});
	}

	it("fires a tRPC mutation after 800ms debounce", () => {
		renderHook({ currentProjectId: "project-1", autoGenerateSummary: true, staleAfterSeconds: 300 });
		act(() => latestCallback("task-1"));
		expect(mutateMock).not.toHaveBeenCalled();

		act(() => vi.advanceTimersByTime(800));
		expect(mutateMock).toHaveBeenCalledWith({ taskId: "task-1", staleAfterSeconds: 300 });
	});

	it("does nothing when autoGenerateSummary is false", () => {
		renderHook({ currentProjectId: "project-1", autoGenerateSummary: false, staleAfterSeconds: 300 });
		act(() => latestCallback("task-1"));
		act(() => vi.advanceTimersByTime(1000));
		expect(mutateMock).not.toHaveBeenCalled();
	});

	it("does nothing when currentProjectId is null", () => {
		renderHook({ currentProjectId: null, autoGenerateSummary: true, staleAfterSeconds: 300 });
		act(() => latestCallback("task-1"));
		act(() => vi.advanceTimersByTime(1000));
		expect(mutateMock).not.toHaveBeenCalled();
	});

	it("deduplicates the same taskId while the debounce timer is active", () => {
		renderHook({ currentProjectId: "project-1", autoGenerateSummary: true, staleAfterSeconds: 300 });
		act(() => {
			latestCallback("task-1");
			latestCallback("task-1");
			latestCallback("task-1");
		});
		act(() => vi.advanceTimersByTime(800));
		expect(mutateMock).toHaveBeenCalledTimes(1);
	});

	it("cancels previous timer when a different task is hovered", () => {
		renderHook({ currentProjectId: "project-1", autoGenerateSummary: true, staleAfterSeconds: 300 });
		act(() => latestCallback("task-1"));
		act(() => vi.advanceTimersByTime(400));
		act(() => latestCallback("task-2"));
		act(() => vi.advanceTimersByTime(800));
		expect(mutateMock).toHaveBeenCalledTimes(1);
		expect(mutateMock).toHaveBeenCalledWith({ taskId: "task-2", staleAfterSeconds: 300 });
	});

	it("clears pending timer on unmount", () => {
		renderHook({ currentProjectId: "project-1", autoGenerateSummary: true, staleAfterSeconds: 300 });
		act(() => latestCallback("task-1"));
		act(() => root.unmount());
		act(() => vi.advanceTimersByTime(1000));
		expect(mutateMock).not.toHaveBeenCalled();
	});

	it("clears pending timer when autoGenerateSummary toggles to false", () => {
		renderHook({ currentProjectId: "project-1", autoGenerateSummary: true, staleAfterSeconds: 300 });
		act(() => latestCallback("task-1"));
		// Re-render with autoGenerateSummary = false
		renderHook({ currentProjectId: "project-1", autoGenerateSummary: false, staleAfterSeconds: 300 });
		act(() => vi.advanceTimersByTime(1000));
		expect(mutateMock).not.toHaveBeenCalled();
	});

	it("allows re-requesting the same task after the timer fires", () => {
		renderHook({ currentProjectId: "project-1", autoGenerateSummary: true, staleAfterSeconds: 300 });
		act(() => latestCallback("task-1"));
		act(() => vi.advanceTimersByTime(800));
		expect(mutateMock).toHaveBeenCalledTimes(1);

		act(() => latestCallback("task-1"));
		act(() => vi.advanceTimersByTime(800));
		expect(mutateMock).toHaveBeenCalledTimes(2);
	});

	it("passes the configured staleAfterSeconds to the mutation", () => {
		renderHook({ currentProjectId: "project-1", autoGenerateSummary: true, staleAfterSeconds: 60 });
		act(() => latestCallback("task-1"));
		act(() => vi.advanceTimersByTime(800));
		expect(mutateMock).toHaveBeenCalledWith({ taskId: "task-1", staleAfterSeconds: 60 });
	});

	it("does nothing when llmConfigured is false", () => {
		renderHook({
			currentProjectId: "project-1",
			autoGenerateSummary: true,
			staleAfterSeconds: 300,
			llmConfigured: false,
		});
		act(() => latestCallback("task-1"));
		act(() => vi.advanceTimersByTime(1000));
		expect(mutateMock).not.toHaveBeenCalled();
	});

	it("clears pending timer when llmConfigured toggles to false", () => {
		renderHook({
			currentProjectId: "project-1",
			autoGenerateSummary: true,
			staleAfterSeconds: 300,
			llmConfigured: true,
		});
		act(() => latestCallback("task-1"));
		renderHook({
			currentProjectId: "project-1",
			autoGenerateSummary: true,
			staleAfterSeconds: 300,
			llmConfigured: false,
		});
		act(() => vi.advanceTimersByTime(1000));
		expect(mutateMock).not.toHaveBeenCalled();
	});
});
