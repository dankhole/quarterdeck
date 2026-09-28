import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LspServerConfig } from "../../src/core/api/code-navigation";
import type { RuntimeDiagnostics } from "../../src/diagnostics";
import { LanguageNavigationManager } from "../../src/language-navigation/manager";

describe("language navigation failure diagnostics", () => {
	let root: string;
	let manager: LanguageNavigationManager;
	let server: LspServerConfig;
	const recordEvent = vi.fn<RuntimeDiagnostics["recordEvent"]>();
	const input = {
		path: "source.ts",
		documentVersion: 1,
		content: "const PRIVATE_DOCUMENT_CONTENT = 1;",
		position: { line: 0, character: 6 },
	};
	const config = () => ({ codeNavigationEnabled: true, lspServers: [server] });
	const scope = () => ({ projectId: "synthetic", cwd: root });

	beforeEach(async () => {
		recordEvent.mockClear();
		root = await mkdtemp(join(tmpdir(), "quarterdeck-lsp-diagnostics-"));
		await writeFile(join(root, input.path), input.content);
		server = {
			id: "fake-diagnostics",
			label: "Private server label",
			enabled: true,
			command: process.execPath,
			args: [resolve("test/utilities/fake-language-server.mjs")],
			extensions: [".ts"],
			rootMarkers: [],
			env: { PRIVATE_ENV: "PRIVATE_ENV_VALUE" },
		};
		manager = new LanguageNavigationManager({ diagnostics: { recordEvent }, requestTimeoutMs: 10_000 });
	});

	afterEach(async () => {
		await manager.close();
		await rm(root, { recursive: true, force: true });
		const retained = JSON.stringify(recordEvent.mock.calls);
		for (const excluded of [input.content, root, "PRIVATE_STDERR", "PRIVATE_ENV_VALUE", server.label]) {
			expect(retained).not.toContain(excluded);
		}
	});

	it("distinguishes an initialization crash and preserves its safe exit code", async () => {
		server.args = ["-e", "process.stderr.write('PRIVATE_STDERR'); process.exit(17)"];
		expect(await manager.navigate("definition", scope(), config(), input)).toMatchObject({ status: "error" });
		await manager.close();
		expect(recordEvent).toHaveBeenCalledWith(
			"code_navigation.request_failed",
			{
				serverId: server.id,
				operation: "definition",
				stage: "initialization",
				category: "process_exited",
				exitCode: 17,
			},
			{ projectId: "synthetic" },
			{ essential: true },
		);
		expect(recordEvent).toHaveBeenCalledWith(
			"code_navigation.stopped",
			{ serverId: server.id, stage: "initialization", category: "process_exited", exitCode: 17 },
			{ projectId: "synthetic" },
			{ essential: true },
		);
	});

	it("preserves output-budget termination instead of a generic disposed-connection cause", async () => {
		server.env = { ...server.env, LSP_TEST_OUTPUT_LIMIT: "1" };
		expect(await manager.hover(scope(), config(), input)).toMatchObject({ status: "error" });
		expect(recordEvent).toHaveBeenCalledWith(
			"code_navigation.request_failed",
			{ serverId: server.id, operation: "hover", stage: "initialization", category: "output_limit" },
			{ projectId: "synthetic" },
			{ essential: true },
		);
	});

	it("identifies a request timeout with operation and server context", async () => {
		await manager.close();
		manager = new LanguageNavigationManager({
			diagnostics: { recordEvent },
			requestTimeoutMs: process.platform === "win32" ? 5_000 : 800,
		});
		server.env = { ...server.env, LSP_TEST_HANG: "1" };
		expect(await manager.navigate("references", scope(), config(), input)).toMatchObject({ status: "error" });
		expect(recordEvent).toHaveBeenCalledWith(
			"code_navigation.request_failed",
			{ serverId: server.id, operation: "references", stage: "request", category: "timeout" },
			{ projectId: "synthetic" },
			{ essential: true },
		);
	});

	it.skipIf(process.platform === "win32")("records a process signal without retaining server output", async () => {
		server.args = ["-e", "process.stderr.write('PRIVATE_STDERR'); process.kill(process.pid, 'SIGTERM')"];
		expect(await manager.navigate("definition", scope(), config(), input)).toMatchObject({ status: "error" });
		expect(recordEvent).toHaveBeenCalledWith(
			"code_navigation.request_failed",
			{
				serverId: server.id,
				operation: "definition",
				stage: "initialization",
				category: "process_exited",
				signal: "SIGTERM",
			},
			{ projectId: "synthetic" },
			{ essential: true },
		);
	});

	it("records disabled admission without launching a server", async () => {
		expect(
			await manager.navigate("definition", scope(), { ...config(), codeNavigationEnabled: false }, input),
		).toMatchObject({ status: "unavailable" });
		expect(recordEvent).toHaveBeenCalledWith(
			"code_navigation.request_failed",
			{ serverId: server.id, operation: "definition", stage: "admission", category: "unavailable" },
			{ projectId: "synthetic" },
			{ essential: true },
		);
		expect(manager.getSnapshot().processCount).toBe(0);
	});
});
