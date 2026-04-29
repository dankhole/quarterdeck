const MAX_TITLE_LENGTH = 80;

const TITLE_STOP_WORDS = new Set([
	"a",
	"about",
	"after",
	"all",
	"also",
	"an",
	"and",
	"are",
	"around",
	"as",
	"at",
	"be",
	"because",
	"been",
	"before",
	"being",
	"but",
	"by",
	"can",
	"could",
	"do",
	"does",
	"doing",
	"for",
	"from",
	"had",
	"has",
	"have",
	"how",
	"i",
	"if",
	"in",
	"into",
	"is",
	"it",
	"its",
	"let",
	"lets",
	"most",
	"need",
	"needs",
	"of",
	"on",
	"or",
	"original",
	"our",
	"please",
	"prompt",
	"recent",
	"should",
	"so",
	"some",
	"summary",
	"task",
	"that",
	"the",
	"their",
	"this",
	"to",
	"too",
	"using",
	"very",
	"was",
	"we",
	"what",
	"when",
	"where",
	"which",
	"while",
	"with",
	"without",
	"work",
	"would",
	"you",
	"your",
]);

const TITLE_ACRONYMS = new Set([
	"api",
	"cli",
	"css",
	"db",
	"dom",
	"git",
	"html",
	"http",
	"id",
	"ids",
	"json",
	"llm",
	"pr",
	"pty",
	"ssh",
	"trpc",
	"ui",
	"url",
	"ux",
	"ws",
]);

export function normalizeGeneratedTitle(raw: string): string | null {
	const title = raw
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.!?:;,\-—]+$/u, "")
		.trim();
	if (!title) {
		return null;
	}
	return title.length > MAX_TITLE_LENGTH ? title.slice(0, MAX_TITLE_LENGTH).trim() : title;
}

function titleCaseWord(word: string): string {
	const lower = word.toLowerCase();
	if (TITLE_ACRONYMS.has(lower)) {
		return lower.toUpperCase();
	}
	return `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`;
}

export function createFallbackTaskTitle(prompt: string): string | null {
	const normalized = prompt
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/[_/\\.]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const matches = normalized.match(/[A-Za-z][A-Za-z0-9'-]*/g) ?? [];
	const selected: string[] = [];
	const seen = new Set<string>();
	for (const match of matches) {
		const word = match.toLowerCase().replace(/^'+|'+$/g, "");
		if (!word || seen.has(word) || TITLE_STOP_WORDS.has(word)) {
			continue;
		}
		if (word.length < 3 && !TITLE_ACRONYMS.has(word)) {
			continue;
		}
		seen.add(word);
		selected.push(titleCaseWord(word));
		if (selected.length >= 4) {
			break;
		}
	}

	if (selected.length === 0) {
		for (const match of matches) {
			const word = match.toLowerCase().replace(/^'+|'+$/g, "");
			if (!word || seen.has(word)) {
				continue;
			}
			if (word.length < 3 && !TITLE_ACRONYMS.has(word)) {
				continue;
			}
			seen.add(word);
			selected.push(titleCaseWord(word));
			if (selected.length >= 4) {
				break;
			}
		}
	}

	if (selected.length === 0) {
		return null;
	}
	return normalizeGeneratedTitle(selected.join(" "));
}
