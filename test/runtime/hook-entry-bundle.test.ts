import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";

import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import * as esbuild from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createQuarterdeckEsbuildOptions } from "../../scripts/esbuild-shared-options.mjs";
import type { RuntimeHookIngestRequest, RuntimeHookIngestResponse } from "../../src/core/api/task-session.js";
import {
	createHookTransitionOutboxReplayer,
	loadPendingHookTransitions,
	type PersistedHookTransition,
} from "../../src/hook-transition-outbox.js";
import { runtimeAppRouter } from "../../src/trpc/app-router.js";
import type { RuntimeTrpcContext } from "../../src/trpc/app-router-context.js";

/**
 * Bundle hygiene for the lightweight hook entry (`src/hook-main.ts` /
 * `src/hook-entry.ts`, built by `scripts/build.mjs` to `dist/hooks.js`). Every
 * Claude/Codex/Pi command hook spawns a full Node process running this bundle, so it
 * must never pull in commander, `@trpc/*`, node-pty, zod, or the heavy
 * terminal/session and workdir/git modules that the full CLI needs. Builds
 * with the exact same esbuild options as the real build (narrowed to this one
 * entry point) and inspects the metafile.
 *
 * `@trpc/*`, `commander`, `node-pty`, and `zod` are all in the esbuild
 * `external` list, so they can never appear as bundled *inputs* even if
 * something transitively imported them — checking inputs alone would not
 * fail if one of those leaked in. The output's `imports` list is what
 * actually records every external package the bundle still reaches for at
 * runtime (via `require`/`import`), so that's what's asserted against the
 * builtin allowlist below.
 */

const ALLOWED_EXTERNAL_IMPORTS = new Set([
	"node:crypto",
	"node:fs",
	"node:fs/promises",
	"node:path",
	"node:os",
	"node:http",
	"node:module",
]);

// Match the production build's module layout without depending on runtime packages.
let outputDirectory: string;
let server: Server | undefined;
const children = new Set<ChildProcess>();

afterEach(async () => {
	for (const child of children) {
		await new Promise<void>((resolveClose) => {
			child.once("close", () => resolveClose());
			child.kill();
		});
	}
	if (server) {
		server.closeAllConnections();
		await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
		server = undefined;
	}
	vi.unstubAllEnvs();
	if (outputDirectory) {
		await rm(outputDirectory, { recursive: true, force: true });
	}
});

async function buildHooksBundle(outfile: string) {
	return await esbuild.build({
		...createQuarterdeckEsbuildOptions("hook-bundle-hygiene-test"),
		entryPoints: ["src/hook-main.ts"],
		outfile,
		metafile: true,
		sourcemap: false,
	});
}

function outputEntryFor(metafile: esbuild.Metafile, outfile: string) {
	const entry =
		metafile.outputs[outfile] ??
		Object.values(metafile.outputs).find((candidate) => candidate.entryPoint === "src/hook-main.ts");
	if (!entry) {
		throw new Error("Expected a metafile output entry for the hook bundle.");
	}
	return entry;
}

