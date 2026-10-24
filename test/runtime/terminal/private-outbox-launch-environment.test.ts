import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IPty, spawn } from "node-pty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as runtimeStateHome from "../../../src/core/runtime-state-home";
import { enqueueHookTransition } from "../../../src/hook-transition-outbox-core";
import { prepareAgentLaunch } from "../../../src/terminal/agent-session-adapters";
import { QUARTERDECK_HOOK_PRIVATE_OUTBOX_ENV } from "../../../src/terminal/hook-runtime-context";
import { PtySession, _testing as ptyTesting } from "../../../src/terminal/pty-session";
import { buildTerminalEnvironment } from "../../../src/terminal/session-manager-types";

const prepareCapability = vi.hoisted(() => vi.fn<() => Promise<string | undefined>>());
vi.mock("../../../src/hook-transition-outbox-private-directory", () => ({
	prepareHookTransitionOutboxDirectoryCapability: prepareCapability,
}));
vi.mock("../../../src/terminal/worktree-context", () => ({ buildWorktreeContextPrompt: vi.fn(async () => "") }));
vi.mock("../../../src/terminal/pty-runtime-health", () => ({
	preflightPtyLaunch: vi.fn(),
	classifyPtySpawnFailure: vi.fn(),
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const inheritedKey = QUARTERDECK_HOOK_PRIVATE_OUTBOX_ENV.toLowerCase();
let stateHome: string;
let matchingCapability: string;
const ptySpawn = vi.fn<typeof spawn>();

beforeEach(async () => {
	prepareCapability.mockReset().mockResolvedValue(undefined);
	ptySpawn.mockReset();
	stateHome = await mkdtemp(join(tmpdir(), "quarterdeck-private-outbox-launch-"));
	vi.stubEnv("QUARTERDECK_STATE_HOME", stateHome);
	vi.spyOn(runtimeStateHome, "getRuntimeHomePath").mockReturnValue(stateHome);
	const directory = join(stateHome, "hook-transition-outbox");
	await mkdir(directory, { mode: 0o700 });
	const identity = await stat(directory, { bigint: true });
	matchingCapability = JSON.stringify({
		version: 1,
		path: await realpath(directory),
		dev: identity.dev.toString(),
		ino: identity.ino.toString(),
	});
	const fakePty: IPty = {
		pid: 4242,
		cols: 80,
		rows: 24,
		process: "synthetic",
		handleFlowControl: false,
		onData: () => ({ dispose: () => undefined }),
		onExit: () => ({ dispose: () => undefined }),
		resize: () => undefined,
		clear: () => undefined,
		write: () => undefined,
		kill: () => undefined,
		pause: () => undefined,
		resume: () => undefined,
	};
	ptySpawn.mockReturnValue(fakePty);
	ptyTesting.setNodePtySpawnOverride(ptySpawn);
});

afterEach(async () => {
	if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
	ptyTesting.setNodePtySpawnOverride(null);
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	await rm(stateHome, { recursive: true, force: true });
});

describe("private outbox capability at the final Windows PTY boundary", () => {
	it.each(["claude", "codex", "pi"] as const)(
		"preserves preparation success and rejects inherited proof after failure or absent hooks for %s",
		async (agentId) => {
			for (const scenario of ["preparation_failed", "no_hooks", "prepared"] as const) {
				// Prepare the adapter under the real host platform; only the actual
				// terminal environment/PTY boundary needs Windows key semantics.
				if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
				prepareCapability.mockResolvedValue(scenario === "prepared" ? matchingCapability : undefined);
				const inherited = { Quarterdeck_Hook_Private_Outbox: matchingCapability };
				const launch = await prepareAgentLaunch({
					taskId: "task-1",
					agentId,
					args: [],
					cwd: stateHome,
					prompt: "",
					projectId: scenario === "no_hooks" ? undefined : "project-1",
					hookSessionInstanceId: "launch-1",
					env: inherited,
				});
				Object.defineProperty(process, "platform", { value: "win32", configurable: true });
				vi.stubEnv(inheritedKey, matchingCapability);
				const terminalEnv = buildTerminalEnvironment(inherited, launch.env);
				PtySession.spawn({ binary: "cmd.exe", cwd: stateHome, env: terminalEnv, cols: 80, rows: 24 });
				const spawnEnv = ptySpawn.mock.lastCall?.[2].env;
				expect(spawnEnv).toBeDefined();
				const capabilityEntries = Object.entries(spawnEnv ?? {}).filter(
					([key]) => key.toLowerCase() === inheritedKey,
				);
				const expected = scenario === "prepared" ? matchingCapability : "";
				expect(capabilityEntries).toEqual([[QUARTERDECK_HOOK_PRIVATE_OUTBOX_ENV, expected]]);

				// Consume the exact value reaching the PTY as a hook would, with an
				// old proof that still matches this directory waiting in process.env.
				vi.stubEnv(QUARTERDECK_HOOK_PRIVATE_OUTBOX_ENV, expected);
				const id = "00000000-0000-4000-8000-000000000001";
				await expect(
					enqueueHookTransition({
						taskId: "task-1",
						projectId: "project-1",
						event: "to_review",
						metadata: {
							source: "claude",
							hookEventName: "Stop",
							sessionInstanceId: "launch-1",
							finalMessage: "synthetic reply",
						},
						delivery: { id, occurredAt: 100 },
					}),
				).resolves.toBe(true);
				const record = JSON.parse(await readFile(join(stateHome, "hook-transition-outbox", `${id}.json`), "utf8"));
				expect(record.request.delivery).toEqual({ id, occurredAt: 100 });
				expect(record.request.metadata.finalMessage).toBe(scenario === "prepared" ? "synthetic reply" : undefined);
			}
		},
	);
});
