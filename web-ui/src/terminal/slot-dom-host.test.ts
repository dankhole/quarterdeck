import { afterEach, describe, expect, it } from "vitest";

import { SlotDomHost } from "@/terminal/slot-dom-host";

describe("SlotDomHost", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("creates a hidden host inside the shared parking root", () => {
		const domHost = new SlotDomHost();

		const parkingRoot = document.getElementById("kb-persistent-terminal-parking-root");
		expect(parkingRoot).toBeInstanceOf(HTMLDivElement);
		expect(parkingRoot?.contains(domHost.hostElement)).toBe(true);
		expect(domHost.hostElement.style.visibility).toBe("hidden");
	});

	it("tracks stage and visible containers while hosting and parking", () => {
		const domHost = new SlotDomHost();
		const stageContainer = document.createElement("div");
		document.body.appendChild(stageContainer);

		expect(domHost.attachToStageContainer(stageContainer)).toEqual({ hadPreviousStage: false });
		expect(domHost.stageContainer).toBe(stageContainer);
		expect(stageContainer.contains(domHost.hostElement)).toBe(true);

		domHost.markVisible();
		domHost.reveal();
		expect(domHost.visibleContainer).toBe(stageContainer);
		expect(domHost.hostElement.style.visibility).toBe("visible");

		domHost.hide();
		expect(domHost.visibleContainer).toBeNull();
		expect(domHost.hostElement.style.visibility).toBe("hidden");

		domHost.park();
		const parkingRoot = document.getElementById("kb-persistent-terminal-parking-root");
		expect(domHost.stageContainer).toBeNull();
		expect(parkingRoot?.contains(domHost.hostElement)).toBe(true);
	});
});