describe("dist/hooks.js bundle hygiene", () => {
	it("uses only allowed Node builtins, without locking, logging, or heavy runtime modules", async () => {
		await mkdir(resolve(".cache"), { recursive: true });
		outputDirectory = await mkdtemp(resolve(".cache/hooks-bundle-hygiene-"));
		const outfile = join(outputDirectory, "hooks.js");
		const result = await buildHooksBundle(outfile);
		const metafile = result.metafile;
		if (!metafile) {
			throw new Error("Expected esbuild to produce a metafile.");
		}

		const inputs = Object.keys(metafile.inputs);
		expect(inputs.length).toBeGreaterThan(0);

		const disallowedInputs = inputs.filter(
			(input) =>
				input.startsWith("src/terminal/session-") ||
				input.startsWith("src/workdir/") ||
				input === "src/core/index.ts" ||
				input === "src/terminal/index.ts" ||
				input === "src/fs/index.ts" ||
				input === "src/fs/locked-file-system.ts" ||
				input === "src/core/runtime-logger.ts" ||
				input === "src/state/runtime-write-admission.ts" ||
				input === "src/fs/in-process-lock-owners.ts" ||
				input.includes("node_modules/"),
		);
		expect(disallowedInputs).toEqual([]);

		// External packages (commander, @trpc/*, node-pty, zod) never show up as
		// bundled *inputs* — they're excluded from bundling entirely — so this is
		// the check that actually catches a regression: every external import the
		// built output still performs at runtime.
		const output = outputEntryFor(metafile, outfile);
		const externalImportPaths = output.imports.filter((entry) => entry.external).map((entry) => entry.path);
		expect(externalImportPaths.length).toBeGreaterThan(0);
		expect(externalImportPaths.filter((path) => !ALLOWED_EXTERNAL_IMPORTS.has(path))).toEqual([]);
		expect(externalImportPaths).toContain("node:http");

		// The built entry explicitly calls process.exit(process.exitCode ?? 0) after
		// main() settles (mirroring src/cli.ts), so a successful best-effort notify
		// exits cleanly on its own rather than relying on the event loop draining.
		const notifyResult = runHooksWithoutEnv(outfile, "notify");
		expect(notifyResult.status).toBe(0);
		expect(notifyResult.stderr).toBe("");
	}, 20_000);

	it.each(["healthy", "deferred", "truncated"])(
		"delivers a built reliable hook through the %s acknowledgement path",
		async (scenario) => {
			await mkdir(resolve(".cache"), { recursive: true });
			outputDirectory = await mkdtemp(resolve(".cache/hooks-bundle-delivery-"));
			const outfile = join(outputDirectory, "hooks.js");
			await buildHooksBundle(outfile);
			const stateHome = join(outputDirectory, "state");
			await mkdir(stateHome);
			vi.stubEnv("QUARTERDECK_STATE_HOME", stateHome);
			const observed: Array<{ input: RuntimeHookIngestRequest; records: PersistedHookTransition[] }> = [];
			const ingest = async (input: RuntimeHookIngestRequest): Promise<RuntimeHookIngestResponse> => {
				observed.push({ input, records: await loadPendingHookTransitions() });
				return scenario === "deferred" ? { ok: false, error: "not ready" } : { ok: true };
			};
			const port = await startHookServer(ingest);
			if (scenario === "truncated") {
				server?.removeAllListeners("request");
				server?.on("request", (req, res) => {
					let raw = "";
					req.setEncoding("utf8");
					req.on("data", (chunk: string) => {
						raw += chunk;
					});
					req.on("end", () => {
						void ingest(JSON.parse(raw)).then(() => {
							res.writeHead(200, { "content-length": "1000", connection: "close" });
							res.end(JSON.stringify({ result: { data: { ok: true } } }));
						});
					});
				});
			}

			const result = await runReliableHook(outfile, stateHome, port);

			expect(result.status).toBe(0); // A retained durable copy is success, not exit 1.
			expect(observed).toHaveLength(scenario === "healthy" ? 1 : 2);
			const first = observed[0]?.input;
			expect(first?.metadata).toMatchObject({
				source: "claude",
				hookEventName: "PostToolUse",
				sessionId: "synthetic-session",
				sessionInstanceId: "synthetic-launch",
				toolName: "Bash",
				toolUseId: "synthetic-tool",
				activityText: "synthetic live activity",
				toolInputSummary: "synthetic live summary",
			});
			for (const observation of observed) {
				expect(observation.input.delivery).toEqual(first?.delivery);
				expect(observation.records).toEqual([
					expect.objectContaining({
						request: expect.objectContaining({ delivery: first?.delivery }),
					}),
				]);
				expect(JSON.stringify(observation.records)).not.toContain("synthetic live");
			}
			const outboxDirectory = join(stateHome, "hook-transition-outbox");
			if (scenario === "healthy") {
				expect(result.stderr).toBe("");
				expect(await readdir(outboxDirectory)).toEqual([]);
			} else {
				expect(result.stderr).toContain("ingest deferred to durable replay");
				const [pending] = await loadPendingHookTransitions();
				expect(pending?.abandonedAt).toEqual(expect.any(Number));
				expect(pending?.request.delivery).toEqual(first?.delivery);
				const replayIngest = vi.fn(async (_input: RuntimeHookIngestRequest) => ({ ok: true as const }));
				const replayer = createHookTransitionOutboxReplayer({ ingest: replayIngest });
				try {
					await replayer.replayOnce();
					expect(replayIngest).toHaveBeenCalledExactlyOnceWith(pending?.request);
					expect(await readdir(outboxDirectory)).toEqual([]);
				} finally {
					await replayer.close();
				}
			}
		},
		20_000,
	);

	it("runs correctly when invoked through a symlinked path (npm-global/Agent-Lab style layout)", async () => {
		await mkdir(resolve(".cache"), { recursive: true });
		outputDirectory = await mkdtemp(resolve(".cache/hooks-bundle-symlink-"));
		const realDistDir = join(outputDirectory, "real", "dist");
		const outfile = join(realDistDir, "hooks.js");
		await buildHooksBundle(outfile);

		const symlinkDir = join(outputDirectory, "linked");
		await symlink(join(outputDirectory, "real"), symlinkDir);
		const symlinkedOutfile = join(symlinkDir, "dist", "hooks.js");

		// "ingest" with no QUARTERDECK_HOOK_* env writes a specific stderr message
		// and exits 1 — unlike "notify", which silently swallows the same failure.
		// That makes it possible to tell "main() actually ran" apart from "main()
		// was silently skipped", which is exactly the bug class being guarded
		// against here (an earlier guard compared import.meta.url to argv[1] and
		// silently no-op'd under a symlinked invocation path).
		for (const path of [outfile, symlinkedOutfile]) {
			const result = runHooksWithoutEnv(path, "ingest");
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("quarterdeck hooks ingest:");
		}
	}, 20_000);
});

