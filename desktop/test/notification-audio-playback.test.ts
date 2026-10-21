import * as fileSystem from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_TONES, notificationToneDuration } from "../../src/shared/notification-tones.js";
import {
	createNotificationToneWave,
	MacOSNotificationTonePlayback,
	type NotificationToneRequest,
	SimulatedNotificationTonePlayback,
} from "../src/notification-audio-playback.js";

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile }));
vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof fileSystem>();
	return { ...original, writeFile: vi.fn(original.writeFile) };
});

const request: NotificationToneRequest = { eventType: "review", volume: 0.4, projectId: "project", taskId: "task" };
describe("main-process notification playback", () => {
	const players: MacOSNotificationTonePlayback[] = [];
	afterEach(async () => {
		await Promise.all(players.splice(0).map((player) => player.dispose()));
		vi.restoreAllMocks();
		vi.mocked(fileSystem.writeFile).mockReset();
		vi.unstubAllGlobals();
		execFile.mockReset();
	});
	function player() {
		const value = new MacOSNotificationTonePlayback();
		players.push(value);
		return value;
	}
	it("renders the same frequencies, beat counts, duration and gain envelope as browser playback", () => {
		for (const eventType of ["permission", "review", "failure"] as const) {
			const wave = createNotificationToneWave(eventType);
			const definition = NOTIFICATION_TONES[eventType];
			expect(wave.toString("ascii", 0, 4)).toBe("RIFF");
			expect(wave.toString("ascii", 8, 16)).toBe("WAVEfmt ");
			expect(wave.readUInt16LE(22)).toBe(1);
			expect(wave.readUInt32LE(24)).toBe(44_100);
			expect(wave.length).toBe(44 + Math.round(notificationToneDuration(definition) * 44_100) * 2);
			for (let beat = 0; beat < definition.frequencies.length; beat++) {
				const beatStart = Math.round(beat * (definition.beatDuration + definition.beatGap) * 44_100);
				const sample = Math.round(0.025 * 44_100);
				const expected = Math.round(
					Math.sin((2 * Math.PI * definition.frequencies[beat] * sample) / 44_100) * 0.4 * 32_767,
				);
				expect(wave.readInt16LE(44 + beatStart * 2)).toBe(0);
				expect(wave.readInt16LE(44 + (beatStart + sample) * 2)).toBe(expected);
			}
		}
	});
	it("uses only a fixed player, private generated assets, bounded deadline and configured volume", async () => {
		execFile.mockImplementation((_file, _args, _options, callback) => callback(null));
		const playback = player();
		const signal = new AbortController().signal;
		await playback.play(request, signal);
		const [command, args, options] = execFile.mock.calls[0];
		expect(command).toBe("/usr/bin/afplay");
		expect(args.slice(0, 2)).toEqual(["-v", "0.4"]);
		expect(options).toEqual({ signal, timeout: 2_000, maxBuffer: 1_024 });
		expect((await fileSystem.stat(dirname(args[2]))).mode & 0o777).toBe(0o700);
		expect((await fileSystem.stat(args[2])).mode & 0o777).toBe(0o600);
		expect(await fileSystem.readFile(args[2])).toEqual(createNotificationToneWave("review"));
		await playback.dispose();
		await expect(fileSystem.stat(dirname(args[2]))).rejects.toMatchObject({ code: "ENOENT" });
	});
	it.each(["spawn failure", "timeout"])("propagates a %s for bounded content-safe reporting", async (message) => {
		execFile.mockImplementation((_file, _args, _options, callback) => callback(new Error(message)));
		await expect(player().play(request, new AbortController().signal)).rejects.toThrow(message);
	});
	it("fences an aborted runtime or disposed player while asset preparation is pending", async () => {
		const playback = player();
		const controller = new AbortController();
		const pending = playback.play(request, controller.signal);
		controller.abort();
		await pending;
		expect(execFile).not.toHaveBeenCalled();
		const second = player();
		const preparing = second.play(request, new AbortController().signal);
		await second.dispose();
		await preparing;
		expect(execFile).not.toHaveBeenCalled();
	});
	it("drains all asset writes before cleaning a partial preparation failure", async () => {
		const originalWrite = vi.mocked(fileSystem.writeFile).getMockImplementation();
		if (!originalWrite) throw new Error("Missing original asset writer");
		let release: (() => void) | undefined;
		let directory: string | undefined;
		vi.mocked(fileSystem.writeFile).mockImplementation(async (path, data, options) => {
			directory = dirname(String(path));
			if (String(path).endsWith("permission.wav")) throw new Error("asset failed");
			if (String(path).endsWith("review.wav"))
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			await originalWrite(path, data, options);
		});
		const pending = player().play(request, new AbortController().signal);
		const result = expect(pending).rejects.toThrow("asset failed");
		await vi.waitFor(() => expect(release).toBeDefined());
		if (!directory) throw new Error("Missing prepared directory");
		expect(await fileSystem.stat(directory)).toBeDefined();
		release?.();
		await result;
		await expect(fileSystem.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
		expect(execFile).not.toHaveBeenCalled();
	});
	it("retries failed asset preparation only when another notification arrives", async () => {
		vi.mocked(fileSystem.writeFile).mockRejectedValueOnce(new Error("temporary asset failure"));
		execFile.mockImplementation((_file, _args, _options, callback) => callback(null));
		const playback = player();
		const signal = new AbortController().signal;
		await expect(playback.play(request, signal)).rejects.toThrow("temporary asset failure");
		expect(execFile).not.toHaveBeenCalled();
		await playback.play(request, signal);
		expect(execFile).toHaveBeenCalledOnce();
	});
	it("records synthetic desktop provenance through authenticated simulation and never spawns audio", async () => {
		const fetch = vi.fn().mockResolvedValue({ ok: true });
		vi.stubGlobal("fetch", fetch);
		const runtime = {
			origin: "http://127.0.0.1:4567",
			generation: "generation",
			clientToken: "private",
			signal: new AbortController().signal,
		};
		await new SimulatedNotificationTonePlayback(runtime).play(request, new AbortController().signal);
		expect(fetch).toHaveBeenCalledWith(
			new URL("/api/agent-lab/host-events", runtime.origin),
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					"X-Quarterdeck-Desktop-Token": "private",
					"x-quarterdeck-runtime-generation": "generation",
				}),
				body: JSON.stringify({ kind: "notification_audio", origin: "desktop", ...request }),
			}),
		);
		expect(execFile).not.toHaveBeenCalled();
	});
});
