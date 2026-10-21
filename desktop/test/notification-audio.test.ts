import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopNotificationAudioPlayer } from "../src/notification-audio.js";
import type { NotificationTonePlayback } from "../src/notification-audio-playback.js";

describe("desktop notification audio policy", () => {
	let runtime: AbortController;
	let player: DesktopNotificationAudioPlayer;
	let playback: NotificationTonePlayback;
	const play = vi.fn<NotificationTonePlayback["play"]>();
	const dispose = vi.fn<NotificationTonePlayback["dispose"]>();
	const failure = vi.fn();
	const context = { projectId: "project", taskId: "task" };
	beforeEach(() => {
		vi.useFakeTimers();
		runtime = new AbortController();
		play.mockReset().mockResolvedValue(undefined);
		dispose.mockReset().mockResolvedValue(undefined);
		failure.mockReset();
		playback = { play, dispose };
	});
	afterEach(() => {
		player?.dispose();
		vi.useRealTimers();
	});
	function start(enabled = true) {
		player = new DesktopNotificationAudioPlayer({ enabled, signal: runtime.signal, playback, onFailure: failure });
	}
	it("preserves each custom tone and fractional volume while serializing with the shared gap", async () => {
		start();
		player.play("permission", 0.4, context);
		player.play("review", 2, context);
		player.play("failure", 0.25, context);
		expect(play).toHaveBeenCalledOnce();
		expect(play.mock.calls[0][0]).toEqual({ eventType: "permission", volume: 0.4, ...context });
		await vi.advanceTimersByTimeAsync(349);
		expect(play).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		expect(play.mock.calls[1][0]).toEqual({ eventType: "review", volume: 1, ...context });
		await vi.advanceTimersByTimeAsync(350);
		expect(play.mock.calls[2][0]).toEqual({ eventType: "failure", volume: 0.25, ...context });
	});
	it("does no audio work for mute, invalid volume, disabled or already-aborted launches", () => {
		start();
		for (const volume of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) player.play("review", volume, context);
		expect(play).not.toHaveBeenCalled();
		player.dispose();
		start(false);
		player.play("review", 1, context);
		expect(play).not.toHaveBeenCalled();
		player.dispose();
		runtime.abort();
		start();
		player.play("review", 1, context);
		expect(play).not.toHaveBeenCalled();
	});
	it("bounds the backlog to eight tones beyond the current playback", async () => {
		start();
		for (let index = 0; index < 50; index++) player.play("review", 0.5, context);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(play).toHaveBeenCalledTimes(9);
	});
	it("cancels current and queued sounds on ownership loss and permits only fresh sounds after reacquisition", async () => {
		let finish: (() => void) | undefined;
		play.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		start();
		player.play("review", 0.5, context);
		player.play("failure", 0.5, context);
		const oldSignal = play.mock.calls[0][1];
		player.stop();
		expect(oldSignal.aborted).toBe(true);
		player.play("permission", 0.5, context);
		finish?.();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(play.mock.calls.map(([request]) => request.eventType)).toEqual(["review", "permission"]);
	});
	it("reports playback errors without leaking details or blocking later notifications", async () => {
		play.mockRejectedValueOnce(new Error("private path and process failure"));
		start();
		player.play("failure", 0.5, context);
		player.play("review", 0.5, context);
		await vi.advanceTimersByTimeAsync(350);
		expect(failure).toHaveBeenCalledExactlyOnceWith("failure");
		expect(play).toHaveBeenCalledTimes(2);
	});
	it("aborts immediately and disposes once on runtime replacement or quit", async () => {
		play.mockImplementation(
			(_request, signal) =>
				new Promise<void>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		);
		start();
		player.play("review", 0.5, context);
		player.play("failure", 0.5, context);
		runtime.abort();
		player.dispose();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(play.mock.calls[0][1].aborted).toBe(true);
		expect(play).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
		expect(failure).not.toHaveBeenCalled();
	});
	it("returns the same cleanup promise so guarded quit can await prepared-asset disposal", async () => {
		let finish: (() => void) | undefined;
		dispose.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		start();
		const cleanup = player.dispose();
		expect(player.dispose()).toBe(cleanup);
		const completed = vi.fn();
		void cleanup.then(completed);
		await Promise.resolve();
		expect(completed).not.toHaveBeenCalled();
		finish?.();
		await cleanup;
		expect(completed).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
	});
});
