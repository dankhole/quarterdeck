import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeBrowserHostIntegrationEventRequest } from "../../src/core/api/host-integrations.js";
import { RUNTIME_MANAGEMENT_GENERATION_HEADER } from "../../src/core/api/runtime-management.js";
import {
	NOTIFICATION_TONE_ATTACK,
	NOTIFICATION_TONE_PEAK_GAIN,
	NOTIFICATION_TONE_RELEASE,
	NOTIFICATION_TONES,
	type NotificationToneEventType,
	notificationToneDuration,
} from "../../src/shared/notification-tones.js";
import type { SelectedRuntime } from "./runtime-selection.js";
import { DESKTOP_ORIGIN, DESKTOP_TOKEN_HEADER } from "./security-policy.js";

export interface NotificationToneRequest {
	eventType: NotificationToneEventType;
	volume: number;
	projectId: string | null;
	taskId: string | null;
}

export interface NotificationTonePlayback {
	play(request: NotificationToneRequest, signal: AbortSignal): Promise<void>;
	dispose(): Promise<void>;
}

const SAMPLE_RATE = 44_100;

/** Fixed, short PCM assets need no renderer, network, or bundled media dependency. */
export function createNotificationToneWave(eventType: NotificationToneEventType): Buffer {
	const definition = NOTIFICATION_TONES[eventType];
	const samples = Math.round(notificationToneDuration(definition) * SAMPLE_RATE);
	const wave = Buffer.alloc(44 + samples * 2);
	wave.write("RIFF", 0);
	wave.writeUInt32LE(wave.length - 8, 4);
	wave.write("WAVEfmt ", 8);
	wave.writeUInt32LE(16, 16);
	wave.writeUInt16LE(1, 20);
	wave.writeUInt16LE(1, 22);
	wave.writeUInt32LE(SAMPLE_RATE, 24);
	wave.writeUInt32LE(SAMPLE_RATE * 2, 28);
	wave.writeUInt16LE(2, 32);
	wave.writeUInt16LE(16, 34);
	wave.write("data", 36);
	wave.writeUInt32LE(samples * 2, 40);
	for (let beat = 0; beat < definition.frequencies.length; beat++) {
		const start = Math.round(beat * (definition.beatDuration + definition.beatGap) * SAMPLE_RATE);
		const length = Math.round(definition.beatDuration * SAMPLE_RATE);
		for (let sample = 0; sample < length; sample++) {
			const time = sample / SAMPLE_RATE;
			const envelope = Math.min(
				1,
				time / NOTIFICATION_TONE_ATTACK,
				(definition.beatDuration - time) / NOTIFICATION_TONE_RELEASE,
			);
			const value =
				Math.sin(2 * Math.PI * definition.frequencies[beat] * time) * envelope * NOTIFICATION_TONE_PEAK_GAIN;
			wave.writeInt16LE(Math.round(value * 32_767), 44 + (start + sample) * 2);
		}
	}
	return wave;
}

/** Main-process macOS playback. Only fixed tone files and bounded volume reach afplay. */
export class MacOSNotificationTonePlayback implements NotificationTonePlayback {
	private directory: Promise<string> | null = null;
	private disposed = false;

	async play({ eventType, volume }: NotificationToneRequest, signal: AbortSignal): Promise<void> {
		if (this.disposed || signal.aborted) return;
		this.directory ??= this.prepare();
		const preparation = this.directory;
		let directory: string;
		try {
			directory = await preparation;
		} catch (error) {
			// A later notification may recover from a transient filesystem failure.
			// Never clear another request's successful or newer preparation.
			if (this.directory === preparation) this.directory = null;
			throw error;
		}
		if (this.disposed || signal.aborted) return;
		await new Promise<void>((resolve, reject) => {
			execFile(
				"/usr/bin/afplay",
				["-v", String(volume), join(directory, `${eventType}.wav`)],
				{ signal, timeout: 2_000, maxBuffer: 1_024 },
				(error) => (error ? reject(error) : resolve()),
			);
		});
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		const directory = await this.directory?.catch(() => null);
		if (directory) await rm(directory, { recursive: true, force: true });
	}

	private async prepare(): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), "quarterdeck-notification-tones-"));
		try {
			const results = await Promise.allSettled(
				(Object.keys(NOTIFICATION_TONES) as NotificationToneEventType[]).map((eventType) =>
					writeFile(join(directory, `${eventType}.wav`), createNotificationToneWave(eventType), { mode: 0o600 }),
				),
			);
			const failed = results.find((result) => result.status === "rejected");
			if (failed?.status === "rejected") throw failed.reason;
			return directory;
		} catch (error) {
			await rm(directory, { recursive: true, force: true });
			throw error;
		}
	}
}

/** Synthetic desktop runs use the existing host ledger and never invoke native audio. */
export class SimulatedNotificationTonePlayback implements NotificationTonePlayback {
	constructor(private readonly runtime: SelectedRuntime) {}

	async play(request: NotificationToneRequest, signal: AbortSignal): Promise<void> {
		const body: RuntimeBrowserHostIntegrationEventRequest = {
			kind: "notification_audio",
			origin: "desktop",
			...request,
		};
		const response = await fetch(new URL("/api/agent-lab/host-events", this.runtime.origin), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: DESKTOP_ORIGIN,
				[DESKTOP_TOKEN_HEADER]: this.runtime.clientToken,
				[RUNTIME_MANAGEMENT_GENERATION_HEADER]: this.runtime.generation,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.any([signal, this.runtime.signal, AbortSignal.timeout(2_000)]),
		});
		if (!response.ok) throw new Error("Simulated notification audio was not recorded.");
	}

	async dispose(): Promise<void> {}
}
