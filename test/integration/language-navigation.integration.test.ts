import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeNavigationRequest, LspServerConfig } from "../../src/core/api/code-navigation";
import { LanguageNavigationManager } from "../../src/language-navigation/manager";
import { mapNavigationLocations, resolveLanguageRoot } from "../../src/language-navigation/paths";
import * as workdirFiles from "../../src/workdir/read-workdir-file";

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "../utilities/fake-language-server.mjs");
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("language navigation process and filesystem ownership", () => {
	let directory: string;
	let root: string;
	let events: string;
	let manager: LanguageNavigationManager;
	let server: LspServerConfig;
	const input: CodeNavigationRequest = {
		path: "source.ts",
		documentVersion: 1,
		content: "// unsaved\nconst target = 1;",
		position: { line: 1, character: 6 },
	};
	const config = () => ({ codeNavigationEnabled: true, lspServers: [server] });
	const scope = () => ({ projectId: "synthetic", cwd: root });
	const readEvents = async (): Promise<Array<Record<string, unknown>>> => {
		try {
			return (await readFile(events, "utf8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
		} catch {
			return [];
		}
	};

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "quarterdeck-lsp-"));
		root = join(directory, "project");
		await mkdir(root);
		await writeFile(join(root, "source.ts"), "const target = 0;");
		events = join(directory, "events.jsonl");
		server = {
			id: "fake",
			label: "Fake",
			enabled: true,
			command: process.execPath,
			args: [fixture],
			extensions: [".ts"],
			rootMarkers: ["package.json"],
			env: { LSP_TEST_EVENTS: events },
		};
		manager = new LanguageNavigationManager();
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await manager.close();
		await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	});

	it("starts lazily, serializes authoritative unsaved buffers, and closes each document", async () => {
		expect((await manager.status(config(), input.path)).status).toBe("ready");
		expect(manager.getSnapshot().processCount).toBe(0);
		server.env = { ...server.env, LSP_TEST_DELAY: "25" };
		const [first, second] = await Promise.all([
			manager.navigate("definition", scope(), config(), input),
			manager.navigate("references", scope(), config(), {
				...input,
				documentVersion: 0,
				content: "target",
				position: { line: 0, character: 0 },
			}),
		]);
		expect(first).toMatchObject({
			status: "ok",
			documentVersion: 1,
			locations: [{ path: "source.ts", range: { start: { line: 1 } } }],
		});
		expect(second).toMatchObject({
			status: "ok",
			documentVersion: 0,
			locations: [{ range: { start: { line: 0 } } }],
		});
		await manager.close();
		const recorded = await readEvents();
		expect(recorded.filter((event) => event.event === "initialize")).toHaveLength(1);
		expect(recorded.filter((event) => event.event === "open").map((event) => event.version)).toEqual([1, 2]);
		expect(
			recorded
				.filter((event) => event.event === "open")
				.map((event) => event.content)
				.sort(),
		).toEqual([input.content, "target"].sort());
		expect(
			recorded.filter((event) => event.event === "open" || event.event === "close").map((event) => event.event),
		).toEqual(["open", "close", "open", "close"]);
		expect(recorded.filter((event) => event.event === "close")).toHaveLength(2);
		expect(await readFile(join(root, "source.ts"), "utf8")).toBe("const target = 0;");
	});

	it.each(["", "x", "\0"])("checks only bytes read after a file shrinks to %j", async (content) => {
		const openWorkdirFile = workdirFiles.openWorkdirFile;
		vi.spyOn(workdirFiles, "openWorkdirFile").mockImplementationOnce(async (worktreePath, relativePath) => {
			const opened = await openWorkdirFile(worktreePath, relativePath);
			await writeFile(opened.absolutePath, content);
			return opened;
		});

		const response = await manager.navigate("definition", scope(), config(), input);
		if (content.includes("\0")) {
			expect(response).toMatchObject({
				status: "unavailable",
				message: "Binary files do not support code navigation.",
			});
			expect(manager.getSnapshot().processCount).toBe(0);
		} else {
			expect(response).toMatchObject({ status: "ok", documentVersion: input.documentVersion });
			expect((await readEvents()).find((event) => event.event === "open")?.content).toBe(input.content);
		}
	});

	it("finds the nearest root marker inside the live scope and filters escaped results", async () => {
		const nested = join(root, "package", "src");
		await mkdir(nested, { recursive: true });
		await writeFile(join(root, "package", "package.json"), "{}");
		await writeFile(join(directory, "package.json"), "{}");
		expect(await resolveLanguageRoot(root, join(nested, "x.ts"), ["package.json"])).toBe(join(root, "package"));
		expect(await resolveLanguageRoot(root, join(root, "source.ts"), ["package.json"])).toBe(root);
		const outside = join(directory, "outside.ts");
		await writeFile(outside, "private");
		await symlink(outside, join(root, "escape.ts"));
		const goodUri = pathToFileURL(join(root, "source.ts")).href;
		const mapped = await mapNavigationLocations(root, [
			{ uri: pathToFileURL(outside).href, range },
			{ uri: pathToFileURL(join(root, "escape.ts")).href, range },
			{ uri: "https://example.com/outside", range },
			{ targetUri: goodUri, targetRange: range, targetSelectionRange: range },
			{ uri: goodUri, range },
		]);
		expect(mapped).toEqual({ locations: [{ path: "source.ts", range }], truncated: false });
	});

	it("rejects invalid paths, missing commands, disabled config, and oversized content without spawning", async () => {
		expect(
			(await manager.navigate("definition", scope(), { ...config(), codeNavigationEnabled: false }, input)).status,
		).toBe("unavailable");
		expect(
			(await manager.navigate("definition", scope(), config(), { ...input, path: "../outside.ts" })).status,
		).toBe("error");
		expect(
			(await manager.navigate("definition", scope(), config(), { ...input, content: "é".repeat(2_621_441) })).status,
		).toBe("unavailable");
		server.command = join(directory, "does-not-exist");
		expect((await manager.navigate("definition", scope(), config(), input)).status).toBe("unavailable");
		expect(manager.getSnapshot().processCount).toBe(0);
		expect(await readEvents()).toEqual([]);
	});

	it("reaps timed out servers and their descendants", async () => {
		await manager.close();
		manager = new LanguageNavigationManager({ requestTimeoutMs: process.platform === "win32" ? 5_000 : 800 });
		server.env = { ...server.env, LSP_TEST_HANG: "1", LSP_TEST_CHILD: "1" };
		expect(await manager.navigate("definition", scope(), config(), input)).toMatchObject({
			status: "error",
			message: expect.stringContaining("timed out"),
		});
		await manager.close();
		const recorded = await readEvents();
		const child = recorded.find((event) => event.event === "child");
		expect(child).toBeDefined();
		await expect.poll(() => processExists(Number(child?.pid))).toBe(false);
		await expect.poll(() => processExists(Number(child?.childPid))).toBe(false);
	});

	it("reaps workers when the language server exits before initialization completes", async () => {
		server.env = { ...server.env, LSP_TEST_CHILD: "1", LSP_TEST_EXIT_INITIALIZE: "1" };
		expect((await manager.navigate("definition", scope(), config(), input)).status).toBe("error");
		const child = (await readEvents()).find((event) => event.event === "child");
		expect(child).toBeDefined();
		await expect.poll(() => processExists(Number(child?.pid))).toBe(false);
		await expect.poll(() => processExists(Number(child?.childPid))).toBe(false);
		await expect.poll(() => manager.getSnapshot().processCount).toBe(0);
	});

	it.each(["LSP_TEST_EXIT_INITIALIZE", "LSP_TEST_FLOOD"])(
		"reaps %s failures even when the protocol connection has already closed",
		async (flag) => {
			server.env = { ...server.env, [flag]: "1" };
			expect((await manager.navigate("definition", scope(), config(), input)).status).toBe("error");
			await manager.close();
			const recorded = await readEvents();
			expect(recorded[0]?.pid).toEqual(expect.any(Number));
			expect(processExists(Number(recorded[0]?.pid))).toBe(false);
			expect(manager.getSnapshot().processCount).toBe(0);
		},
	);

	it("keeps stopping owners tracked so runtime close waits for overlapping project cleanup", async () => {
		server.env = { ...server.env, LSP_TEST_SLOW_SHUTDOWN: "200" };
		expect((await manager.navigate("definition", scope(), config(), input)).status).toBe("ok");
		const recorded = await readEvents();
		const pid = Number(recorded[0]?.pid);
		const stopped = manager.stopProject(scope().projectId);
		expect(manager.getSnapshot().processCount).toBe(1);
		await manager.close();
		await stopped;
		expect(processExists(pid)).toBe(false);
		expect(manager.getSnapshot().processCount).toBe(0);
	});

	it("fences removed projects and pre-reset requests, and supports explicitly re-added projects", async () => {
		const oldGeneration = manager.generation;
		await manager.stopProject(scope().projectId);
		expect((await manager.navigate("definition", scope(), config(), input)).status).toBe("unavailable");
		manager.restoreProject(scope().projectId);
		expect((await manager.navigate("definition", scope(), config(), input, oldGeneration)).status).toBe("error");
		expect((await manager.navigate("definition", scope(), config(), input)).status).toBe("ok");
	});

	it("shuts down idle processes and caps project processes by resolved language root", async () => {
		await manager.close();
		manager = new LanguageNavigationManager({ idleTimeoutMs: 100 });
		expect((await manager.navigate("definition", scope(), config(), input)).status).toBe("ok");
		await expect.poll(() => manager.getSnapshot().processCount, { timeout: 3000 }).toBe(0);
		await manager.close();
		manager = new LanguageNavigationManager();
		for (let index = 0; index < 4; index++) {
			const path = `package-${index}`;
			await mkdir(join(root, path));
			await writeFile(join(root, path, "package.json"), "{}");
			await writeFile(join(root, path, "source.ts"), "target");
			const response = await manager.navigate("definition", scope(), config(), {
				...input,
				path: `${path}/source.ts`,
			});
			expect(response.status).toBe(index < 3 ? "ok" : "unavailable");
		}
		expect(manager.getSnapshot().processCount).toBe(3);
	});
});
