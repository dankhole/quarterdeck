import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockFsWrite = (
	fd: number,
	buffer: Buffer,
	offset: number,
	callback: (error: NodeJS.ErrnoException | null, written: number) => void,
) => void;

const ptyMocks = vi.hoisted(() => ({
	spawn: vi.fn(),
}));
const fsWriteMock = vi.hoisted(() => vi.fn<MockFsWrite>());
const preflightPtyLaunchMock = vi.hoisted(() => vi.fn());
const managedProcessOwnershipMocks = vi.hoisted(() => ({
	register: vi.fn(),
	retire: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		write: fsWriteMock,
	};
});

vi.mock("../../../src/terminal/pty-runtime-health", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/terminal/pty-runtime-health")>();
	return {
		...actual,
		preflightPtyLaunch: preflightPtyLaunchMock,
	};
});

vi.mock("../../../src/terminal/managed-process-ownership", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/terminal/managed-process-ownership")>();
	return {
		...actual,
		registerManagedProcessOwnership: managedProcessOwnershipMocks.register,
		retireManagedProcessOwnership: managedProcessOwnershipMocks.retire,
	};
});

import { PtySession } from "../../../src/terminal";
import { _testing as ptySessionTesting } from "../../../src/terminal/pty-session";

const originalPlatform = process.platform;
const originalComSpec = process.env.ComSpec;
const originalCOMSPEC = process.env.COMSPEC;
const originalPath = process.env.PATH;
const originalPathExt = process.env.PATHEXT;
let windowsCommandDirectory: string;

interface MockNodePtyWriteStream {
	_fd: number;
	_writeQueue: Array<{ buffer: Buffer; offset: number }>;
	_writeImmediate?: NodeJS.Immediate;
	_processWriteQueue: () => void;
}

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", {
		value,
		configurable: true,
	});
}

function createMockWriteStream(buffer = Buffer.from("hello")): MockNodePtyWriteStream {
	return {
		_fd: 10,
		_writeQueue: [{ buffer, offset: 0 }],
		_processWriteQueue: vi.fn(),
	};
}

function createMockPtyProcess(writeStream?: MockNodePtyWriteStream) {
	const listeners: {
		onData?: (data: string | Buffer | Uint8Array) => void;
		onExit?: (event: { exitCode: number; signal?: number }) => void;
	} = {};

	return {
		pid: 4242,
		onData: vi.fn((listener: (data: string | Buffer | Uint8Array) => void) => {
			listeners.onData = listener;
		}),
		onExit: vi.fn((listener: (event: { exitCode: number; signal?: number }) => void) => {
			listeners.onExit = listener;
		}),
		kill: vi.fn(),
		write: vi.fn(),
		resize: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		emitData: (data: string | Buffer | Uint8Array) => {
			listeners.onData?.(data);
		},
		emitExit: (event: { exitCode: number; signal?: number }) => {
			listeners.onExit?.(event);
		},
		_writeStream: writeStream,
	};
}

