import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyRuntimeNotificationPresentation } from "@/runtime/runtime-notification-presentation";
import {
	createMockSession,
	defaultProps,
	HookHarness,
	setupTestHarness,
	type TestHarness,
} from "./audible-notifications-test-utils";

const play = vi.hoisted(() => vi.fn(() => Promise.resolve("native")));
vi.mock("@/utils/notification-audio", () => ({ notificationAudioPlayer: { play, ensureContext: vi.fn() } }));
const generation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const epoch = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("authoritative desktop notification presentation", () => {
	let harness: TestHarness;
	beforeEach(() => {
		applyRuntimeNotificationPresentation(null);
		play.mockClear();
		harness = setupTestHarness();
	});
	afterEach(() => {
		harness.cleanup();
		applyRuntimeNotificationPresentation(null);
	});
	function render(state: "running" | "awaiting_review") {
		act(() =>
			harness.root.render(
				<HookHarness
					{...defaultProps()}
					notificationSessions={{
						task: createMockSession({
							taskId: "task",
							state,
							reviewReason: state === "awaiting_review" ? "hook" : null,
						}),
					}}
				/>,
			),
		);
	}
	it("consumes edges while desktop owns presentation without replay when ownership returns", () => {
		render("running");
		act(() => applyRuntimeNotificationPresentation({ owner: "desktop", epoch, runtimeGeneration: generation }));
		render("awaiting_review");
		harness.flushSettleWindow();
		expect(play).not.toHaveBeenCalled();
		act(() => applyRuntimeNotificationPresentation({ owner: "browser", epoch: null, runtimeGeneration: generation }));
		harness.flushSettleWindow();
		expect(play).not.toHaveBeenCalled();
		render("running");
		render("awaiting_review");
		harness.flushSettleWindow();
		expect(play).toHaveBeenCalledOnce();
	});
	it("cancels an already settling browser sound when desktop acquires presentation", () => {
		render("running");
		render("awaiting_review");
		act(() => applyRuntimeNotificationPresentation({ owner: "desktop", epoch, runtimeGeneration: generation }));
		harness.flushSettleWindow();
		expect(play).not.toHaveBeenCalled();
	});
});
