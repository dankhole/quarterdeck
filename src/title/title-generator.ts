const TITLE_SYSTEM_PROMPT =
	"Generate a concise 3-8 word title for this coding task. Return only the title text, nothing else. No quotes, no punctuation at the end.";

/**
 * Generate a short task title from a prompt using the Anthropic API (Haiku).
 * Returns null on any failure — never throws.
 */
export async function generateTaskTitle(prompt: string): Promise<string | null> {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		return null;
	}

	try {
		const response = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: "claude-haiku-4-5-20241022",
				max_tokens: 30,
				system: TITLE_SYSTEM_PROMPT,
				messages: [{ role: "user", content: prompt }],
			}),
		});

		if (!response.ok) {
			return null;
		}

		const data = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
		const text = data.content?.find((block) => block.type === "text")?.text?.trim();
		if (!text || text.length === 0) {
			return null;
		}

		return text;
	} catch {
		return null;
	}
}
