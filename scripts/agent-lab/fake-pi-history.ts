import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export interface FakePiHistory {
	path: string;
	parentId: string | null;
}

function assertContained(root: string, path: string): void {
	const child = relative(root, path);
	if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
		throw new Error("Fake Pi history must remain inside its isolated fixture.");
	}
}

/** Native Pi accepts custom session storage; keep the synthetic source in isolated lab state. */
export async function initializeFakePiHistory(options: {
	environment: NodeJS.ProcessEnv;
	sessionId: string;
	cwd: string;
	prompt: string;
}): Promise<FakePiHistory> {
	const { environment, sessionId } = options;
	const tempRoot = environment.TMPDIR || environment.TEMP;
	const stateHome = environment.QUARTERDECK_STATE_HOME;
	if (
		environment.QUARTERDECK_AGENT_LAB !== "1" ||
		!tempRoot ||
		!stateHome ||
		!isAbsolute(tempRoot) ||
		!isAbsolute(stateHome) ||
		!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)
	) {
		throw new Error("Fake Pi history requires an explicit isolated Agent Lab environment and session identity.");
	}
	const root = await realpath(stateHome);
	assertContained(await realpath(tempRoot), root);
	const path = join(root, "agent-lab", "pi-history", `${sessionId}.jsonl`);
	let current = root;
	for (const segment of relative(root, path).split(sep)) {
		current = join(current, segment);
		try {
			if ((await lstat(current)).isSymbolicLink()) throw new Error("Fake Pi history cannot follow symlinks.");
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
	}
	await mkdir(join(root, "agent-lab", "pi-history"), { recursive: true, mode: 0o700 });
	const timestamp = new Date().toISOString();
	try {
		await writeFile(
			path,
			`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp, cwd: options.cwd })}\n`,
			{ flag: "wx", mode: 0o600 },
		);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
	}
	const records: unknown[] = (await readFile(path, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const header = records[0];
	if (
		!header ||
		typeof header !== "object" ||
		!("type" in header && header.type === "session" && "id" in header && header.id === sessionId)
	) {
		throw new Error("Fake Pi history has a mismatched session header.");
	}
	const leaf = records.at(-1);
	const history: FakePiHistory = {
		path,
		parentId:
			records.length > 1 && leaf && typeof leaf === "object" && "id" in leaf && typeof leaf.id === "string"
				? leaf.id
				: null,
	};
	if (records.length === 1 && options.prompt) await appendFakePiMessage(history, "user", options.prompt);
	return history;
}

export async function appendFakePiMessage(
	history: FakePiHistory,
	role: "user" | "assistant",
	text: string,
): Promise<void> {
	const id = randomUUID().slice(0, 8);
	const timestamp = Date.now();
	await appendFile(
		history.path,
		`${JSON.stringify({ type: "message", id, parentId: history.parentId, timestamp: new Date(timestamp).toISOString(), message: { role, content: [{ type: "text", text }], timestamp } })}\n`,
	);
	history.parentId = id;
}
