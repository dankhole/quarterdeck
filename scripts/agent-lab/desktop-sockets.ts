import type { Page } from "playwright-core";
import { runtimeTerminalWsOutputAckMessageSchema } from "../../src/core/api/streams";

export const DESKTOP_SMOKE_SOCKET_PATHS = ["/api/runtime/ws", "/api/terminal/io", "/api/terminal/control"] as const;

export interface DesktopSocketEvidence {
	path: (typeof DESKTOP_SMOKE_SOCKET_PATHS)[number];
	createdAt: string;
	sentFrames: number;
	receivedFrames: number;
	closed: boolean;
	errors: number;
}

interface TerminalSocketPair {
	io?: DesktopSocketEvidence;
	control?: DesktopSocketEvidence;
	receivedBytes: number;
	acknowledgedBytes: number;
}

interface OutputFence {
	projectId: string;
	taskId: string;
	pattern: RegExp;
	tails: Map<TerminalSocketPair, string>;
	target?: { pair: TerminalSocketPair; bytes: number };
}

/** Capture transport activity without retaining auth query strings or frame content. */
export class DesktopSocketObserver {
	private observedPages = new WeakSet<Page>();
	private evidence: DesktopSocketEvidence[] = [];
	private outputFence?: OutputFence;

	observe(page: Page): void {
		if (this.observedPages.has(page)) return;
		this.observedPages.add(page);
		const terminals = new Map<string, TerminalSocketPair>();
		page.on("websocket", (socket) => {
			const url = new URL(socket.url());
			const path = url.pathname;
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
			if (expected !== "/api/runtime/ws") {
				const projectId = url.searchParams.get("projectId");
				const taskId = url.searchParams.get("taskId");
				const clientId = url.searchParams.get("clientId");
				const key = JSON.stringify([projectId, taskId, clientId]);
				const channel = expected === "/api/terminal/io" ? "io" : "control";
				let pair = terminals.get(key);
				if (!pair || pair[channel] || pair.io?.closed || pair.control?.closed) {
					pair = { receivedBytes: 0, acknowledgedBytes: 0 };
					terminals.set(key, pair);
				}
				pair[channel] = record;
				const terminal = pair;
				if (channel === "io") {
					socket.on("framereceived", ({ payload }) => {
						terminal.receivedBytes += Buffer.byteLength(payload);
						const fence = this.outputFence;
						if (!fence || fence.target || fence.projectId !== projectId || fence.taskId !== taskId) return;
						const text = `${fence.tails.get(terminal) ?? ""}${payload.toString()}`;
						if (fence.pattern.test(text)) fence.target = { pair: terminal, bytes: terminal.receivedBytes };
						else fence.tails.set(terminal, text.slice(-4096));
					});
				} else {
					socket.on("framesent", ({ payload }) => {
						if (typeof payload !== "string" || payload.length > 128) return;
						try {
							const ack = runtimeTerminalWsOutputAckMessageSchema.safeParse(JSON.parse(payload));
							if (ack.success) terminal.acknowledgedBytes += ack.data.bytes;
						} catch {
							// Non-JSON frames are not terminal receipts.
						}
					});
				}
			}
			socket.on("framesent", () => record.sentFrames++);
			socket.on("framereceived", () => record.receivedFrames++);
			socket.on("socketerror", () => record.errors++);
			socket.on("close", () => {
				record.closed = true;
			});
		});
	}

	/** Match only during the synthetic probe and retain only ACK byte counts in evidence. */
	terminalOutputFence(projectId: string, taskId: string, pattern: RegExp) {
		if (this.outputFence) throw new Error("A terminal output fence is already active.");
		const fence: OutputFence = { projectId, taskId, pattern, tails: new Map() };
		this.outputFence = fence;
		return {
			receipt: () => {
				const target = fence.target;
				if (!target || target.pair.acknowledgedBytes < target.bytes) return null;
				return target.bytes;
			},
			dispose: () => {
				if (this.outputFence === fence) this.outputFence = undefined;
			},
		};
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