function runHooksWithoutEnv(
	hooksJsPath: string,
	subcommand: "ingest" | "notify",
): { status: number | null; stderr: string } {
	const env = { ...process.env };
	delete env.QUARTERDECK_HOOK_TASK_ID;
	delete env.QUARTERDECK_HOOK_PROJECT_ID;
	delete env.QUARTERDECK_HOOK_SESSION_INSTANCE_ID;
	try {
		execFileSync(process.execPath, [hooksJsPath, "hooks", subcommand, "--event", "to_review", "--source", "claude"], {
			stdio: ["ignore", "ignore", "pipe"],
			env,
		});
		return { status: 0, stderr: "" };
	} catch (error) {
		const execError = error as { status: number | null; stderr: Buffer | string };
		return { status: execError.status, stderr: String(execError.stderr) };
	}
}

async function startHookServer(
	ingest: (input: RuntimeHookIngestRequest) => Promise<RuntimeHookIngestResponse>,
): Promise<number> {
	const context = { hooksApi: { ingest } } as unknown as RuntimeTrpcContext;
	server = createServer(
		createHTTPHandler({
			router: runtimeAppRouter,
			basePath: "/api/trpc/",
			createContext: async () => context,
		}),
	);
	await new Promise<void>((resolveStart) => server?.listen(0, "127.0.0.1", resolveStart));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected a TCP port.");
	return address.port;
}

function runReliableHook(
	outfile: string,
	stateHome: string,
	port: number,
): Promise<{ status: number | null; stderr: string }> {
	return new Promise((resolveChild, reject) => {
		const child = spawn(
			process.execPath,
			[
				outfile,
				"hooks",
				"ingest",
				"--event",
				"to_in_progress",
				"--source",
				"claude",
				"--activity-text",
				"synthetic live activity",
				"--tool-input-summary",
				"synthetic live summary",
			],
			{
				env: {
					...process.env,
					HOME: stateHome,
					USERPROFILE: stateHome,
					QUARTERDECK_STATE_HOME: stateHome,
					QUARTERDECK_RUNTIME_HOST: "127.0.0.1",
					QUARTERDECK_RUNTIME_PORT: String(port),
					QUARTERDECK_HOOK_TASK_ID: "synthetic-task",
					QUARTERDECK_HOOK_PROJECT_ID: "synthetic-project",
					QUARTERDECK_HOOK_SESSION_INSTANCE_ID: "synthetic-launch",
				},
				stdio: ["pipe", "ignore", "pipe"],
			},
		);
		children.add(child);
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.once("close", (status) => {
			children.delete(child);
			resolveChild({ status, stderr });
		});
		child.stdin.on("error", reject);
		child.stdin.end(
			JSON.stringify({
				hook_event_name: "PostToolUse",
				session_id: "synthetic-session",
				tool_name: "Bash",
				tool_use_id: "synthetic-tool",
				tool_input: { command: "printf synthetic" },
			}),
		);
	});
}
