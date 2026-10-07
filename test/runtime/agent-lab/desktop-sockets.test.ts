import { EventEmitter } from "node:events";

import type { Page } from "playwright-core";
import { describe, expect, it } from "vitest";

import { DesktopSocketObserver } from "../../../scripts/agent-lab/desktop-sockets";

class SyntheticSocket extends EventEmitter {
	constructor(private readonly path: string) {
		super();
	}

	url(): string {
		return `ws://127.0.0.1:44000${this.path}?token=synthetic-private-value`;
	}
}

describe("packaged desktop socket acceptance evidence", () => {
	it("rejects the missing control channel even when runtime and terminal I/O exchange frames", () => {
		const observer = new DesktopSocketObserver();
		const page = new EventEmitter();
		observer.observe(page as unknown as Page);
		for (const path of ["/api/runtime/ws", "/api/terminal/io"]) {
			const socket = new SyntheticSocket(path);
			page.emit("websocket", socket);
			if (path !== "/api/runtime/ws") socket.emit("framesent", { payload: "private synthetic frame" });
			socket.emit("framereceived", { payload: "private synthetic frame" });
		}
		expect(() => observer.assertTraffic()).toThrow("/api/terminal/control");
		const control = new SyntheticSocket("/api/terminal/control");
		page.emit("websocket", control);
		control.emit("framesent", { payload: "private synthetic frame" });
		control.emit("framereceived", { payload: "private synthetic frame" });
		expect(() => observer.assertTraffic()).not.toThrow();
		const serialized = JSON.stringify(observer.snapshot());
		expect(serialized).not.toContain("synthetic-private-value");
		expect(serialized).not.toContain("private synthetic frame");
	});

	it("does not accept a constructed or failed socket without successful traffic", () => {
		const observer = new DesktopSocketObserver();
		const page = new EventEmitter();
		observer.observe(page as unknown as Page);
		observer.observe(page as unknown as Page);
		const socket = new SyntheticSocket("/api/runtime/ws");
		page.emit("websocket", socket);
		socket.emit("socketerror", "private error detail");
		socket.emit("close");
		expect(observer.snapshot()).toEqual([
			{
				path: "/api/runtime/ws",
				createdAt: expect.any(String),
				sentFrames: 0,
				receivedFrames: 0,
				errors: 1,
				closed: true,
			},
		]);
		expect(() => observer.assertTraffic()).toThrow("/api/runtime/ws");
	});
});
