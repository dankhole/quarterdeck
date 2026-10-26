import { execFile } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPiLifecycleEsbuildOptions } from "../../../scripts/esbuild-shared-options.mjs";
import type { RuntimeHookIngestRequest } from "../../../src/core/api/task-session";
import { compareSameProducerHookDeliveries } from "../../../src/hook-delivery-order";
import { loadPendingHookTransitions } from "../../../src/hook-transition-outbox";
import { prepareHookTransitionOutboxDirectoryCapability } from "../../../src/hook-transition-outbox-private-directory";
import {
	buildPiLifecycleExtensionSource,
	linkPiLifecycleExtensionImports,
} from "../../../src/terminal/pi-lifecycle-extension";
import { useProcessTestBudget } from "../../utilities/process-test-budget";

useProcessTestBudget();
const run = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function prepareLaunchAsset(root: string, launch: string, layout: "source" | "packaged"): Promise<string> {
	const launchAsset = join(launch, "quarterdeck-lifecycle.mjs");
	if (layout === "source") {
		await writeFile(launchAsset, buildPiLifecycleExtensionSource());
	} else {
		const installation = join(root, "installed package");
		const asset = join(installation, "terminal/pi-lifecycle-extension.runtime.js");
		const result = await build({
			...createPiLifecycleEsbuildOptions(),
			entryPoints: [resolve("src/terminal/pi-lifecycle-extension.runtime.js")],
			outfile: asset,
			metafile: true,
			logLevel: "silent",
		});
		const inputs = Object.keys(result.metafile?.inputs ?? {});
		expect(inputs).toContain("src/hook-reliable-delivery.ts");
		expect(inputs).toContain("src/hook-delivery-order.ts");
		expect(
			inputs.some((path) => path.includes("node_modules/") || path.includes("session-transition-controller")),
		).toBe(false);
		const imports = Object.values(result.metafile?.outputs ?? {}).flatMap((output) => output.imports);
		expect(imports.every((entry) => entry.external && entry.path.startsWith("node:"))).toBe(true);
		await build({
			entryPoints: [resolve("test/utilities/pi-lifecycle-asset-emitter.fixture.ts")],
			outfile: join(installation, "emitter.mjs"),
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node22",
			logLevel: "silent",
		});
		// Exercise the installed loader's dist/terminal fallback, then remove
		// its entire installation to prove the launch copy is self-contained.
		await run(process.execPath, [join(installation, "emitter.mjs"), launchAsset], { timeout: 8_000 });
		await rm(installation, { recursive: true, force: true });
		expect(await readFile(launchAsset, "utf8")).not.toContain('from "file:');
	}
	return launchAsset;
}

