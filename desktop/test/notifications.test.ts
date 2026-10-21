import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopNotificationSubscriptionOptions } from "../src/notification-subscription.js";
import { DesktopNotifications, type DesktopNotificationsOptions } from "../src/notifications.js";

const mocks = vi.hoisted(() => ({
	play: vi.fn(),
	stopAudio: vi.fn(),
	disposeAudio: vi.fn(),
	audio: vi.fn(),
	native: vi.fn(),
	show: vi.fn(),
	once: vi.fn(),
	subscription: vi.fn(),
	stopSubscription: vi.fn(),
	refreshFocus: vi.fn(),
	resolveTarget: vi.fn(),
}));
vi.mock("electron", () => ({ Notification: mocks.native }));
vi.mock("../src/notification-audio.js", () => ({ DesktopNotificationAudioPlayer: mocks.audio }));
vi.mock("../src/notification-subscription.js", () => ({ DesktopNotificationSubscription: mocks.subscription }));

describe("desktop notification presentation wiring", () => {
	let presenter: DesktopNotifications;
	let options: DesktopNotificationsOptions;
	let subscription: DesktopNotificationSubscriptionOptions;
	const event = {
		eventType: "review" as const,
		projectId: "project",
		taskId: "task",
		eventId: "edge",
		projectName: "Project",
		volume: 0.4,
	};
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.disposeAudio.mockResolvedValue(undefined);
		mocks.audio.mockImplementation(function AudioPlayerMock() {
			return { play: mocks.play, stop: mocks.stopAudio, dispose: mocks.disposeAudio };
		});
		mocks.native.mockImplementation(function NativeNotificationMock() {
			return { show: mocks.show, once: mocks.once };
		});
		mocks.subscription.mockImplementation(function SubscriptionMock(value) {
			subscription = value;
			return { stop: mocks.stopSubscription, refreshFocus: mocks.refreshFocus, resolveTarget: mocks.resolveTarget };
		});
		options = {
			runtime: {
				origin: "http://127.0.0.1:1234",
				generation: "generation",
				clientToken: "private",
				signal: new AbortController().signal,
			},
			buildId: "build",
			synthetic: false,
			nativeNotifications: true,
			isCurrent: () => true,
			getFocus: () => ({ focused: false, currentProjectId: null }),
			onBadge: vi.fn(),
			onClick: vi.fn(),
			onAudioFailure: vi.fn(),
		};
	});
	afterEach(async () => {
		await presenter?.stop();
		vi.useRealTimers();
	});
	it("dispatches custom audio with actual volume and silent native banners without a renderer", () => {
		presenter = new DesktopNotifications(options);
		subscription.onNotification(event);
		expect(mocks.play).toHaveBeenCalledWith("review", 0.4, event);
		expect(mocks.native).toHaveBeenCalledWith({
			title: "Quarterdeck",
			subtitle: "Project",
			body: "A task is ready for review.",
			silent: true,
		});
		expect(mocks.show).toHaveBeenCalledOnce();
	});
	it("plays custom tones when native banners are unsupported or denied", () => {
		presenter = new DesktopNotifications({ ...options, nativeNotifications: false });
		subscription.onNotification(event);
		expect(mocks.play).toHaveBeenCalledOnce();
		expect(mocks.native).not.toHaveBeenCalled();
		presenter.stop();
		presenter = new DesktopNotifications(options);
		mocks.show.mockImplementationOnce(() => {
			throw new Error("denied");
		});
		expect(() => subscription.onNotification(event)).toThrow("denied");
		expect(mocks.play).toHaveBeenCalledTimes(2);
	});
	it("cancels playback on presentation reset and disposes both owners on shutdown", () => {
		presenter = new DesktopNotifications(options);
		subscription.onPresentationReset?.();
		expect(mocks.stopAudio).toHaveBeenCalledOnce();
		presenter.stop();
		expect(mocks.disposeAudio).toHaveBeenCalledOnce();
		expect(mocks.stopSubscription).toHaveBeenCalledOnce();
	});
	it("uses simulated playback and suppresses every native banner in synthetic lab launches", () => {
		presenter = new DesktopNotifications({ ...options, synthetic: true });
		subscription.onNotification(event);
		expect(mocks.audio.mock.calls[0][0]).toMatchObject({ enabled: true, playback: expect.any(Object) });
		expect(mocks.play).toHaveBeenCalledWith("review", 0.4, event);
		expect(mocks.native).not.toHaveBeenCalled();
	});
	it("rejects old-runtime events and click navigation after replacement", () => {
		let current = true;
		presenter = new DesktopNotifications({ ...options, isCurrent: () => current });
		subscription.onNotification(event);
		const click = mocks.once.mock.calls[0][1];
		mocks.resolveTarget.mockReturnValue({ projectId: "project", taskId: null });
		click();
		expect(options.onClick).toHaveBeenCalledWith({ projectId: "project", taskId: null });
		current = false;
		click();
		subscription.onNotification(event);
		expect(options.onClick).toHaveBeenCalledOnce();
		expect(mocks.play).toHaveBeenCalledOnce();
	});
	it("awaits audio cleanup before stop resolves, with a bounded quit deadline", async () => {
		vi.useFakeTimers();
		let finish: (() => void) | undefined;
		mocks.disposeAudio.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		presenter = new DesktopNotifications(options);
		const stop = presenter.stop();
		expect(presenter.stop()).toBe(stop);
		const complete = vi.fn();
		void stop.then(complete);
		await vi.advanceTimersByTimeAsync(100);
		expect(complete).not.toHaveBeenCalled();
		finish?.();
		await stop;
		expect(complete).toHaveBeenCalledOnce();
		presenter = new DesktopNotifications(options);
		mocks.disposeAudio.mockImplementationOnce(() => new Promise<void>(() => {}));
		const stalled = presenter.stop();
		await vi.advanceTimersByTimeAsync(2_000);
		await stalled;
		expect(vi.getTimerCount()).toBe(0);
	});
});
