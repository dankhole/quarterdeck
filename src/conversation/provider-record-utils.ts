export function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(value: Record<string, unknown>, key: string): string | null {
	const candidate = value[key];
	return typeof candidate === "string" ? candidate : null;
}

export function readBoolean(value: Record<string, unknown>, key: string): boolean | null {
	const candidate = value[key];
	return typeof candidate === "boolean" ? candidate : null;
}

export function readNonNegativeInteger(value: Record<string, unknown>, key: string): number | null {
	const candidate = value[key];
	return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null;
}

export function collectTextBlocks(input: {
	content: unknown;
	acceptedBlockType: string;
}): { text: string; firstContentIndex: number } | null {
	if (typeof input.content === "string") {
		return input.content.trim() ? { text: input.content, firstContentIndex: 0 } : null;
	}
	if (!Array.isArray(input.content)) {
		return null;
	}
	const textBlocks: Array<{ text: string; index: number }> = [];
	for (const [index, block] of input.content.entries()) {
		if (!isJsonObject(block) || readString(block, "type") !== input.acceptedBlockType) {
			continue;
		}
		const text = readString(block, "text");
		if (text?.trim()) {
			textBlocks.push({ text, index });
		}
	}
	if (textBlocks.length === 0) {
		return null;
	}
	return {
		text: textBlocks.map((block) => block.text).join("\n\n"),
		firstContentIndex: textBlocks[0]?.index ?? 0,
	};
}
