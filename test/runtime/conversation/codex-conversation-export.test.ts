import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { exportCodexConversation } from "../../../src/conversation/codex-conversation-export";
import type { OwnedCodexAppServerTransport } from "../../../src/execution/codex-app-server-client";

const input = {
	binary: "codex",
	args: [],
	cwd: resolve("/tmp/project"),
	env: {},
	threadId: "thread-1",
	codexHome: resolve("/tmp/profile"),
};
const turn = (id: string, text: string) => ({ id, items: [{ id: `${id}-message`, type: "agentMessage", text }] });

function fixture(pages: unknown[], threadId = input.threadId, codexHome = input.codexHome) {
	const listeners = new Set<(message: unknown) => void>();
	const requests: { id?: number; method: string; params?: unknown }[] = [];
	const stop = vi.fn(async () => {});
	const transport: OwnedCodexAppServerTransport = {
		pid: 123,
		write(message) {
			const request = message as (typeof requests)[number];
			requests.push(request);
			if (request.id === undefined) return;
			queueMicrotask(() => {
				const result =
					request.method === "initialize"
						? { userAgent: "fake", codexHome, platformFamily: "unix", platformOs: "linux" }
						: request.method === "thread/read"
							? { thread: { id: threadId, sessionId: "shared-session-tree" } }
							: pages.shift();
				for (const listener of listeners) listener({ id: request.id, result });
			});
		},
		onMessage(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		onExit: () => () => {},
		requestStop: vi.fn(),
		waitForExit: async () => true,
		stopAndReap: stop,
	};
	const spawnTransport = vi.fn(() => transport);
	return { requests, stop, spawnTransport };
}

describe("full Codex conversation export", () => {
	it("accepts a terminal page with the optional cursor omitted", async () => {
		const f = fixture([{ data: [turn("one", "saved reply")] }]);
		await expect(exportCodexConversation(input, f)).resolves.toBe("## Codex\n\nsaved reply\n");
		expect(f.stop).toHaveBeenCalledOnce();
	});

	it.skipIf(process.platform === "win32")(
		"accepts a canonicalized profile path pointing to the same directory",
		async () => {
			const directory = await mkdtemp(join(tmpdir(), "codex-copy-profile-"));
			const alias = `${directory}-alias`;
			try {
				await symlink(directory, alias);
				const f = fixture(
					[{ data: [turn("one", "saved reply")], nextCursor: null }],
					input.threadId,
					await realpath(directory),
				);
				await expect(exportCodexConversation({ ...input, codexHome: alias }, f)).resolves.toContain("saved reply");
				expect(f.stop).toHaveBeenCalledOnce();
			} finally {
				await rm(alias, { force: true });
				await rm(directory, { recursive: true, force: true });
			}
		},
	);

	it("reads every page in order, preserves messages and plans, and never resumes the thread", async () => {
		const f = fixture([
			{ data: [turn("latest", "Final reply"), turn("middle", "Progress")], nextCursor: "older" },
			{
				data: [
					{
						id: "first",
						itemsView: "full",
						items: [
							{
								id: "u",
								type: "userMessage",
								content: [
									{ type: "text", text: "First prompt" },
									{ type: "localImage", path: "/tmp/image.png" },
								],
							},
							{ id: "p", type: "plan", text: "1. Investigate" },
							{ id: "tool", type: "commandExecution", aggregatedOutput: "Excluded tool output" },
							{ id: "c", type: "contextCompaction" },
						],
					},
				],
				nextCursor: null,
			},
		]);
		await expect(exportCodexConversation(input, f)).resolves.toBe(
			"## You\n\nFirst prompt\n[Image: /tmp/image.png]\n\n## Codex — Plan\n\n1. Investigate\n\n[Context compacted]\n\n## Codex\n\nProgress\n\n## Codex\n\nFinal reply\n",
		);
		expect(f.requests.map(({ method }) => method)).toEqual([
			"initialize",
			"initialized",
			"thread/read",
			"thread/turns/list",
			"thread/turns/list",
		]);
		expect(f.requests[2]?.params).toEqual({ threadId: "thread-1", includeTurns: false });
		expect(f.requests[4]?.params).toEqual({
			threadId: "thread-1",
			cursor: "older",
			limit: 10,
			sortDirection: "desc",
			itemsView: "full",
		});
		expect(f.spawnTransport).toHaveBeenCalledWith(
			expect.objectContaining({ args: ["app-server", "--stdio"], env: { CODEX_HOME: input.codexHome } }),
		);
		expect(f.stop).toHaveBeenCalledOnce();
	});

	it.each([
		["profile", "thread-1", resolve("/tmp/wrong")],
		["conversation", "wrong-thread", input.codexHome],
	])("rejects the wrong %s and reaps the process", async (_name, threadId, codexHome) => {
		const f = fixture([], threadId, codexHome);
		await expect(exportCodexConversation(input, f)).rejects.toThrow("different");
		expect(f.requests.some(({ method }) => method === "thread/turns/list")).toBe(false);
		expect(f.stop).toHaveBeenCalledOnce();
	});

	it.each([
		[
			{ data: [], nextCursor: "loop" },
			{ data: [], nextCursor: "loop" },
		],
		[
			{ data: [turn("duplicate", "text")], nextCursor: "next" },
			{ data: [turn("duplicate", "text")], nextCursor: null },
		],
		[{ data: [{ ...turn("summary", "text"), itemsView: "summary" }], nextCursor: null }],
		[{ data: [turn("too-large", "a".repeat(8 * 1024 * 1024))], nextCursor: null }],
		[{ data: [], nextCursor: null }],
	])(
		"rejects incomplete, repeated, oversized, or empty history without returning a partial transcript",
		async (...pages) => {
			const f = fixture(pages);
			await expect(exportCodexConversation(input, f)).rejects.toThrow();
			expect(f.stop).toHaveBeenCalledOnce();
		},
	);

	it("stops when the read deadline expires", async () => {
		const f = fixture([{ data: [turn("one", "text")], nextCursor: "next" }]);
		const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(30_000);
		await expect(exportCodexConversation(input, { ...f, now })).rejects.toThrow("too long");
		expect(f.stop).toHaveBeenCalledOnce();
	});
});
