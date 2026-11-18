import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeDisconnectedFallback } from "@/components/app/runtime-disconnected-fallback";
import { RUNTIME_ADMISSION_REQUIRED_MESSAGE } from "@/runtime/runtime-client-admission";

describe("RuntimeDisconnectedFallback", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		act(() => root.unmount());
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it.each([undefined, RUNTIME_ADMISSION_REQUIRED_MESSAGE])(
		"never exposes a direct desktop reload for %s",
		(message) => {
			vi.stubEnv("DEV", true);
			act(() => root.render(<RuntimeDisconnectedFallback message={message} presentation="banner" />));
			expect(container.querySelector("button")).toBeNull();
			expect(container.textContent).toContain("View > Reload Window");
			expect(container.textContent).toContain("File > Restart Runtime");
		},
	);

	it("shows the specific disconnect reason when one is available", () => {
		act(() => {
			root.render(<RuntimeDisconnectedFallback message="Browser and runtime builds do not match." />);
		});

		expect(container.textContent).toContain("Browser and runtime builds do not match.");
	});

	it("shows the reopen path without promising automatic recovery for expired production admission", () => {
		vi.stubEnv("DEV", false);
		act(() => root.render(<RuntimeDisconnectedFallback message={RUNTIME_ADMISSION_REQUIRED_MESSAGE} />));
		expect(container.textContent).toContain("Reopen Quarterdeck to connect");
		expect(container.textContent).toContain("Reopen the Quarterdeck desktop app");
		expect(container.textContent).toContain("Local drafts remain available");
		expect(container.textContent).not.toContain("reconnect automatically");
		expect(container.querySelector("button")).toBeNull();
	});
});
