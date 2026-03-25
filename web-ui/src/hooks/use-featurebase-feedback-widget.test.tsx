import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeClineProviderSettings } from "@/runtime/types";

const defaultClineProviderSettings: RuntimeClineProviderSettings = {
	providerId: null,
	modelId: null,
	baseUrl: null,
	apiKeyConfigured: false,
	oauthProvider: null,
	oauthAccessTokenConfigured: false,
	oauthRefreshTokenConfigured: false,
	oauthAccountId: null,
	oauthExpiresAt: null,
};

async function importFeaturebaseModule() {
	const fetchClineAccountProfileMock = vi.fn();
	vi.resetModules();
	vi.doMock("@/runtime/runtime-config-query", () => ({
		fetchClineAccountProfile: fetchClineAccountProfileMock,
	}));
	const module = await import("@/hooks/use-featurebase-feedback-widget");
	return {
		module,
		fetchClineAccountProfileMock,
	};
}

describe("useFeaturebaseFeedbackWidget", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		document.head.querySelector("#featurebase-sdk")?.remove();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.resetModules();
		delete (window as Window & { Featurebase?: unknown }).Featurebase;
		document.head.querySelector("#featurebase-sdk")?.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
			return;
		}
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
			previousActEnvironment;
	});

	it("initializes the feedback widget even if the SDK load event fires immediately", async () => {
		const { module } = await importFeaturebaseModule();
		const featurebaseMock = vi.fn();
		const originalAppendChild = document.head.appendChild.bind(document.head);

		vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
			const result = originalAppendChild(node);
			if (node instanceof HTMLScriptElement && node.id === "featurebase-sdk") {
				(window as Window & { Featurebase?: unknown }).Featurebase = featurebaseMock;
				node.dispatchEvent(new Event("load"));
			}
			return result;
		});

		function HookHarness(): null {
			module.useFeaturebaseFeedbackWidget({
				workspaceId: null,
				clineProviderSettings: defaultClineProviderSettings,
			});
			return null;
		}

		await act(async () => {
			root.render(<HookHarness />);
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(featurebaseMock).toHaveBeenCalledWith(
			"initialize_feedback_widget",
			expect.objectContaining({
				organization: "cline",
				theme: "dark",
				locale: "en",
				metadata: { app: "kanban" },
			}),
			expect.any(Function),
		);
	});

	it("replays an early open request after the widget reports ready", async () => {
		vi.useFakeTimers();
		const { module } = await importFeaturebaseModule();
		const featurebaseMock = vi.fn();
		const postMessageMock = vi.spyOn(window, "postMessage");
		const originalAppendChild = document.head.appendChild.bind(document.head);

		vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
			const result = originalAppendChild(node);
			if (node instanceof HTMLScriptElement && node.id === "featurebase-sdk") {
				(window as Window & { Featurebase?: unknown }).Featurebase = featurebaseMock;
				node.dispatchEvent(new Event("load"));
			}
			return result;
		});

		function HookHarness(): null {
			module.useFeaturebaseFeedbackWidget({
				workspaceId: null,
				clineProviderSettings: defaultClineProviderSettings,
			});
			return null;
		}

		await act(async () => {
			root.render(<HookHarness />);
			await Promise.resolve();
			await Promise.resolve();
		});

		await act(async () => {
			module.openFeaturebaseFeedbackWidget();
			await Promise.resolve();
		});

		expect(postMessageMock).not.toHaveBeenCalled();

		const initializeCall = featurebaseMock.mock.calls.find(([action]) => action === "initialize_feedback_widget");
		const readyCallback = initializeCall?.[2];
		expect(typeof readyCallback).toBe("function");

		await act(async () => {
			(readyCallback as (error: unknown, callback?: { action?: string }) => void)(null, {
				action: "widgetReady",
			});
			await Promise.resolve();
		});

		expect(postMessageMock).toHaveBeenCalledTimes(1);
		expect(postMessageMock).toHaveBeenCalledWith(
			{
				target: "FeaturebaseWidget",
				data: {
					action: "openFeedbackWidget",
				},
			},
			"*",
		);

		await act(async () => {
			vi.advanceTimersByTime(50);
			await Promise.resolve();
		});

		expect(postMessageMock).toHaveBeenCalledTimes(2);
	});

	it("initializes immediately even while the managed Cline profile request is still pending", async () => {
		const { module, fetchClineAccountProfileMock } = await importFeaturebaseModule();
		const featurebaseMock = vi.fn();
		const originalAppendChild = document.head.appendChild.bind(document.head);

		fetchClineAccountProfileMock.mockReturnValue(new Promise(() => {}));

		vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
			const result = originalAppendChild(node);
			if (node instanceof HTMLScriptElement && node.id === "featurebase-sdk") {
				(window as Window & { Featurebase?: unknown }).Featurebase = featurebaseMock;
				node.dispatchEvent(new Event("load"));
			}
			return result;
		});

		function HookHarness(): null {
			module.useFeaturebaseFeedbackWidget({
				workspaceId: "workspace-1",
				clineProviderSettings: {
					...defaultClineProviderSettings,
					oauthProvider: "cline",
					oauthAccessTokenConfigured: true,
					oauthAccountId: "account-123",
				},
			});
			return null;
		}

		await act(async () => {
			root.render(<HookHarness />);
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(fetchClineAccountProfileMock).toHaveBeenCalledWith("workspace-1");
		expect(featurebaseMock).toHaveBeenCalledWith(
			"identify",
			expect.objectContaining({
				organization: "cline",
				userId: "account-123",
			}),
		);
		expect(featurebaseMock).toHaveBeenCalledWith(
			"initialize_feedback_widget",
			expect.objectContaining({
				organization: "cline",
				theme: "dark",
				locale: "en",
				metadata: expect.objectContaining({
					app: "kanban",
					cline_account_id: "account-123",
				}),
			}),
			expect.any(Function),
		);
	});
});
