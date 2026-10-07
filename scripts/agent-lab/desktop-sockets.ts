import type { Page } from "playwright-core";

export const DESKTOP_SMOKE_SOCKET_PATHS = ["/api/runtime/ws", "/api/terminal/io", "/api/terminal/control"] as const;

export interface DesktopSocketEvidence {
	path: (typeof DESKTOP_SMOKE_SOCKET_PATHS)[number];
	createdAt: string;
	sentFrames: number;
	receivedFrames: number;
	closed: boolean;
	errors: number;
}

/** Capture transport activity without retaining auth query strings or frame content. */
export class DesktopSocketObserver {
	private observedPages = new WeakSet<Page>();
	private evidence: DesktopSocketEvidence[] = [];

	observe(page: Page): void {
		if (this.observedPages.has(page)) return;
		this.observedPages.add(page);
		page.on("websocket", (socket) => {
			const path = new URL(socket.url()).pathname;
			const expected = DESKTOP_SMOKE_SOCKET_PATHS.find((candidate) => candidate === path);
			if (!expected || this.evidence.length >= 128) return;
			const record: DesktopSocketEvidence = {
				path: expected,
				createdAt: new Date().toISOString(),
				sentFrames: 0,
				receivedFrames: 0,
				closed: false,
				errors: 0,
			};
			this.evidence.push(record);
			socket.on("framesent", () => record.sentFrames++);
			socket.on("framereceived", () => record.receivedFrames++);
			socket.on("socketerror", () => record.errors++);
			socket.on("close", () => {
				record.closed = true;
			});
		});
	}

	snapshot(): DesktopSocketEvidence[] {
		return this.evidence.map((record) => ({ ...record }));
	}

	assertTraffic(): void {
		const missing = DESKTOP_SMOKE_SOCKET_PATHS.filter(
			(path) =>
				!this.evidence.some(
					(record) =>
						record.path === path &&
						record.receivedFrames > 0 &&
						(path === "/api/runtime/ws" || record.sentFrames > 0),
				),
		);
		if (missing.length > 0)
			throw new Error(`Packaged desktop did not exchange traffic on required WebSockets: ${missing.join(", ")}.`);
	}
}
