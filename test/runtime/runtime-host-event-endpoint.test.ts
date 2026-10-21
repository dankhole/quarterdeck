import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runtimeBrowserHostIntegrationEventRequestSchema } from "../../src/core/api/host-integrations.js";
import { handleRuntimeHostEventRequest } from "../../src/server/runtime-host-event-endpoint.js";
import { RuntimeHostEventLedger } from "../../src/server/runtime-host-event-ledger.js";

describe("synthetic host-event notification provenance", () => {
	it("records optional desktop provenance while preserving existing browser requests", async () => {
		const ledger = new RuntimeHostEventLedger("/unused/host-events.json", { persist: async () => {} });
		for (const origin of [undefined, "desktop"] as const) {
			const body = {
				kind: "notification_audio",
				eventType: "review",
				volume: 0.4,
				projectId: "project",
				taskId: "task",
				...(origin ? { origin } : {}),
			};
			const request = Readable.from([JSON.stringify(body)]) as unknown as IncomingMessage;
			request.method = "POST";
			const writeHead = vi.fn();
			const end = vi.fn();
			const response = { writeHead, end } as unknown as ServerResponse;
			expect(
				await handleRuntimeHostEventRequest(
					request,
					response,
					new URL("http://localhost/api/agent-lab/host-events"),
					ledger,
				),
			).toBe(true);
			expect(writeHead).toHaveBeenCalledWith(201, expect.any(Object));
			expect(JSON.parse(end.mock.calls[0][0]).event).toMatchObject({ origin: origin ?? "browser", ...body });
		}
		expect(ledger.list().events.map((event) => event.origin)).toEqual(["browser", "desktop"]);
	});
	it("restricts desktop provenance to the existing notification simulation request", () => {
		expect(
			runtimeBrowserHostIntegrationEventRequestSchema.parse({
				kind: "clipboard_read",
				characterCount: 1,
				origin: "desktop",
			}),
		).toEqual({ kind: "clipboard_read", characterCount: 1 });
		expect(
			runtimeBrowserHostIntegrationEventRequestSchema.safeParse({
				kind: "notification_audio",
				eventType: "review",
				volume: 0.4,
				projectId: null,
				taskId: null,
				origin: "runtime",
			}).success,
		).toBe(false);
	});
});
