import type * as childProcess from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listWindowsDesktopProcesses } from "../../../scripts/agent-lab/desktop-windows-processes";

const run = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof childProcess>()),
	execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: run }),
}));

function row(pid: number, parentPid: number, birth: string, command: string): string {
	return `${pid}\t${parentPid}\t${birth}\t${Buffer.from(command, "utf8").toString("base64")}`;
}

describe("Windows desktop lab process snapshot", () => {
	beforeEach(() => run.mockReset());

	it("projects only the custody fields and preserves exact creation digits and Unicode command text", async () => {
		const birth = "639310648524127900";
		const command = '"C:\\Synthetic\\Quarterdeck.exe" "项目\t☃\n[]"';
		run.mockResolvedValueOnce({
			stdout: [row(0, 0, "", ""), row(101, 25, birth, command), row(102, 101, "", ""), "done\t101", ""].join("\r\n"),
		});
		await expect(listWindowsDesktopProcesses()).resolves.toEqual([
			{ pid: 101, parentPid: 25, startedAt: `windows:${birth}`, command },
			{ pid: 102, parentPid: 101, startedAt: "", command: "" },
		]);
		const [, args, options] = run.mock.calls[0] ?? [];
		const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
		expect(script).toContain("SELECT ProcessId, ParentProcessId, CreationDate, CommandLine FROM Win32_Process");
		expect(script).toContain(".ToUniversalTime().Ticks.ToString($culture)");
		expect(script.match(/Import-Module/gu)).toHaveLength(1);
		expect(options).toMatchObject({ timeout: 10_000, windowsHide: true });
	});

	it.each(["", "done\t101\n", `${row(101, 25, "1", "powershell.exe")}\n`, `${row(101, 25, "", "")}\ndone\t101\n`])(
		"rejects missing, partial or unreadable snapshot evidence",
		(stdout) => {
			run.mockResolvedValueOnce({ stdout });
			return expect(listWindowsDesktopProcesses()).rejects.toThrow("did not confirm its own probe process");
		},
	);

	it("reports only bounded stage, code and HRESULT information for a failed query", async () => {
		run.mockRejectedValueOnce({
			message: "private executable command",
			stdout: "private process inventory",
			code: 1,
			stderr:
				"qd-stage=load-cim\r\nqd-stage=query\r\nqd-hresult=80041017\r\nqd-cim-status=15\r\nprivate command text\r\n",
		});
		await expect(listWindowsDesktopProcesses()).rejects.toThrow(
			/^Windows process snapshot failed \(stage=query, elapsed=\d+ms, code=1, HRESULT=0x80041017, CIM status=15\)\.$/u,
		);
	});

	it("preserves the terminating signal when PowerShell never reached the script", async () => {
		run.mockRejectedValueOnce({ code: null, stderr: "", killed: true, signal: "SIGTERM" });
		await expect(listWindowsDesktopProcesses()).rejects.toThrow(
			/^Windows process snapshot failed \(stage=startup, elapsed=\d+ms, signal=SIGTERM\)\.$/u,
		);
	});
});
