import { browserHostIntegrations } from "@/runtime/browser-host-integrations";
import type { RuntimeHostIntegrationSuccessOutcome } from "@/runtime/types";
import {
	NOTIFICATION_TONE_ATTACK,
	NOTIFICATION_TONE_PEAK_GAIN,
	NOTIFICATION_TONE_QUEUE_GAP,
	NOTIFICATION_TONE_RELEASE,
	NOTIFICATION_TONES,
	type NotificationToneEventType,
	notificationToneDuration,
} from "../../../src/shared/notification-tones";

export type AudibleNotificationEventType = NotificationToneEventType;

export interface AudibleNotificationContext {
	projectId?: string | null;
	taskId?: string | null;
}

export type NotificationAudioOutcome = RuntimeHostIntegrationSuccessOutcome | "unavailable";

export class NotificationAudioPlayer {
	private audioContext: AudioContext | null = null;
	private nextAvailableTime = 0;
	constructor(
		private readonly hostIntegrations: Pick<
			typeof browserHostIntegrations,
			"runNotificationAudio"
		> = browserHostIntegrations,
	) {}

	ensureContext(): AudioContext | null {
		return this.hostIntegrations.runNotificationAudio(null, () => {
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
		}).value;
	}

	play(
		eventType: AudibleNotificationEventType,
		volume: number,
		context: AudibleNotificationContext = {},
	): Promise<NotificationAudioOutcome> {
		try {
			const result = this.hostIntegrations.runNotificationAudio(
				{
					eventType,
					volume,
					projectId: context.projectId,
					taskId: context.taskId,
				},
				() => {
					if (!this.audioContext) {
						return;
					}
					if (this.audioContext.state === "suspended") {
						this.audioContext.resume().catch(() => {});
					}

					const ctx = this.audioContext;
					const def = NOTIFICATION_TONES[eventType];
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
						gain.gain.linearRampToValueAtTime(
							clampedVolume * NOTIFICATION_TONE_PEAK_GAIN,
							beatStart + NOTIFICATION_TONE_ATTACK,
						);
						gain.gain.setValueAtTime(
							clampedVolume * NOTIFICATION_TONE_PEAK_GAIN,
							beatEnd - NOTIFICATION_TONE_RELEASE,
						);
						gain.gain.linearRampToValueAtTime(0, beatEnd);

						osc.connect(gain);
						gain.connect(ctx.destination);
						osc.start(beatStart);
						osc.stop(beatEnd);

						offset += def.beatDuration + def.beatGap;
					}

					this.nextAvailableTime = startTime + notificationToneDuration(def) + NOTIFICATION_TONE_QUEUE_GAP;
				},
			);
			return result.outcome === "simulated"
				? result.acknowledgement.then(() => result.outcome)
				: Promise.resolve(result.outcome);
		} catch (error) {
			return Promise.reject(error);
		}
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
