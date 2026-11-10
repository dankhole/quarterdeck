import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyError } from "@/components/app-toaster";
import { isRuntimeDisconnected } from "@/runtime/runtime-connection-state";
import { installGlobalErrorCapture, setGlobalErrorCallback } from "@/utils/global-error-capture";
import { createUnexpectedErrorNotifier } from "@/utils/unexpected-error-notification";

vi.mock("@/components/app-toaster", () => ({ notifyError: vi.fn() }));
vi.mock("@/runtime/runtime-connection-state", () => ({ isRuntimeDisconnected: vi.fn(() => false) }));

function rejectionEvent(reason: unknown): Event {
	const event = new Event("unhandledrejection", { cancelable: true });
	Object.defineProperty(event, "reason", { value: reason });
	return event;
}

describe("global unexpected-error feedback", () => {
	const record = vi.fn();
	let uninstall: () => void;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(isRuntimeDisconnected).mockReturnValue(false);
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(Date, "now").mockReturnValue(1_000);
		setGlobalErrorCallback(record);
		uninstall = installGlobalErrorCapture(createUnexpectedErrorNotifier());
	});

	afterEach(() => {
		uninstall();
		setGlobalErrorCallback(null);
		vi.restoreAllMocks();
	});

	it("notifies uncaught errors without exposing their message or location", () => {
		window.dispatchEvent(
			new ErrorEvent("error", {
				message: "secret prompt and credential",
				error: new Error("secret prompt and credential"),
				filename: "/private/project/source.ts",
			}),
		);

		expect(record).toHaveBeenCalledWith("error", "uncaught", "secret prompt and credential", expect.any(String));
		expect(notifyError).toHaveBeenCalledExactlyOnceWith(
			"An unexpected error interrupted Quarterdeck. Try the action again. If it keeps failing, open Diagnostics.",
			{ key: "unexpected-ui-error" },
		);
	});

	it.each([new Error("private failure"), "private rejection", { token: "private value" }])(
		"notifies unhandled promise rejections with safe, actionable text (%s)",
		(reason) => {
			window.dispatchEvent(rejectionEvent(reason));
			expect(record).toHaveBeenCalledWith("error", "unhandled-rejection", expect.any(String), undefined);
			expect(notifyError).toHaveBeenCalledOnce();
			expect(vi.mocked(notifyError).mock.calls[0]?.[0]).not.toContain("private");
		},
	);

	it("keeps console errors and warnings diagnostic-only, including already-toasted failures", () => {
		console.error("An action already showed its own toast");
		console.warn("WebSocket reconnect or optional background operation");
		expect(record).toHaveBeenCalledWith("error", "console", "An action already showed its own toast", undefined);
		expect(record).toHaveBeenCalledWith(
			"warn",
			"console",
			"WebSocket reconnect or optional background operation",
			undefined,
		);
		expect(notifyError).not.toHaveBeenCalled();
	});

	it("does not toast expected cancellation", () => {
		window.dispatchEvent(rejectionEvent(new DOMException("Request cancelled", "AbortError")));
		expect(record).toHaveBeenCalledOnce();
		expect(notifyError).not.toHaveBeenCalled();
	});

	it("does not duplicate the persistent disconnected-runtime fallback", () => {
		vi.mocked(isRuntimeDisconnected).mockReturnValue(true);
		window.dispatchEvent(rejectionEvent(new Error("Network failure")));
		expect(notifyError).not.toHaveBeenCalled();
		vi.mocked(isRuntimeDisconnected).mockReturnValue(false);
		window.dispatchEvent(rejectionEvent(new Error("Unexpected action failure")));
		expect(notifyError).toHaveBeenCalledOnce();
	});

	it("coalesces bursts across error types without losing diagnostic evidence, then allows another notice", () => {
		window.dispatchEvent(new ErrorEvent("error", { message: "first failure" }));
		window.dispatchEvent(rejectionEvent(new Error("second failure")));
		vi.mocked(Date.now).mockReturnValue(10_999);
		window.dispatchEvent(rejectionEvent(new Error("third failure")));
		expect(notifyError).toHaveBeenCalledOnce();
		expect(record).toHaveBeenCalledTimes(3);
		vi.mocked(Date.now).mockReturnValue(11_000);
		window.dispatchEvent(rejectionEvent(new Error("later failure")));
		expect(notifyError).toHaveBeenCalledTimes(2);
		expect(record).toHaveBeenCalledTimes(4);
	});

	it("leaves explicitly handled events to their existing owner", () => {
		const event = rejectionEvent(new Error("handled elsewhere"));
		event.preventDefault();
		window.dispatchEvent(event);
		expect(record).toHaveBeenCalledOnce();
		expect(notifyError).not.toHaveBeenCalled();
	});

	it("removes both global listeners on disposal", () => {
		uninstall();
		window.dispatchEvent(new ErrorEvent("error", { message: "after disposal" }));
		window.dispatchEvent(rejectionEvent("after disposal"));
		expect(record).not.toHaveBeenCalled();
		expect(notifyError).not.toHaveBeenCalled();
	});
});
