export interface NormalizedConversationText {
	text: string;
	changed: boolean;
	truncated: boolean;
	unsafeCharactersReplaced: boolean;
}

function replaceUnsafeControls(value: string): string {
	let result = "";
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		const unsafe =
			(codePoint >= 0 && codePoint <= 8) ||
			codePoint === 11 ||
			codePoint === 12 ||
			(codePoint >= 14 && codePoint <= 31) ||
			(codePoint >= 127 && codePoint <= 159) ||
			(codePoint >= 0x202a && codePoint <= 0x202e) ||
			(codePoint >= 0x2066 && codePoint <= 0x2069);
		result += unsafe ? "\ufffd" : character;
	}
	return result;
}

function truncateUtf8(value: string, maxBytes: number): string {
	const ellipsis = "\u2026";
	const ellipsisBytes = Buffer.byteLength(ellipsis, "utf8");
	const contentLimit = Math.max(0, maxBytes - ellipsisBytes);
	let usedBytes = 0;
	let result = "";
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (usedBytes + characterBytes > contentLimit) {
			break;
		}
		result += character;
		usedBytes += characterBytes;
	}
	return `${result}${ellipsis}`;
}

function replaceUnpairedSurrogates(value: string): string {
	let result = "";
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				result += value[index] ?? "";
				result += value[index + 1] ?? "";
				index += 1;
			} else {
				result += "\ufffd";
			}
			continue;
		}
		result += codeUnit >= 0xdc00 && codeUnit <= 0xdfff ? "\ufffd" : (value[index] ?? "");
	}
	return result;
}

export function normalizeConversationText(value: string, maxBytes: number): NormalizedConversationText | null {
	const wellFormed = replaceUnpairedSurrogates(value);
	const normalizedLines = wellFormed.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
	const withoutUnsafeControls = replaceUnsafeControls(normalizedLines);
	const safe = withoutUnsafeControls.trim();
	if (!safe) {
		return null;
	}
	const changed = safe !== value;
	if (Buffer.byteLength(safe, "utf8") <= maxBytes) {
		return {
			text: safe,
			changed,
			truncated: false,
			unsafeCharactersReplaced: wellFormed !== value || withoutUnsafeControls !== normalizedLines,
		};
	}
	return {
		text: truncateUtf8(safe, maxBytes),
		changed: true,
		truncated: true,
		unsafeCharactersReplaced: wellFormed !== value || withoutUnsafeControls !== normalizedLines,
	};
}
