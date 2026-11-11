import type { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { SlotRenderer } from "@/terminal/slot-renderer";

interface TestAddon {
	dispose: Mock<() => void>;
	clearTextureAtlas: Mock<() => void>;
	contextLoss: (() => void) | null;
}

const webgl = vi.hoisted(() => ({
	instances: [] as TestAddon[],
	constructorFailure: false,
	activationFailure: false,
	loseContextOnLoad: false,
	atlas: { clear: vi.fn() },
}));

vi.mock("@xterm/addon-webgl", () => ({
	WebglAddon: class {
		contextLoss: (() => void) | null = null;
		dispose = vi.fn();
		clearTextureAtlas = vi.fn(() => webgl.atlas.clear());

		constructor() {
			if (webgl.constructorFailure) {
				throw new Error("WebGL unavailable");
			}
			webgl.instances.push(this);
		}

		onContextLoss(listener: () => void) {
			this.contextLoss = listener;
			return { dispose: vi.fn() };
		}
	},
}));

vi.mock("@/utils/client-logger", () => ({
	createClientLogger: () => ({ debug: vi.fn(), info: vi.fn() }),
}));

interface TestMediaQuery {
	query: string;
	handler: () => void;
	removeEventListener: Mock;
}

const fixtures: { renderer: SlotRenderer; terminal: Terminal }[] = [];
const mediaQueries: TestMediaQuery[] = [];
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;

function createRenderer() {
	const terminal = new Terminal({ cols: 5, rows: 2, allowProposedApi: true });
	const host = document.createElement("div");
	const element = vi.spyOn(terminal, "element", "get").mockReturnValue(document.createElement("div"));
	const loadAddon = vi.spyOn(terminal, "loadAddon").mockImplementation(() => {
		if (webgl.activationFailure) {
			throw new Error("WebGL activation failed");
		}
		if (webgl.loseContextOnLoad) {
			webgl.instances.at(-1)!.contextLoss!();
		}
	});
	const refresh = vi.spyOn(terminal, "refresh").mockImplementation(() => {});
	const clearTextureAtlas = vi.spyOn(terminal, "clearTextureAtlas").mockImplementation(() => webgl.atlas.clear());
	const resize = vi.spyOn(terminal, "resize");
	const reset = vi.spyOn(terminal, "reset");
	const clear = vi.spyOn(terminal, "clear");
	const fit = vi.fn();
	const forceResize = vi.fn();
	const state = { staged: true, visible: true, disposed: false };
	const renderer = new SlotRenderer(1, terminal, host, { fit } as unknown as FitAddon, {
		forceResize,
		getStageContainer: () => (state.staged ? host : null),
		getVisibleContainer: () => (state.visible ? host : null),
		isDisposed: () => state.disposed,
	});
	const fixture = {
		renderer,
		terminal,
		element,
		loadAddon,
		refresh,
		clearTextureAtlas,
		resize,
		reset,
		clear,
		fit,
		forceResize,
		state,
	};
	fixtures.push(fixture);
	return fixture;
}

function setDpr(dpr: number): void {
	vi.stubGlobal("devicePixelRatio", dpr);
}

function flushFrames(): void {
	const pending = [...frames.values()];
	frames.clear();
	for (const callback of pending) {
		callback(0);
	}
}

function write(terminal: Terminal, text: string): Promise<void> {
	return new Promise((resolve) => terminal.write(text, resolve));
}

function expectPresentationOnly(fixture: ReturnType<typeof createRenderer>): void {
	expect(fixture.resize).not.toHaveBeenCalled();
	expect(fixture.clearTextureAtlas).not.toHaveBeenCalled();
	expect(fixture.reset).not.toHaveBeenCalled();
	expect(fixture.clear).not.toHaveBeenCalled();
	expect(fixture.forceResize).not.toHaveBeenCalled();
}

describe("SlotRenderer presentation recovery", () => {
	beforeEach(() => {
		webgl.instances.length = 0;
		webgl.constructorFailure = false;
		webgl.activationFailure = false;
		webgl.loseContextOnLoad = false;
		webgl.atlas.clear.mockClear();
		mediaQueries.length = 0;
		frames.clear();
		nextFrame = 0;
		setDpr(1);
		vi.stubGlobal(
			"requestAnimationFrame",
			vi.fn((callback: FrameRequestCallback) => {
				const frame = ++nextFrame;
				frames.set(frame, callback);
				return frame;
			}),
		);
		vi.stubGlobal(
			"cancelAnimationFrame",
			vi.fn((frame: number) => frames.delete(frame)),
		);
		vi.stubGlobal(
			"matchMedia",
			vi.fn((query: string) => {
				const mediaQuery: TestMediaQuery = { query, handler: () => {}, removeEventListener: vi.fn() };
				mediaQueries.push(mediaQuery);
				return {
					addEventListener: vi.fn((_type: string, handler: () => void) => {
						mediaQuery.handler = handler;
					}),
					removeEventListener: mediaQuery.removeEventListener,
				} as unknown as MediaQueryList;
			}),
		);
	});

	afterEach(() => {
		for (const fixture of fixtures.splice(0)) {
			fixture.renderer.dispose();
			fixture.terminal.dispose();
		}
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("replaces the addon before fitting and refreshing without mutating terminal state", () => {
		const fixture = createRenderer();
		fixture.renderer.attachWebglAddon();
		const original = webgl.instances[0]!;

		fixture.renderer.resetRenderer();

		expect(webgl.instances).toHaveLength(2);
		expect(original.dispose).toHaveBeenCalledOnce();
		expect(fixture.renderer.hasWebgl).toBe(true);
		expect(fixture.fit).toHaveBeenCalledOnce();
		expect(fixture.refresh).toHaveBeenCalledWith(0, 1);
		expect(original.dispose.mock.invocationCallOrder[0]).toBeLessThan(fixture.loadAddon.mock.invocationCallOrder[1]!);
		expect(fixture.loadAddon.mock.invocationCallOrder[1]).toBeLessThan(fixture.fit.mock.invocationCallOrder[0]!);
		expect(fixture.fit.mock.invocationCallOrder[0]).toBeLessThan(fixture.refresh.mock.invocationCallOrder[0]!);
		expectPresentationOnly(fixture);
	});

	it.each(["reset", "dpr"] as const)(
		"preserves two populated buffers and their shared atlas during %s",
		async (trigger) => {
			const first = createRenderer();
			const second = createRenderer();
			first.renderer.attachWebglAddon();
			second.renderer.attachWebglAddon();
			await write(first.terminal, "\u001b[?1049hABCDE\u001b[1;5H");
			await write(second.terminal, "\u001b[?1049hVWXYZ\u001b[1;5H");

			if (trigger === "reset") {
				first.renderer.resetRenderer();
			} else {
				first.renderer.listenForDprChange();
				mediaQueries[0]!.handler();
				flushFrames();
			}

			expect(webgl.instances).toHaveLength(trigger === "reset" ? 3 : 2);
			expect(webgl.instances[0]!.dispose).toHaveBeenCalledTimes(trigger === "reset" ? 1 : 0);

			expect(first.terminal.buffer.active.cursorX).toBe(4);
			expect(second.terminal.buffer.active.cursorX).toBe(4);
			expect(first.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("ABCDE");
			expect(second.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("VWXYZ");
			expect(webgl.instances[1]!.dispose).not.toHaveBeenCalled();
			expect(webgl.atlas.clear).not.toHaveBeenCalled();
			for (const addon of webgl.instances) {
				expect(addon.clearTextureAtlas).not.toHaveBeenCalled();
			}
			expectPresentationOnly(first);
			expectPresentationOnly(second);
			await write(first.terminal, "Q");
			expect(first.terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("ABCDQ");
		},
	);

	it("refreshes the rows resulting from the fit, not the previous geometry", () => {
		const fixture = createRenderer();
		fixture.fit.mockImplementation(() => fixture.terminal.resize(6, 3));

		fixture.renderer.resetRenderer();

		expect(fixture.refresh).toHaveBeenCalledWith(0, 2);
		expect(fixture.forceResize).not.toHaveBeenCalled();
	});

	it("coalesces DPR events after native handlers and rearms at the latest DPR", () => {
		const fixture = createRenderer();
		fixture.renderer.attachWebglAddon();
		fixture.renderer.listenForDprChange();
		expect(mediaQueries[0]!.query).toBe("(resolution: 1dppx)");

		setDpr(2);
		mediaQueries[0]!.handler();
		expect(mediaQueries[0]!.removeEventListener).toHaveBeenCalledWith("change", mediaQueries[0]!.handler);
		expect(mediaQueries[1]!.query).toBe("(resolution: 2dppx)");
		setDpr(1);
		mediaQueries[1]!.handler();
		expect(mediaQueries[2]!.query).toBe("(resolution: 1dppx)");
		expect(requestAnimationFrame).toHaveBeenCalledOnce();
		expect(webgl.instances).toHaveLength(1);
		expect(fixture.fit).not.toHaveBeenCalled();
		// Native xterm DPR listeners run in the event dispatch, before this frame.
		flushFrames();
		expect(webgl.instances).toHaveLength(1);
		expect(fixture.fit).toHaveBeenCalledOnce();
		expect(fixture.refresh).toHaveBeenCalledWith(0, 1);
		expect(fixture.fit.mock.invocationCallOrder[0]).toBeLessThan(fixture.refresh.mock.invocationCallOrder[0]!);
		expectPresentationOnly(fixture);

		for (let transition = 0; transition < 20; transition += 1) {
			setDpr(transition % 2 === 0 ? 2 : 1);
			mediaQueries.at(-1)!.handler();
			flushFrames();
		}
		expect(fixture.fit).toHaveBeenCalledTimes(21);
		expect(webgl.instances).toHaveLength(1);
		expect(webgl.instances[0]!.dispose).not.toHaveBeenCalled();
		expect(fixture.loadAddon).toHaveBeenCalledOnce();
	});

	it("cancels hidden-slot recovery even while its stage container remains", () => {
		const fixture = createRenderer();
		fixture.renderer.attachWebglAddon();
		fixture.renderer.listenForDprChange();
		mediaQueries[0]!.handler();
		const staleFrame = [...frames.values()][0]!;
		const staleListener = mediaQueries[1]!.handler;
		fixture.state.visible = false;

		fixture.renderer.clearDprListener();
		fixture.renderer.clearDprListener();
		staleFrame(0);
		staleListener();
		flushFrames();

		expect(cancelAnimationFrame).toHaveBeenCalledOnce();
		expect(mediaQueries).toHaveLength(2);
		expect(webgl.instances).toHaveLength(1);
		expect(fixture.fit).not.toHaveBeenCalled();
		expectPresentationOnly(fixture);
	});

	it("can resume DPR observation after hiding", () => {
		const fixture = createRenderer();
		fixture.renderer.attachWebglAddon();
		fixture.renderer.listenForDprChange();
		fixture.renderer.clearDprListener();
		fixture.renderer.listenForDprChange();
		mediaQueries[1]!.handler();
		flushFrames();
		expect(fixture.renderer.hasWebgl).toBe(true);
		expect(fixture.fit).toHaveBeenCalledOnce();
	});

	it.each(["hidden", "detached", "disposed"] as const)("rechecks %s state inside deferred recovery", (state) => {
		const fixture = createRenderer();
		fixture.renderer.attachWebglAddon();
		fixture.renderer.listenForDprChange();
		mediaQueries[0]!.handler();
		if (state === "hidden") {
			fixture.state.visible = false;
		} else if (state === "detached") {
			fixture.state.staged = false;
			fixture.state.visible = false;
		} else {
			fixture.state.disposed = true;
		}

		flushFrames();

		expect(webgl.instances).toHaveLength(1);
		expect(fixture.fit).not.toHaveBeenCalled();
		expect(fixture.refresh).not.toHaveBeenCalled();
	});

	it("cancels pending DPR recovery when explicitly reset", () => {
		const fixture = createRenderer();
		fixture.renderer.attachWebglAddon();
		fixture.renderer.listenForDprChange();
		mediaQueries[0]!.handler();
		fixture.renderer.resetRenderer();
		flushFrames();
		expect(webgl.instances).toHaveLength(2);
		expect(fixture.fit).toHaveBeenCalledOnce();
		expect(cancelAnimationFrame).toHaveBeenCalledOnce();
	});

	it("does not attach duplicate addons and disposes each replacement only once", () => {
		const fixture = createRenderer();
		fixture.renderer.attachWebglAddon();
		fixture.renderer.attachWebglAddon();
		expect(webgl.instances).toHaveLength(1);
		fixture.renderer.resetRenderer();
		fixture.renderer.resetRenderer();
		expect(webgl.instances).toHaveLength(3);
		expect(webgl.instances[0]!.dispose).toHaveBeenCalledOnce();
		expect(webgl.instances[1]!.dispose).toHaveBeenCalledOnce();
		expect(webgl.instances[2]!.dispose).not.toHaveBeenCalled();
	});

	it.each(["construction", "activation"] as const)(
		"retains the DOM fallback after failed %s and permits retry",
		(failure) => {
			const fixture = createRenderer();
			fixture.renderer.attachWebglAddon();
			webgl.constructorFailure = failure === "construction";
			webgl.activationFailure = failure === "activation";

			fixture.renderer.resetRenderer();

			expect(fixture.renderer.hasWebgl).toBe(false);
			expect(fixture.fit).toHaveBeenCalledOnce();
			expect(fixture.refresh).toHaveBeenCalledWith(0, 1);
			for (const addon of webgl.instances) {
				expect(addon.dispose).toHaveBeenCalledOnce();
			}
			webgl.constructorFailure = false;
			webgl.activationFailure = false;
			fixture.renderer.resetRenderer();
			expect(fixture.renderer.hasWebgl).toBe(true);
			expectPresentationOnly(fixture);
		},
	);

	it("ignores stale or repeated context-loss callbacks without discarding the current addon", () => {
		const fixture = createRenderer();
		fixture.renderer.attachWebglAddon();
		const old = webgl.instances[0]!;
		fixture.renderer.resetRenderer();
		const current = webgl.instances[1]!;
		old.contextLoss!();
		expect(fixture.renderer.hasWebgl).toBe(true);
		expect(current.dispose).not.toHaveBeenCalled();
		current.contextLoss!();
		current.contextLoss!();
		expect(current.dispose).toHaveBeenCalledOnce();
		expect(fixture.renderer.hasWebgl).toBe(false);
		fixture.renderer.resetRenderer();
		expect(fixture.renderer.hasWebgl).toBe(true);
	});

	it("keeps the DOM fallback on subsequent DPR changes after context loss", () => {
		const fixture = createRenderer();
		fixture.renderer.attachWebglAddon();
		fixture.renderer.listenForDprChange();
		webgl.instances[0]!.contextLoss!();
		mediaQueries[0]!.handler();
		flushFrames();
		expect(webgl.instances).toHaveLength(1);
		expect(webgl.instances[0]!.dispose).toHaveBeenCalledOnce();
		expect(fixture.renderer.hasWebgl).toBe(false);
		expect(fixture.fit).toHaveBeenCalledOnce();
		expect(fixture.refresh).toHaveBeenCalledWith(0, 1);
		expectPresentationOnly(fixture);
	});

	it("does not retain an addon that loses context during activation", () => {
		const fixture = createRenderer();
		webgl.loseContextOnLoad = true;
		fixture.renderer.resetRenderer();
		expect(webgl.instances[0]!.dispose).toHaveBeenCalledOnce();
		expect(fixture.renderer.hasWebgl).toBe(false);
		expect(fixture.refresh).toHaveBeenCalledWith(0, 1);
	});

	it("skips recovery for unopened, hidden-staged, or parked terminals", () => {
		const fixture = createRenderer();
		fixture.element.mockReturnValue(undefined);
		fixture.renderer.resetRenderer();
		fixture.element.mockReturnValue(document.createElement("div"));
		fixture.state.visible = false;
		fixture.renderer.resetRenderer();
		fixture.state.staged = false;
		fixture.renderer.resetRenderer();
		expect(webgl.instances).toHaveLength(0);
		expect(fixture.fit).not.toHaveBeenCalled();
		expect(fixture.refresh).not.toHaveBeenCalled();
		expectPresentationOnly(fixture);
	});

	it("disposes pending work and ignores later attach, reset, listener, or context callbacks", () => {
		const fixture = createRenderer();
		fixture.renderer.attachWebglAddon();
		fixture.renderer.listenForDprChange();
		mediaQueries[0]!.handler();
		const staleFrame = [...frames.values()][0]!;
		fixture.renderer.dispose();
		fixture.renderer.dispose();
		staleFrame(0);
		mediaQueries[1]!.handler();
		webgl.instances[0]!.contextLoss!();
		fixture.renderer.attachWebglAddon();
		fixture.renderer.resetRenderer();
		fixture.renderer.listenForDprChange();
		flushFrames();
		expect(webgl.instances).toHaveLength(1);
		expect(webgl.instances[0]!.dispose).toHaveBeenCalledOnce();
		expect(mediaQueries).toHaveLength(2);
		expect(fixture.fit).not.toHaveBeenCalled();
		expect(fixture.renderer.hasWebgl).toBe(false);
	});
});
