import type { Page } from "playwright-core";
import { z } from "zod";

import { runtimeAgentDefinitionSchema } from "../../src/core/api/config";

const availabilitySchema = runtimeAgentDefinitionSchema.pick({
	id: true,
	installed: true,
	status: true,
	statusMessage: true,
	detectedVersion: true,
	requiredVersion: true,
});
const configEnvelopeSchema = z.object({
	result: z.object({ data: z.object({ agents: z.array(availabilitySchema).max(16) }) }),
});

/** Project only availability metadata; never persist the surrounding config. */
export function readDesktopAgentAvailability(payload: unknown): z.infer<typeof availabilitySchema>[] {
	const results = Array.isArray(payload) ? payload.slice(0, 32) : [payload];
	return results.flatMap((result: unknown) => {
		const parsed = configEnvelopeSchema.safeParse(result);
		return parsed.success ? parsed.data.result.data.agents : [];
	});
}

export class DesktopConfigObserver {
	private observedPages = new WeakSet<Page>();
	private pending = new Set<Promise<void>>();
	private records: Array<{ observedAt: string; agents: z.infer<typeof availabilitySchema>[] }> = [];
	private acceptedResponses = 0;

	observe(page: Page): void {
		if (this.observedPages.has(page)) return;
		this.observedPages.add(page);
		page.on("response", (response) => {
			const path = new URL(response.url()).pathname;
			if (!path.startsWith("/api/trpc/") || !path.includes("runtime.getConfig") || !response.ok()) return;
			if (this.acceptedResponses++ >= 64) return;
			const observation = response
				.json()
				.then((payload: unknown) => {
					const agents = readDesktopAgentAvailability(payload);
					if (agents.length > 0) this.records.push({ observedAt: new Date().toISOString(), agents });
				})
				.catch(() => {});
			this.pending.add(observation);
			void observation.finally(() => this.pending.delete(observation));
		});
	}

	async snapshot(): Promise<Array<{ observedAt: string; agents: z.infer<typeof availabilitySchema>[] }>> {
		await Promise.all([...this.pending]);
		return this.records.map((record) => ({ ...record, agents: record.agents.map((agent) => ({ ...agent })) }));
	}
}
