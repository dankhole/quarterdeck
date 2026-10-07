import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { desktopChildMessageSchema } from "../../src/core/api/desktop-runtime-protocol.js";

describe("private host effects across the actual helper IPC channel", () => {
	let directory: string;
	const children: ChildProcess[] = [];
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "quarterdeck-host-ipc-"));
	});
	afterEach(async () => {
		for (const child of children.splice(0)) {
			if (child.exitCode !== null || child.signalCode !== null) continue;
			const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
			child.kill("SIGKILL");
			await exited;
		}
		await rm(directory, { recursive: true, force: true });
	});

	it.each(["owned", "attached"] as const)("forwards only the %s helper's admitted effects", async (ownership) => {
		const evidence = join(directory, "result.json");
		const startupId = randomUUID();
		const child = fork(resolve("test/utilities/desktop-host-effects-child.ts"), [evidence, ownership], {
			execArgv: ["--import", "tsx"],
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		children.push(child);
		child.stderr?.resume();
		let requests = 0;
		child.on("message", (input: unknown) => {
			const message = desktopChildMessageSchema.parse(input);
			if (message.type !== "quarterdeck:desktop-host-request") return;
			requests++;
			const { action: _action, ...identity } = message;
			const response = { ...identity, type: "quarterdeck:desktop-host-result", result: { status: "cancelled" } };
			// A parent reply for another generation must not complete this request.
			child.send({ ...response, runtimeGeneration: randomUUID() });
			child.send(response);
		});
		const exited = new Promise<number | null>((resolve, reject) => {
			child.once("exit", resolve);
			child.once("error", reject);
		});
		child.send({
			type: "quarterdeck:desktop-startup",
			protocolVersion: 1,
			startupId,
			clientToken: "a".repeat(43),
			allowedOrigins: ["app://quarterdeck"],
		});
		expect(await exited).toBe(0);
		expect(JSON.parse(await readFile(evidence, "utf8"))).toEqual(
			ownership === "owned" ? { status: "cancelled" } : { status: "failed", reason: "disconnected" },
		);
		expect(requests).toBe(ownership === "owned" ? 1 : 0);
	});
});
