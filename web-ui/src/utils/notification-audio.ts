export type AudibleNotificationEventType = "permission" | "review" | "failure";

interface ToneDefinition {
	/** Frequency in Hz for each beat. */
	frequencies: number[];
	/** Duration of each beat in seconds. */
	beatDuration: number;
	/** Gap between beats in seconds. */
	beatGap: number;
}

const TONE_DEFINITIONS: Record<AudibleNotificationEventType, ToneDefinition> = {
	permission: {
		frequencies: [660, 660],
		beatDuration: 0.1,
		beatGap: 0.08,
	},
	review: {
		frequencies: [440],
		beatDuration: 0.15,
		beatGap: 0,
	},
	failure: {
		frequencies: [740, 740, 740],
		beatDuration: 0.1,
		beatGap: 0.08,
	},
};

/** Total duration of a tone pattern in seconds. */
function toneDuration(def: ToneDefinition): number {
	const beats = def.frequencies.length;
	return beats * def.beatDuration + Math.max(0, beats - 1) * def.beatGap;
}

/** Gap between queued notifications in seconds. */
const QUEUE_GAP = 0.35;

export class NotificationAudioPlayer {
	private audioContext: AudioContext | null = null;
	private nextAvailableTime = 0;

	ensureContext(): AudioContext | null {
		if (this.audioContext) {
			if (this.audioContext.state === "suspended") {
				this.audioContext.resume().catch(() => {});
			}
			return this.audioContext;
		}
		try {
			this.audioContext = new AudioContext();
			if (this.audioContext.state === "suspended") {
				this.audioContext.resume().catch(() => {});
			}
			return this.audioContext;
		} catch {
			return null;
		}
	}

	play(eventType: AudibleNotificationEventType, volume: number): void {
		if (!this.audioContext) {
			return;
		}
		if (this.audioContext.state === "suspended") {
			this.audioContext.resume().catch(() => {});
		}

		const ctx = this.audioContext;
		const def = TONE_DEFINITIONS[eventType];
		const clampedVolume = Math.max(0, Math.min(1, volume));

		// Queue: schedule after the previous sound finishes (or now if nothing is queued).
		const now = ctx.currentTime;
		const startTime = Math.max(now, this.nextAvailableTime);

		let offset = 0;
		for (const freq of def.frequencies) {
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();

			osc.type = "sine";
			osc.frequency.value = freq;

			// Ramp in and out to avoid clicks.
			const beatStart = startTime + offset;
			const beatEnd = beatStart + def.beatDuration;
			gain.gain.setValueAtTime(0, beatStart);
			gain.gain.linearRampToValueAtTime(clampedVolume * 0.4, beatStart + 0.01);
			gain.gain.setValueAtTime(clampedVolume * 0.4, beatEnd - 0.02);
			gain.gain.linearRampToValueAtTime(0, beatEnd);

			osc.connect(gain);
			gain.connect(ctx.destination);
			osc.start(beatStart);
			osc.stop(beatEnd);

			offset += def.beatDuration + def.beatGap;
		}

		this.nextAvailableTime = startTime + toneDuration(def) + QUEUE_GAP;
	}

	dispose(): void {
		if (this.audioContext) {
			this.audioContext.close().catch(() => {});
			this.audioContext = null;
		}
		this.nextAvailableTime = 0;
	}
}

export const notificationAudioPlayer = new NotificationAudioPlayer();
