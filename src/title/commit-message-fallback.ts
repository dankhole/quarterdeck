const MAX_SUMMARY_LENGTH = 72;

interface DiffFileSummary {
	path: string;
	additions: number;
	deletions: number;
	isNew: boolean;
	isDeleted: boolean;
	isRenamed: boolean;
}

function normalizePath(path: string): string {
	return path.replace(/^"?[ab]\//, "").replace(/"$/, "");
}

function basename(path: string): string {
	const parts = path.split("/");
	return parts[parts.length - 1] || path;
}

function truncateSummary(summary: string): string {
	if (summary.length <= MAX_SUMMARY_LENGTH) {
		return summary;
	}
	return summary.slice(0, MAX_SUMMARY_LENGTH).trimEnd();
}

function classifyArea(paths: string[]): string {
	if (paths.every((path) => path.endsWith(".md") || path.startsWith("docs/"))) {
		return "docs";
	}
	if (paths.every((path) => path.includes("test") || path.includes("spec"))) {
		return "tests";
	}
	if (paths.some((path) => /package(?:-lock)?\.json$|pnpm-lock\.yaml$|yarn\.lock$/.test(path))) {
		return "dependencies";
	}
	if (paths.every((path) => /\.(json|ya?ml|toml|env|config\.[cm]?[jt]s)$/.test(path))) {
		return "config";
	}
	if (paths.every((path) => path.startsWith("web-ui/") || path.endsWith(".tsx") || path.endsWith(".css"))) {
		return "web UI";
	}
	return "changed files";
}

function parseDiffFiles(diff: string): DiffFileSummary[] {
	const files: DiffFileSummary[] = [];
	let current: DiffFileSummary | null = null;

	for (const line of diff.split(/\r?\n/)) {
		const header = line.match(/^diff --git a\/(.+) b\/(.+)$/);
		if (header) {
			current = {
				path: normalizePath(header[2] ?? header[1] ?? "files"),
				additions: 0,
				deletions: 0,
				isNew: false,
				isDeleted: false,
				isRenamed: false,
			};
			files.push(current);
			continue;
		}
		if (!current) {
			continue;
		}
		if (line.startsWith("new file mode")) {
			current.isNew = true;
		} else if (line.startsWith("deleted file mode")) {
			current.isDeleted = true;
		} else if (line.startsWith("rename to ")) {
			current.path = normalizePath(line.slice("rename to ".length));
			current.isRenamed = true;
		} else if (line.startsWith("+") && !line.startsWith("+++")) {
			current.additions += 1;
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			current.deletions += 1;
		}
	}

	return files;
}

function summarizeSingleFile(file: DiffFileSummary): string {
	const name = basename(file.path);
	if (file.isRenamed) {
		return `rename ${name}`;
	}
	if (file.isNew && !file.isDeleted) {
		return `add ${name}`;
	}
	if (file.isDeleted && !file.isNew) {
		return `remove ${name}`;
	}
	return `update ${name}`;
}

export function createFallbackCommitMessage(diff: string): string | null {
	const files = parseDiffFiles(diff);
	if (files.length === 0) {
		return null;
	}

	const paths = files.map((file) => file.path);
	const firstFile = files[0];
	const summary = files.length === 1 && firstFile ? summarizeSingleFile(firstFile) : `update ${classifyArea(paths)}`;
	const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0);
	const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0);
	const changeStats = `${files.length} ${files.length === 1 ? "file" : "files"}, +${totalAdditions}/-${totalDeletions}`;
	const bullets = [`- Update ${changeStats}`];

	const notableFiles = paths.slice(0, 3).map((path) => basename(path));
	if (notableFiles.length > 0) {
		bullets.push(`- Touch ${notableFiles.join(", ")}`);
	}

	return `${truncateSummary(summary)}\n\n${bullets.join("\n")}`;
}
