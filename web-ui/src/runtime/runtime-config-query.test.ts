import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { browserHostIntegrations } from "@/runtime/browser-host-integrations";
import { fetchRuntimeConfig } from "@/runtime/runtime-config-query";
import { createTestRuntimeConfigResponse } from "@/test-utils/runtime-config-factory";

const getConfigQueryMock = vi.hoisted(() => vi.fn());
const getRuntimeTrpcClientMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: getRuntimeTrpcClientMock,
}));

describe("runtime config host capabilities", () => {
	beforeEach(() => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		browserHostIntegrations.configureCapabilities({ nativeUiAvailable: false });
		getConfigQueryMock.mockReset();
		getRuntimeTrpcClientMock.mockReset();
		getRuntimeTrpcClientMock.mockReturnValue({
			runtime: { getConfig: { query: getConfigQueryMock } },
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps browser integrations fail-closed until launch-derived config enables them", async () => {
		const action = vi.fn(() => "played");
		expect(browserHostIntegrations.runNotificationAudio(action)).toBeNull();
		expect(action).not.toHaveBeenCalled();

		getConfigQueryMock.mockResolvedValue(
			createTestRuntimeConfigResponse({ runtimeCapabilities: { nativeUiAvailable: true } }),
		);
		await fetchRuntimeConfig("project-1");

		expect(browserHostIntegrations.runNotificationAudio(action)).toBe("played");
		expect(action).toHaveBeenCalledOnce();
	});

	it("applies a disabled capability from runtime config", async () => {
		browserHostIntegrations.configureCapabilities({ nativeUiAvailable: true });
		const action = vi.fn(() => "played");
		getConfigQueryMock.mockResolvedValue(
			createTestRuntimeConfigResponse({ runtimeCapabilities: { nativeUiAvailable: false } }),
		);

		await fetchRuntimeConfig(null);

		expect(browserHostIntegrations.runNotificationAudio(action)).toBeNull();
		expect(action).not.toHaveBeenCalled();
	});
});
