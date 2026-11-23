const INTERRUPTION =
	"■ Conversation interrupted - tell the model what to do differently. " +
	"Something went wrong? Hit `/feedback` to report the issue.";
const COMPOSER = "› Ask Codex to do anything";

export function renderFakeCodexInterruption(columns: number, kind: "current" | "historical"): string {
	// Lay out result rows as TUI text instead of letting the terminal split words
	// at the right edge. ConPTY can paint those physical rows separately, so a
	// word broken by autowrap is not a provider-formatted continuation row.
	const rows: string[] = [];
	let row = "";
	for (const word of INTERRUPTION.split(" ")) {
		if (row && row.length + 1 + word.length > columns) {
			rows.push(row);
			row = "";
		}
		row += row ? ` ${word}` : word;
	}
	rows.push(row);
	const frame = `\u001b[2J\u001b[H\u001b[31m${rows.join("\r\n")}\u001b[0m\r\n\r\n${COMPOSER}`;
	return kind === "historical"
		? `${frame}\r\n\r\nAGENT LAB CURRENT TURN WORKING\r\n\r\n${COMPOSER}\u001b]52;c;?\u0007`
		: frame;
}
