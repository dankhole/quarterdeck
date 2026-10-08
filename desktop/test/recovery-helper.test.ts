import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopRecoveryHelper, type DesktopRecoveryHelperOptions } from "../src/recovery-helper.js";

const children: ChildProcess[] = [];
afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(
		children.splice(0).map(async (child) => {
			if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
			const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
			child.kill("SIGKILL");
			await exited;
		}),
	);
});

function helper(mode = "recovered", overrides: Partial<DesktopRecoveryHelperOptions> = {}) {
	const spawnChild = vi.fn((executable, args, options) => {
		expect(executable).toBe("/synthetic/bin/node");
		expect(args).toEqual(["/synthetic/dist/cli.js", "recover", "--confirm-stopped"]);
		expect(options).toMatchObject({
			cwd: "/synthetic",
			stdio: ["ignore", "ignore", "ignore"],
			shell: false,
			detached: false,
			env: { QUARTERDECK_STATE_HOME: "/synthetic/state", PROVIDER_SETTING: "retained" },
		});
		for (const name of [
			"QUARTERDECK_DESKTOP_CHILD",
			"QUARTERDECK_DESKTOP_LAB_CONFIG",
			"QUARTERDECK_AGENT_LAB",
			"NODE_OPTIONS",
			"NODE_PATH",
			"DYLD_INSERT_LIBRARIES",
		]) {
			expect(options.env?.[name]).toBeUndefined();
		}
		const child = spawn(
			process.execPath,
			[fileURLToPath(new URL("./fixtures/recovery-helper.mjs", import.meta.url))],
			{
				...options,
				cwd: undefined,
				...(mode === "timeout" ? { stdio: ["ignore", "ignore", "ignore", "ipc"] as const } : {}),
			},
		);
		children.push(child);
		return child;
	});
	const options: DesktopRecoveryHelperOptions = {
		bundle: {
			root: "/synthetic",
			nodePath: "/synthetic/bin/node",
			cliPath: "/synthetic/dist/cli.js",
			version: "0.12.8",
			buildId: "synthetic",
			sourceSha: "a".repeat(40),
			arch: process.arch,
		},
		launch: { synthetic: true, stateHome: "/synthetic/state", projectPath: "/synthetic/project" },
		environment: {
			...process.env,
			DESKTOP_RECOVERY_FIXTURE_MODE: mode,
			PROVIDER_SETTING: "retained",
			QUARTERDECK_STATE_HOME: "/untrusted/inherited-state",
			QUARTERDECK_DESKTOP_CHILD: "1",
			QUARTERDECK_DESKTOP_LAB_CONFIG: "/untrusted/lab.json",
			QUARTERDECK_AGENT_LAB: "1",
			NODE_OPTIONS: "--require /untrusted/inject.js",
			NODE_PATH: "/untrusted/modules",
			DYLD_INSERT_LIBRARIES: "/untrusted/inject.dylib",
		},
		deadlineMs: 1000,
		terminationDeadlineMs: 100,
		spawnChild,
		...overrides,
	};
	return { owner: new DesktopRecoveryHelper(options), spawnChild };
}

describe("trusted desktop recovery helper", () => {
	it("uses fixed bundled commands, trusted state home, sanitized environment, and actual exit", async () => {
		const { owner, spawnChild } = helper();
		const result = owner.run();
		expect(owner.isRunning()).toBe(true);
		expect(await owner.run()).toBe("unavailable");
		expect(await result).toBe("recovered");
		expect(owner.isRunning()).toBe(false);
		expect(spawnChild).toHaveBeenCalledOnce();
		expect(children[0]?.exitCode).toBe(0);
	});

	it("keeps recovery blocked on nonzero exit and spawn failure", async () => {
		expect(await helper("failed").owner.run()).toBe("failed");
		const fixture = helper("recovered", {
			spawnChild: () => {
				throw new Error("private environment contents");
			},
		});
		expect(await fixture.owner.run()).toBe("failed");
		expect(fixture.owner.isRunning()).toBe(false);
	});

	it("terminates only its newly spawned maintenance child and waits for actual exit on timeout", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const fixture = helper("timeout", { deadlineMs: 100 });
		const result = fixture.owner.run();
		const child = children[0];
		if (!child) throw new Error("Expected a spawned maintenance child");
		expect(await once(child, "message")).toEqual(["ready", undefined]);
		await vi.advanceTimersByTimeAsync(200);
		expect(await result).toBe("timed_out");
		expect(fixture.owner.isRunning()).toBe(false);
		expect(children[0]?.signalCode).toBe("SIGKILL");
		expect(fixture.spawnChild).toHaveBeenCalledOnce();
	});

	it("keeps an unconfirmed maintenance child fenced after bounded cleanup", async () => {
		const child = Object.assign(new EventEmitter(), { pid: 123, kill: vi.fn(() => false) });
		const fixture = helper("timeout", {
			deadlineMs: 1,
			terminationDeadlineMs: 1,
			spawnChild: () => child as unknown as ChildProcess,
		});
		expect(await fixture.owner.run()).toBe("timed_out");
		expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
		expect(fixture.owner.isRunning()).toBe(true);
		expect(await fixture.owner.run()).toBe("unavailable");
		child.emit("exit", null);
		expect(fixture.owner.isRunning()).toBe(false);
	});
});
