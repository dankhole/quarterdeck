/** Codex rust-v0.159.0 trust_directory.rs, with synthetic fixture paths only. */
export const MODERN_CODEX_TRUST_DISCLOSURE =
	"Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings can run code automatically, even without a model request. Continue only if you trust these files. Your trust decision will be saved.";
export const MODERN_CODEX_TRUST_GIT_WARNING =
	"Note: You’re in a subdirectory of a Git project. Trusting will apply to the repository root:";

function wrappedRows(text: string, width: number): string[] {
	const rows: string[] = [];
	let row = "";
	for (const word of text.split(" ")) {
		if (row && row.length + 1 + word.length > width) {
			rows.push(row);
			row = "";
		}
		// The native path may occupy more than one rendered row.
		let remainder = word;
		while (remainder.length > width) {
			if (row) {
				rows.push(row);
				row = "";
			}
			rows.push(remainder.slice(0, width));
			remainder = remainder.slice(width);
		}
		row += `${row ? " " : ""}${remainder}`;
	}
	if (row) rows.push(row);
	return rows;
}

export function renderModernCodexTrustANSI(
	options: {
		cols?: number;
		selection?: "confirm" | "cancel";
		gitRoot?: boolean;
		path?: string;
		windows?: boolean;
	} = {},
): string {
	const width = (options.cols ?? 80) - 2;
	const paragraph = (text: string) => wrappedRows(text, width).map((row) => `  ${row}`);
	const rows = [
		"",
		"  \u001b[1mFolder access\u001b[22m",
		"",
		...paragraph(options.path ?? "/synthetic/quarterdeck/fixture-worktree"),
		"",
		...(options.gitRoot
			? [...paragraph(MODERN_CODEX_TRUST_GIT_WARNING), ...paragraph("/synthetic/quarterdeck/repository"), ""]
			: []),
		...paragraph(MODERN_CODEX_TRUST_DISCLOSURE),
		"",
		`${options.selection === "cancel" ? " " : "›"} 1. Trust and continue`,
		`${options.selection === "cancel" ? "›" : " "} 2. Quit`,
		"",
		...paragraph(options.windows ? "enter continue and create sandbox · esc quit" : "enter continue · esc quit"),
	];
	return `\u001b[?1049h\u001b[?25l\u001b[2J\u001b[H${rows.map((row) => `\u001b[2K${row}`).join("\r\n")}\u001b[0m`;
}

/** Shared by recognizer and exact-current-PTY pipeline tests. */
export const MODERN_CODEX_TRUST_RENDER_ANSI = renderModernCodexTrustANSI();
