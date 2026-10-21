import { Notification } from "electron";
import type { NotificationToneEventType } from "../../src/shared/notification-tones.js";
import { DesktopNotificationAudioPlayer } from "./notification-audio.js";
import { SimulatedNotificationTonePlayback } from "./notification-audio-playback.js";
import {
	DesktopNotificationSubscription,
	type DesktopNotificationSubscriptionOptions,
} from "./notification-subscription.js";

export interface DesktopNotificationsOptions
	extends Pick<
		DesktopNotificationSubscriptionOptions,
		"runtime" | "buildId" | "getFocus" | "onBadge" | "createSocket"
	> {
	synthetic: boolean;
	nativeNotifications: boolean;
	isCurrent: () => boolean;
	onClick: (target: { projectId: string | null; taskId: string | null }) => void;
	onAudioFailure: (eventType: NotificationToneEventType) => void;
}

/** Main owns custom tones independently from renderer health and macOS banner permission. */
export class DesktopNotifications {
	private readonly audio: DesktopNotificationAudioPlayer;
	private readonly subscription: DesktopNotificationSubscription;
	private disposal: Promise<void> | null = null;

	constructor(options: DesktopNotificationsOptions) {
		this.audio = new DesktopNotificationAudioPlayer({
			enabled: options.synthetic || process.platform === "darwin",
			signal: options.runtime.signal,
			playback: options.synthetic ? new SimulatedNotificationTonePlayback(options.runtime) : undefined,
			onFailure: options.onAudioFailure,
		});
		this.subscription = new DesktopNotificationSubscription({
			...options,
			onPresentationReset: this.audio.stop,
			onNotification: (event) => {
				if (!options.isCurrent()) return;
				this.audio.play(event.eventType, event.volume, event);
				if (options.synthetic || !options.nativeNotifications) return;
				const notification = new Notification({
					title: "Quarterdeck",
					subtitle: event.projectName,
					body: {
						permission: "A task needs your input.",
						review: "A task is ready for review.",
						failure: "A task needs attention.",
					}[event.eventType],
					silent: true,
				});
				notification.once("click", () => {
					if (options.isCurrent()) options.onClick(this.subscription.resolveTarget(event));
				});
				notification.show();
			},
		});
	}

	refreshFocus(): void {
		this.subscription.refreshFocus();
	}

	stop(): Promise<void> {
		if (this.disposal) return this.disposal;
		this.subscription.stop();
		// Guarded quit awaits asset cleanup, including preparation already in flight.
		// A stalled filesystem must not indefinitely retain the app's quit lease.
		let timer: ReturnType<typeof setTimeout>;
		this.disposal = Promise.race([
			this.audio.dispose(),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, 2_000);
			}),
		]).finally(() => clearTimeout(timer));
		return this.disposal;
	}
}
