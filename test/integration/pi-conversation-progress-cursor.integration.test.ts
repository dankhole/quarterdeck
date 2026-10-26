import { appendFile, mkdir, readFile, rename, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createConversationProgressCursor,
	PROGRESS_READ_LIMITS,
} from "../../src/conversation/conversation-progress-cursor";
import * as piProgressSource from "../../src/conversation/pi-progress-source";
import * as fileValidation from "../../src/fs/validated-file-open";
import { createTempDir } from "../utilities/temp-dir";

vi.mock("../../src/fs/validated-file-open", { spy: true });
const jsonl = (...records: unknown[]) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
const entry = (id: string, parentId: string | null, extra: Record<string, unknown> = {}, timestamp = 200) => ({
	type: "custom",
	id,
	parentId,
	timestamp: new Date(timestamp).toISOString(),
	...extra,
});
const message = (id: string, parentId: string | null, text: string, timestamp = 200) =>
	entry(
		id,
		parentId,
		{
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text }], timestamp, stopReason: "toolUse" },
		},
		timestamp,
	);

describe("bounded Pi progress cursor exact files", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		for (const cleanup of cleanups.splice(0)) await cleanup();
	});
	async function setup(limits?: Partial<typeof PROGRESS_READ_LIMITS>) {
		const temporary = createTempDir("pi-progress-");
		cleanups.push(temporary.cleanupAsync);
		const launchPath = join(temporary.path, "worktree");
		const storage = join(temporary.path, "overridden-pi-storage");
		await mkdir(launchPath);
		await mkdir(storage);
		// Intentionally not a provider UUID filename or under a default history root.
		const sourcePath = join(storage, "native-selected-history.jsonl");
		const hint = {
			providerId: "pi" as const,
			providerSessionId: "session-1",
			sessionInstanceId: "launch-1",
			sourcePath,
		};
		const input = { hint, sessionInstanceId: "launch-1", launchPath, since: 100, limits };
		const header = { type: "session", version: 3, id: "session-1", cwd: launchPath };
		await writeFile(sourcePath, jsonl(header));
		return { input, header, launchPath, sourcePath, storage, cursor: createConversationProgressCursor(input) };
	}
	async function drain(cursor: ReturnType<typeof createConversationProgressCursor>) {
		let result = await cursor.read();
		for (let pass = 0; result.hasMore && pass < 100; pass++) {
			expect(result.sourceBytesExamined).toBeLessThanOrEqual(PROGRESS_READ_LIMITS.maxSourceBytes);
			result = await cursor.read();
		}
		expect(result.hasMore).toBe(false);
		return result;
	}

	it("uses native storage overrides and only assistant text without changing source bytes", async () => {
		const f = await setup();
		const saved = jsonl(
			f.header,
			entry("u", null, { type: "message", message: { role: "user", content: "Prompt" } }),
			message("a", "u", "Working\n  carefully"),
			entry("t", "a", {
				type: "message",
				message: { role: "toolResult", content: [{ type: "text", text: "child reply" }] },
			}),
			entry("c", "t", { type: "custom_message", content: "subagent result", display: true }),
		);
		await writeFile(f.sourcePath, saved);
		expect(await f.cursor.read()).toMatchObject({ text: "Working\n  carefully", hasMore: false });
		expect(await readFile(f.sourcePath, "utf8")).toBe(saved);
	});
	it.each([
		{ sessionInstanceId: undefined },
		{ sessionInstanceId: "old-launch" },
		{ launchPath: undefined },
		{ launchPath: "relative" },
		{ since: Number.NaN },
	])("requires caller-owned current launch identity %j", async (override) => {
		const f = await setup();
		await appendFile(f.sourcePath, jsonl(message("a", null, "Must not read")));
		expect(await createConversationProgressCursor({ ...f.input, ...override }).read()).toEqual({
			text: null,
			hasMore: false,
			sourceBytesExamined: 0,
		});
	});
	it.each([
		{ id: "child-session" },
		{ version: 2 },
		{ version: 4 },
		{ cwd: "/foreign" },
		{ cwd: "relative" },
		{ type: "message" },
	])("rejects mismatched/unsupported header %j", async (override) => {
		const f = await setup();
		await writeFile(f.sourcePath, jsonl({ ...f.header, ...override }, message("a", null, "Must not surface")));
		expect((await f.cursor.read()).text).toBeNull();
	});
	it("never discovers another session when the exact hint is absent and rejects symlink escapes", async () => {
		const f = await setup();
		await appendFile(f.sourcePath, jsonl(message("a", null, "Another candidate")));
		const link = join(f.storage, "escape.jsonl");
		const outside = join(f.launchPath, "outside.jsonl");
		await writeFile(outside, jsonl(f.header, message("a", null, "Outside")));
		await symlink(outside, link);
		for (const sourcePath of [join(f.storage, "missing.jsonl"), link, f.storage, "relative.jsonl"]) {
			expect(
				(await createConversationProgressCursor({ ...f.input, hint: { ...f.input.hint, sourcePath } }).read()).text,
			).toBeNull();
		}
	});
	it("filters by saved-entry time rather than streaming-start message time", async () => {
		const f = await setup();
		await appendFile(f.sourcePath, jsonl(message("a", null, "Old entry", 99)));
		expect((await f.cursor.read()).text).toBeNull();
		await appendFile(
			f.sourcePath,
			jsonl({
				...message("b", "a", "Streaming began before Running", f.input.since + 2000),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Streaming began before Running" }],
					timestamp: f.input.since - 50,
				},
			}),
		);
		expect((await f.cursor.read()).text).toBe("Streaming began before Running");
		await appendFile(f.sourcePath, jsonl(message("c", "b", "Current", 100)));
		expect((await f.cursor.read()).text).toBe("Current");
		f.cursor.beginEpoch(300);
		expect((await f.cursor.read()).text).toBeNull();
		await appendFile(f.sourcePath, jsonl(message("d", "c", "Next epoch", 400)));
		expect((await f.cursor.read()).text).toBe("Next epoch");
	});
	it("keeps split UTF-8 private until the newline completes and caps preview length", async () => {
		const f = await setup({ chunkBytes: 11 });
		await f.cursor.read();
		const bytes = Buffer.from(jsonl(message("a", null, "😀".repeat(600))));
		const split = bytes.indexOf(Buffer.from("😀")) + 2;
		await appendFile(f.sourcePath, bytes.subarray(0, split));
		expect((await drain(f.cursor)).text).toBeNull();
		await appendFile(f.sourcePath, bytes.subarray(split));
		expect((await drain(f.cursor)).text).toHaveLength(500);
	});
	it.each(["branch_summary", "compaction", "parent_jump", "new_root", "duplicate", "malformed", "unknown"])(
		"clears stale text for %s without poisoning subsequent linear replies",
		async (kind) => {
			const f = await setup();
			await appendFile(f.sourcePath, jsonl(message("a", null, "Safe")));
			expect((await f.cursor.read()).text).toBe("Safe");
			const bad =
				kind === "malformed"
					? "bad-json\n"
					: jsonl(
							kind === "parent_jump"
								? entry("b", "unseen")
								: kind === "new_root"
									? entry("b", null)
									: kind === "duplicate"
										? entry("a", "other")
										: entry("b", "a", { type: kind }),
						);
			await appendFile(f.sourcePath, bad);
			expect((await f.cursor.read()).text).toBeNull();
			await appendFile(
				f.sourcePath,
				jsonl(
					message(
						"c",
						kind === "duplicate" || kind === "malformed" || kind === "unknown" ? "a" : "b",
						"Fresh linear reply",
					),
				),
			);
			expect((await f.cursor.read()).text).toBe("Fresh linear reply");
			await appendFile(f.sourcePath, jsonl(message("d", "c", "Same running epoch", 400)));
			expect((await f.cursor.read()).text).toBe("Same running epoch");
		},
	);
	it("uses a newly appended assistant as the active leaf even when it starts another branch", async () => {
		const f = await setup();
		await appendFile(f.sourcePath, jsonl(message("a", null, "Abandoned reply")));
		expect((await f.cursor.read()).text).toBe("Abandoned reply");
		await appendFile(f.sourcePath, jsonl(message("b", null, "New root reply")));
		expect((await f.cursor.read()).text).toBe("New root reply");
		await appendFile(f.sourcePath, jsonl(message("c", "a", "Reply on an earlier branch")));
		expect((await f.cursor.read()).text).toBe("Reply on an earlier branch");
	});
	it.each(["error", "aborted"])("clears %s response text and accepts a later successful retry", async (stopReason) => {
		const f = await setup();
		await appendFile(f.sourcePath, jsonl(message("a", null, "Previous commentary")));
		expect((await f.cursor.read()).text).toBe("Previous commentary");
		await appendFile(
			f.sourcePath,
			jsonl({
				...message("b", "a", "Do not expose failure"),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Do not expose failure" }],
					timestamp: 200,
					stopReason,
				},
			}),
		);
		expect((await f.cursor.read()).text).toBeNull();
		await appendFile(f.sourcePath, jsonl(message("c", "b", "Successful retry")));
		expect((await f.cursor.read()).text).toBe("Successful retry");
	});
	it.each([null, { content: "Replacement is not a newly persisted assistant reply" }])(
		"clears a context-edited preview for %j and accepts later replies",
		async (replacement) => {
			const f = await setup();
			await appendFile(f.sourcePath, jsonl(message("a", null, "Invalidated assistant text")));
			expect((await f.cursor.read()).text).toBe("Invalidated assistant text");
			await appendFile(
				f.sourcePath,
				jsonl(entry("edit", "a", { type: "context_edit", targetId: "a", replacement })),
			);
			expect((await f.cursor.read()).text).toBeNull();
			await appendFile(f.sourcePath, jsonl(message("b", "edit", "Later retry")));
			expect((await f.cursor.read()).text).toBe("Later retry");
		},
	);
	it("retains the current preview when a context edit targets another entry", async () => {
		const f = await setup();
		await appendFile(
			f.sourcePath,
			jsonl(
				message("a", null, "Current assistant text"),
				entry("edit", "a", { type: "context_edit", targetId: "earlier-entry", replacement: null }),
			),
		);
		expect((await f.cursor.read()).text).toBe("Current assistant text");
	});
	it("does not let known historical branch boundaries suppress a fresh linear reply", async () => {
		const f = await setup();
		await appendFile(
			f.sourcePath,
			jsonl(
				message("a", null, "Old branch", 50),
				entry("b", null, { type: "branch_summary" }, 60),
				message("c", "b", "Current"),
			),
		);
		expect((await f.cursor.read()).text).toBe("Current");
	});
	it("caps source I/O while bootstrapping multi-MiB history and draining oversized tools", async () => {
		const f = await setup();
		const old = Array.from({ length: 100 }, (_, i) =>
			entry(`old${i}`, i ? `old${i - 1}` : null, { data: "x".repeat(32 * 1024) }, 50),
		);
		await appendFile(f.sourcePath, jsonl(...old));
		expect((await drain(f.cursor)).text).toBeNull();
		await appendFile(
			f.sourcePath,
			jsonl(
				message("a", "old99", "Fresh"),
				entry("tool", "a", { type: "message", message: { role: "toolResult", content: "x".repeat(300 * 1024) } }),
			),
		);
		expect(await f.cursor.read()).toMatchObject({ text: "Fresh", hasMore: true });
		expect((await drain(f.cursor)).text).toBe("Fresh");
	});
	it("recovers in the same epoch after a tool result over the 1 MiB raw record cap", async () => {
		const f = await setup();
		await appendFile(f.sourcePath, jsonl(message("a", null, "Before noisy tool")));
		expect((await f.cursor.read()).text).toBe("Before noisy tool");
		await appendFile(
			f.sourcePath,
			jsonl(
				entry("tool", "a", {
					type: "message",
					message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(2 * 1024 * 1024) }] },
				}),
				message("b", "tool", "Fresh after large tool"),
			),
		);
		expect((await drain(f.cursor)).text).toBe("Fresh after large tool");
	});
	it("respects per-read record budgets without replaying records", async () => {
		const f = await setup({ maxRecords: 1 });
		await appendFile(f.sourcePath, jsonl(message("a", null, "First"), message("b", "a", "Second")));
		expect(await f.cursor.read()).toMatchObject({ text: null, hasMore: true });
		expect(await f.cursor.read()).toMatchObject({ text: "First", hasMore: true });
		expect(await f.cursor.read()).toMatchObject({ text: "Second", hasMore: false });
		expect((await f.cursor.read()).text).toBe("Second");
	});
	it("omits over-cap assistant text and recovers after oversized opaque records", async () => {
		const f = await setup({ maxRawRecordBytes: 40 * 1024 });
		await appendFile(f.sourcePath, jsonl(message("a", null, "x".repeat(33 * 1024))));
		expect((await f.cursor.read()).text).toBeNull();
		await appendFile(f.sourcePath, jsonl(message("b", "a", "Safe")));
		expect((await f.cursor.read()).text).toBe("Safe");
		await appendFile(
			f.sourcePath,
			jsonl(entry("c", "b", { data: "x".repeat(64 * 1024) }), message("d", "c", "Fresh after opaque record")),
		);
		expect((await drain(f.cursor)).text).toBe("Fresh after opaque record");
	});
	it.each(["replace", "truncate", "header", "preview"])(
		"fences %s mutation and skips its existing snapshot",
		async (change) => {
			const f = await setup();
			const original = jsonl(
				f.header,
				message("a", null, "Captured"),
				entry("tail", "a", { data: "x".repeat(200) }),
			);
			await writeFile(f.sourcePath, original);
			expect((await f.cursor.read()).text).toBe("Captured");
			if (change === "replace") {
				await writeFile(`${f.sourcePath}.new`, jsonl(f.header, message("other", null, "Existing replacement")));
				await rename(`${f.sourcePath}.new`, f.sourcePath);
			} else if (change === "truncate") {
				await truncate(f.sourcePath, Buffer.byteLength(jsonl(f.header)));
			} else if (change === "header") {
				await writeFile(f.sourcePath, original.replace('"version":3', '"version":4'));
			} else await writeFile(f.sourcePath, original.replace("Captured", "Replaced"));
			expect((await f.cursor.read()).text).toBeNull();
			if (change !== "header") {
				await appendFile(f.sourcePath, jsonl(message("fresh", "unretained-parent", "Fresh after fence", 400)));
				expect((await f.cursor.read()).text).toBe("Fresh after fence");
			}
		},
	);
	it("rejects a preview mutated while the final source validation runs", async () => {
		const f = await setup();
		await appendFile(f.sourcePath, jsonl(message("a", null, "Original")));
		const validate = fileValidation.validateOpenedContainedRegularFile;
		vi.spyOn(fileValidation, "validateOpenedContainedRegularFile").mockImplementationOnce(async (input) => {
			await writeFile(f.sourcePath, jsonl(f.header, message("a", null, "Mutation")));
			return await validate(input);
		});
		expect((await f.cursor.read()).text).toBeNull();
		expect((await f.cursor.read()).text).toBeNull();
	});
	it("retries an incomplete header without loading or rewriting history", async () => {
		const f = await setup();
		const header = jsonl(f.header);
		await writeFile(f.sourcePath, header.slice(0, 20));
		expect((await f.cursor.read()).text).toBeNull();
		await appendFile(f.sourcePath, header.slice(20) + jsonl(message("a", null, "Header completed")));
		expect((await f.cursor.read()).text).toBe("Header completed");
	});
	it("fences path replacement during the first read and skips preexisting replacement text", async () => {
		const f = await setup();
		await appendFile(f.sourcePath, jsonl(message("a", null, "Original")));
		const validate = fileValidation.validateOpenedContainedRegularFile;
		vi.spyOn(fileValidation, "validateOpenedContainedRegularFile").mockImplementationOnce(async (input) => {
			await writeFile(`${f.sourcePath}.new`, jsonl(f.header, message("b", null, "Replacement")));
			await rename(f.sourcePath, `${f.sourcePath}.old`);
			await rename(`${f.sourcePath}.new`, f.sourcePath);
			return await validate(input);
		});
		expect((await f.cursor.read()).text).toBeNull();
		expect((await f.cursor.read()).text).toBeNull();
		await appendFile(f.sourcePath, jsonl(message("c", "b", "Fresh after replacement", 400)));
		expect((await f.cursor.read()).text).toBe("Fresh after replacement");
	});
	it("drains appends arriving during final validation without treating them as replacement", async () => {
		const f = await setup();
		await appendFile(f.sourcePath, jsonl(message("a", null, "First")));
		const validate = fileValidation.validateOpenedContainedRegularFile;
		vi.spyOn(fileValidation, "validateOpenedContainedRegularFile").mockImplementationOnce(async (input) => {
			await appendFile(f.sourcePath, jsonl(message("b", "a", "Appended", 400)));
			return await validate(input);
		});
		expect(await f.cursor.read()).toMatchObject({ text: "First", hasMore: true });
		expect(await f.cursor.read()).toMatchObject({ text: "Appended", hasMore: false });
	});
	it("does not commit an in-flight prior epoch", async () => {
		const f = await setup();
		await appendFile(f.sourcePath, jsonl(message("a", null, "Old epoch")));
		const pending = f.cursor.read();
		f.cursor.beginEpoch(300);
		expect((await pending).text).toBeNull();
		await appendFile(f.sourcePath, jsonl(message("b", "a", "Current", 400)));
		expect((await f.cursor.read()).text).toBe("Current");
	});
	it("fails closed within the source budget for a huge header", async () => {
		const f = await setup();
		await writeFile(f.sourcePath, jsonl({ ...f.header, extra: "x".repeat(64 * 1024) }, message("a", null, "No")));
		const result = await f.cursor.read();
		expect(result.text).toBeNull();
		expect(result.sourceBytesExamined).toBeLessThanOrEqual(PROGRESS_READ_LIMITS.maxSourceBytes);
	});
	it("counts actual read requests within a reduced byte budget, including guards", async () => {
		const f = await setup({ maxSourceBytes: 8 * 1024, chunkBytes: 2048, maxRecords: 5 });
		await f.cursor.read();
		const openSource = piProgressSource.openPiProgressSource;
		const requestedPerRead: Array<() => number> = [];
		vi.spyOn(piProgressSource, "openPiProgressSource").mockImplementation(async (hint) => {
			const source = await openSource(hint);
			if (source) {
				const read = vi.spyOn(source.fileHandle, "read");
				requestedPerRead.push(() =>
					read.mock.calls.reduce(
						(total, args: readonly unknown[]) => total + (typeof args[2] === "number" ? args[2] : 0),
						0,
					),
				);
			}
			return source;
		});
		await appendFile(
			f.sourcePath,
			jsonl(message("a", null, "x".repeat(1500)), entry("tool", "a", { data: "x".repeat(64 * 1024) })),
		);
		for (let pass = 0; pass < 40; pass++) {
			const result = await f.cursor.read();
			const requested = requestedPerRead.at(-1)?.();
			expect(requested).toBe(result.sourceBytesExamined);
			expect(requested).toBeLessThanOrEqual(8 * 1024);
			if (!result.hasMore) break;
		}
	});
	it("fences same-size edits outside the header, preview, and cursor anchor", async () => {
		const f = await setup();
		const saved = jsonl(f.header, message("a", null, "Safe"), entry("metadata", "a", { data: "x".repeat(500) }));
		await writeFile(f.sourcePath, saved);
		expect((await f.cursor.read()).text).toBe("Safe");
		await writeFile(f.sourcePath, saved.replace('"parentId":"a","timestamp"', '"parentId":"z","timestamp"'));
		expect((await f.cursor.read()).text).toBeNull();
	});
	it("rolls bounded duplicate detection forward without disabling a long running epoch", async () => {
		const f = await setup();
		await f.cursor.read();
		await appendFile(
			f.sourcePath,
			jsonl(
				...Array.from({ length: 4097 }, (_, i) => entry(`e${i}`, i ? `e${i - 1}` : null)),
				message("a", "e4096", "Still within the running epoch"),
			),
		);
		expect((await drain(f.cursor)).text).toBe("Still within the running epoch");
		await appendFile(f.sourcePath, jsonl(message("b", "a", "Another reply in the same epoch", 400)));
		expect((await f.cursor.read()).text).toBe("Another reply in the same epoch");
	});
	it("does not read source bytes after its deadline has already elapsed", async () => {
		const f = await setup({ deadlineMs: -1 });
		expect(await f.cursor.read()).toEqual({ text: null, hasMore: false, sourceBytesExamined: 0 });
		expect((await stat(f.sourcePath)).size).toBeGreaterThan(0);
	});
});
