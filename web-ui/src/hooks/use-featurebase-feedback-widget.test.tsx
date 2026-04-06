import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FeaturebaseFeedbackState } from "@/hooks/use-featurebase-feedback-widget";
import { useFeaturebaseFeedbackWidget } from "@/hooks/use-featurebase-feedback-widget";

describe("useFeaturebaseFeedbackWidget", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
	});

	it("returns a stable idle stub since Featurebase auth is unavailable without Cline OAuth", async () => {
		let hookResult: FeaturebaseFeedbackState | null = null;

		function HookHarness(): null {
			hookResult = useFeaturebaseFeedbackWidget({ workspaceId: "workspace-1" });
			return null;
		}

		await act(async () => {
			root.render(<HookHarness />);
			await Promise.resolve();
		});

		expect(hookResult).not.toBeNull();
		expect(hookResult!.authState).toBe("idle");
		expect(hookResult!.widgetOpenCount).toBe(0);
		expect(typeof hookResult!.openFeedbackWidget).toBe("function");
	});

	it("openFeedbackWidget is a no-op that resolves immediately", async () => {
		let hookResult: FeaturebaseFeedbackState | null = null;

		function HookHarness(): null {
			hookResult = useFeaturebaseFeedbackWidget({ workspaceId: "workspace-1" });
			return null;
		}

		await act(async () => {
			root.render(<HookHarness />);
			await Promise.resolve();
		});

		await act(async () => {
			await hookResult!.openFeedbackWidget();
		});

		expect(hookResult!.authState).toBe("idle");
		expect(hookResult!.widgetOpenCount).toBe(0);
	});

	it("returns idle state when workspaceId is null", async () => {
		let hookResult: FeaturebaseFeedbackState | null = null;

		function HookHarness(): null {
			hookResult = useFeaturebaseFeedbackWidget({ workspaceId: null });
			return null;
		}

		await act(async () => {
			root.render(<HookHarness />);
			await Promise.resolve();
		});

		expect(hookResult!.authState).toBe("idle");
		expect(hookResult!.widgetOpenCount).toBe(0);
	});
});
