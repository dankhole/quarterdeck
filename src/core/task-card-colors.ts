// Stable palette indices are persisted on tasks; append colors rather than reordering.
export const TASK_CARD_COLORS = [
	"#E8B4B8",
	"#EAC3AA",
	"#E8D3A2",
	"#DBD9A5",
	"#C4DAAF",
	"#ACD6B7",
	"#A7D8CA",
	"#A8D8DA",
	"#ACCDE3",
	"#B4BFE4",
	"#C6B7E2",
	"#D8B5DF",
	"#E3B3CD",
	"#E3C1C7",
	"#DCC8B4",
	"#DDD4B9",
	"#CDD5B7",
	"#B9CEBA",
	"#B5CDC6",
	"#B5CBCD",
	"#B9C6D7",
	"#C3C3D8",
	"#CEC0D5",
	"#D5BED0",
	"#E6AD9F",
	"#E9BE94",
	"#E2D38F",
	"#CCD599",
	"#AFD0A2",
	"#9DCEB4",
	"#98CDC6",
	"#9DCBD6",
	"#A1BDE0",
	"#ADAEE0",
	"#C2A7DC",
	"#D5A7D6",
	"#DEA7BC",
	"#CDAF9F",
	"#A8C1AE",
	"#ACBACF",
] as const;

export function taskColorSeed(id: string): number {
	let hash = 2166136261;
	for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
	return (hash >>> 0) % TASK_CARD_COLORS.length;
}

function countTaskColors(cards: readonly { colorIndex?: number }[]): number[] {
	const counts = Array.from({ length: TASK_CARD_COLORS.length }, () => 0);
	for (const card of cards) {
		if (card.colorIndex !== undefined && counts[card.colorIndex] !== undefined)
			counts[card.colorIndex] = (counts[card.colorIndex] ?? 0) + 1;
	}
	return counts;
}

const paletteRgb = TASK_CARD_COLORS.map((color) => [
	Number.parseInt(color.slice(1, 3), 16),
	Number.parseInt(color.slice(3, 5), 16),
	Number.parseInt(color.slice(5, 7), 16),
]);

function chooseTaskColor(id: string, counts: readonly number[]): number {
	const minimum = Math.min(...counts);
	const seed = taskColorSeed(id);
	// Prefer the most distinct available pastel; the task seed breaks ties.
	const usedColors = paletteRgb.filter((_, index) => (counts[index] ?? 0) > 0);
	let selected = seed;
	let bestDistance = -1;
	for (let offset = 0; offset < counts.length; offset++) {
		const index = (seed + offset) % counts.length;
		if (counts[index] !== minimum) continue;
		const rgb = paletteRgb[index];
		if (!rgb) continue;
		const distance = Math.min(
			...usedColors.map((used) =>
				rgb.reduce((sum, channel, channelIndex) => sum + (channel - (used[channelIndex] ?? 0)) ** 2, 0),
			),
		);
		if (distance > bestDistance) {
			selected = index;
			bestDistance = distance;
		}
	}
	return selected;
}

export function allocateTaskColor(id: string, cards: readonly { colorIndex?: number }[]): number {
	return chooseTaskColor(id, countTaskColors(cards));
}

// Deterministic legacy backfill; the next authoritative write persists these assignments.
export function assignMissingTaskColors<
	T extends { columns: { cards: { id: string; createdAt: number; colorIndex?: number }[] }[] },
>(board: T): T {
	const cards = board.columns.flatMap((column) => column.cards);
	const missing = cards.filter((card) => card.colorIndex === undefined);
	if (missing.length === 0) return board;
	const counts = countTaskColors(cards);
	for (const card of missing.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
		card.colorIndex = chooseTaskColor(card.id, counts);
		counts[card.colorIndex] = (counts[card.colorIndex] ?? 0) + 1;
	}
	return board;
}
