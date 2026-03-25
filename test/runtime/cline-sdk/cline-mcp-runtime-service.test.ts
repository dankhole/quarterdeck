import { afterEach, describe, expect, it } from "vitest";

import {
	handleClineMcpOauthCallback,
	startOauthCallbackListener,
} from "../../../src/cline-sdk/cline-mcp-runtime-service.js";
import { setKanbanRuntimePort } from "../../../src/core/runtime-endpoint.js";

describe("cline-mcp-runtime-service OAuth callback handling", () => {
	const originalRuntimePort = process.env.KANBAN_RUNTIME_PORT;

	afterEach(() => {
		if (originalRuntimePort) {
			setKanbanRuntimePort(Number(originalRuntimePort));
		} else {
			setKanbanRuntimePort(3484);
			delete process.env.KANBAN_RUNTIME_PORT;
		}
	});

	it("resolves a pending callback session through the main runtime callback URL", async () => {
		setKanbanRuntimePort(4010);
		const session = await startOauthCallbackListener(1000);

		try {
			const callbackUrl = new URL(session.redirectUrl);
			callbackUrl.searchParams.set("code", "auth-code-123");

			const response = await handleClineMcpOauthCallback(callbackUrl);
			expect(response).toEqual({
				statusCode: 200,
				body: "<html><body><h1>Authorization complete</h1><p>You can close this tab and return to Cline.</p></body></html>",
			});
			await expect(session.awaitAuthorizationCode()).resolves.toBe("auth-code-123");
		} finally {
			await session.close();
		}
	});
});
