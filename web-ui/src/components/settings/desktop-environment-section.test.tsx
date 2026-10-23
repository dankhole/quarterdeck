import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopEnvironmentSection } from "@/components/settings/desktop-environment-section";
import { getRuntimeEnvironment } from "@/runtime/runtime-environment";
import type {
	DesktopEnvironmentBridge,
	DesktopEnvironmentResponse,
	DesktopEnvironmentSnapshot,
} from "../../../../src/shared/desktop-environment-contract";

vi.mock("@/runtime/runtime-environment", () => ({ getRuntimeEnvironment: vi.fn() }));

const reactTestGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

function snapshot(overrides: Partial<DesktopEnvironmentSnapshot> = {}): DesktopEnvironmentSnapshot {
	return {
		ownership: "owned",
		source: "login-shell",
		failureReason: null,
		appliedDirectories: [],
		appliedImportLoginShellEnvironment: true,
		preferences: { importLoginShellEnvironment: true, extraExecutableDirectories: [] },
		...overrides,
	};
}

describe("desktop environment Settings section", () => {
	let root: Root;
	let container: HTMLDivElement;
	let bridge: DesktopEnvironmentBridge;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = reactTestGlobal.IS_REACT_ACT_ENVIRONMENT;
		reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		vi.mocked(getRuntimeEnvironment).mockReturnValue({
			kind: "desktop",
			runtimeOrigin: "http://127.0.0.1:4000",
			runtimeGeneration: "generation-1",
			capabilities: { desktop: true, nativeDialogs: true, nativeNotifications: true },
		});
		bridge = {
			version: 1,
			getSnapshot: vi.fn(async () => snapshot()),
			request: vi.fn(async (): Promise<DesktopEnvironmentResponse> => ({ outcome: "saved", snapshot: snapshot() })),
		};
		Object.defineProperty(window, "quarterdeckDesktopEnvironment", { configurable: true, value: bridge });
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		Reflect.deleteProperty(window, "quarterdeckDesktopEnvironment");
		reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
	});

	async function render(open = true): Promise<void> {
		await act(async () => root.render(<DesktopEnvironmentSection open={open} />));
	}

	function button(text: string): HTMLButtonElement {
		const match = Array.from(container.querySelectorAll("button")).find((element) => element.textContent === text);
		if (!match) throw new Error(`Missing button: ${text}`);
		return match;
	}

	it("hides native settings in browser mode without invoking the bridge", async () => {
		vi.mocked(getRuntimeEnvironment).mockReturnValue({ kind: "browser", runtimeOrigin: "http://localhost" });
		await render();
		expect(container.textContent).toBe("");
		expect(bridge.getSnapshot).not.toHaveBeenCalled();
	});

	it("saves the import choice through native intent and shows that refresh is pending", async () => {
		vi.mocked(bridge.request).mockResolvedValue({
			outcome: "saved",
			snapshot: snapshot({ preferences: { importLoginShellEnvironment: false, extraExecutableDirectories: [] } }),
		});
		await render();
		const checkbox = container.querySelector<HTMLButtonElement>("[role=checkbox]");
		expect(checkbox?.getAttribute("aria-checked")).toBe("true");
		await act(async () => checkbox?.click());
		expect(bridge.request).toHaveBeenCalledExactlyOnceWith({ kind: "set-login-shell-import", enabled: false });
		expect(checkbox?.getAttribute("aria-checked")).toBe("false");
		expect(container.textContent).toContain("Saved changes have not been applied.");
		expect(container.textContent).toContain("save immediately");
	});

	it("uses fixed native intents for folder selection and guarded refresh", async () => {
		await render();
		await act(async () => button("Add folders…").click());
		expect(bridge.request).toHaveBeenLastCalledWith({ kind: "add-folders" });
		await act(async () => button("Refresh Environment").click());
		expect(bridge.request).toHaveBeenLastCalledWith({ kind: "refresh" });
	});

	it("explains CLI ownership and offers no mutations for an attached runtime", async () => {
		vi.mocked(bridge.getSnapshot).mockResolvedValue(snapshot({ ownership: "attached" }));
		await render();
		expect(container.textContent).toContain("restart the owning CLI");
		expect(container.querySelector("button")).toBeNull();
		expect(bridge.request).not.toHaveBeenCalled();
	});

	it("surfaces capture failure and preserves the saved choice when native mutation fails", async () => {
		vi.mocked(bridge.getSnapshot).mockResolvedValue(
			snapshot({ source: "fallback", failureReason: "capture_timeout" }),
		);
		vi.mocked(bridge.request).mockRejectedValue(new Error("private native error"));
		await render();
		expect(container.textContent).toContain("Shell import timed out.");
		await act(async () => container.querySelector<HTMLButtonElement>("[role=checkbox]")?.click());
		expect(container.querySelector("[role=checkbox]")?.getAttribute("aria-checked")).toBe("true");
		expect(container.querySelector("[role=alert]")?.textContent).toContain("Could not update");
		expect(container.textContent).not.toContain("private native error");
	});

	it("offers explicit recovery for unreadable preferences", async () => {
		vi.mocked(bridge.getSnapshot).mockResolvedValue(snapshot({ preferences: null }));
		await render();
		expect(button("Add folders…").disabled).toBe(true);
		await act(async () => button("Reset environment settings").click());
		expect(bridge.request).toHaveBeenCalledWith({ kind: "reset-preferences" });
	});

	it("ignores a stale initial read after Settings closes and reopens", async () => {
		let resolveFirst: (value: DesktopEnvironmentSnapshot) => void = () => {};
		vi.mocked(bridge.getSnapshot)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveFirst = resolve;
				}),
			)
			.mockResolvedValue(snapshot({ ownership: "attached" }));
		await render();
		await render(false);
		await render();
		await act(async () => resolveFirst(snapshot()));
		expect(container.textContent).toContain("restart the owning CLI");
		expect(container.querySelector("[role=checkbox]")).toBeNull();
	});
});
