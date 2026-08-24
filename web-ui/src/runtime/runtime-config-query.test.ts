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
		browserHostIntegrations.configureCapabilities({
			nativeUiAvailable: false,
			hostIntegrationMode: "unavailable",
		});
		getConfigQueryMock.mockReset();
		getRuntimeTrpcClientMock.mockReset();
		getRuntimeTrpcClientMock.mockReturnValue({
			runtime: { getConfig: { query: getConfigQueryMock } },
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("applies native host capabilities from runtime config", async () => {
		const action = vi.fn(() => "played");
		expect(browserHostIntegrations.runNotificationAudio(null, action)).toEqual({
			outcome: "unavailable",
			value: null,
		});
		expect(action).not.toHaveBeenCalled();

		getConfigQueryMock.mockResolvedValue(
			createTestRuntimeConfigResponse({
				runtimeCapabilities: { nativeUiAvailable: true, hostIntegrationMode: "native" },
			}),
		);
		await fetchRuntimeConfig("project-1");

		expect(browserHostIntegrations.runNotificationAudio(null, action)).toEqual({
			outcome: "native",
			value: "played",
		});
		expect(action).toHaveBeenCalledOnce();
	});

	it("applies a disabled capability from runtime config", async () => {
		browserHostIntegrations.configureCapabilities({ nativeUiAvailable: true, hostIntegrationMode: "native" });
		const action = vi.fn(() => "played");
		getConfigQueryMock.mockResolvedValue(
			createTestRuntimeConfigResponse({
				runtimeCapabilities: { nativeUiAvailable: false, hostIntegrationMode: "unavailable" },
			}),
		);

		await fetchRuntimeConfig(null);

		expect(browserHostIntegrations.runNotificationAudio(null, action)).toEqual({
			outcome: "unavailable",
			value: null,
		});
		expect(action).not.toHaveBeenCalled();
	});
});
