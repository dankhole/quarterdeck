import { NOTIFICATION_TONE_QUEUE_GAP, type NotificationToneEventType } from "../../src/shared/notification-tones.js";
import {
	MacOSNotificationTonePlayback,
	type NotificationTonePlayback,
	type NotificationToneRequest,
} from "./notification-audio-playback.js";

const MAX_PENDING_TONES = 8;

function waitBetweenTones(signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, NOTIFICATION_TONE_QUEUE_GAP * 1_000);
		signal.addEventListener("abort", finish, { once: true });
		if (signal.aborted) finish();
	});
}

/** Playback policy stays separate from notification ownership and the native audio mechanism. */
export class DesktopNotificationAudioPlayer {
	private readonly queue: NotificationToneRequest[] = [];
	private active: AbortController | null = null;
	private disposed = false;
	private disposal: Promise<void> | null = null;

	private readonly playback: NotificationTonePlayback;
	constructor(
		private readonly options: {
			enabled: boolean;
			signal: AbortSignal;
			playback?: NotificationTonePlayback;
			onFailure: (eventType: NotificationToneEventType) => void;
		},
	) {
		this.playback = options.playback ?? new MacOSNotificationTonePlayback();
		options.signal.addEventListener("abort", this.onAbort, { once: true });
		if (options.signal.aborted) this.onAbort();
	}

	play(eventType: NotificationToneEventType, volume: number, context: { projectId: string; taskId: string }): void {
		if (!this.options.enabled || this.disposed || !Number.isFinite(volume) || volume <= 0) return;
		if (this.queue.length >= MAX_PENDING_TONES) return;
		this.queue.push({ eventType, volume: Math.min(1, volume), projectId: context.projectId, taskId: context.taskId });
		if (!this.active) {
			const controller = new AbortController();
			this.active = controller;
			void this.drain(controller);
		}
	}

	/** Ownership loss and preference changes cancel queued and current presentation. */
	stop = (): void => {
		this.queue.length = 0;
		this.active?.abort();
		this.active = null;
	};

	dispose = (): Promise<void> => {
		if (this.disposal) return this.disposal;
		this.disposed = true;
		this.options.signal.removeEventListener("abort", this.onAbort);
		this.stop();
		this.disposal = this.playback.dispose().catch(() => undefined);
		return this.disposal;
	};

	private onAbort = (): void => {
		void this.dispose();
	};

	private async drain(controller: AbortController): Promise<void> {
		try {
			while (!controller.signal.aborted) {
				const next = this.queue.shift();
				if (!next) return;
				try {
					await this.playback.play(next, controller.signal);
				} catch {
					/* An unavailable output or failed player must not block later notifications. */
					if (!controller.signal.aborted) {
						try {
							this.options.onFailure(next.eventType);
						} catch {
							/* Diagnostic delivery does not own the notification queue. */
						}
					}
				}
				if (!controller.signal.aborted) await waitBetweenTones(controller.signal);
			}
		} finally {
			if (this.active === controller) this.active = null;
		}
	}
}
