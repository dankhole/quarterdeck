import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { resolveWindowsBinaryPath } from "../core/command-discovery.js";
import { resolveQuarterdeckCommandParts } from "../core/quarterdeck-command.js";
import { SUPPORTED_PI_VERSION } from "./agent-registry.js";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const DISCOVERY_ERROR = "Pi model discovery is unavailable. You can still use Pi default.";
const packageSchema = z.object({
	name: z.literal(PACKAGE_NAME),
	version: z.literal(SUPPORTED_PI_VERSION),
	bin: z.object({ pi: z.literal("dist/bundle/cli.js") }),
});

async function resolveBinary(binary: string): Promise<string> {
	if (process.platform === "win32") {
		const selected = resolveWindowsBinaryPath(binary);
		if (!selected) throw new Error(DISCOVERY_ERROR);
		return selected.path;
	}
	const candidates = binary.includes("/")
		? [resolve(binary)]
		: (process.env.PATH ?? "")
				.split(delimiter)
				.filter(Boolean)
				.map((entry) => resolve(entry, binary));
	for (const candidate of candidates) {
		try {
			await access(candidate, constants.X_OK);
			if ((await stat(candidate)).isFile()) return candidate;
		} catch {
			// Match direct PATH lookup, never shell aliases or fallback shell discovery.
		}
	}
	throw new Error(DISCOVERY_ERROR);
}

/** Recognize npm's Node .cmd shim as data; never evaluate it or accept arbitrary target paths. */
function npmCommandShim(target: string): string {
	return [
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
		`endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
		"",
	].join("\n");
}

async function resolveInstalledPackage(binary: string): Promise<string> {
	const selected = await resolveBinary(binary);
	let entry = await realpath(selected);
	if (extname(entry).toLowerCase() === ".cmd") {
		const shim = (await readFile(entry, "utf8")).replaceAll("\r\n", "\n");
		const targets = [
			"node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js",
			"..\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js",
		];
		const target = targets.find((candidate) => shim === npmCommandShim(candidate));
		if (!target) throw new Error(DISCOVERY_ERROR);
		entry = await realpath(resolve(dirname(entry), ...target.split("\\")));
	}
	const packageDir = resolve(dirname(entry), "../..");
	packageSchema.parse(JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")));
	if (entry !== (await realpath(join(packageDir, "dist/bundle/cli.js")))) throw new Error(DISCOVERY_ERROR);
	return packageDir;
}

function discoverySource(packageDir: string, cwd: string): string {
	const moduleUrl = (relative: string): string =>
		JSON.stringify(pathToFileURL(join(packageDir, "dist", relative)).href);
	return `import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from ${moduleUrl("config.js")};
import { SettingsManager } from ${moduleUrl("core/settings-manager.js")};
import { ReadOnlyAuthStorage } from ${moduleUrl("core/auth-storage.js")};
import { ModelRuntime } from ${moduleUrl("core/model-runtime.js")};
import { resolveModelScopeFromModels } from ${moduleUrl("core/model-resolver.js")};

// No CLI main, session, resource loader, extensions, or credential resolution requests.
try {
  process.env.PI_OFFLINE = "1";
  const signal = AbortSignal.timeout(4_000);
  const agentDir = getAgentDir();
  const readOptional = async (path) => {
    try { return await readFile(path, { encoding: "utf8", signal }); }
    catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  };
  const [global, project, cached] = await Promise.all([
    readOptional(join(agentDir, "settings.json")),
    readOptional(join(${JSON.stringify(cwd)}, CONFIG_DIR_NAME, "settings.json")),
    readOptional(join(agentDir, "models-store.json")),
  ]);
  const readonly = () => { throw new Error("Read-only discovery"); };
  const settings = SettingsManager.fromStorage({
    withLock(scope, callback) {
      if (callback(scope === "global" ? global : project) !== undefined) readonly();
    },
  });
  if (settings.drainErrors().length) readonly();
  const patterns = settings.getEnabledModels();
  if (patterns !== undefined && (!Array.isArray(patterns) || patterns.some(p => typeof p !== "string"))) readonly();
  const cache = cached ? JSON.parse(cached.replace(/^\\uFEFF/, "")) : {};
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) readonly();
  const runtime = await ModelRuntime.create({
    credentials: new ReadOnlyAuthStorage(join(agentDir, "auth.json")),
    modelsPath: join(agentDir, "models.json"),
    modelsStore: {
      async read(providerId) { signal.throwIfAborted(); return Object.hasOwn(cache, providerId) ? cache[providerId] : undefined; },
      async write() { readonly(); },
      async delete() { readonly(); },
    },
    allowModelNetwork: false,
    signal,
  });
  const available = await runtime.getAvailable(undefined, { signal });
  if (runtime.getError()) readonly();
  const models = patterns?.length
    ? resolveModelScopeFromModels(patterns, available).scopedModels.map(entry => entry.model)
    : available;
  signal.throwIfAborted();
  process.stdout.write(JSON.stringify({ models: models.map(({ provider, id }) => ({ provider, id })) }));
} catch {
  // Native errors can contain private settings, endpoints, or credentials. Emit none of them.
  process.exitCode = 1;
}
`;
}

/** Prepare metadata-only discovery from the exact selected npm Pi installation, never another SDK copy. */
export async function preparePiModelDiscovery(
	binary: string,
	cwd: string,
): Promise<{ binary: string; args: string[] }> {
	try {
		const packageDir = await resolveInstalledPackage(binary);
		// Retain native desktop admission, but neither the CLI entrypoint nor inherited --import/--require flags.
		const [node] = resolveQuarterdeckCommandParts({
			execPath: process.execPath,
			argv: process.argv,
			execArgv: [],
		});
		if (!node) throw new Error(DISCOVERY_ERROR);
		return { binary: node, args: ["--input-type=module", "--eval", discoverySource(packageDir, cwd)] };
	} catch {
		throw new Error(DISCOVERY_ERROR);
	}
}
