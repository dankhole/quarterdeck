import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConversationProgressCursor } from "../../src/conversation";
import { PROGRESS_READ_LIMITS } from "../../src/conversation/conversation-progress-cursor";
import * as fileValidation from "../../src/fs/validated-file-open";
import { createTempDir } from "../utilities/temp-dir";

vi.mock("../../src/fs/validated-file-open", { spy: true });

function codexHeader(sessionId = "session-1", historyMode = "paginated") {
	return {
		type: "session_meta",
		payload: { id: sessionId, history_mode: historyMode, cli_version: "99.0.0-preview" },
	};
}
function codexMessage(text: string, timestamp = 200) {
	return {
		timestamp: new Date(timestamp).toISOString(),
		type: "response_item",
		payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text }] },
	};
}
function codexOutput(bytes: number) {
	return { type: "response_item", payload: { type: "function_call_output", output: "x".repeat(bytes) } };
}
function claudeMessage(input: {
	uuid: string;
	parentUuid?: string | null;
	text?: string;
	sidechain?: boolean;
	timestamp?: number;
}) {
	return {
		type: "assistant",
		sessionId: "session-1",
		uuid: input.uuid,
		...(input.parentUuid !== undefined ? { parentUuid: input.parentUuid } : {}),
		isSidechain: input.sidechain ?? false,
		timestamp: new Date(input.timestamp ?? 200).toISOString(),
		message: { role: "assistant", content: [{ type: "text", text: input.text ?? "Foreground message" }] },
	};
}
const jsonl = (...records: unknown[]) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

