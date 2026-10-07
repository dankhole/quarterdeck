import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { assertRuntimeProcessLaunchAdmission } from "../core/runtime-process-launch-admission.js";
import { buildWindowsProcessArgsCommandLine } from "../core/windows-cmd-launch";
import { resolveWindowsPowerShellPath } from "../core/windows-system-paths";
import { LanguageNavigationError } from "./failure";

// The supervisor joins its job BEFORE launching the server, so even an immediate
// crash cannot escape ownership. The job handle is noninheritable and remains
// open until supervisor exit. Windows then kills every remaining job member.
// No PID enumeration, parent-liveness assumption, or stdout proxy is involved.
// https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
const OWNER_SOURCE = `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class QuarterdeckLanguageProcess {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
        public uint cb;
        public string reserved, desktop, title;
        public uint x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
        public ushort showWindow, reservedSize;
        public IntPtr reservedPointer, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
        public IntPtr process, thread;
        public uint processId, threadId;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string application, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles,
        uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo info);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static void Check(bool success) {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public static void Run(string executable, string arguments) {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        Check(job != IntPtr.Zero);
        // Intentionally keep this sole handle until process teardown. Closing it
        // explicitly would terminate this supervisor before it returns the child code.
        ExtendedLimits limits = new ExtendedLimits();
        limits.BasicLimitInformation.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE, no breakaway
        Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
        Check(AssignProcessToJobObject(job, GetCurrentProcess()));
        StartupInfo startup = new StartupInfo();
        startup.cb = (uint)Marshal.SizeOf(startup);
        startup.flags = 0x100; // STARTF_USESTDHANDLES
        startup.stdin = GetStdHandle(-10);
        startup.stdout = GetStdHandle(-11);
        startup.stderr = GetStdHandle(-12);
        foreach (IntPtr handle in new [] { startup.stdin, startup.stdout, startup.stderr })
            Check(SetHandleInformation(handle, 1, 1)); // HANDLE_FLAG_INHERIT
        ProcessInfo child;
        Check(CreateProcessW(executable, new StringBuilder(arguments), IntPtr.Zero,
            IntPtr.Zero, true, 0x08000000, IntPtr.Zero, null, ref startup, out child)); // CREATE_NO_WINDOW
        CloseHandle(child.thread);
        Check(WaitForSingleObject(child.process, 0xffffffff) == 0);
        uint exitCode;
        Check(GetExitCodeProcess(child.process, out exitCode));
        CloseHandle(child.process);
        Environment.Exit(unchecked((int)exitCode));
    }
}
`;

/** Keep command data out of the encoded script and its much smaller native argv budget. */
export function spawnWindowsLanguageProcess(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
	const commandLine = buildWindowsProcessArgsCommandLine([command, ...args]);
	// CreateProcessW allows 32,767 UTF-16 code units including the terminating null.
	if (commandLine.length > 32_766) {
		throw new LanguageNavigationError("The language server command exceeds the Windows command-line limit.", true, {
			stage: "initialization",
			category: "unavailable",
		});
	}
	const prefix = `QUARTERDECK_LSP_LAUNCH_${randomUUID().replaceAll("-", "")}`;
	const executableKey = `${prefix}_EXE`;
	const argumentsKey = `${prefix}_ARGV`;
	const script = `$ErrorActionPreference = 'Stop'
try {
$executable = [Environment]::GetEnvironmentVariable('${executableKey}')
$arguments = [Environment]::GetEnvironmentVariable('${argumentsKey}')
[Environment]::SetEnvironmentVariable('${executableKey}', $null, 'Process')
[Environment]::SetEnvironmentVariable('${argumentsKey}', $null, 'Process')
Add-Type -TypeDefinition @'
${OWNER_SOURCE}
'@
[QuarterdeckLanguageProcess]::Run($executable, $arguments)
} catch { exit 1 }
`;

	assertRuntimeProcessLaunchAdmission();
	return spawn(
		resolveWindowsPowerShellPath(),
		[
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			Buffer.from(script, "utf16le").toString("base64"),
		],
		{
			cwd,
			env: { ...env, [executableKey]: command, [argumentsKey]: commandLine },
			stdio: "pipe",
			shell: false,
			windowsHide: true,
		},
	);
}
