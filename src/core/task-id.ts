const TASK_ID_LENGTH = 5;
const RANDOM_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function createShortTaskId(randomUuid: () => string): string {
	return randomUuid().replaceAll("-", "").slice(0, TASK_ID_LENGTH);
}

export function createUniqueTaskId(existingIds: Set<string>, randomUuid: () => string): string {
	for (let attempt = 0; attempt < 16; attempt += 1) {
		const candidate = createShortTaskId(randomUuid);
		if (!existingIds.has(candidate)) {
			return candidate;
		}
	}
	for (let attempt = 0; attempt < 16; attempt += 1) {
		const candidate = createRandomId(TASK_ID_LENGTH);
		if (!existingIds.has(candidate)) {
			return candidate;
		}
	}
	return createRandomId(TASK_ID_LENGTH);
}

function createRandomId(length: number): string {
	let id = "";
	for (let index = 0; index < length; index += 1) {
		id += RANDOM_ID_ALPHABET[Math.floor(Math.random() * RANDOM_ID_ALPHABET.length)] ?? "0";
	}
	return id;
}