describe("incremental progress cursor isolated files", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const cleanup of cleanups.splice(0)) await cleanup();
	});
	async function setup(providerId: "codex" | "claude" = "codex", limits?: Partial<typeof PROGRESS_READ_LIMITS>) {
		const temporary = createTempDir("progress-cursor-");
		cleanups.push(temporary.cleanupAsync);
		const sourcePath = join(temporary.path, "session-1.jsonl");
		const cursor = createConversationProgressCursor({
			hint: { providerId, providerSessionId: "session-1", sourcePath },
			since: 100,
			roots: { codex: [temporary.path], claude: [temporary.path] },
			limits,
		});
		return { temporary, sourcePath, cursor };
	}

	it("bootstraps a multi-MiB source within a constant budget then retains commentary ahead of noisy appends", async () => {
		const { sourcePath, cursor } = await setup();
		const old = jsonl(
			codexHeader(),
			...Array.from({ length: 100 }, () => codexOutput(32 * 1024)),
			codexMessage("Old completed answer", 99),
		);
		await writeFile(sourcePath, old);
		const before = await stat(sourcePath);
		let bootstrap = await cursor.read();
		expect(bootstrap.text).toBeNull();
		expect(bootstrap.sourceBytesExamined).toBeLessThanOrEqual(PROGRESS_READ_LIMITS.maxSourceBytes + 4096);
		while (bootstrap.hasMore) bootstrap = await cursor.read();
		expect(bootstrap.hasMore).toBe(false);
		await appendFile(sourcePath, jsonl(codexMessage("Fresh commentary"), codexOutput(300 * 1024)));
		const first = await cursor.read();
		expect(first).toMatchObject({ text: "Fresh commentary", hasMore: true });
		expect(first.sourceBytesExamined).toBeLessThanOrEqual(PROGRESS_READ_LIMITS.maxSourceBytes);
		let result = first;
		for (let pass = 0; result.hasMore && pass < 10; pass += 1) result = await cursor.read();
		expect(result).toMatchObject({ text: "Fresh commentary", hasMore: false });
		expect(await readFile(sourcePath, "utf8")).toBe(
			`${old}${jsonl(codexMessage("Fresh commentary"), codexOutput(300 * 1024))}`,
		);
		expect((await stat(sourcePath)).size).toBeGreaterThan(before.size);
	});

	it("keeps a split UTF-8 message until its record completes and bounds retained text", async () => {
		const { sourcePath, cursor } = await setup(undefined, { chunkBytes: 11 });
		await writeFile(sourcePath, jsonl(codexHeader()));
		while ((await cursor.read()).hasMore) {}
		const message = Buffer.from(jsonl(codexMessage("😀".repeat(600))));
		const split = message.indexOf(Buffer.from("😀")) + 2;
		await appendFile(sourcePath, message.subarray(0, split));
		let result = await cursor.read();
		while (result.hasMore) result = await cursor.read();
		expect(result.text).toBeNull();
		await appendFile(sourcePath, message.subarray(split));
		for (let pass = 0; pass < 100; pass += 1) {
			result = await cursor.read();
			if (!result.hasMore) break;
		}
		expect(result.text).toHaveLength(500);
	});

	it("omits assistant records beyond the bounded fingerprint budget while still draining large tool records", async () => {
		const { sourcePath, cursor } = await setup();
		await writeFile(sourcePath, jsonl(codexHeader(), codexMessage("x".repeat(33 * 1024))));
		expect((await cursor.read()).text).toBeNull();
		await appendFile(sourcePath, jsonl(codexMessage("Bounded fresh message"), codexOutput(300 * 1024)));
		let result = await cursor.read();
		expect(result.text).toBe("Bounded fresh message");
		while (result.hasMore) {
			expect(result.sourceBytesExamined).toBeLessThanOrEqual(PROGRESS_READ_LIMITS.maxSourceBytes);
			result = await cursor.read();
		}
		expect(result.text).toBe("Bounded fresh message");
	});

	it("detects a changed assistant record even when truncation regrows identical bytes around the forward cursor", async () => {
		const { sourcePath, cursor } = await setup();
		await writeFile(sourcePath, jsonl(codexHeader()));
		await cursor.read();
		const output = codexOutput(300 * 1024);
		await appendFile(sourcePath, jsonl(codexMessage("Old captured preview"), output));
		expect(await cursor.read()).toMatchObject({ text: "Old captured preview", hasMore: true });
		await writeFile(sourcePath, jsonl(codexHeader(), codexMessage("Different replacement"), output, output));
		expect((await cursor.read()).text).toBeNull();
		await appendFile(sourcePath, jsonl(codexMessage("Fresh after repeated-output rewrite", 400)));
		expect((await cursor.read()).text).toBe("Fresh after repeated-output rewrite");
	});

	it("does not let an unread prior-epoch rollback suppress the next turn", async () => {
		const { sourcePath, cursor } = await setup();
		await writeFile(sourcePath, jsonl(codexHeader(), codexMessage("Prior turn", 200)));
		await cursor.read();
		cursor.pause();
		await appendFile(
			sourcePath,
			jsonl({
				timestamp: new Date(250).toISOString(),
				type: "event_msg",
				payload: { type: "thread_rolled_back", num_turns: 1 },
			}),
		);
		cursor.beginEpoch(300);
		await appendFile(sourcePath, jsonl(codexMessage("Current turn", 400)));
		expect((await cursor.read()).text).toBe("Current turn");
	});

	it("does not commit an in-flight old epoch's cursor or preview", async () => {
		const { sourcePath, cursor } = await setup();
		await writeFile(sourcePath, jsonl(codexHeader(), codexMessage("Old turn message", 200)));
		const pending = cursor.read();
		cursor.beginEpoch(300);
		expect((await pending).text).toBeNull();
		await appendFile(sourcePath, jsonl(codexMessage("New turn message", 400)));
		expect((await cursor.read()).text).toBe("New turn message");
	});

	it("drains appends that arrive during a read without consuming them twice", async () => {
		const { sourcePath, cursor } = await setup();
		await writeFile(sourcePath, jsonl(codexHeader(), codexMessage("First snapshot")));
		const validate = fileValidation.validateOpenedContainedRegularFile;
		vi.spyOn(fileValidation, "validateOpenedContainedRegularFile").mockImplementationOnce(async (input) => {
			await appendFile(sourcePath, jsonl(codexMessage("Appended during read", 300), codexOutput(160 * 1024)));
			return await validate(input);
		});
		expect(await cursor.read()).toMatchObject({ text: "First snapshot", hasMore: true });
		expect(await cursor.read()).toMatchObject({ text: "Appended during read", hasMore: true });
		expect(await cursor.read()).toMatchObject({ text: "Appended during read", hasMore: false });
	});

	it("fences replacement during the very first read and skips its existing candidate", async () => {
		const { sourcePath, cursor } = await setup();
		await writeFile(sourcePath, jsonl(codexHeader(), codexMessage("Displaced snapshot")));
		const validate = fileValidation.validateOpenedContainedRegularFile;
		vi.spyOn(fileValidation, "validateOpenedContainedRegularFile").mockImplementationOnce(async (input) => {
			await writeFile(`${sourcePath}.new`, jsonl(codexHeader(), codexMessage("Replacement's preexisting message")));
			await rename(`${sourcePath}.new`, sourcePath);
			return await validate(input);
		});
		expect((await cursor.read()).text).toBeNull();
		expect((await cursor.read()).text).toBeNull();
		await appendFile(sourcePath, jsonl(codexMessage("Fresh after fenced replacement", 400)));
		expect((await cursor.read()).text).toBe("Fresh after fenced replacement");
	});

	it.each(["replace", "truncate", "pause-truncate"] as const)(
		"clears captured text and skips the existing snapshot after %s",
		async (change) => {
			const { sourcePath, cursor } = await setup();
			await writeFile(sourcePath, jsonl(codexHeader(), codexMessage("Captured commentary")));
			expect((await cursor.read()).text).toBe("Captured commentary");
			if (change === "replace") {
				await writeFile(`${sourcePath}.new`, jsonl(codexHeader(), codexMessage("Replacement's existing message")));
				await rename(`${sourcePath}.new`, sourcePath);
			} else {
				if (change === "pause-truncate") cursor.pause();
				await writeFile(
					sourcePath,
					jsonl(codexHeader(), codexMessage("Rewritten snapshot with a longer stale message")),
				);
			}
			expect((await cursor.read()).text).toBeNull();
			await appendFile(sourcePath, jsonl(codexMessage("Fresh after replacement", 500)));
			expect((await cursor.read()).text).toBe("Fresh after replacement");
		},
	);

	it("retries a provider file whose header is still being written", async () => {
		const { sourcePath, cursor } = await setup();
		await writeFile(sourcePath, '{"type":"session_meta","payload":');
		expect((await cursor.read()).text).toBeNull();
		await appendFile(
			sourcePath,
			`${JSON.stringify(codexHeader().payload)}}\n${jsonl(codexMessage("Header is complete"))}`,
		);
		expect((await cursor.read()).text).toBe("Header is complete");
	});

	it.each([
		codexHeader("another-session"),
		codexHeader("session-1", "future-mode"),
		{ type: "session_meta", payload: { id: "session-1", history_mode: 7 } },
	])("rejects mismatched or unsupported Codex headers", async (header) => {
		const { sourcePath, cursor } = await setup();
		await writeFile(sourcePath, jsonl(header, codexMessage("Must not surface")));
		expect((await cursor.read()).text).toBeNull();
	});

	it("clears opaque oversized/malformed records and suppresses previews after rollback until another epoch", async () => {
		const { sourcePath, cursor } = await setup(undefined, { maxRawRecordBytes: 512 });
		await writeFile(sourcePath, jsonl(codexHeader(), codexMessage("Safe commentary")));
		expect((await cursor.read()).text).toBe("Safe commentary");
		await appendFile(sourcePath, jsonl(codexOutput(1000)));
		expect((await cursor.read()).text).toBeNull();
		await appendFile(sourcePath, `not-json\n${jsonl(codexMessage("Safe after malformed record"))}`);
		expect((await cursor.read()).text).toBe("Safe after malformed record");
		await appendFile(
			sourcePath,
			jsonl(
				{ type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } },
				codexMessage("Cannot reconstruct rollback"),
			),
		);
		expect((await cursor.read()).text).toBeNull();
		cursor.beginEpoch(300);
		await appendFile(sourcePath, jsonl(codexMessage("Later epoch", 400)));
		expect((await cursor.read()).text).toBe("Later epoch");
	});

	it("never surfaces Claude sidechains and clears prior text on a detached foreground branch", async () => {
		const { sourcePath, cursor } = await setup("claude");
		await writeFile(sourcePath, jsonl(claudeMessage({ uuid: "main-1", parentUuid: null })));
		expect((await cursor.read()).text).toBe("Foreground message");
		await appendFile(
			sourcePath,
			jsonl(claudeMessage({ uuid: "side-1", parentUuid: "main-1", text: "Private sidechain", sidechain: true })),
		);
		expect((await cursor.read()).text).toBe("Foreground message");
		await appendFile(
			sourcePath,
			jsonl({ type: "progress", uuid: "detached", parentUuid: "older-branch", sessionId: "session-1" }),
		);
		expect((await cursor.read()).text).toBeNull();
		await appendFile(
			sourcePath,
			jsonl(claudeMessage({ uuid: "main-2", parentUuid: "detached", text: "New foreground branch" })),
		);
		expect((await cursor.read()).text).toBe("New foreground branch");
	});

	it("requires the exact hinted filename inside the approved provider root", async () => {
		const { temporary, sourcePath } = await setup();
		const root = join(temporary.path, "approved");
		await mkdir(root);
		await writeFile(sourcePath, jsonl(codexHeader(), codexMessage("Outside root")));
		const cursor = createConversationProgressCursor({
			hint: { providerId: "codex", providerSessionId: "session-1", sourcePath },
			since: 100,
			roots: { codex: [root], claude: [] },
		});
		expect(await cursor.read()).toMatchObject({ text: null, sourceBytesExamined: 0 });
	});
});