describe("PtySession", () => {
	beforeEach(() => {
		ptyMocks.spawn.mockReset();
		ptySessionTesting.setNodePtySpawnOverride(ptyMocks.spawn);
		fsWriteMock.mockReset();
		preflightPtyLaunchMock.mockReset();
		managedProcessOwnershipMocks.register.mockReset();
		managedProcessOwnershipMocks.retire.mockReset();
		managedProcessOwnershipMocks.retire.mockResolvedValue(undefined);
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
		if (originalPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = originalPath;
		}
		if (originalPathExt === undefined) {
			delete process.env.PATHEXT;
		} else {
			process.env.PATHEXT = originalPathExt;
		}
		windowsCommandDirectory = mkdtempSync(join(tmpdir(), "quarterdeck-win-pty-default-"));
		writeFileSync(join(windowsCommandDirectory, "codex.cmd"), "@echo off\r\n");
		writeFileSync(join(windowsCommandDirectory, "claude.cmd"), "@echo off\r\n");
		process.env.PATH = windowsCommandDirectory;
		process.env.PATHEXT = ".cmd";
	});

	afterEach(() => {
		ptySessionTesting.setNodePtySpawnOverride(null);
		setPlatform(originalPlatform);
		rmSync(windowsCommandDirectory, { recursive: true, force: true });
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalPathExt === undefined) delete process.env.PATHEXT;
		else process.env.PATHEXT = originalPathExt;
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
		expect(ptyMocks.spawn.mock.calls[0]?.[1]).toContain("/d /v:off /s /c");
		expect(ptyMocks.spawn.mock.calls[0]?.[1]).toContain(join(windowsCommandDirectory, "codex.cmd"));
		expect(ptyMocks.spawn.mock.calls[0]?.[1]).toContain("hello^");
		expect(ptyMocks.spawn.mock.calls[0]?.[1]).toContain("world");
		expect(session.pid).toBe(4242);
	});

	it("registers and retires exact managed ownership around a Windows PTY lifetime", async () => {
		setPlatform("win32");
		process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
		const ptyProcess = createMockPtyProcess();
		ptyMocks.spawn.mockReturnValue(ptyProcess);
		const handle = {
			recordId: "12345678-1234-1234-1234-123456789abc",
			path: "C:\\state\\managed-processes\\12345678-1234-1234-1234-123456789abc.json",
		};
		managedProcessOwnershipMocks.register.mockResolvedValue(handle);

		const session = PtySession.spawn({
			binary: "codex",
			args: [],
			cwd: "C:/repo",
			cols: 120,
			rows: 40,
		});
		await session.registerManagedProcessOwnership(handle.recordId);

		expect(managedProcessOwnershipMocks.register).toHaveBeenCalledWith(4242, handle.recordId);
		ptyProcess.emitExit({ exitCode: 0 });
		await vi.waitFor(() => expect(managedProcessOwnershipMocks.retire).toHaveBeenCalledWith(handle));
	});

	it("waits for the deferred ConPTY PID before registering managed ownership", async () => {
		setPlatform("win32");
		process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
		let pid = 0;
		const ptyProcess = createMockPtyProcess();
		Object.defineProperty(ptyProcess, "pid", { get: () => pid });
		ptyMocks.spawn.mockReturnValue(ptyProcess);
		managedProcessOwnershipMocks.register.mockResolvedValue(null);

		const session = PtySession.spawn({
			binary: "codex",
			args: [],
			cwd: "C:/repo",
			cols: 120,
			rows: 40,
		});
		setTimeout(() => {
			pid = 5151;
		}, 0);

		await session.registerManagedProcessOwnership("12345678-1234-1234-1234-123456789abc");

		expect(managedProcessOwnershipMocks.register).toHaveBeenCalledWith(5151, "12345678-1234-1234-1234-123456789abc");
	});

	it("does not over-quote bare executables on Windows", () => {
		setPlatform("win32");
		process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
		const ptyProcess = createMockPtyProcess();
		ptyMocks.spawn.mockReturnValue(ptyProcess);

		PtySession.spawn({
			binary: "claude",
			args: [],
			cwd: "C:/repo",
			cols: 120,
			rows: 40,
		});

		expect(ptyMocks.spawn).toHaveBeenCalledTimes(1);
		expect(ptyMocks.spawn.mock.calls[0]?.[1]).toContain(join(windowsCommandDirectory, "claude.cmd"));
	});

	it("launches bare executables directly on Windows when PATH resolves to .exe", () => {
		setPlatform("win32");
		process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
		process.env.PATHEXT = ".com;.exe;.bat;.cmd";
		const windowsBinDir = mkdtempSync(join(tmpdir(), "quarterdeck-win-path-"));
		writeFileSync(join(windowsBinDir, "codex.exe"), "");
		process.env.PATH = "";

		const ptyProcess = createMockPtyProcess();
		ptyMocks.spawn.mockReturnValue(ptyProcess);

		try {
			PtySession.spawn({
				binary: "codex",
				args: ["--foo", "bar"],
				cwd: "C:/repo",
				env: {
					PATH: windowsBinDir,
					PATHEXT: ".com;.exe;.bat;.cmd",
					ComSpec: "C:\\Windows\\System32\\cmd.exe",
				},
				cols: 120,
				rows: 40,
			});
		} finally {
			rmSync(windowsBinDir, { recursive: true, force: true });
		}

		expect(ptyMocks.spawn).toHaveBeenCalledTimes(1);
		expect(ptyMocks.spawn.mock.calls[0]?.[0]).toBe(join(windowsBinDir, "codex.exe"));
		expect(ptyMocks.spawn.mock.calls[0]?.[1]).toEqual(["--foo", "bar"]);
	});

	it("preserves full prompt text on Windows", () => {
		setPlatform("win32");
		process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
		const ptyProcess = createMockPtyProcess();
		ptyMocks.spawn.mockReturnValue(ptyProcess);

		PtySession.spawn({
			binary: "claude",
			args: ["add comment to random file\nwith more context"],
			cwd: "C:/repo",
			cols: 120,
			rows: 40,
		});

		expect(ptyMocks.spawn).toHaveBeenCalledTimes(1);
		const cmdArgs = ptyMocks.spawn.mock.calls[0]?.[1] as string;
		expect(cmdArgs).toContain("claude");
		expect(cmdArgs).toContain("add^");
		expect(cmdArgs).toContain("comment^");
		expect(cmdArgs).toContain("random^");
		expect(cmdArgs).toContain("file\\nwith^");
		expect(cmdArgs).toContain("more^");
		expect(cmdArgs).toContain("context");
	});

	it("prefers a sibling PowerShell shim so Windows PTYs preserve multiline prompts", () => {
		setPlatform("win32");
		process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
		process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
		const windowsBinDir = mkdtempSync(join(tmpdir(), "quarterdeck-win-pty-shim-"));
		writeFileSync(join(windowsBinDir, "codex.cmd"), "@echo off\r\n");
		writeFileSync(join(windowsBinDir, "codex.ps1"), "exit 0\r\n");
		const ptyProcess = createMockPtyProcess();
		ptyMocks.spawn.mockReturnValue(ptyProcess);

		try {
			PtySession.spawn({
				binary: "codex",
				args: ["--", "first line\r\nsecond line"],
				cwd: "C:/repo",
				env: {
					PATH: windowsBinDir,
					PATHEXT: ".COM;.EXE;.BAT;.CMD",
					SystemRoot: "C:\\Windows",
				},
				cols: 120,
				rows: 40,
			});
		} finally {
			rmSync(windowsBinDir, { recursive: true, force: true });
		}

		expect(ptyMocks.spawn).toHaveBeenCalledWith(
			"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				join(windowsBinDir, "codex.ps1"),
				"--",
				"first line\r\nsecond line",
			],
			expect.objectContaining({ cwd: "C:/repo" }),
		);
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
		expect(ptyMocks.spawn.mock.calls[0]?.[0]).toBe("C:\\Windows\\System32\\cmd.exe");
	});

	it("ignores resize calls after the pty has exited", () => {
		setPlatform("win32");
		const ptyProcess = createMockPtyProcess();
		ptyMocks.spawn.mockReturnValue(ptyProcess);

		const session = PtySession.spawn({
			binary: "claude",
			args: [],
			cwd: "C:/repo",
			cols: 120,
			rows: 40,
		});

		ptyProcess.emitExit({ exitCode: 0 });

		expect(() => session.resize(100, 30, 1200, 720)).not.toThrow();
		expect(ptyProcess.resize).not.toHaveBeenCalled();
	});

	it("forces a same-size Windows redraw through a bounded ConPTY row nudge", () => {
		setPlatform("win32");
		const ptyProcess = createMockPtyProcess();
		ptyMocks.spawn.mockReturnValue(ptyProcess);

		const session = PtySession.spawn({
			binary: "claude",
			args: [],
			cwd: "C:/repo",
			cols: 120,
			rows: 40,
		});

		session.forceRedraw(120, 40, 1200, 800);

		expect(ptyProcess.resize).toHaveBeenNthCalledWith(1, 120, 39, { width: 1200, height: 800 });
		expect(ptyProcess.resize).toHaveBeenNthCalledWith(2, 120, 40, { width: 1200, height: 800 });
	});

	it("uses SIGWINCH for a same-size redraw outside Windows", () => {
		setPlatform("linux");
		const ptyProcess = createMockPtyProcess();
		ptyMocks.spawn.mockReturnValue(ptyProcess);
		const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

		const session = PtySession.spawn({
			binary: "claude",
			args: [],
			cwd: "/tmp",
			cols: 120,
			rows: 40,
		});
		session.forceRedraw(120, 40);

		expect(killSpy).toHaveBeenCalledWith(4242, "SIGWINCH");
		killSpy.mockRestore();
	});

	it("ignores node-pty resize races after process exit", () => {
		setPlatform("win32");
		const ptyProcess = createMockPtyProcess();
		ptyProcess.resize.mockImplementation(() => {
			throw new Error("Cannot resize a pty that has already exited");
		});
		ptyMocks.spawn.mockReturnValue(ptyProcess);

		const session = PtySession.spawn({
			binary: "claude",
			args: [],
			cwd: "C:/repo",
			cols: 120,
			rows: 40,
		});

		expect(() => session.resize(100, 30)).not.toThrow();
		expect(() => session.resize(120, 40)).not.toThrow();
		expect(ptyProcess.resize).toHaveBeenCalledTimes(1);
	});

	it("rethrows non-ignorable resize errors", () => {
		setPlatform("win32");
		const ptyProcess = createMockPtyProcess();
		ptyProcess.resize.mockImplementation(() => {
			const error = new Error("permission denied") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		});
		ptyMocks.spawn.mockReturnValue(ptyProcess);

		const session = PtySession.spawn({
			binary: "claude",
			args: [],
			cwd: "C:/repo",
			cols: 120,
			rows: 40,
		});

		expect(() => session.resize(100, 30)).toThrow("permission denied");
	});

	it("ignores EIO write errors", () => {
		setPlatform("darwin");
		const ptyProcess = createMockPtyProcess();
		ptyProcess.write.mockImplementation(() => {
			const error = new Error("i/o error") as NodeJS.ErrnoException;
			error.code = "EIO";
			throw error;
		});
		ptyMocks.spawn.mockReturnValue(ptyProcess);

		const session = PtySession.spawn({
			binary: "claude",
			args: [],
			cwd: "/tmp",
			cols: 120,
			rows: 40,
		});

		expect(() => session.write("hello")).not.toThrow();
	});

	it("rethrows non-ignorable write errors", () => {
		setPlatform("darwin");
		const ptyProcess = createMockPtyProcess();
		ptyProcess.write.mockImplementation(() => {
			const error = new Error("permission denied") as NodeJS.ErrnoException;
			error.code = "EPERM";
			throw error;
		});
		ptyMocks.spawn.mockReturnValue(ptyProcess);

		const session = PtySession.spawn({
			binary: "claude",
			args: [],
			cwd: "/tmp",
			cols: 120,
			rows: 40,
		});

		expect(() => session.write("hello")).toThrow("permission denied");
	});

	it("suppresses node-pty async EIO write queue errors", () => {
		setPlatform("darwin");
		const writeStream = createMockWriteStream();
		const ptyProcess = createMockPtyProcess(writeStream);
		const error = new Error("i/o error") as NodeJS.ErrnoException;
		error.code = "EIO";
		fsWriteMock.mockImplementation((_fd, _buffer, _offset, callback) => {
			callback(error, 0);
		});
		ptyMocks.spawn.mockReturnValue(ptyProcess);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			PtySession.spawn({
				binary: "claude",
				args: [],
				cwd: "/tmp",
				cols: 120,
				rows: 40,
			});

			writeStream._processWriteQueue();

			expect(fsWriteMock).toHaveBeenCalledTimes(1);
			expect(writeStream._writeQueue).toHaveLength(0);
			expect(consoleError).not.toHaveBeenCalled();
		} finally {
			consoleError.mockRestore();
		}
	});

	it("keeps node-pty async non-ignorable write errors visible", () => {
		setPlatform("darwin");
		const writeStream = createMockWriteStream();
		const ptyProcess = createMockPtyProcess(writeStream);
		const error = new Error("permission denied") as NodeJS.ErrnoException;
		error.code = "EPERM";
		fsWriteMock.mockImplementation((_fd, _buffer, _offset, callback) => {
			callback(error, 0);
		});
		ptyMocks.spawn.mockReturnValue(ptyProcess);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			PtySession.spawn({
				binary: "claude",
				args: [],
				cwd: "/tmp",
				cols: 120,
				rows: 40,
			});

			writeStream._processWriteQueue();

			expect(fsWriteMock).toHaveBeenCalledTimes(1);
			expect(writeStream._writeQueue).toHaveLength(0);
			expect(consoleError).toHaveBeenCalledWith("Unhandled pty write error", error);
		} finally {
			consoleError.mockRestore();
		}
	});
});
