import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { desktopChildMessageSchema } from "../../src/core/api/desktop-runtime-protocol.js";

describe("private desktop runtime shutdown channel", () => {
	let directory: string;
	const children: ChildProcess[] = [];
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "quarterdeck-desktop-channel-"));
	});
	afterEach(async () => {
		for (const child of children.splice(0)) {
			if (child.exitCode !== null || child.signalCode !== null) continue;
			const exited = new Promise<void>((done) => child.once("exit", () => done()));
			child.kill("SIGKILL");
			await exited;
		}
		await rm(directory, { recursive: true, force: true });
	});

	async function launch(finalStatus = "clean") {
		const startupId = randomUUID();
		const evidencePath = join(directory, `${startupId}.txt`);
		const child = fork(resolve("test/utilities/desktop-channel-child.ts"), [evidencePath, finalStatus], {
			execArgv: ["--import", "tsx"],
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		children.push(child);
		child.stdout?.resume();
		let stderr = "";
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		const exit = new Promise<number | null>((done) => child.once("exit", done));
		const ready = new Promise<void>((done, reject) => {
			child.once("error", reject);
			child.once("exit", (code) => reject(new Error(`Fixture exited before ready (${code}): ${stderr}`)));
			child.once("message", (value: unknown) => {
				const message = desktopChildMessageSchema.parse(value);
				if (message.type === "quarterdeck:desktop-ready") done();
				else reject(new Error("Unexpected fixture readiness."));
			});
		});
		child.send({
			type: "quarterdeck:desktop-startup",
			protocolVersion: 1,
			startupId,
			clientToken: "a".repeat(43),
			allowedOrigins: ["app://quarterdeck"],
		});
		await ready;
		function requestStop(requestId = randomUUID()) {
			child.send({ type: "quarterdeck:desktop-shutdown", protocolVersion: 1, startupId, requestId });
			return requestId;
		}
		return { child, requestStop, exit, evidencePath };
	}

	it("finishes pending cleanup after the parent disconnects following a bounded timeout", async () => {
		const fixture = await launch();
		const result = new Promise<unknown>((done) => fixture.child.once("message", done));
		fixture.requestStop();
		expect(await result).toMatchObject({ outcome: { status: "incomplete", safeToExit: false } });
		expect(fixture.child.exitCode).toBeNull();
		fixture.child.disconnect();
		expect(await fixture.exit).toBe(0);
		expect(await readFile(fixture.evidencePath, "utf8")).toBe("bounded\ncompletion\n");
	});

	it("drains completion when disconnection races the bounded shutdown", async () => {
		const fixture = await launch();
		fixture.requestStop();
		fixture.child.disconnect();
		expect(await fixture.exit).toBe(0);
		expect(await readFile(fixture.evidencePath, "utf8")).toBe("bounded\ncompletion\n");
	});

	it("exits unsuccessfully after disconnected cleanup completes with an unconfirmed result", async () => {
		const fixture = await launch("incomplete");
		fixture.child.disconnect();
		expect(await fixture.exit).toBe(1);
		expect(await readFile(fixture.evidencePath, "utf8")).toBe("completion\n");
	});

	it("answers concurrent shutdown requests instead of dropping an earlier request", async () => {
		const fixture = await launch();
		const messages: string[] = [];
		const both = new Promise<void>((done) =>
			fixture.child.on("message", (value: unknown) => {
				const message = desktopChildMessageSchema.parse(value);
				if (message.type !== "quarterdeck:desktop-shutdown-result") return;
				messages.push(message.requestId);
				if (messages.length === 2) done();
			}),
		);
		const ids = [fixture.requestStop(), fixture.requestStop()];
		await both;
		expect(messages.sort()).toEqual(ids.sort());
		fixture.child.disconnect();
		expect(await fixture.exit).toBe(0);
	});
});
