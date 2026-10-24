import { randomUUID } from "node:crypto";

// UUIDv8 custom layout: 74 random producer bits, an "ed" layout marker, and
// a fixed-width 40-bit capture ordinal. The RFC variant/version stay valid;
// neither the UUID nor its producer key contains wall time or provider data.
const ORDERED_DELIVERY_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-ed)([0-9a-f]{10})$/iu;
const MAX_CAPTURE_ORDINAL = 0xffffffffff;

/** One generator per extension instance; call synchronously at native event capture. */
export function createHookDeliveryIdGenerator(): () => string {
	const nonce = randomUUID();
	const producer = `${nonce.slice(0, 14)}8${nonce.slice(15, 24)}ed`;
	let ordinal = 0;
	return () => {
		// Never wrap or rotate producer identity: that would erase causal order.
		if (ordinal > MAX_CAPTURE_ORDINAL) throw new Error("Hook delivery capture ordinal exhausted.");
		return `${producer}${(ordinal++).toString(16).padStart(10, "0")}`;
	};
}

/** Opaque producer key for this layout only; legacy/random UUIDs have no known order. */
export function getHookDeliveryProducerId(deliveryId: string): string | null {
	return ORDERED_DELIVERY_ID.exec(deliveryId)?.[1]?.toLowerCase() ?? null;
}

/** Ordinal comparison only when both IDs carry the same recognized producer. */
export function compareSameProducerHookDeliveries(leftId: string, rightId: string): number | null {
	const left = ORDERED_DELIVERY_ID.exec(leftId);
	const right = ORDERED_DELIVERY_ID.exec(rightId);
	if (!left || !right || left[1]?.toLowerCase() !== right[1]?.toLowerCase()) return null;
	const leftOrdinal = Number.parseInt(left[2] ?? "", 16);
	const rightOrdinal = Number.parseInt(right[2] ?? "", 16);
	return Math.sign(leftOrdinal - rightOrdinal);
}

/** Capture-order evidence, not timestamp evidence or authority across launches. */
export function isLaterSameProducerHookDelivery(candidateId: string, predecessorId: string): boolean {
	return compareSameProducerHookDeliveries(candidateId, predecessorId) === 1;
}
