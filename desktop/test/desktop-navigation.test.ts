import { afterEach, describe, expect, it, vi } from "vitest";
import { navigateDesktopDocument } from "../src/desktop-navigation.js";

function fixture(hasCommitted = () => false) {
	return {
		load: vi.fn(() => new Promise<void>(() => undefined)),
		stop: vi.fn(),
		hasCommitted,
		restoreSurvivingDocument: vi.fn(),
		releaseTransition: vi.fn(),
		deadlineMs: 50,
	};
}

afterEach(() => vi.useRealTimers());

describe("acknowledged desktop document navigation", () => {
	it("cancels a stalled provisional load before restoring exact surviving authority and releasing its hold", async () => {
		vi.useFakeTimers();
		const options = fixture();
		const failed = expect(navigateDesktopDocument(options)).rejects.toThrow("Desktop navigation did not complete.");
		await vi.advanceTimersByTimeAsync(50);
		await failed;
		expect(options.stop).toHaveBeenCalledOnce();
		expect(options.restoreSurvivingDocument).toHaveBeenCalledOnce();
		expect(options.releaseTransition).toHaveBeenCalledOnce();
		expect(options.stop.mock.invocationCallOrder[0]).toBeLessThan(
			options.restoreSurvivingDocument.mock.invocationCallOrder[0] ?? 0,
		);
		expect(options.restoreSurvivingDocument.mock.invocationCallOrder[0]).toBeLessThan(
			options.releaseTransition.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("never restores authority or releases the old hold after actual document commit", async () => {
		const options = fixture(() => true);
		options.load.mockImplementationOnce(() => Promise.reject(new Error("private load detail")));
		await expect(navigateDesktopDocument(options)).rejects.toThrow("Desktop navigation did not complete.");
		expect(options.restoreSurvivingDocument).not.toHaveBeenCalled();
		expect(options.releaseTransition).not.toHaveBeenCalled();
		expect(options.stop).not.toHaveBeenCalled();
	});

	it("treats a renderer crash during provisional navigation as loss of the captured document lifetime", async () => {
		vi.useFakeTimers();
		let epoch = 0;
		const capturedEpoch = epoch;
		const options = fixture(() => epoch !== capturedEpoch);
		const failed = expect(navigateDesktopDocument(options)).rejects.toThrow("Desktop navigation did not complete.");
		epoch += 1;
		await vi.advanceTimersByTimeAsync(50);
		await failed;
		expect(options.restoreSurvivingDocument).not.toHaveBeenCalled();
		expect(options.releaseTransition).not.toHaveBeenCalled();
	});

	it("settles a throwing stop without an uncaught exception or reopening an unconfirmed document", async () => {
		vi.useFakeTimers();
		const options = fixture();
		options.stop.mockImplementationOnce(() => {
			throw new Error("destroyed contents");
		});
		const failed = expect(navigateDesktopDocument(options)).rejects.toThrow("Desktop navigation did not complete.");
		await vi.advanceTimersByTimeAsync(50);
		await failed;
		expect(options.restoreSurvivingDocument).not.toHaveBeenCalled();
		expect(options.releaseTransition).not.toHaveBeenCalled();
	});

	it("successful replacement leaves release to document retirement and cancels its deadline", async () => {
		vi.useFakeTimers();
		const options = fixture(() => true);
		options.load.mockResolvedValueOnce(undefined);
		await navigateDesktopDocument(options);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(options.stop).not.toHaveBeenCalled();
		expect(options.restoreSurvivingDocument).not.toHaveBeenCalled();
		expect(options.releaseTransition).not.toHaveBeenCalled();
	});
});
