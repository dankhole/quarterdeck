import { describe, expect, it, vi } from "vitest";
import { _testing, DesktopNativeExperienceError } from "../../../scripts/agent-lab/desktop-native-experience";

function fixture(showWindow = false) {
	const original = {
		windowId: 1,
		webContentsId: 2,
		documentNonce: "synthetic-document-nonce",
		url: "app://quarterdeck/project",
		visible: showWindow,
		focused: showWindow,
		bounds: { x: 100, y: 100, width: 1280, height: 860 },
		zoom: 1,
		generation: "generation-1",
		processes: [
			{ role: "app" as const, pid: 5001, birth: "birth-1" },
			{ role: "helper" as const, pid: 5002, birth: "birth-2" },
			{ role: "renderer" as const, pid: 5003, birth: "birth-3" },
		],
	};
	const current = structuredClone(original);
	const ports = {
		capture: vi.fn(async () => structuredClone(current)),
		closeWindow: vi.fn(async () => {
			current.visible = false;
			current.focused = false;
		}),
		activateWindow: vi.fn(async () => {
			current.visible = true;
			current.focused = true;
		}),
		waitForWindow: vi.fn(async () => {}),
		configure: vi.fn(async (bounds: typeof original.bounds, zoom: number) => {
			current.bounds = bounds;
			current.zoom = zoom;
		}),
		exercise: vi.fn(async (zoom: number, size: { width: number; height: number }) => ({
			zoom,
			size,
			actions: [actionEvidence("Settings")],
			screenshots: ["synthetic.png"],
			captures: [],
			keyboard: {
				settingsEnter: true as const,
				settingsTabContained: true as const,
				settingsEscape: true as const,
				createEnter: true as const,
				createEscape: true as const,
			},
		})),
		restore: vi.fn(async () => {
			current.bounds = structuredClone(original.bounds);
			current.zoom = original.zoom;
		}),
	};
	return { ports, original, mutate: (change: (state: typeof original) => void) => change(current) };
}

