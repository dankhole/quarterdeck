// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { observeRuntimeAdmissionResponse, subscribeRuntimeAdmissionRequired } from "@/runtime/runtime-client-admission";

describe("runtime admission-required mapping", () => {
	it("recognizes only the scoped server401 and leaves its body available to tRPC", async () => {
		const listener = vi.fn();
		const unsubscribe = subscribeRuntimeAdmissionRequired(listener);
		try {
			for (const [status, body] of [
				[503, { code: "QUARTERDECK_CLIENT_ACCESS_REQUIRED" }],
				[401, { error: "different authorization scope" }],
			] as const) {
				expect(await observeRuntimeAdmissionResponse(new Response(JSON.stringify(body), { status }))).toBe(false);
			}
			expect(listener).not.toHaveBeenCalled();
			const response = new Response(JSON.stringify({ code: "QUARTERDECK_CLIENT_ACCESS_REQUIRED" }), { status: 401 });
			expect(await observeRuntimeAdmissionResponse(response)).toBe(true);
			expect(listener).toHaveBeenCalledOnce();
			expect(await response.json()).toEqual({ code: "QUARTERDECK_CLIENT_ACCESS_REQUIRED" });
		} finally {
			unsubscribe();
		}
	});

	it("does not publish a cancelled request's late admission failure", async () => {
		const listener = vi.fn();
		const unsubscribe = subscribeRuntimeAdmissionRequired(listener);
		const controller = new AbortController();
		controller.abort();
		try {
			expect(
				await observeRuntimeAdmissionResponse(
					new Response(JSON.stringify({ code: "QUARTERDECK_CLIENT_ACCESS_REQUIRED" }), { status: 401 }),
					controller.signal,
				),
			).toBe(false);
			expect(listener).not.toHaveBeenCalled();
		} finally {
			unsubscribe();
		}
	});
});
