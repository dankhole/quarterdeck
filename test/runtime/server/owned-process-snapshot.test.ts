import { afterEach, describe, expect, it, vi } from "vitest";
import {
	compareOwnedProcessBirth,
	type OwnedProcessSnapshot,
	queryOwnedProcessSnapshot,
} from "../../../src/server/owned-process-snapshot.js";

const mocks = vi.hoisted(() => ({
	execFile: vi.fn(),
	readdir: vi.fn(),
	readFile: vi.fn(),
	queryWindowsProcessTreeSnapshot: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("node:fs/promises", () => ({ readdir: mocks.readdir, readFile: mocks.readFile }));
vi.mock("../../../src/core/windows-process-snapshot.js", () => ({
	queryWindowsProcessTreeSnapshot: mocks.queryWindowsProcessTreeSnapshot,
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform");
afterEach(() => {
	if (platform) Object.defineProperty(process, "platform", platform);
	vi.resetAllMocks();
});

function usePlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value });
}

function mockBsdSnapshot(stdout: string): void {
	usePlatform("darwin");
	mocks.execFile.mockImplementation(
		(_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
			callback(null, stdout);
		},
	);
}

function procStat(pid: number, parentPid: number, ticks: string): string {
	const fields = Array<string>(20).fill("0");
	fields[0] = "S";
	fields[1] = String(parentPid);
	fields[19] = ticks;
	return `${pid} (name with ) spaces) ${fields.join(" ")}`;
}

function processRow(birthTime: OwnedProcessSnapshot["birthTime"]): OwnedProcessSnapshot {
	return { pid: 10, parentPid: 1, creationIdentity: "identity", birthTime, preciseIdentity: true, zombie: false };
}

describe("owned process snapshot birth ordering", () => {
	it("preserves exact Windows UTC ticks above Number precision and retains identity gaps", async () => {
		usePlatform("win32");
		mocks.queryWindowsProcessTreeSnapshot.mockResolvedValue([
			{ pid: 10, parentPid: 1, creationTime: "638000000000000001" },
			{ pid: 11, parentPid: 10, creationTime: "638000000000000000" },
			{ pid: 12, parentPid: 10, creationTime: null },
		]);
		const [parent, child, unknown] = await queryOwnedProcessSnapshot();
		if (!parent || !child || !unknown) throw new Error("Missing snapshot fixture rows.");
		expect(parent).toMatchObject({
			creationIdentity: "638000000000000001",
			birthTime: { clock: "windows", value: 638000000000000001n },
		});
		expect(compareOwnedProcessBirth(parent, child)).toBe(1);
		expect(unknown).toMatchObject({ creationIdentity: "", birthTime: undefined });
		expect(compareOwnedProcessBirth(parent, unknown)).toBeNull();
	});

	it("orders Linux boot-relative start ticks numerically within the same boot", async () => {
		usePlatform("linux");
		mocks.readdir.mockResolvedValue(["10", "11", "not-a-pid"]);
		mocks.readFile.mockImplementation(async (path: string) => {
			if (path === "/proc/sys/kernel/random/boot_id") return "boot-identity\n";
			if (path === "/proc/10/stat") return procStat(10, 1, "99");
			if (path === "/proc/11/stat") return procStat(11, 10, "100");
			throw new Error("Unexpected fixture path.");
		});
		const [parent, child] = await queryOwnedProcessSnapshot();
		if (!parent || !child) throw new Error("Missing snapshot fixture rows.");
		expect(parent).toMatchObject({
			creationIdentity: "boot-identity:99",
			birthTime: { clock: "linux", bootId: "boot-identity", value: 99n },
		});
		expect(compareOwnedProcessBirth(parent, child)).toBe(-1);
		expect(
			compareOwnedProcessBirth(parent, { ...child, birthTime: { clock: "linux", bootId: "other", value: 100n } }),
		).toBeNull();
	});

	it("does not invent a comparable Linux clock without a boot identity", async () => {
		usePlatform("linux");
		mocks.readdir.mockResolvedValue([]);
		mocks.readFile.mockResolvedValue("\n");
		await expect(queryOwnedProcessSnapshot()).rejects.toThrow("boot identity");
	});

	it("parses C-locale BSD timestamps in UTC across month and year boundaries", async () => {
		mockBsdSnapshot(
			[
				"10 1 Tue Dec 31 23:59:59 2024 S",
				"11 10 Wed Jan  1 00:00:00 2025 S",
				"12 11 Wed Jan  1 00:00:00 2025 Z",
			].join("\n"),
		);
		const [parent, child, zombie] = await queryOwnedProcessSnapshot();
		if (!parent || !child || !zombie) throw new Error("Missing snapshot fixture rows.");
		expect(parent).toMatchObject({
			creationIdentity: "Tue Dec 31 23:59:59 2024",
			birthTime: { clock: "bsd", value: BigInt(Date.UTC(2024, 11, 31, 23, 59, 59) / 1_000) },
			preciseIdentity: false,
		});
		expect(compareOwnedProcessBirth(parent, child)).toBe(-1);
		expect(compareOwnedProcessBirth(child, zombie)).toBe(0);
		expect(zombie.zombie).toBe(true);
		expect(mocks.execFile).toHaveBeenCalledWith(
			"/bin/ps",
			["-A", "-o", "pid=,ppid=,lstart=,stat="],
			expect.objectContaining({ env: expect.objectContaining({ LC_ALL: "C", TZ: "UTC" }) }),
			expect.any(Function),
		);
	});

	it.each(["Fri Feb 30 00:00:00 2024", "Fri Xxx  1 00:00:00 2024", "Fri Mar  1 25:00:00 2024"])(
		"fails closed on malformed BSD birth time %s",
		async (birth) => {
			mockBsdSnapshot(`10 1 ${birth} S`);
			await expect(queryOwnedProcessSnapshot()).rejects.toThrow("birth time");
		},
	);

	it("never compares different clocks, missing timestamps, or missing identity as equal", () => {
		const windows = processRow({ clock: "windows", value: 100n });
		const linux = processRow({ clock: "linux", bootId: "boot", value: 100n });
		const bsd = processRow({ clock: "bsd", value: 100n });
		for (const left of [windows, linux, bsd]) {
			expect(compareOwnedProcessBirth(left, left)).toBe(0);
			for (const right of [windows, linux, bsd].filter((entry) => entry !== left)) {
				expect(compareOwnedProcessBirth(left, right)).toBeNull();
			}
			expect(compareOwnedProcessBirth(left, processRow(undefined))).toBeNull();
			expect(compareOwnedProcessBirth(left, { ...left, creationIdentity: "" })).toBeNull();
		}
	});
});