describe("bounded desktop native experience", () => {
	it("never closes or activates a hidden window, checks both zooms and restores presentation", async () => {
		const { ports, original } = fixture();
		const proof = await _testing.proveNativeExperience(false, ports);
		expect(proof.mode).toBe("hidden");
		expect(proof.visibleCloseActivateFocusVerified).toBe(false);
		expect(proof.checkpoints.map((entry) => entry.zoom)).toEqual([1.25, 1.5]);
		expect(ports.configure.mock.calls.map(([bounds]) => [bounds.width, bounds.height])).toEqual([
			[1180, 720],
			[1460, 1040],
		]);
		expect(ports.closeWindow).not.toHaveBeenCalled();
		expect(ports.activateWindow).not.toHaveBeenCalled();
		expect(ports.restore).toHaveBeenCalledWith(original);
	});

	it("proves visible close and focused activation without replacing the window or runtime", async () => {
		const { ports } = fixture(true);
		const proof = await _testing.proveNativeExperience(true, ports);
		expect(proof.visibleCloseActivateFocusVerified).toBe(true);
		expect(ports.waitForWindow.mock.calls).toEqual([
			[false, false],
			[true, true],
		]);
		expect(ports.activateWindow.mock.invocationCallOrder[0]).toBeGreaterThan(
			ports.closeWindow.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it.each(["visible", "focused"] as const)("fails if hidden mode unexpectedly becomes %s", async (field) => {
		const { ports, mutate } = fixture();
		ports.exercise.mockImplementationOnce(async () => {
			mutate((state) => {
				state[field] = true;
			});
			return {
				zoom: 1.25,
				size: { width: 1180, height: 720 },
				actions: [],
				screenshots: [],
				captures: [],
				keyboard: {
					settingsEnter: true,
					settingsTabContained: true,
					settingsEscape: true,
					createEnter: true,
					createEscape: true,
				},
			};
		});
		await expect(_testing.proveNativeExperience(false, ports)).rejects.toMatchObject({
			failureStage: "identity",
			restorationConfirmed: false,
		});
		expect(ports.activateWindow).not.toHaveBeenCalled();
		expect(ports.restore).toHaveBeenCalledTimes(1);
	});

	it("rejects visible activation without actual native focus", async () => {
		const { ports, mutate } = fixture(true);
		ports.activateWindow.mockImplementationOnce(async () =>
			mutate((state) => {
				state.visible = true;
				state.focused = false;
			}),
		);
		await expect(_testing.proveNativeExperience(true, ports)).rejects.toMatchObject({
			failureStage: "activate",
			restorationConfirmed: true,
		});
	});

	it.each(["generation", "window", "document", "renderer-birth", "helper-pid", "selection"])(
		"rejects changed %s and restores presentation",
		async (change) => {
			const { ports, mutate } = fixture();
			const exercise = ports.exercise.getMockImplementation();
			ports.exercise.mockImplementationOnce(async (zoom, size) => {
				mutate((state) => {
					if (change === "generation") state.generation = "different";
					if (change === "window") state.windowId++;
					if (change === "document") state.webContentsId++;
					if (change === "renderer-birth") {
						const renderer = state.processes[2];
						if (renderer) renderer.birth = "reused-pid";
					}
					if (change === "helper-pid") {
						const helper = state.processes[1];
						if (helper) helper.pid++;
					}
					if (change === "selection") state.url = "app://quarterdeck/other";
				});
				if (!exercise) throw new Error("Missing synthetic exercise");
				return exercise(zoom, size);
			});
			await expect(_testing.proveNativeExperience(false, ports)).rejects.toMatchObject({
				failureStage: "identity",
				restorationConfirmed: false,
			});
			expect(ports.restore).toHaveBeenCalledTimes(1);
		},
	);

	it("rejects same-URL reload with unchanged WebContents and process identities", async () => {
		const { ports, mutate, original } = fixture();
		const exercise = ports.exercise.getMockImplementation();
		ports.exercise.mockImplementationOnce(async (zoom, size) => {
			mutate((state) => {
				state.documentNonce = "";
			});
			if (!exercise) throw new Error("Missing synthetic exercise");
			return exercise(zoom, size);
		});
		await expect(_testing.proveNativeExperience(false, ports)).rejects.toMatchObject({
			failureStage: "identity",
			restorationConfirmed: false,
		});
		const last = await ports.capture();
		expect(last.windowId).toBe(original.windowId);
		expect(last.webContentsId).toBe(original.webContentsId);
		expect(last.url).toBe(original.url);
		expect(last.processes).toEqual(original.processes);
		expect(ports.restore).toHaveBeenCalledTimes(1);
	});

	it("preserves the failing stage and reports restoration failure without exposing cause", async () => {
		const { ports } = fixture();
		ports.exercise.mockRejectedValueOnce(new Error("private UI data"));
		ports.restore.mockRejectedValueOnce(new Error("private runtime data"));
		try {
			await _testing.proveNativeExperience(false, ports);
			throw new Error("expected failure");
		} catch (error) {
			expect(error).toBeInstanceOf(DesktopNativeExperienceError);
			expect(error).toMatchObject({ failureStage: "keyboard_visual", restorationConfirmed: false });
			expect(JSON.stringify(error)).not.toContain("private");
		}
	});

	it("rejects an unconfirmed bounds/zoom restoration", async () => {
		const { ports } = fixture();
		ports.restore.mockImplementationOnce(async () => {});
		await expect(_testing.proveNativeExperience(false, ports)).rejects.toMatchObject({
			failureStage: "restore",
			restorationConfirmed: false,
		});
	});

	it("does not claim requested zoom when configuration failed", async () => {
		const { ports } = fixture();
		ports.configure.mockImplementationOnce(async () => {});
		await expect(_testing.proveNativeExperience(false, ports)).rejects.toMatchObject({
			failureStage: "zoom",
			restorationConfirmed: true,
		});
		expect(ports.exercise).not.toHaveBeenCalled();
	});

	it.each([
		null,
		{ x: -1, y: 2, width: 20, height: 20 },
		{ x: 90, y: 2, width: 20, height: 20 },
		{ x: 2, y: 90, width: 20, height: 20 },
		{ x: 2, y: 2, width: 0, height: 20 },
		{ x: Number.NaN, y: 2, width: 20, height: 20 },
	])("rejects missing, clipped or invalid primary-action bounds", (bounds) => {
		expect(() => _testing.assertActionBounds(bounds, { width: 100, height: 100 })).toThrow();
	});
	it("accepts a primary action contained in the logical viewport", () => {
		expect(() =>
			_testing.assertActionBounds({ x: 5, y: 10, width: 80, height: 20 }, { width: 100, height: 100 }),
		).not.toThrow();
	});
});

function actionEvidence(name: "Settings" | "Settings Save" | "Settings Cancel") {
	return {
		name,
		bounds: { x: 5, y: 10, width: 80, height: 20 },
		viewport: { width: 100, height: 100 },
		disabled: false,
		centerHit: true,
		pointerEventsNone: false,
	};
}

describe("native capture and action diagnostics", () => {
	it("allows the unchanged Settings Save's inactive hit target while retaining its bounds check", () => {
		const save = { ...actionEvidence("Settings Save"), disabled: true, centerHit: false, pointerEventsNone: true };
		expect(() => _testing.assertNativeAction(save, "settings_actions")).not.toThrow();
		expect(() => _testing.assertNativeAction(save, "board_actions")).toThrow(_testing.NativeVisualFailure);
		expect(() =>
			_testing.assertNativeAction({ ...save, bounds: { ...save.bounds, x: 90 } }, "settings_actions"),
		).toThrow(_testing.NativeVisualFailure);
	});

	it.each([
		{ ...actionEvidence("Settings Save"), centerHit: false },
		{ ...actionEvidence("Settings Save"), disabled: true, centerHit: false },
		{ ...actionEvidence("Settings Cancel"), disabled: true, centerHit: false, pointerEventsNone: true },
	])("still rejects blocked enabled actions and other disabled actions", (action) => {
		expect(() => _testing.assertNativeAction(action, "settings_actions")).toThrow(_testing.NativeVisualFailure);
	});

	it("preserves bounded action and substage diagnostics through restoration", async () => {
		const { ports } = fixture();
		const action = { ...actionEvidence("Settings Save"), centerHit: false };
		ports.exercise.mockRejectedValueOnce(
			new _testing.NativeVisualFailure({
				step: "settings_actions",
				action,
				check: "hit_target",
			}),
		);
		await expect(_testing.proveNativeExperience(false, ports)).rejects.toMatchObject({
			failureStage: "keyboard_visual",
			restorationConfirmed: true,
			diagnostic: { step: "settings_actions", action, check: "hit_target" },
		});
		expect(ports.restore).toHaveBeenCalledTimes(1);
	});

	it("retains actual PNG dimensions independently of the zoomed CSS viewport", () => {
		const png = Buffer.alloc(24);
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
		png.writeUInt32BE(1180, 16);
		png.writeUInt32BE(692, 20);
		expect(_testing.readPngSize(png)).toEqual({ width: 1180, height: 692 });
	});

	it.each([Buffer.alloc(23), Buffer.alloc(24), Buffer.alloc(16 * 1024 * 1024 + 1)])(
		"rejects absent, malformed or unbounded capture evidence",
		(png) => {
			expect(() => _testing.readPngSize(png)).toThrow();
		},
	);

	it.each([0, 8193])("rejects invalid native image dimensions (%s)", (width) => {
		const png = Buffer.alloc(24);
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
		png.writeUInt32BE(width, 16);
		png.writeUInt32BE(692, 20);
		expect(() => _testing.readPngSize(png)).toThrow();
	});
});
