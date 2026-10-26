import { basename } from "node:path";

import { describe, expect, it } from "vitest";
import { runtimeHookDeliverySchema } from "../../src/core/api/task-session.js";
import {
	compareSameProducerHookDeliveries,
	createHookDeliveryIdGenerator,
	getHookDeliveryProducerId,
	isLaterSameProducerHookDelivery,
} from "../../src/hook-delivery-order.js";
import { getOutboxRecordPath } from "../../src/hook-transition-outbox-core.js";

function requireId(ids: string[], index: number): string {
	const id = ids[index];
	if (!id) throw new Error("Missing generated delivery ID.");
	return id;
}

describe("causal hook delivery UUIDs", () => {
	it("keeps capture order lexically sortable across hexadecimal carries", () => {
		const nextId = createHookDeliveryIdGenerator();
		const ids = Array.from({ length: 258 }, () => nextId());
		expect([...ids].reverse().sort((left, right) => left.localeCompare(right))).toEqual(ids);
		for (const [earlier, later] of [
			[15, 16],
			[255, 256],
		] as const) {
			expect(isLaterSameProducerHookDelivery(requireId(ids, later), requireId(ids, earlier))).toBe(true);
			expect(compareSameProducerHookDeliveries(requireId(ids, earlier), requireId(ids, later))).toBe(-1);
		}
		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(ids.map(getHookDeliveryProducerId)).size).toBe(1);
	});

	it("is accepted by the unchanged UUID schema and outbox filename validator", () => {
		const id = createHookDeliveryIdGenerator()();
		expect(runtimeHookDeliverySchema.parse({ id, occurredAt: 123 })).toEqual({ id, occurredAt: 123 });
		expect(basename(getOutboxRecordPath(id))).toBe(`${id}.json`);
		expect(id[14]).toBe("8");
		expect(getHookDeliveryProducerId(id)).not.toBeNull();
	});

	it("compares only one recognized producer, without treating wall time as order", () => {
		const nextId = createHookDeliveryIdGenerator();
		const earlier = nextId();
		const later = nextId();
		const unrelated = createHookDeliveryIdGenerator()();
		expect(compareSameProducerHookDeliveries(earlier, earlier.toUpperCase())).toBe(0);
		expect(getHookDeliveryProducerId(earlier.toUpperCase())).toBe(getHookDeliveryProducerId(earlier));
		expect(isLaterSameProducerHookDelivery(later, earlier)).toBe(true);
		expect(isLaterSameProducerHookDelivery(earlier, later)).toBe(false);
		expect(isLaterSameProducerHookDelivery(later, unrelated)).toBe(false);
		expect(compareSameProducerHookDeliveries(later, unrelated)).toBeNull();
	});

	it.each([
		"00000000-0000-4000-8000-000000000001",
		"00000000-0000-8000-8000-000000000001",
		"00000000-0000-8000-7000-ed0000000001",
		"producer:000000000001",
		"../00000000-0000-8000-8000-ed0000000001",
		"",
	])("does not infer causal order from legacy or unrecognized IDs: %s", (id) => {
		const ordered = createHookDeliveryIdGenerator()();
		expect(getHookDeliveryProducerId(id)).toBeNull();
		expect(compareSameProducerHookDeliveries(id, ordered)).toBeNull();
		expect(isLaterSameProducerHookDelivery(ordered, id)).toBe(false);
	});
});
