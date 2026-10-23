import type { ExecFileException } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadPiModelCatalog, parsePiModelCatalog } from "../../../src/config/pi-model-catalog.js";
import { createTestRuntimeConfigState } from "../../utilities/runtime-config-factory.js";

const { execFile, armTimeout } = vi.hoisted(() => ({ execFile: vi.fn(), armTimeout: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile }));
vi.mock("../../../src/core/windows-cmd-launch.js", () => ({
	resolveWindowsCompatibleCommand: (binary: string, args: string[]) => ({ binary, args }),
}));
vi.mock("../../../src/core/process-termination.js", () => ({ armChildProcessTimeout: armTimeout }));
const header = "provider  model  context  max-out  thinking  images";
const table = `${header}\nalpha  shared-model  200K  32K  yes  yes\nbeta  shared-model  1.5M  8192  no  yes\nlocal  qwen:7b  32K  4K  yes  no\n`;
const resolveCommand = vi.fn(async () => ({
	agentId: "pi" as const,
	label: "Pi",
	binary: "pi",
	command: "pi",
	args: ["--extension", "unsafe.ts", "private-prompt"],
}));
afterEach(() => vi.clearAllMocks());

describe("Pi model catalog", () => {
	it("retains exact provider/model identities including local model tags without forwarding other fields", () => {
		expect(parsePiModelCatalog(table)).toEqual({
			models: [
				{ provider: "alpha", id: "shared-model" },
				{ provider: "beta", id: "shared-model" },
				{ provider: "local", id: "qwen:7b" },
			],
		});
		expect(
			parsePiModelCatalog(`${header}\nalpha shared-model 200K 32K yes yes\nalpha shared-model 200K 32K yes yes`)
				.models,
		).toHaveLength(1);
	});
	it("handles native empty catalogs and rejects malformed output without reflecting it", () => {
		expect(parsePiModelCatalog("No models available. Please log in.")).toEqual({ models: [] });
		for (const output of [
			"secret-error",
			`${header}\nalpha private-secret invalid 32K yes yes`,
			`${header}\nalpha https://secret?key=value 200K 32K yes yes`,
		]) {
			expect(() => parsePiModelCatalog(output)).toThrow(/Pi model catalog/);
			expect(() => parsePiModelCatalog(output)).not.toThrow(/private-secret|secret-error|key=value/);
		}
	});
	it("uses only bounded, offline native metadata discovery in the requested project", async () => {
		const stdin = new PassThrough();
		execFile.mockImplementation((_binary, _args, _options, callback) => {
			queueMicrotask(() => callback(null, table, "private stderr"));
			return { stdin };
		});
		const settle = vi.fn();
		armTimeout.mockReturnValue({ settle, isTimedOut: () => false });
		expect(
			(await loadPiModelCatalog(createTestRuntimeConfigState(), "/project-a", { resolveCommand })).models,
		).toHaveLength(3);
		expect(resolveCommand).toHaveBeenCalledWith(expect.objectContaining({ selectedAgentId: "pi" }));
		expect(execFile).toHaveBeenCalledWith(
			"pi",
			[
				"--list-models",
				"--offline",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--no-mcp",
				"--no-approve",
			],
			expect.objectContaining({
				cwd: "/project-a",
				maxBuffer: 1024 * 1024,
				env: expect.objectContaining({ PI_OFFLINE: "1", NO_COLOR: "1", FORCE_COLOR: "0" }),
			}),
			expect.any(Function),
		);
		expect(armTimeout).toHaveBeenCalledWith(expect.anything(), 5_000, expect.anything());
		expect(stdin.writableEnded).toBe(true);
		expect(settle).toHaveBeenCalledOnce();
	});
	it.each(["failure", "timeout"])(
		"fails closed on %s without exposing command errors or partial catalogs",
		async (kind) => {
			execFile.mockImplementation((_binary, _args, _options, callback) => {
				queueMicrotask(() =>
					callback(
						kind === "failure" ? (new Error("private stderr and credentials") as ExecFileException) : null,
						table,
					),
				);
				return {};
			});
			armTimeout.mockReturnValue({ settle: vi.fn(), isTimedOut: () => kind === "timeout" });
			await expect(
				loadPiModelCatalog(createTestRuntimeConfigState(), "/project-b", { resolveCommand }),
			).rejects.toThrow("Pi model discovery failed. You can still use Pi default.");
		},
	);
});
