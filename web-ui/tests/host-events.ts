import type { Page } from "@playwright/test";

import type {
	RuntimeHostIntegrationEvent,
	RuntimeHostIntegrationEventKind,
	RuntimeHostIntegrationEventLedgerResponse,
} from "../src/runtime/types";

export async function listHostEvents(page: Page): Promise<RuntimeHostIntegrationEventLedgerResponse> {
	return await page.evaluate(async () => {
		const response = await fetch("/api/agent-lab/host-events");
		if (!response.ok) {
			throw new Error(`Could not list Agent Lab host events (HTTP ${response.status}).`);
		}
		return (await response.json()) as RuntimeHostIntegrationEventLedgerResponse;
	});
}

export async function resetHostEvents(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const response = await fetch("/api/agent-lab/host-events/reset", { method: "POST" });
		if (!response.ok) {
			throw new Error(`Could not reset Agent Lab host events (HTTP ${response.status}).`);
		}
	});
}

export async function waitForHostEvent(
	page: Page,
	kind: RuntimeHostIntegrationEventKind,
	afterSequence = 0,
): Promise<RuntimeHostIntegrationEvent> {
	const response = await page.evaluate(
		async ({ requestedKind, sequence }) => {
			const query = new URLSearchParams({
				kind: requestedKind,
				afterSequence: String(sequence),
				timeoutMs: "10000",
			});
			const result = await fetch(`/api/agent-lab/host-events?${query}`);
			if (!result.ok) {
				throw new Error(`Could not await Agent Lab host event (HTTP ${result.status}).`);
			}
			return (await result.json()) as RuntimeHostIntegrationEventLedgerResponse;
		},
		{ requestedKind: kind, sequence: afterSequence },
	);
	const event = response.events[0];
	if (!event) {
		throw new Error(`Timed out waiting for Agent Lab host event ${kind}.`);
	}
	return event;
}
