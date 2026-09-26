function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fold the legacy queue into Review before validating the canonical runtime contract. */
export function migrateLegacyBacklog(raw: unknown): unknown {
	if (!isPlainRecord(raw) || !Array.isArray(raw.columns)) return raw;
	const legacy = raw.columns.filter((column: unknown) => isPlainRecord(column) && column.id === "backlog");
	if (legacy.length === 0) return raw;
	const queued: unknown[] = [];
	for (const column of legacy) {
		if (!isPlainRecord(column) || !Array.isArray(column.cards)) return raw;
		queued.push(...column.cards.map((card: unknown) => (isPlainRecord(card) ? { ...card, unstarted: true } : card)));
	}
	let foundReview = false;
	const columns = raw.columns
		.filter((column: unknown) => !isPlainRecord(column) || column.id !== "backlog")
		.map((column: unknown) => {
			if (!isPlainRecord(column) || column.id !== "review" || !Array.isArray(column.cards)) return column;
			foundReview = true;
			return { ...column, cards: [...column.cards, ...queued] };
		});
	if (!foundReview) columns.push({ id: "review", title: "Review", cards: queued });
	return { ...raw, columns };
}