describe("Pi static asset resolution and process-exit publication", () => {
	it.each([
		[
			"C:\\Program Files\\Quarterdeck #1%\\src\\terminal\\pi-lifecycle-extension.runtime.js",
			"file:///C:/Program%20Files/Quarterdeck%20%231%25/src/",
		],
		["\\\\host\\share name\\src\\terminal\\pi-lifecycle-extension.runtime.js", "file://host/share%20name/src/"],
	])("links Windows static imports without drive, space or URL-character corruption: %s", (asset, prefix) => {
		const source =
			'import { buildHookIngestRequest } from "../commands/hook-metadata.js";\nimport { publishReliableHook } from "../hook-reliable-delivery.js";\nimport { createHookDeliveryIdGenerator } from "../hook-delivery-order.js";';
		const linked = linkPiLifecycleExtensionImports(source, pathToFileURL(asset, { windows: true }));
		expect(linked).toContain(`from "${prefix}commands/hook-metadata.ts"`);
		expect(linked).toContain(`from "${prefix}hook-reliable-delivery.ts"`);
		expect(linked).toContain(`from "${prefix}hook-delivery-order.ts"`);
		expect(linked).not.toContain("import(");
	});

	it.each([
		["source", "queued"],
		["packaged", "queued"],
		["packaged", "transient"],
	] as const)(
		"preserves %s %s publications after explicit immediate process.exit(0), with zero hook children",
		async (layout, scenario) => {
			const root = await mkdtemp(join(tmpdir(), "quarterdeck-pi-exit-"));
			directories.push(root);
			const launch = join(root, "launch path #1%");
			const state = join(root, "state");
			await mkdir(launch);
			await mkdir(state);
			vi.stubEnv("QUARTERDECK_STATE_HOME", state);
			const capability = scenario === "queued" ? await prepareHookTransitionOutboxDirectoryCapability() : undefined;
			await prepareLaunchAsset(root, launch, layout);
			const fixture = join(launch, "exit.fixture.mjs");
			await copyFile(resolve("test/utilities/pi-lifecycle-exit.fixture.mjs"), fixture);
			const args =
				layout === "source" ? ["--import", import.meta.resolve("tsx"), fixture, scenario] : [fixture, scenario];
			const started = Date.now();
			const { stdout, stderr } = await run(process.execPath, args, {
				timeout: 8_000,
				env: {
					...process.env,
					HOME: state,
					USERPROFILE: state,
					QUARTERDECK_STATE_HOME: state,
					QUARTERDECK_RUNTIME_HOST: "127.0.0.1",
					QUARTERDECK_RUNTIME_PORT: "1",
					QUARTERDECK_HOOK_TASK_ID: "synthetic-task",
					QUARTERDECK_HOOK_PROJECT_ID: "synthetic-project",
					QUARTERDECK_HOOK_SESSION_INSTANCE_ID: "synthetic-launch",
					QUARTERDECK_HOOK_PRIVATE_OUTBOX: capability,
					QUARTERDECK_PI_HOOK_COMMAND_JSON: JSON.stringify(["forbidden-hook-child", "notify"]),
				},
			});
			expect(Date.now() - started).toBeLessThan(6_000);
			const report: unknown = JSON.parse(stdout.trim());
			expect(report).toEqual({
				spawned: 0,
				swallowed: scenario === "transient" ? 1 : 0,
				expectedRecords: scenario === "transient" ? 1 : 16,
				idempotent: true,
				protectedShutdown: true,
			});
			if (scenario === "transient") expect(stderr).toContain("could not publish a Pi lifecycle hook for replay");
			expect(stderr).not.toContain("Synthetic final");
			expect(stderr).not.toContain("blocked outbox");
			const records = await loadPendingHookTransitions();
			expect(records).toHaveLength(scenario === "transient" ? 1 : 16);
			expect(records.every((record) => typeof record.abandonedAt === "number")).toBe(true);
			expect(new Set(records.map((record) => record.request.delivery.id)).size).toBe(records.length);
			expect(JSON.stringify(records)).not.toContain("private-session.jsonl");
			if (scenario === "queued") {
				const final = records.find((record) => record.request.event === "to_review");
				expect(final?.request.metadata).toMatchObject({
					source: "pi",
					hookEventName: "AgentSettled",
					sessionId: "synthetic-pi-session",
				});
				if (process.platform !== "win32" || capability) {
					expect(final?.request.metadata?.finalMessage).toBe("**Synthetic final**\n\n- retained");
				}
			}
		},
	);

	it.each([
		["source", "healthy"],
		["source", "pending"],
		["packaged", "healthy"],
		["packaged", "pending"],
	] as const)(
		"preserves producer and appropriate handoff through separate %s ESM modules (%s reload)",
		async (layout, scenario) => {
			const root = await mkdtemp(join(tmpdir(), "quarterdeck-pi-reload-"));
			directories.push(root);
			const launch = join(root, "launch");
			const state = join(root, "state");
			await mkdir(launch);
			await mkdir(state);
			vi.stubEnv("QUARTERDECK_STATE_HOME", state);
			const capability = await prepareHookTransitionOutboxDirectoryCapability();
			const asset = await prepareLaunchAsset(root, launch, layout);
			await copyFile(asset, join(launch, "quarterdeck-lifecycle-reloaded.mjs"));
			const fixture = join(launch, "reload.fixture.mjs");
			await copyFile(resolve("test/utilities/pi-lifecycle-reload.fixture.mjs"), fixture);
			const requests: RuntimeHookIngestRequest[] = [];
			const server = createServer((request, response) => {
				let body = "";
				request.setEncoding("utf8");
				request.on("data", (chunk: string) => {
					body += chunk;
				});
				request.on("end", () => {
					const input: RuntimeHookIngestRequest = JSON.parse(body);
					requests.push(input);
					const defer = scenario === "pending" && input.event === "to_review";
					response.writeHead(200, { "content-type": "application/json" });
					response.end(
						JSON.stringify({
							result: { data: defer ? { ok: false, error: "synthetic deferred settlement" } : { ok: true } },
						}),
					);
				});
			});
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			try {
				const port = (server.address() as AddressInfo).port;
				const args = layout === "source" ? ["--import", import.meta.resolve("tsx"), fixture] : [fixture];
				const { stdout, stderr } = await run(process.execPath, args, {
					timeout: 8_000,
					env: {
						...process.env,
						HOME: state,
						USERPROFILE: state,
						QUARTERDECK_STATE_HOME: state,
						QUARTERDECK_RUNTIME_HOST: "127.0.0.1",
						QUARTERDECK_RUNTIME_PORT: String(port),
						QUARTERDECK_HOOK_TASK_ID: "synthetic-task",
						QUARTERDECK_HOOK_PROJECT_ID: "synthetic-project",
						QUARTERDECK_HOOK_SESSION_INSTANCE_ID: "synthetic-launch",
						QUARTERDECK_HOOK_PRIVATE_OUTBOX: capability,
					},
				});
				expect(JSON.parse(stdout.trim())).toEqual({
					registrySize: 1,
					handoff: scenario === "pending",
					unpublished: 0,
				});
				expect(stderr).not.toContain("Synthetic reply");
				const oldSettlement = requests.find((request) => request.event === "to_review");
				expect(oldSettlement?.metadata?.finalMessage).toBe("Synthetic reply before reload");
				const pending = await loadPendingHookTransitions();
				if (scenario === "healthy") {
					expect(pending).toEqual([]);
					expect(requests.map((request) => request.metadata?.hookEventName)).toEqual([
						"AgentStart",
						"AgentEnd",
						"AgentSettled",
						"session_meta",
						"AgentStart",
					]);
					expect(
						compareSameProducerHookDeliveries(
							oldSettlement?.delivery?.id ?? "",
							requests.at(-1)?.delivery?.id ?? "",
						),
					).toBeLessThan(0);
				} else {
					expect(pending).toHaveLength(3);
					expect(requests.filter((request) => request.metadata?.hookEventName === "AgentStart")).toHaveLength(1);
					const oldReply = pending.find((record) => record.request.event === "to_review");
					const newStart = pending.find((record) => record.request.event === "to_in_progress");
					expect(
						compareSameProducerHookDeliveries(
							oldReply?.request.delivery.id ?? "",
							newStart?.request.delivery.id ?? "",
						),
					).toBeLessThan(0);
					if (process.platform !== "win32" || capability)
						expect(oldReply?.request.metadata?.finalMessage).toBe("Synthetic reply before reload");
				}
			} finally {
				server.closeAllConnections();
				await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
			}
		},
	);
});
