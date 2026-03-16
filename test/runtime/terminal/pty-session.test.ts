import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ptyMocks = vi.hoisted(() => ({
	spawn: vi.fn(),
}));

vi.mock("node-pty", () => ({
	spawn: ptyMocks.spawn,
}));

import { PtySession } from "../../../src/terminal/pty-session.js";

const originalPlatform = process.platform;
const originalComSpec = process.env.ComSpec;
const originalCOMSPEC = process.env.COMSPEC;

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", {
		value,
		configurable: true,
	});
}

function createMockPtyProcess() {
	return {
		pid: 4242,
		onData: vi.fn(),
		onExit: vi.fn(),
		kill: vi.fn(),
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
	};
}

describe("PtySession", () => {
	beforeEach(() => {
		ptyMocks.spawn.mockReset();
		setPlatform(originalPlatform);
		if (originalComSpec === undefined) {
			delete process.env.ComSpec;
		} else {
			process.env.ComSpec = originalComSpec;
		}
		if (originalCOMSPEC === undefined) {
			delete process.env.COMSPEC;
		} else {
			process.env.COMSPEC = originalCOMSPEC;
		}
	});

	afterEach(() => {
		setPlatform(originalPlatform);
	});

	it("launches through cmd shell on Windows", () => {
		setPlatform("win32");
		process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
		const ptyProcess = createMockPtyProcess();
		ptyMocks.spawn.mockReturnValue(ptyProcess);

		const session = PtySession.spawn({
			binary: "codex",
			args: ["--foo", "hello world"],
			cwd: "C:/repo",
			env: { TERM: "xterm-256color" },
			cols: 120,
			rows: 40,
		});

		expect(ptyMocks.spawn).toHaveBeenCalledTimes(1);
		expect(ptyMocks.spawn.mock.calls[0]?.[0]).toBe("C:\\Windows\\System32\\cmd.exe");
		expect(ptyMocks.spawn.mock.calls[0]?.[1]).toEqual([
			"/d",
			"/s",
			"/c",
			'"codex" "--foo" "hello world"',
		]);
		expect(session.pid).toBe(4242);
	});

	it("does not use cmd shell outside Windows", () => {
		setPlatform("darwin");
		const ptyProcess = createMockPtyProcess();
		ptyMocks.spawn.mockReturnValue(ptyProcess);

		PtySession.spawn({
			binary: "codex",
			args: [],
			cwd: "/tmp",
			cols: 120,
			rows: 40,
		});

		expect(ptyMocks.spawn).toHaveBeenCalledTimes(1);
		expect(ptyMocks.spawn.mock.calls[0]?.[0]).toBe("codex");
	});

	it("does not wrap cmd itself on Windows", () => {
		setPlatform("win32");
		process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
		const ptyProcess = createMockPtyProcess();
		ptyMocks.spawn.mockReturnValue(ptyProcess);

		PtySession.spawn({
			binary: "cmd.exe",
			args: ["/c", "echo hi"],
			cwd: "C:/repo",
			cols: 120,
			rows: 40,
		});

		expect(ptyMocks.spawn).toHaveBeenCalledTimes(1);
		expect(ptyMocks.spawn.mock.calls[0]?.[0]).toBe("cmd.exe");
	});
});
