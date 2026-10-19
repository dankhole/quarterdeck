import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopUpdateControl } from "@/components/app/desktop-update-control";
import { getRuntimeEnvironment } from "@/runtime/runtime-environment";
import type { DesktopUpdateBridge, DesktopUpdateSnapshot } from "../../../../src/shared/desktop-update-contract";

vi.mock("@/runtime/runtime-environment", () => ({ getRuntimeEnvironment: vi.fn() }));

const available: DesktopUpdateSnapshot = {
	phase: "available",
	installedVersion: "0.12.8",
	availableVersion: "0.12.9",
	channel: "latest",
};

describe("desktop update product control", () => {
	let container: HTMLDivElement;
	let root: Root;
	let publication: ((value: DesktopUpdateSnapshot) => void) | undefined;
	let previousActEnvironment: boolean | undefined;
	const unsubscribe = vi.fn();
	const request = vi.fn(async () => {});
	const getSnapshot = vi.fn<DesktopUpdateBridge["getSnapshot"]>();
	let bridge: DesktopUpdateBridge;
	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
		getSnapshot.mockResolvedValue(available);
		publication = undefined;
		bridge = {
			version: 1,
			getSnapshot: getSnapshot,
			onSnapshot: (listener) => {
				publication = listener;
				return unsubscribe;
			},
			request: request,
		};
		Object.defineProperty(window, "quarterdeckDesktopUpdates", { configurable: true, value: bridge });
		vi.mocked(getRuntimeEnvironment).mockReturnValue({
			kind: "desktop",
			runtimeOrigin: "http://127.0.0.1:54321",
			runtimeGeneration: "generation",
			capabilities: { desktop: true, nativeDialogs: true, nativeNotifications: false },
		});
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		Object.defineProperty(window, "quarterdeckDesktopUpdates", { configurable: true, value: undefined });
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});
	const render = async (): Promise<void> => {
		await act(async () => root.render(<DesktopUpdateControl />));
	};

	it("shows an accessible version and requests only native details on click", async () => {
		await render();
		const button = container.querySelector("button");
		expect(button?.textContent).toBe("Update available · v0.12.9");
		await act(async () => button?.click());
		expect(request).toHaveBeenCalledExactlyOnceWith("details");
	});

	it("renders nothing in browsers", async () => {
		vi.mocked(getRuntimeEnvironment).mockReturnValue({ kind: "browser", runtimeOrigin: "http://localhost:3000" });
		await render();
		expect(container.textContent).toBe("");
		expect(getSnapshot).not.toHaveBeenCalled();
	});

	it.each([undefined, { version: 2 }])(
		"renders nothing without a supported optional update namespace: %s",
		async (value) => {
			Object.defineProperty(window, "quarterdeckDesktopUpdates", { configurable: true, value });
			await render();
			expect(container.textContent).toBe("");
			expect(getSnapshot).not.toHaveBeenCalled();
		},
	);

	it.each(["getSnapshot", "onSnapshot", "request"] as const)("supports older bridges without %s", async (method) => {
		Object.defineProperty(bridge, method, { value: undefined });
		await render();
		expect(container.textContent).toBe("");
		expect(getSnapshot).not.toHaveBeenCalled();
	});

	it.each(["disabled", "idle", "checking", "current", "failed", "preparing", "quitting"] as const)(
		"hides the available control for %s state",
		async (phase) => {
			getSnapshot.mockResolvedValue({ ...available, phase });
			await render();
			expect(container.querySelector("button")).toBeNull();
		},
	);

	it("takes live publications over a delayed initial snapshot and unsubscribes on unmount", async () => {
		let resolve: (value: DesktopUpdateSnapshot) => void = () => {};
		getSnapshot.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		await render();
		expect(container.querySelector("button")).toBeNull();
		await act(async () => publication?.(available));
		expect(container.textContent).toContain("Update available · v0.12.9");
		await act(async () => resolve({ ...available, phase: "checking", availableVersion: null }));
		expect(container.textContent).toContain("Update available · v0.12.9");
		await act(async () => publication?.({ ...available, phase: "failed", availableVersion: null }));
		expect(container.querySelector("button")).toBeNull();
		act(() => root.unmount());
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		await act(async () => publication?.(available));
		expect(container.textContent).toBe("");
		// Keep afterEach responsible for an ordinary mounted root.
		root = createRoot(container);
	});

	it("quietly ignores unavailable and malformed snapshots", async () => {
		getSnapshot.mockRejectedValueOnce(new Error("unavailable"));
		await render();
		expect(container.querySelector("button")).toBeNull();
		await act(async () => publication?.({ ...available, phase: "invalid" } as unknown as DesktopUpdateSnapshot));
		expect(container.querySelector("button")).toBeNull();
	});

	it("ignores an initial snapshot that resolves after unmount", async () => {
		let resolve: (value: DesktopUpdateSnapshot) => void = () => {};
		getSnapshot.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		await render();
		act(() => root.unmount());
		await act(async () => resolve(available));
		expect(container.querySelector("button")).toBeNull();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		root = createRoot(container);
	});
});
