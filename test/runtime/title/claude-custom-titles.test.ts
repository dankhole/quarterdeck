import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	CLAUDE_CUSTOM_TITLE_SCAN_BYTES_PER_READ,
	CLAUDE_MISSING_TRANSCRIPT_BACKOFF_MS,
	ClaudeCustomTitleFollower,
} from "../../../src/title/claude-custom-titles";
import { createTempDir } from "../../utilities/temp-dir";

const SESSION_ID = "session-1";
const directories: Array<ReturnType<typeof createTempDir>> = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => directory.cleanupAsync()));
});

function entry(record: Record<string, unknown>): string {
	return `${JSON.stringify({ sessionId: SESSION_ID, ...record })}\n`;
}

async function transcript(content: string) {
	const directory = createTempDir("claude-titles-");
	directories.push(directory);
	const projectDirectory = join(directory.path, "projects", "-repo");
	await mkdir(projectDirectory, { recursive: true });
	const path = join(projectDirectory, `${SESSION_ID}.jsonl`);
	await writeFile(path, content, "utf8");
	return { profileRoot: directory.path, path };
}

const targets = [{ sessionId: SESSION_ID, hint: null }];

describe("Claude custom title follower", () => {
	it("adopts only the session's latest complete custom-title entry", async () => {
		const { profileRoot } = await transcript(
			[
				entry({ type: "custom-title", customTitle: "  First\tname  " }),
				entry({ type: "custom-title", customTitle: "Other session", sessionId: "session-2" }),
				entry({ type: "summary", summary: "Summary title", leafUuid: "leaf" }),
				entry({ type: "ai-title", aiTitle: "AI title" }),
				JSON.stringify({ type: "custom-title", customTitle: "Still writing", sessionId: SESSION_ID }),
			].join(""),
		);
		const follower = new ClaudeCustomTitleFollower();
		expect([...(await follower.read(profileRoot, targets)).values()].map(({ title }) => title)).toEqual([
			"First name",
		]);
	});

	it("reads appended entries and does not resurrect a title after an empty rename", async () => {
		const { profileRoot, path } = await transcript(entry({ type: "custom-title", customTitle: "Original" }));
		const follower = new ClaudeCustomTitleFollower();
		expect((await follower.read(profileRoot, targets)).get(SESSION_ID)?.title).toBe("Original");
		await appendFile(path, entry({ type: "custom-title", customTitle: "Renamed", uuid: "u" }));
		expect((await follower.read(profileRoot, targets)).get(SESSION_ID)?.title).toBe("Renamed");
		await appendFile(path, entry({ type: "custom-title", customTitle: "   " }));
		expect(await follower.read(profileRoot, targets)).toEqual(new Map());
	});

	it("finds an old rename beyond one read budget only after catching up", async () => {
		const filler = entry({ type: "user", message: { role: "user", content: "x".repeat(60_000) } });
		const fillerCount = Math.ceil(CLAUDE_CUSTOM_TITLE_SCAN_BYTES_PER_READ / filler.length) + 1;
		const { profileRoot } = await transcript(
			`${entry({ type: "custom-title", customTitle: "Early rename" })}${filler.repeat(fillerCount)}`,
		);
		const follower = new ClaudeCustomTitleFollower();
		expect(await follower.read(profileRoot, targets)).toEqual(new Map());
		expect((await follower.read(profileRoot, targets)).get(SESSION_ID)?.title).toBe("Early rename");
	});

	it("restarts when the transcript is replaced", async () => {
		const { profileRoot, path } = await transcript(entry({ type: "custom-title", customTitle: "Before" }));
		const follower = new ClaudeCustomTitleFollower();
		expect((await follower.read(profileRoot, targets)).get(SESSION_ID)?.title).toBe("Before");
		const replacement = `${path}.next`;
		await writeFile(replacement, entry({ type: "custom-title", customTitle: "After replacement" }), "utf8");
		await rename(replacement, path);
		expect((await follower.read(profileRoot, targets)).get(SESSION_ID)?.title).toBe("After replacement");
	});

	it("gives a repeated identical rename a new revision", async () => {
		const { profileRoot, path } = await transcript(entry({ type: "custom-title", customTitle: "Same" }));
		const follower = new ClaudeCustomTitleFollower();
		const first = (await follower.read(profileRoot, targets)).get(SESSION_ID);
		expect((await follower.read(profileRoot, targets)).get(SESSION_ID)).toEqual(first);
		await appendFile(path, entry({ type: "custom-title", customTitle: "Same" }));
		const repeated = (await follower.read(profileRoot, targets)).get(SESSION_ID);
		expect(repeated?.title).toBe("Same");
		expect(repeated?.revision).not.toBe(first?.revision);
	});

	it("backs off lookups for a missing transcript until the backoff expires or a hint arrives", async () => {
		const directory = createTempDir("claude-titles-backoff-");
		directories.push(directory);
		let now = 1_000;
		const follower = new ClaudeCustomTitleFollower(() => now);
		expect(await follower.read(directory.path, targets)).toEqual(new Map());
		const path = join(directory.path, "projects", "-repo", `${SESSION_ID}.jsonl`);
		await mkdir(join(directory.path, "projects", "-repo"), { recursive: true });
		await writeFile(path, entry({ type: "custom-title", customTitle: "Found" }), "utf8");
		expect(await follower.read(directory.path, targets)).toEqual(new Map());
		now += CLAUDE_MISSING_TRANSCRIPT_BACKOFF_MS.initial;
		expect((await follower.read(directory.path, targets)).get(SESSION_ID)?.title).toBe("Found");

		const hinted = new ClaudeCustomTitleFollower(() => now);
		const missingDirectory = createTempDir("claude-titles-backoff-hint-");
		directories.push(missingDirectory);
		const hintedPath = join(missingDirectory.path, "projects", "-repo", `${SESSION_ID}.jsonl`);
		expect(await hinted.read(missingDirectory.path, targets)).toEqual(new Map());
		await mkdir(join(missingDirectory.path, "projects", "-repo"), { recursive: true });
		await writeFile(hintedPath, entry({ type: "custom-title", customTitle: "Hinted" }), "utf8");
		const hint = { providerId: "claude" as const, providerSessionId: SESSION_ID, sourcePath: hintedPath };
		expect((await hinted.read(missingDirectory.path, [{ sessionId: SESSION_ID, hint }])).get(SESSION_ID)?.title).toBe(
			"Hinted",
		);
	});

	it("keeps the current title when the transcript is missing", async () => {
		const directory = createTempDir("claude-titles-missing-");
		directories.push(directory);
		expect(await new ClaudeCustomTitleFollower().read(directory.path, targets)).toEqual(new Map());
	});
});
