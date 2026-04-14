import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NotificationAudioPlayer } from "@/utils/notification-audio";

// --- Web Audio API mocks ---

function createMockOscillator(): OscillatorNode {
	return {
		type: "sine",
		frequency: { value: 440 },
		connect: vi.fn(),
		start: vi.fn(),
		stop: vi.fn(),
		disconnect: vi.fn(),
	} as unknown as OscillatorNode;
}

function createMockGainNode(): GainNode {
	const gain = {
		value: 1,
		setValueAtTime: vi.fn(),
		linearRampToValueAtTime: vi.fn(),
	};
	return {
		gain,
		connect: vi.fn(),
		disconnect: vi.fn(),
	} as unknown as GainNode;
}

function createMockAudioContext(stateOverride: AudioContextState = "running"): AudioContext {
	let currentState = stateOverride;
	return {
		get state() {
			return currentState;
		},
		get currentTime() {
			return 0;
		},
		resume: vi.fn(async () => {
			currentState = "running";
		}),
		close: vi.fn(async () => {}),
		get destination() {
			return {} as AudioDestinationNode;
		},
		createOscillator: vi.fn(() => createMockOscillator()),
		createGain: vi.fn(() => createMockGainNode()),
	} as unknown as AudioContext;
}

let mockAudioContextInstance: AudioContext | null = null;
let audioContextConstructorSpy: ReturnType<typeof vi.fn>;

function stubAudioContext(stateOverride: AudioContextState = "running"): void {
	audioContextConstructorSpy = vi.fn(function MockAudioContext() {
		mockAudioContextInstance = createMockAudioContext(stateOverride);
		return mockAudioContextInstance;
	});
	vi.stubGlobal("AudioContext", audioContextConstructorSpy);
}

beforeEach(() => {
	mockAudioContextInstance = null;
	stubAudioContext();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("NotificationAudioPlayer", () => {
	it("creates AudioContext lazily on ensureContext", () => {
		const player = new NotificationAudioPlayer();

		expect(audioContextConstructorSpy).not.toHaveBeenCalled();

		const ctx1 = player.ensureContext();
		expect(audioContextConstructorSpy).toHaveBeenCalledTimes(1);
		expect(ctx1).toBe(mockAudioContextInstance);

		// Second call returns cached context.
		const ctx2 = player.ensureContext();
		expect(audioContextConstructorSpy).toHaveBeenCalledTimes(1);
		expect(ctx2).toBe(ctx1);
	});

	it("resumes suspended AudioContext", () => {
		stubAudioContext("suspended");

		const player = new NotificationAudioPlayer();
		player.ensureContext();

		expect(mockAudioContextInstance!.resume).toHaveBeenCalled();
	});

	it("play creates oscillator and gain nodes for permission (2 beats)", () => {
		const player = new NotificationAudioPlayer();
		player.ensureContext();
		const ctx = mockAudioContextInstance!;

		player.play("permission", 0.5);

		expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
		expect(ctx.createGain).toHaveBeenCalledTimes(2);
	});

	it("play creates oscillator and gain nodes for review (1 beat)", () => {
		const player = new NotificationAudioPlayer();
		player.ensureContext();
		const ctx = mockAudioContextInstance!;

		player.play("review", 0.5);

		expect(ctx.createOscillator).toHaveBeenCalledTimes(1);
		expect(ctx.createGain).toHaveBeenCalledTimes(1);
	});

	it("play creates oscillator and gain nodes for failure (3 beats)", () => {
		const player = new NotificationAudioPlayer();
		player.ensureContext();
		const ctx = mockAudioContextInstance!;

		player.play("failure", 0.5);

		expect(ctx.createOscillator).toHaveBeenCalledTimes(3);
		expect(ctx.createGain).toHaveBeenCalledTimes(3);
	});

	it("play connects oscillators through gain to destination", () => {
		const mockGain = createMockGainNode();
		const mockOsc = createMockOscillator();
		const ctx = createMockAudioContext();
		(ctx.createOscillator as ReturnType<typeof vi.fn>).mockReturnValue(mockOsc);
		(ctx.createGain as ReturnType<typeof vi.fn>).mockReturnValue(mockGain);

		audioContextConstructorSpy = vi.fn(function MockAudioContext() {
			mockAudioContextInstance = ctx;
			return ctx;
		});
		vi.stubGlobal("AudioContext", audioContextConstructorSpy);

		const player = new NotificationAudioPlayer();
		player.ensureContext();

		player.play("permission", 0.5);

		expect(mockOsc.connect).toHaveBeenCalledWith(mockGain);
		expect(mockGain.connect).toHaveBeenCalledWith(ctx.destination);
		expect(mockOsc.start).toHaveBeenCalled();
		expect(mockOsc.stop).toHaveBeenCalled();
	});

	it("play no-ops when AudioContext is null", () => {
		const player = new NotificationAudioPlayer();

		// No ensureContext call — context is null.
		expect(() => player.play("permission", 0.5)).not.toThrow();
	});

	it("play clamps volume to 0-1 range", () => {
		const mockGainHigh = createMockGainNode();
		const mockGainLow = createMockGainNode();

		const ctx = createMockAudioContext();
		(ctx.createGain as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockGainHigh).mockReturnValueOnce(mockGainLow);

		audioContextConstructorSpy = vi.fn(function MockAudioContext() {
			mockAudioContextInstance = ctx;
			return ctx;
		});
		vi.stubGlobal("AudioContext", audioContextConstructorSpy);

		const player = new NotificationAudioPlayer();
		player.ensureContext();

		player.play("permission", 1.5);
		// Gain envelope uses clamped volume * 0.4, so max 0.4.
		expect(mockGainHigh.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.4, expect.any(Number));

		player.play("permission", -0.5);
		expect(mockGainLow.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, expect.any(Number));
	});

	it("dispose closes AudioContext", () => {
		const player = new NotificationAudioPlayer();
		player.ensureContext();

		player.dispose();

		expect(mockAudioContextInstance!.close).toHaveBeenCalled();

		// Subsequent play no-ops (context is null).
		expect(() => player.play("permission", 0.5)).not.toThrow();
	});

	it("queues multiple play calls sequentially", () => {
		const player = new NotificationAudioPlayer();
		player.ensureContext();
		const ctx = mockAudioContextInstance!;

		player.play("permission", 0.5);
		player.play("review", 0.5);
		player.play("failure", 0.5);

		// All should schedule: 2 + 1 + 3 = 6 oscillators.
		expect(ctx.createOscillator).toHaveBeenCalledTimes(6);
	});

	it("handles AudioContext constructor throwing", () => {
		audioContextConstructorSpy = vi.fn(function MockAudioContext() {
			throw new Error("AudioContext not allowed");
		});
		vi.stubGlobal("AudioContext", audioContextConstructorSpy);

		const player = new NotificationAudioPlayer();
		const ctx = player.ensureContext();

		expect(ctx).toBeNull();
		expect(() => player.play("permission", 0.5)).not.toThrow();
	});

	it("volume 0 still schedules oscillators", () => {
		const player = new NotificationAudioPlayer();
		player.ensureContext();
		const ctx = mockAudioContextInstance!;

		player.play("review", 0);

		expect(ctx.createOscillator).toHaveBeenCalledOnce();
	});
});
