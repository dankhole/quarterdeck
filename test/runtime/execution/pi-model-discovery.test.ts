import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SUPPORTED_PI_VERSION } from "../../../src/config/agent-registry.js";
import { preparePiModelDiscovery } from "../../../src/config/pi-model-discovery.js";
import * as quarterdeckCommand from "../../../src/core/quarterdeck-command.js";

const roots: string[] = [];
const available = [
	{
		provider: "alpha",
		id: "first",
		name: "Friendly First",
		baseUrl: "private-endpoint",
		headers: { secret: "private-key" },
	},
	{ provider: "alpha", id: "second", name: "Friendly Second" },
	{ provider: "local", id: "qwen:7b", name: "Qwen" },
];

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "quarterdeck-pi-discovery-"));
	roots.push(root);
	const packageDir = join(root, "prefix", "node_modules", "@earendil-works", "pi-coding-agent");
	const cwd = join(root, "project");
	const agentDir = join(root, "profile");
	const binary = join(packageDir, "dist", "bundle", "cli.js");
	const put = async (path: string, contents: string) => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, contents);
	};
	await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);
	await put(
		join(packageDir, "package.json"),
		JSON.stringify({
			name: "@earendil-works/pi-coding-agent",
			version: SUPPORTED_PI_VERSION,
			type: "module",
			bin: { pi: "dist/bundle/cli.js" },
		}),
	);
	await put(binary, "#!/usr/bin/env node\nthrow new Error('CLI must never execute');\n");
	await chmod(binary, 0o755);
	await put(
		join(packageDir, "dist/config.js"),
		`
export const CONFIG_DIR_NAME = ".pi";
export const getAgentDir = () => process.env.PI_CODING_AGENT_DIR;
`,
	);
	await put(
		join(packageDir, "dist/core/settings-manager.js"),
		`
export class SettingsManager {
  static fromStorage(storage) {
    const snapshots = {};
    for (const scope of ["global", "project"]) storage.withLock(scope, content => {
      snapshots[scope] = content ? JSON.parse(content.replace(/^\\uFEFF/, "")) : {};
    });
    return {
      getEnabledModels: () => ({ ...snapshots.global, ...snapshots.project }).enabledModels,
      drainErrors: () => [],
    };
  }
}
`,
	);
	await put(
		join(packageDir, "dist/core/auth-storage.js"),
		`
import { readFileSync } from "node:fs";
export class ReadOnlyAuthStorage {
  constructor(path) { this.data = JSON.parse(readFileSync(path, "utf8")); }
}
`,
	);
	await put(
		join(packageDir, "dist/core/model-runtime.js"),
		`
export class ModelRuntime {
  static async create(options) {
    if (options.allowModelNetwork !== false || process.env.PI_OFFLINE !== "1") throw new Error("Unsafe network");
    if (options.credentials.data.secret !== "private-credential") throw new Error("Wrong auth storage");
    for (const method of ["write", "delete"]) {
      let rejected = false;
      try { await options.modelsStore[method]("alpha", {}); } catch { rejected = true; }
      if (!rejected) throw new Error("Writable model storage");
    }
    const cached = await options.modelsStore.read("alpha");
    if (process.env.TEST_PI_FAIL) throw new Error("private-endpoint private-credential");
    return {
      getAvailable: async (_provider, { signal }) => { signal.throwIfAborted(); return cached?.models ?? ${JSON.stringify(available)}; },
      getError: () => process.env.TEST_PI_RUNTIME_ERROR,
    };
  }
}
`,
	);
	await put(join(agentDir, "auth.json"), JSON.stringify({ secret: "private-credential" }));
	const scope = async (patterns: string[], indices = [1, 0]) => {
		await put(
			join(packageDir, "dist/core/model-resolver.js"),
			`
export function resolveModelScopeFromModels(patterns, available) {
  if (JSON.stringify(patterns) !== ${JSON.stringify(JSON.stringify(patterns))}) throw new Error("Patterns changed");
  return {
    scopedModels: ${JSON.stringify(indices)}.map(i => ({ model: available[i], thinkingLevel: "high" })),
    diagnostics: [{ message: "private-pattern", pattern: "private-pattern" }],
  };
}
`,
		);
	};
	await scope([]);
	return { root, packageDir, cwd, agentDir, binary, put, scope };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function run(f: Fixture, binary = f.binary, extraEnv: NodeJS.ProcessEnv = {}) {
	const command = await preparePiModelDiscovery(binary, f.cwd);
	expect(command.binary).toBe(process.execPath);
	expect(command.args.slice(0, 2)).toEqual(["--input-type=module", "--eval"]);
	expect(command.args[2]).not.toMatch(/\bimport\s*\(/);
	return new Promise<{ code: string | number; stdout: string; stderr: string }>((resolve) => {
		execFile(
			command.binary,
			command.args,
			{
				cwd: f.cwd,
				encoding: "utf8",
				timeout: 5_000,
				env: {
					...process.env,
					HOME: f.root,
					USERPROFILE: f.root,
					QUARTERDECK_STATE_HOME: join(f.root, "state"),
					PI_CODING_AGENT_DIR: f.agentDir,
					...extraEnv,
				},
			},
			(error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
		);
	});
}

async function snapshot(root: string): Promise<Record<string, string>> {
	const files = await readdir(root, { recursive: true, withFileTypes: true });
	const entries = await Promise.all(
		files
			.filter((file) => file.isFile())
			.map(async (file) => {
				const path = join(file.parentPath, file.name);
				return [path, await readFile(path, "utf8")] as const;
			}),
	);
	return Object.fromEntries(entries);
}

describe("installed Pi metadata discovery", () => {
	it("uses the admitted Node executable without forwarding the CLI or inherited preload flags", async () => {
		const f = await fixture();
		const resolveNode = vi
			.spyOn(quarterdeckCommand, "resolveQuarterdeckCommandParts")
			.mockReturnValue(["admitted-node-wrapper", "must-not-forward-cli"]);
		const command = await preparePiModelDiscovery(f.binary, f.cwd);
		expect(resolveNode).toHaveBeenCalledWith({ execPath: process.execPath, argv: process.argv, execArgv: [] });
		expect(command.binary).toBe("admitted-node-wrapper");
		expect(command.args.slice(0, 2)).toEqual(["--input-type=module", "--eval"]);
		expect(command.args).not.toContain("must-not-forward-cli");
	});

	it("sanitizes native installation admission failures", async () => {
		const f = await fixture();
		vi.spyOn(quarterdeckCommand, "resolveQuarterdeckCommandParts").mockImplementation(() => {
			throw new Error("private installation path");
		});
		await expect(preparePiModelDiscovery(f.binary, f.cwd)).rejects.toThrow(
			"Pi model discovery is unavailable. You can still use Pi default.",
		);
	});
	it("uses static imports from the selected installation and emits identities only without writes", async () => {
		const f = await fixture();
		await f.put(
			join(f.agentDir, "settings.json"),
			JSON.stringify({ extensions: ["private-extension"], packages: ["must-not-install"] }),
		);
		await f.put(join(f.cwd, ".pi/settings.json"), JSON.stringify({ extensions: ["must-not-execute"] }));
		const before = await snapshot(f.root);
		const result = await run(f);
		expect(result).toEqual({
			code: 0,
			stdout: JSON.stringify({ models: available.map(({ provider, id }) => ({ provider, id })) }),
			stderr: "",
		});
		expect(await snapshot(f.root)).toEqual(before);
	});

	it("forwards glob, suffix, literal-colon, bracket and fuzzy-name patterns unchanged, preserving native order", async () => {
		const f = await fixture();
		const patterns = ["alpha/second:high", "ALPHA/*:low", "local/qwen:7b", "bracket[1m]", "Friendly", "alpha/second"];
		await f.put(join(f.agentDir, "settings.json"), JSON.stringify({ enabledModels: patterns }));
		await f.scope(patterns);
		const result = await run(f);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			models: [
				{ provider: "alpha", id: "second" },
				{ provider: "alpha", id: "first" },
			],
		});
		expect(result.stderr).toBe("");
	});

	it("uses the project override instead of combining model scopes", async () => {
		const f = await fixture();
		await f.put(join(f.agentDir, "settings.json"), JSON.stringify({ enabledModels: ["global"] }));
		await f.put(join(f.cwd, ".pi/settings.json"), JSON.stringify({ enabledModels: ["project"] }));
		await f.scope(["project"], [2]);
		expect(JSON.parse((await run(f)).stdout)).toEqual({ models: [{ provider: "local", id: "qwen:7b" }] });
	});

	it.each([undefined, "", "{}", '{"enabledModels":[]}'])(
		"treats absent or empty scope as unrestricted: %s",
		async (content) => {
			const f = await fixture();
			if (content !== undefined) await f.put(join(f.agentDir, "settings.json"), content);
			const result = await run(f);
			expect(result.code).toBe(0);
			expect(JSON.parse(result.stdout).models).toHaveLength(available.length);
		},
	);

	it("allows an empty project scope to clear the global scope", async () => {
		const f = await fixture();
		await f.put(join(f.agentDir, "settings.json"), '{"enabledModels":["restricted"]}');
		await f.put(join(f.cwd, ".pi/settings.json"), '{"enabledModels":[]}');
		expect(JSON.parse((await run(f)).stdout).models).toHaveLength(available.length);
	});

	it("retains zero matches rather than replacing the scope with every model", async () => {
		const f = await fixture();
		await f.put(join(f.agentDir, "settings.json"), '{"enabledModels":["absent"]}');
		await f.scope(["absent"], []);
		expect(await run(f)).toEqual({ code: 0, stdout: '{"models":[]}', stderr: "" });
	});

	it("restores cached catalogs through a BOM-tolerant read-only store", async () => {
		const f = await fixture();
		await f.put(
			join(f.agentDir, "models-store.json"),
			`\uFEFF${JSON.stringify({ alpha: { models: [available[2]] } })}`,
		);
		const before = await snapshot(f.root);
		expect(JSON.parse((await run(f)).stdout)).toEqual({ models: [{ provider: "local", id: "qwen:7b" }] });
		expect(await snapshot(f.root)).toEqual(before);
	});

	it.each([
		'{"enabledModels":"private-pattern"}',
		'{"enabledModels":[123]}',
		'{"enabledModels":null}',
		"private-invalid-json",
	])("rejects malformed settings without exposing their contents: %s", async (contents) => {
		const f = await fixture();
		await f.put(join(f.agentDir, "settings.json"), contents);
		expect(await run(f)).toEqual({ code: 1, stdout: "", stderr: "" });
	});

	it.each(["TEST_PI_FAIL", "TEST_PI_RUNTIME_ERROR"])("suppresses private native errors: %s", async (key) => {
		const f = await fixture();
		expect(await run(f, f.binary, { [key]: "private-credential" })).toEqual({ code: 1, stdout: "", stderr: "" });
	});

	it.skipIf(process.platform === "win32")(
		"resolves the first PATH executable through its symlink, not a second installation",
		async () => {
			const f = await fixture();
			const binDir = join(f.root, "bin");
			await mkdir(binDir);
			await symlink(f.binary, join(binDir, "pi"));
			vi.stubEnv("PATH", `${binDir}${delimiter}${process.env.PATH ?? ""}`);
			const command = await preparePiModelDiscovery("pi", f.cwd);
			expect(command.args[2]).toContain("pi-coding-agent/dist/core/model-runtime.js");
			expect((await run(f, "pi")).code).toBe(0);
		},
	);

	it("recognizes a standard Windows npm shim without executing it", async () => {
		const f = await fixture();
		const shimPath = join(f.root, "prefix", "pi.cmd");
		await f.put(
			shimPath,
			[
				"@ECHO off",
				"GOTO start",
				":find_dp0",
				"SET dp0=%~dp0",
				"EXIT /b",
				":start",
				"SETLOCAL",
				"CALL :find_dp0",
				"",
				'IF EXIST "%dp0%\\node.exe" (',
				'  SET "_prog=%dp0%\\node.exe"',
				") ELSE (",
				'  SET "_prog=node"',
				"  SET PATHEXT=%PATHEXT:;.JS;=;%",
				")",
				"",
				'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*',
				"",
			].join("\r\n"),
		);
		await chmod(shimPath, 0o755);
		expect((await run(f, shimPath)).code).toBe(0);
		await f.put(shimPath, `${await readFile(shimPath, "utf8")}\r\necho private-wrapper`);
		await expect(preparePiModelDiscovery(shimPath, f.cwd)).rejects.toThrow(/^Pi model discovery is unavailable/);
	});

	it.each(["name", "version", "bin"])("fails closed on incompatible package %s", async (field) => {
		const f = await fixture();
		const path = join(f.packageDir, "package.json");
		await f.put(
			path,
			JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")), [field]: "private-wrong-value" }),
		);
		await expect(preparePiModelDiscovery(f.binary, f.cwd)).rejects.toThrow(
			"Pi model discovery is unavailable. You can still use Pi default.",
		);
	});

	it("rejects standalone executables and arbitrary wrappers without reflecting their paths", async () => {
		const f = await fixture();
		const wrapper = join(f.root, "private-wrapper");
		await f.put(wrapper, "#!/bin/sh\necho private-secret\n");
		await chmod(wrapper, 0o755);
		await expect(preparePiModelDiscovery(wrapper, f.cwd)).rejects.toThrow(
			"Pi model discovery is unavailable. You can still use Pi default.",
		);
	});
});
