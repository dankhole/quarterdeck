export type NotificationToneEventType = "permission" | "review" | "failure";

export interface NotificationToneDefinition {
	readonly frequencies: readonly number[];
	readonly beatDuration: number;
	readonly beatGap: number;
}

/** Quarterdeck's tones are shared by browser previews and desktop playback. Times are seconds. */
export const NOTIFICATION_TONES: Readonly<Record<NotificationToneEventType, NotificationToneDefinition>> = {
	permission: { frequencies: [660, 660], beatDuration: 0.1, beatGap: 0.08 },
	review: { frequencies: [440], beatDuration: 0.15, beatGap: 0 },
	failure: { frequencies: [740, 740, 740], beatDuration: 0.1, beatGap: 0.08 },
};

export const NOTIFICATION_TONE_PEAK_GAIN = 0.4;
export const NOTIFICATION_TONE_ATTACK = 0.01;
export const NOTIFICATION_TONE_RELEASE = 0.02;
export const NOTIFICATION_TONE_QUEUE_GAP = 0.35;

export function notificationToneDuration(definition: NotificationToneDefinition): number {
	return (
		definition.frequencies.length * definition.beatDuration +
		Math.max(0, definition.frequencies.length - 1) * definition.beatGap
	);
}
