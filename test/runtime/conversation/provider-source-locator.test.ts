import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONVERSATION_READ_LIMITS } from "../../../src/conversation/index.js";
import { ProviderConversationSourceLocator } from "../../../src/conversation/provider-source-locator.js";
import { createTempDir } from "../../utilities/temp-dir.js";

const SESSION_ID = "session-123";

describe("ProviderConversationSourceLocator", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});

	async function createRoots() {
		const temporary = createTempDir("conversation-source-locator-");
		cleanups.push(temporary.cleanup);
		const allowedRoot = join(temporary.path, "allowed");
		const outsideRoot = join(temporary.path, "outside");
		await Promise.all([mkdir(allowedRoot), mkdir(outsideRoot)]);
		return { allowedRoot, outsideRoot };
	}

	function locate(
		locator: ProviderConversationSourceLocator,
		hint: { providerId: "claude"; providerSessionId: string; sourcePath: string } | null = null,
	) {
		return locator.locate({
			projectId: "project-1",
			taskId: "task-1",
			providerSessionId: SESSION_ID,
			deadlineAt: Date.now() + 2_000,
			hint,
		});
	}

	it("opens a regular exact-session source inside an approved canonical root", async () => {
		const { allowedRoot } = await createRoots();
		const sourcePath = join(allowedRoot, "project", `${SESSION_ID}.jsonl`);
		await mkdir(join(allowedRoot, "project"));
		await writeFile(sourcePath, "{}\n", "utf8");
		const locator = new ProviderConversationSourceLocator("claude", [allowedRoot], DEFAULT_CONVERSATION_READ_LIMITS);
		const result = await locate(locator);
		expect(result).toMatchObject({ status: "available" });
		if (result.status === "available") {
			expect(result.source.canonicalPath).toBe(await realpath(sourcePath));
			await result.source.fileHandle.close();
		}
	});

	it("treats a hook transcript path as a validated hint and avoids directory traversal when it is valid", async () => {
		const { allowedRoot } = await createRoots();
		const sourcePath = join(allowedRoot, "project", `${SESSION_ID}.jsonl`);
		await mkdir(join(allowedRoot, "project"));
		await writeFile(sourcePath, "{}\n", "utf8");
		const locator = new ProviderConversationSourceLocator("claude", [allowedRoot], DEFAULT_CONVERSATION_READ_LIMITS);
		const result = await locate(locator, {
			providerId: "claude",
			providerSessionId: SESSION_ID,
			sourcePath,
		});
		expect(result).toMatchObject({ status: "available", accounting: { lookupEntriesExamined: 0 } });
		if (result.status === "available") await result.source.fileHandle.close();
	});

	it("rejects dot-dot traversal outside the provider root", async () => {
		const { allowedRoot, outsideRoot } = await createRoots();
		const outsidePath = join(outsideRoot, `${SESSION_ID}.jsonl`);
		await writeFile(outsidePath, "{}\n", "utf8");
		const locator = new ProviderConversationSourceLocator("claude", [allowedRoot], DEFAULT_CONVERSATION_READ_LIMITS);
		const result = await locate(locator, {
			providerId: "claude",
			providerSessionId: SESSION_ID,
			sourcePath: join(allowedRoot, "..", "outside", `${SESSION_ID}.jsonl`),
		});
		expect(result).toEqual({
			status: "invalid_source",
			reason: "source_outside_allowed_roots",
			accounting: expect.objectContaining({ lookupEntriesExamined: 0 }),
		});
	});

	it("rejects a symlink whose canonical target escapes the approved root", async () => {
		const { allowedRoot, outsideRoot } = await createRoots();
		const outsidePath = join(outsideRoot, `${SESSION_ID}.jsonl`);
		const linkedPath = join(allowedRoot, `${SESSION_ID}.jsonl`);
		await writeFile(outsidePath, "{}\n", "utf8");
		await symlink(outsidePath, linkedPath);
		const locator = new ProviderConversationSourceLocator("claude", [allowedRoot], DEFAULT_CONVERSATION_READ_LIMITS);
		const result = await locate(locator);
		expect(result).toMatchObject({ status: "invalid_source", reason: "source_outside_allowed_roots" });
		expect(JSON.stringify(result)).not.toContain(outsidePath);
	});

	it("rejects a matching directory because provider sources must be regular files", async () => {
		const { allowedRoot } = await createRoots();
		const directoryPath = join(allowedRoot, `${SESSION_ID}.jsonl`);
		await mkdir(directoryPath);
		const locator = new ProviderConversationSourceLocator("claude", [allowedRoot], DEFAULT_CONVERSATION_READ_LIMITS);
		const result = await locate(locator, {
			providerId: "claude",
			providerSessionId: SESSION_ID,
			sourcePath: directoryPath,
		});
		expect(result).toMatchObject({ status: "invalid_source", reason: "source_not_regular_file" });
	});

	it("stops source discovery at the directory-entry bound", async () => {
		const { allowedRoot } = await createRoots();
		await Promise.all(
			Array.from({ length: 10 }, (_, index) => writeFile(join(allowedRoot, `unrelated-${index}.jsonl`), "{}\n")),
		);
		const locator = new ProviderConversationSourceLocator("claude", [allowedRoot], {
			...DEFAULT_CONVERSATION_READ_LIMITS,
			maxLookupEntries: 3,
		});
		await expect(locate(locator)).resolves.toMatchObject({
			status: "unavailable",
			reason: "source_lookup_limit",
			accounting: { lookupEntriesExamined: 3 },
		});
	});
});
