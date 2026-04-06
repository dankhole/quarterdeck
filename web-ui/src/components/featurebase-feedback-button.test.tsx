import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeaturebaseFeedbackButton } from "@/components/featurebase-feedback-button";
import type { FeaturebaseFeedbackState } from "@/hooks/use-featurebase-feedback-widget";

function createFeaturebaseFeedbackState(authState: FeaturebaseFeedbackState["authState"]): {
	state: FeaturebaseFeedbackState;
} {
	return {
		state: {
			authState,
			widgetOpenCount: 0,
			openFeedbackWidget: vi.fn(async () => {}),
		},
	};
}

describe("FeaturebaseFeedbackButton", () => {
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

	it("renders nothing for any agent since Featurebase auth is unavailable", () => {
		const { state: fbState } = createFeaturebaseFeedbackState("ready");
		act(() => {
			root.render(<FeaturebaseFeedbackButton selectedAgentId={"claude"} featurebaseFeedbackState={fbState} />);
		});
		expect(container.innerHTML).toBe("");
	});

	it("renders nothing when featurebaseFeedbackState is undefined", () => {
		act(() => {
			root.render(<FeaturebaseFeedbackButton selectedAgentId={"claude"} />);
		});
		expect(container.innerHTML).toBe("");
	});
});
