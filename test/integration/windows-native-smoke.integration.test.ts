import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import type { RawData } from "ws";
import { WebSocket } from "ws";

import type {
	RuntimeConfigResponse,
	RuntimeFileContentResponse,
	RuntimeListFilesResponse,
	RuntimeOpenProjectResponse,
	RuntimeProjectBoardCommandExecutionResult,
	RuntimeProjectStateResponse,
	RuntimeShellSessionStartResponse,
	RuntimeTaskSessionInputResponse,
	RuntimeTaskSessionStartResponse,
	RuntimeTaskSessionStopResponse,
	RuntimeTerminalWsServerMessage,
	RuntimeWorkdirChangesResponse,
	RuntimeWorkdirEntryMutationResponse,
	RuntimeWorktreeDeleteResponse,
	RuntimeWorktreeEnsureResponse,
} from "../../src/core";
import {
	buildQuarterdeckCommandLine,
	mergeProcessEnvironment,
	resolveWindowsCompatibleCommand,
	resolveWindowsComSpec,
	resolveWindowsPowerShellPath,
} from "../../src/core";
import { registerManagedProcessOwnership } from "../../src/terminal/managed-process-ownership";
import { createReviewBoard } from "../utilities/board-factory";
import { commitAll, initGitRepository, runGit } from "../utilities/git-env";
import {
	getAvailablePort,
	resolveTsxCliPath,
	resolveTsxLoaderImportSpecifier,
	startQuarterdeckServer,
	waitForExit,
} from "../utilities/integration-server";
import { createBoardSeedCommandBatch } from "../utilities/project-board-command";
import { createTempDir } from "../utilities/temp-dir";
import { requestJson } from "../utilities/trpc-request";

const execFileAsync = promisify(execFile);
const ACL_INSPECTION_PATHS_KEY = "QUARTERDECK_WINDOWS_ACL_INSPECTION_PATHS";

interface WindowsAclRule {
	sid: string;
	accessType: string;
	rights: string;
}

interface WindowsAclInspection {
	path: string;
	currentSid: string;
	ownerSid: string;
	protected: boolean;
	rules: WindowsAclRule[];
}

const WINDOWS_ACL_INSPECTION_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	`$paths = @(ConvertFrom-Json -InputObject ([Environment]::GetEnvironmentVariable('${ACL_INSPECTION_PATHS_KEY}', 'Process')))`,
	"$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
	"$rows = @(foreach ($path in $paths) { $acl = Get-Acl -LiteralPath $path; $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; $rules = @($acl.Access | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; accessType = $_.AccessControlType.ToString(); rights = $_.FileSystemRights.ToString() } }); [pscustomobject]@{ path = $path; currentSid = $currentSid; ownerSid = $ownerSid; protected = $acl.AreAccessRulesProtected; rules = $rules } })",
	"ConvertTo-Json -InputObject $rows -Depth 5 -Compress",
].join("; ");

async function assertPrivateWindowsAcls(paths: readonly string[]): Promise<void> {
	const { stdout } = await execFileAsync(
		resolveWindowsPowerShellPath(process.env),
		["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_ACL_INSPECTION_SCRIPT],
		{
			encoding: "utf8",
			env: mergeProcessEnvironment(process.env, {
				[ACL_INSPECTION_PATHS_KEY]: JSON.stringify(paths),
			}),
			timeout: 10_000,
			windowsHide: true,
		},
	);
	const parsed = JSON.parse(String(stdout)) as WindowsAclInspection | WindowsAclInspection[];
	const inspections = Array.isArray(parsed) ? parsed : [parsed];
	expect(inspections).toHaveLength(paths.length);
	for (const inspection of inspections) {
		if (lstatSync(inspection.path).isDirectory()) expect(inspection.protected, inspection.path).toBe(true);
		expect(inspection.ownerSid, inspection.path).toBe(inspection.currentSid);
		expect(inspection.rules.length, inspection.path).toBeGreaterThanOrEqual(2);
		const allowedSids = new Set([inspection.currentSid, "S-1-5-18"]);
		for (const rule of inspection.rules) {
			expect(rule.accessType, inspection.path).toBe("Allow");
			expect(allowedSids.has(rule.sid), `${inspection.path}: unexpected SID ${rule.sid}`).toBe(true);
			expect(rule.rights, inspection.path).toContain("FullControl");
		}
		expect(
			inspection.rules.some((rule) => rule.sid === inspection.currentSid),
			inspection.path,
		).toBe(true);
		expect(
			inspection.rules.some((rule) => rule.sid === "S-1-5-18"),
			inspection.path,
		).toBe(true);
	}
}

async function captureDiagnostics(stateHome: string, outputDirectory: string, homeDirectory: string): Promise<void> {
	const cliEntrypoint = resolve(process.cwd(), "src/cli.ts");
	await execFileAsync(
		process.execPath,
		[
			"--import",
			resolveTsxLoaderImportSpecifier(),
			cliEntrypoint,
			"diagnostics",
			"capture",
			"--output",
			outputDirectory,
			"--json",
		],
		{
			cwd: process.cwd(),
			encoding: "utf8",
			env: mergeProcessEnvironment(process.env, {
				HOME: homeDirectory,
				USERPROFILE: homeDirectory,
				QUARTERDECK_STATE_HOME: stateHome,
			}),
			timeout: 20_000,
			windowsHide: true,
		},
	);
}

async function executeWindowsShellCommand(
	command: string,
	input: string,
	env: NodeJS.ProcessEnv,
	cwd: string,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolveCommand, rejectCommand) => {
		const child = execFile(
			resolveWindowsComSpec(env),
			["/d", "/s", "/c", command],
			{
				cwd,
				encoding: "utf8",
				env,
				timeout: 10_000,
				windowsHide: true,
				windowsVerbatimArguments: true,
			},
			(error, stdout, stderr) => {
				if (error) {
					rejectCommand(error);
					return;
				}
				resolveCommand({ stdout, stderr });
			},
		);
		if (!child.stdin) {
			rejectCommand(new Error("Native Windows command serializer probe did not expose stdin."));
			return;
		}
		child.stdin.end(input);
	});
}

async function executeWindowsResolvedCommand(
	binary: string,
	args: string[],
	input: string,
	env: NodeJS.ProcessEnv,
	cwd: string,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolveCommand, rejectCommand) => {
		const child = execFile(
			binary,
			args,
			{
				cwd,
				encoding: "utf8",
				env,
				timeout: 10_000,
				windowsHide: true,
				windowsVerbatimArguments: binary.toLowerCase() === resolveWindowsComSpec(env).toLowerCase(),
			},
			(error, stdout, stderr) => {
				if (error) {
					rejectCommand(error);
					return;
				}
				resolveCommand({ stdout, stderr });
			},
		);
		if (!child.stdin) {
			rejectCommand(new Error("Native Windows resolved-command probe did not expose stdin."));
			return;
		}
		child.stdin.end(input);
	});
}

function assertNoWindowsCommandError(stderr: string): void {
	const normalized = stderr.trim();
	if (!normalized) return;
	expect(normalized).toMatch(/^#< CLIXML\r?\n<Objs\b/u);
	expect(normalized).toContain('<Obj S="progress"');
	expect(normalized).toContain("<AV>Preparing modules for first use.</AV>");
	expect(normalized).toMatch(/<T>Completed<\/T>.*<\/Objs>$/su);
}

async function assertWindowsShellCommandRoundTrip(tempHome: string): Promise<void> {
	const fixtureRoot = join(tempHome, "command %NAME% !ROUND_TRIP! ^ & (runtime)");
	const copiedNodePath = join(fixtureRoot, "node %NAME% !ROUND_TRIP! ^ & (copy).exe");
	const powerShellDecoyPath = join(fixtureRoot, "powershell.exe");
	const cmdDecoyPath = join(fixtureRoot, "cmd.exe");
	const captureScriptPath = join(fixtureRoot, "capture arguments.cjs");
	const capturePath = join(fixtureRoot, "captured arguments.json");
	const shimDirectory = join(tempHome, "node_modules", ".bin");
	const cmdShimPath = join(shimDirectory, "capture arguments.cmd");
	const powerShellShimPath = join(shimDirectory, "capture arguments.ps1");
	const expectedArguments = [
		"space value",
		"%NAME%",
		"!ROUND_TRIP!",
		"^",
		"&",
		"|",
		"(round trip)",
		"combined %NAME% !ROUND_TRIP! ^ & | (value)",
	];
	const expectedInput = "status-line stdin %NAME% !ROUND_TRIP! ^ & | (value)";

	mkdirSync(fixtureRoot, { recursive: true });
	mkdirSync(shimDirectory, { recursive: true });
	copyFileSync(process.execPath, copiedNodePath);
	copyFileSync(process.execPath, powerShellDecoyPath);
	copyFileSync(process.execPath, cmdDecoyPath);
	writeFileSync(
		captureScriptPath,
		[
			"const chunks = [];",
			"process.stdin.on('data', (chunk) => chunks.push(chunk));",
			"process.stdin.on('end', () => {",
			"  require('node:fs').writeFileSync(process.argv[2], JSON.stringify({ args: process.argv.slice(3), input: Buffer.concat(chunks).toString('utf8') }), 'utf8');",
			"  process.stdout.write('round-trip stdout');",
			"});",
			"",
		].join("\n"),
		"utf8",
	);
	const commandEnv = mergeProcessEnvironment(process.env, {
		NAME: "EXPANDED_NAME",
		PATH: `${fixtureRoot}${delimiter}${process.env.PATH ?? ""}`,
		ROUND_TRIP: "EXPANDED_DELAYED_VALUE",
	});
	const poisonedComSpecEnv = Object.fromEntries(
		Object.entries(commandEnv).filter(([key]) => key.toLowerCase() !== "comspec"),
	);
	poisonedComSpecEnv.ComSpec = "cmd.exe";
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
	expect(resolveWindowsComSpec(poisonedComSpecEnv)).toBe(join(systemRoot, "System32", "cmd.exe"));
	const command = buildQuarterdeckCommandLine(
		[capturePath, ...expectedArguments],
		{ execPath: copiedNodePath, argv: [copiedNodePath, captureScriptPath] },
		"win32",
		commandEnv,
	);
	const result = await executeWindowsShellCommand(command, expectedInput, commandEnv, fixtureRoot);

	expect(result.stdout).toBe("round-trip stdout");
	assertNoWindowsCommandError(result.stderr);
	expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual({
		args: expectedArguments,
		input: expectedInput,
	});

	writeFileSync(
		cmdShimPath,
		[
			"@echo off",
			'"%QUARTERDECK_WINDOWS_NODE%" "%QUARTERDECK_WINDOWS_CAPTURE_SCRIPT%" "%QUARTERDECK_WINDOWS_CAPTURE_PATH%" %*',
			"exit /b %errorlevel%",
			"",
		].join("\r\n"),
		"utf8",
	);
	const cmdArguments = expectedArguments;
	const cmdResolved = resolveWindowsCompatibleCommand(cmdShimPath, cmdArguments, "win32", {
		...commandEnv,
		QUARTERDECK_WINDOWS_CAPTURE_PATH: capturePath,
		QUARTERDECK_WINDOWS_CAPTURE_SCRIPT: captureScriptPath,
	});
	const cmdResult = await executeWindowsResolvedCommand(
		cmdResolved.binary,
		cmdResolved.args,
		expectedInput,
		{
			...commandEnv,
			QUARTERDECK_WINDOWS_CAPTURE_PATH: capturePath,
			QUARTERDECK_WINDOWS_CAPTURE_SCRIPT: captureScriptPath,
		},
		fixtureRoot,
	);
	expect(cmdResult).toEqual({ stdout: "round-trip stdout", stderr: "" });
	expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual({ args: cmdArguments, input: expectedInput });

	writeFileSync(
		powerShellShimPath,
		[
			"& $env:QUARTERDECK_WINDOWS_NODE $env:QUARTERDECK_WINDOWS_CAPTURE_SCRIPT $env:QUARTERDECK_WINDOWS_CAPTURE_PATH @args",
			"exit $LASTEXITCODE",
			"",
		].join("\r\n"),
		"utf8",
	);
	const multilineArguments = [
		...cmdArguments,
		'quoted "value"',
		"trailing-backslash\\",
		"first line\nsecond line",
		"carriage\rreturn",
	];
	const powerShellResolved = resolveWindowsCompatibleCommand(cmdShimPath, multilineArguments, "win32", {
		...commandEnv,
		QUARTERDECK_WINDOWS_CAPTURE_PATH: capturePath,
		QUARTERDECK_WINDOWS_CAPTURE_SCRIPT: captureScriptPath,
	});
	expect(powerShellResolved.binary.toLowerCase()).toContain("powershell.exe");
	const powerShellResult = await executeWindowsResolvedCommand(
		powerShellResolved.binary,
		powerShellResolved.args,
		expectedInput,
		{
			...commandEnv,
			QUARTERDECK_WINDOWS_CAPTURE_PATH: capturePath,
			QUARTERDECK_WINDOWS_CAPTURE_SCRIPT: captureScriptPath,
		},
		fixtureRoot,
	);
	expect(powerShellResult).toEqual({ stdout: "round-trip stdout", stderr: "" });
	expect(JSON.parse(readFileSync(capturePath, "utf8"))).toEqual({
		args: multilineArguments,
		input: expectedInput,
	});
}

interface QueuedWebSocket {
	socket: WebSocket;
	queue: RawData[];
	events: EventEmitter;
}

function rawDataToBuffer(data: RawData): Buffer {
	if (typeof data === "string") return Buffer.from(data, "utf8");
	if (Buffer.isBuffer(data)) return data;
	if (Array.isArray(data)) return Buffer.concat(data.map((part) => rawDataToBuffer(part)));
	return Buffer.from(data);
}

async function openQueuedWebSocket(url: string): Promise<QueuedWebSocket> {
	const socket = new WebSocket(url);
	const queue: RawData[] = [];
	const events = new EventEmitter();
	socket.on("message", (message) => {
		queue.push(message);
		events.emit("message");
	});
	await Promise.race([
		once(socket, "open"),
		new Promise<never>((_, reject) => {
			const timeout = setTimeout(() => reject(new Error(`Timed out opening native terminal socket: ${url}`)), 5_000);
			timeout.unref();
		}),
	]);
	return { socket, queue, events };
}

async function waitForControlMessage(
	queuedSocket: QueuedWebSocket,
	predicate: (message: RuntimeTerminalWsServerMessage) => boolean,
): Promise<RuntimeTerminalWsServerMessage> {
	return await new Promise((resolveMessage, rejectMessage) => {
		const tryResolve = () => {
			const index = queuedSocket.queue.findIndex((rawData) => {
				const message = JSON.parse(rawDataToBuffer(rawData).toString("utf8")) as RuntimeTerminalWsServerMessage;
				return predicate(message);
			});
			if (index < 0) return;
			const [rawData] = queuedSocket.queue.splice(index, 1);
			clearTimeout(timeout);
			queuedSocket.events.removeListener("message", tryResolve);
			resolveMessage(JSON.parse(rawDataToBuffer(rawData).toString("utf8")) as RuntimeTerminalWsServerMessage);
		};
		const timeout = setTimeout(() => {
			queuedSocket.events.removeListener("message", tryResolve);
			rejectMessage(new Error("Timed out waiting for native terminal control message."));
		}, 10_000);
		queuedSocket.events.on("message", tryResolve);
		tryResolve();
	});
}

async function closeWebSocket(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.CLOSED) return;
	if (socket.readyState !== WebSocket.CLOSING) socket.close();
	await once(socket, "close");
}

async function assertNativeConptyResizeReconnectRestore(
	baseUrl: string,
	projectId: string,
	taskId: string,
): Promise<void> {
	const websocketOrigin = baseUrl.replace(/^http/u, "ws");
	const clientId = `windows-native-${randomUUID()}`;
	const socketUrl = (kind: "io" | "control") =>
		`${websocketOrigin}/api/terminal/${kind}?taskId=${encodeURIComponent(taskId)}&projectId=${encodeURIComponent(projectId)}&clientId=${encodeURIComponent(clientId)}`;

	let ioSocket: QueuedWebSocket | null = null;
	let controlSocket: QueuedWebSocket | null = null;
	try {
		ioSocket = await openQueuedWebSocket(socketUrl("io"));
		controlSocket = await openQueuedWebSocket(socketUrl("control"));
		controlSocket.socket.send(JSON.stringify({ type: "resize", cols: 111, rows: 33 }));
		const initialRestore = await waitForControlMessage(controlSocket, (message) => message.type === "restore");
		expect(initialRestore).toMatchObject({ type: "restore", cols: 111, rows: 33 });
		controlSocket.socket.send(JSON.stringify({ type: "restore_complete" }));

		// Same-size force exercises the Windows ConPTY row nudge. Requesting a
		// snapshot immediately afterwards proves the final geometry was restored.
		controlSocket.socket.send(JSON.stringify({ type: "resize", cols: 111, rows: 33, force: true }));
		controlSocket.socket.send(JSON.stringify({ type: "request_restore" }));
		const forcedRestore = await waitForControlMessage(controlSocket, (message) => message.type === "restore");
		expect(forcedRestore).toMatchObject({ type: "restore", cols: 111, rows: 33 });
		controlSocket.socket.send(JSON.stringify({ type: "restore_complete" }));

		await closeWebSocket(ioSocket.socket);
		ioSocket = null;
		await closeWebSocket(controlSocket.socket);
		controlSocket = null;

		ioSocket = await openQueuedWebSocket(socketUrl("io"));
		controlSocket = await openQueuedWebSocket(socketUrl("control"));
		controlSocket.socket.send(JSON.stringify({ type: "resize", cols: 111, rows: 33, force: true }));
		const reconnectRestore = await waitForControlMessage(controlSocket, (message) => message.type === "restore");
		expect(reconnectRestore).toMatchObject({ type: "restore", cols: 111, rows: 33 });
		controlSocket.socket.send(JSON.stringify({ type: "restore_complete" }));
	} finally {
		await Promise.all([
			ioSocket ? closeWebSocket(ioSocket.socket) : Promise.resolve(),
			controlSocket ? closeWebSocket(controlSocket.socket) : Promise.resolve(),
		]);
	}
}

function installWindowsLaunchFixtures(binDir: string): void {
	mkdirSync(binDir, { recursive: true });
	writeFileSync(
		join(binDir, "codex.cmd"),
		[
			"@echo off",
			'"%QUARTERDECK_WINDOWS_NODE%" --import "%QUARTERDECK_WINDOWS_TSX_LOADER%" "%QUARTERDECK_WINDOWS_FAKE_CODEX%" %*',
			"exit /b %errorlevel%",
			"",
		].join("\r\n"),
		"utf8",
	);
	writeFileSync(
		join(binDir, "code.cmd"),
		["@echo off", '> "%QUARTERDECK_WINDOWS_HOST_LAUNCH_LOG%" echo %~1', "exit /b 0", ""].join("\r\n"),
		"utf8",
	);
	writeFileSync(
		join(binDir, "codex.ps1"),
		[
			"if ($args -contains '--') { $serializedArguments = ConvertTo-Json -InputObject @($args) -Compress; [System.IO.File]::WriteAllText($env:QUARTERDECK_WINDOWS_POWERSHELL_AGENT_MARKER, $serializedArguments) }",
			"& $env:QUARTERDECK_WINDOWS_NODE --import $env:QUARTERDECK_WINDOWS_TSX_LOADER $env:QUARTERDECK_WINDOWS_FAKE_CODEX @args",
			"exit $LASTEXITCODE",
			"",
		].join("\r\n"),
		"utf8",
	);
}

async function waitUntil(
	condition: () => boolean | Promise<boolean>,
	description: string,
	timeoutMs = 10_000,
): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (await condition()) {
			return;
		}
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
	}
	throw new Error(`Timed out waiting for ${description}.`);
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function forceStopProcess(child: ChildProcess | null): Promise<void> {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGKILL");
	await waitForExit(child, 5_000);
}

describe.runIf(process.platform === "win32").sequential("native Windows smoke", () => {
	it("covers source CLI, agent probing, ConPTY task/shell sessions, worktrees, shortcuts, and host launch", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("quarterdeck-windows-smoke-home-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("quarterdeck windows %NAME% ! ^ & (smoke)-");
		const fakeBinPath = join(tempHome, "fake-bin");
		const customStateHome = join(tempHome, "custom Quarterdeck state");
		const diagnosticBundlePath = join(tempHome, "diagnostic exports", "native ACL capture");
		const hostLaunchLogPath = join(tempHome, "host-launch.log");
		const shellMarkerPath = join(tempHome, "shell-shortcut.marker");
		const powerShellAgentMarkerPath = join(tempHome, "powershell-agent-arguments.json");
		const ignoredDirectoryPath = join(projectPath, ".windows-smoke-cache");
		const ignoredFilePath = join(projectPath, ".windows-smoke.env");
		const leadingTrackedRelativePath = " leading-note.txt";
		const longTrackedRelativePath = join(
			...Array.from({ length: 5 }, (_, index) => `${String(index + 1)}-${"nested".repeat(8)}`),
			"long-path-sentinel.txt",
		);
		const longTrackedPath = join(projectPath, longTrackedRelativePath);
		let stopServer: (() => Promise<void>) | null = null;
		let crashServer: (() => Promise<void>) | null = null;
		let orphanOwner: ChildProcess | null = null;
		let unrelatedAgent: ChildProcess | null = null;
		let managedOrphanPid: number | null = null;

		try {
			await assertWindowsShellCommandRoundTrip(tempHome);
			initGitRepository(projectPath);
			runGit(projectPath, ["config", "user.name", "Quarterdeck Windows Smoke"]);
			runGit(projectPath, ["config", "user.email", "windows-smoke@example.com"]);
			writeFileSync(join(projectPath, "README.md"), "# Native Windows smoke\n", "utf8");
			writeFileSync(join(projectPath, leadingTrackedRelativePath), "leading path content\n", "utf8");
			writeFileSync(
				join(projectPath, ".gitignore"),
				["/.windows-smoke-cache/", "/.windows-smoke.env", "/code.exe", "/codex.exe", "/git.exe", ""].join("\n"),
				"utf8",
			);
			mkdirSync(ignoredDirectoryPath, { recursive: true });
			writeFileSync(join(ignoredDirectoryPath, "sentinel.txt"), "junction target\n", "utf8");
			writeFileSync(ignoredFilePath, "WINDOWS_SMOKE=ready\n", "utf8");
			commitAll(projectPath, "seed native Windows smoke project");
			expect(longTrackedPath.length).toBeGreaterThan(260);
			mkdirSync(dirname(longTrackedPath), { recursive: true });
			writeFileSync(longTrackedPath, "Git for Windows long-path checkout\n", "utf8");
			runGit(projectPath, ["-c", "core.longpaths=true", "add", "--", longTrackedRelativePath]);
			runGit(projectPath, ["-c", "core.longpaths=true", "commit", "-qm", "seed long tracked path"]);
			// Windows searches cwd before PATH for a bare executable. These invalid
			// project-local decoys prove every runtime launch uses the exact inherited-
			// PATH target for Git, the task agent, and the editor launcher.
			for (const decoyName of ["git.exe", "codex.exe", "code.exe"]) {
				writeFileSync(join(projectPath, decoyName), "not a Windows executable", "utf8");
			}

			installWindowsLaunchFixtures(fakeBinPath);
			const inheritedPath = process.env.PATH ?? process.env.Path ?? "";
			const smokePath = [fakeBinPath, inheritedPath].filter(Boolean).join(delimiter);
			const serverEnvironment = {
				PATH: smokePath,
				QUARTERDECK_AGENT_LAB: "1",
				QUARTERDECK_AGENT_LAB_CLI_ENTRYPOINT: resolve(process.cwd(), "src/cli.ts"),
				QUARTERDECK_AGENT_LAB_TSX_CLI: resolveTsxCliPath(),
				QUARTERDECK_STATE_HOME: customStateHome,
				QUARTERDECK_WINDOWS_FAKE_CODEX: resolve(process.cwd(), "scripts/agent-lab/fake-codex.ts"),
				QUARTERDECK_WINDOWS_HOST_LAUNCH_LOG: hostLaunchLogPath,
				QUARTERDECK_WINDOWS_NODE: process.execPath,
				QUARTERDECK_WINDOWS_POWERSHELL_AGENT_MARKER: powerShellAgentMarkerPath,
				QUARTERDECK_WINDOWS_SHELL_MARKER: shellMarkerPath,
				QUARTERDECK_WINDOWS_TSX_LOADER: resolveTsxLoaderImportSpecifier(),
			};
			const port = await getAvailablePort();
			const server = await startQuarterdeckServer({
				cwd: projectPath,
				homeDir: tempHome,
				port,
				extraEnv: serverEnvironment,
			});
			stopServer = server.stop;
			crashServer = server.crash;

			const runtimeUrl = new URL(server.runtimeUrl);
			const baseUrl = runtimeUrl.origin;
			const projectId = decodeURIComponent(runtimeUrl.pathname.slice(1));
			expect(projectId).not.toBe("");

			const diagnosticInstancesRoot = join(customStateHome, "diagnostics", "instances");
			await waitUntil(async () => {
				const instanceIds = await readdir(diagnosticInstancesRoot).catch(() => []);
				return instanceIds.some((instanceId) =>
					existsSync(join(diagnosticInstancesRoot, instanceId, "journal", "journal.json")),
				);
			}, "private diagnostic journal persistence");
			const instanceIds = await readdir(diagnosticInstancesRoot);
			expect(instanceIds).toHaveLength(1);
			const diagnosticInstancePath = join(diagnosticInstancesRoot, instanceIds[0] ?? "missing-instance");
			const diagnosticJournalPath = join(diagnosticInstancePath, "journal");
			const segmentName = (await readdir(diagnosticJournalPath)).find((name) => /^records-\d+\.jsonl$/u.test(name));
			expect(segmentName).toBeDefined();

			await captureDiagnostics(customStateHome, diagnosticBundlePath, tempHome);
			await assertPrivateWindowsAcls([
				join(customStateHome, "diagnostics"),
				diagnosticInstancePath,
				join(diagnosticInstancePath, "runtime.json"),
				diagnosticJournalPath,
				join(diagnosticJournalPath, "journal.json"),
				join(diagnosticJournalPath, segmentName ?? "missing-segment"),
				diagnosticBundlePath,
				join(diagnosticBundlePath, "manifest.json"),
				join(diagnosticBundlePath, "records.jsonl"),
			]);

			const configResponse = await requestJson<RuntimeConfigResponse>({
				baseUrl,
				procedure: "runtime.getConfig",
				type: "query",
				projectId,
			});
			expect(configResponse.status).toBe(200);
			expect(configResponse.payload.agents.find((agent) => agent.id === "codex")).toMatchObject({
				installed: true,
				status: "installed",
			});

			const refFilesResponse = await requestJson<RuntimeListFilesResponse>({
				baseUrl,
				procedure: "project.listFiles",
				type: "query",
				projectId,
				payload: { taskId: null, ref: "HEAD" },
			});
			expect(refFilesResponse.status).toBe(200);
			expect(refFilesResponse.payload.files).toContain(leadingTrackedRelativePath);
			const refContentResponse = await requestJson<RuntimeFileContentResponse>({
				baseUrl,
				procedure: "project.getFileContent",
				type: "query",
				projectId,
				payload: { taskId: null, path: leadingTrackedRelativePath, ref: "HEAD" },
			});
			expect(refContentResponse.payload.content).toBe("leading path content\n");

			const leadingCreatedRelativePath = " created-in-quarterdeck.txt";
			const createLeadingEntryResponse = await requestJson<RuntimeWorkdirEntryMutationResponse>({
				baseUrl,
				procedure: "project.createWorkdirEntry",
				type: "mutation",
				projectId,
				payload: { taskId: null, path: leadingCreatedRelativePath, kind: "file" },
			});
			expect(createLeadingEntryResponse.payload).toMatchObject({
				ok: true,
				path: leadingCreatedRelativePath,
			});
			writeFileSync(join(projectPath, leadingCreatedRelativePath), "untracked leading path\n", "utf8");

			const caseRenameSource = "Case-Rename.txt";
			const caseRenameTarget = "case-rename.txt";
			const createCaseRenameResponse = await requestJson<RuntimeWorkdirEntryMutationResponse>({
				baseUrl,
				procedure: "project.createWorkdirEntry",
				type: "mutation",
				projectId,
				payload: { taskId: null, path: caseRenameSource, kind: "file" },
			});
			expect(createCaseRenameResponse.payload).toMatchObject({ ok: true, path: caseRenameSource });
			writeFileSync(join(projectPath, caseRenameSource), "case-only rename content\n", "utf8");
			const caseRenameResponse = await requestJson<RuntimeWorkdirEntryMutationResponse>({
				baseUrl,
				procedure: "project.renameWorkdirEntry",
				type: "mutation",
				projectId,
				payload: {
					taskId: null,
					path: caseRenameSource,
					nextPath: caseRenameTarget,
					kind: "file",
				},
			});
			expect(caseRenameResponse.payload).toMatchObject({ ok: true, path: caseRenameTarget });
			expect(await readdir(projectPath)).toContain(caseRenameTarget);
			expect(await readdir(projectPath)).not.toContain(caseRenameSource);
			expect(readFileSync(join(projectPath, caseRenameTarget), "utf8")).toBe("case-only rename content\n");

			const changesResponse = await requestJson<RuntimeWorkdirChangesResponse>({
				baseUrl,
				procedure: "project.getChanges",
				type: "query",
				projectId,
				payload: { taskId: null },
			});
			expect(changesResponse.payload.files).toContainEqual(
				expect.objectContaining({ path: leadingCreatedRelativePath, status: "untracked" }),
			);
			rmSync(powerShellAgentMarkerPath, { force: true });

			const shellCommand = `"${process.execPath}" -e "require('node:fs').writeFileSync(process.env.QUARTERDECK_WINDOWS_SHELL_MARKER,'ok')"`;
			const savedConfig = await requestJson<RuntimeConfigResponse>({
				baseUrl,
				procedure: "runtime.saveConfig",
				type: "mutation",
				projectId,
				payload: {
					selectedAgentId: "codex",
					selectedShortcutLabel: "Native smoke",
					shortcuts: [{ label: "Native smoke", command: shellCommand, icon: "play" }],
				},
			});
			expect(savedConfig.status).toBe(200);
			expect(savedConfig.payload.shortcuts).toContainEqual({
				label: "Native smoke",
				command: shellCommand,
				icon: "play",
			});

			const taskId = "windows-native-task";
			const stateResponse = await requestJson<RuntimeProjectStateResponse>({
				baseUrl,
				procedure: "project.getState",
				type: "query",
				projectId,
			});
			expect(stateResponse.status).toBe(200);
			const seedResponse = await requestJson<RuntimeProjectBoardCommandExecutionResult>({
				baseUrl,
				procedure: "project.applyBoardCommands",
				type: "mutation",
				projectId,
				payload: createBoardSeedCommandBatch(
					createReviewBoard(taskId, "Native Windows task PTY"),
					stateResponse.payload.revision,
					"seed-native-windows-smoke",
				),
			});
			expect(seedResponse.status).toBe(200);

			const worktreeResponse = await requestJson<RuntimeWorktreeEnsureResponse>({
				baseUrl,
				procedure: "project.ensureWorktree",
				type: "mutation",
				projectId,
				payload: { taskId, baseRef: "main" },
			});
			expect(worktreeResponse.status).toBe(200);
			expect(worktreeResponse.payload.ok).toBe(true);
			if (!worktreeResponse.payload.ok) {
				throw new Error(worktreeResponse.payload.error ?? "Native Windows worktree creation failed.");
			}
			const mirroredIgnoredPath = join(worktreeResponse.payload.path, ".windows-smoke-cache");
			expect(lstatSync(mirroredIgnoredPath).isSymbolicLink()).toBe(true);
			expect(readFileSync(join(mirroredIgnoredPath, "sentinel.txt"), "utf8")).toBe("junction target\n");
			const mirroredIgnoredFilePath = join(worktreeResponse.payload.path, ".windows-smoke.env");
			const mirroredIgnoredFileStat = lstatSync(mirroredIgnoredFilePath);
			expect(mirroredIgnoredFileStat.isSymbolicLink() || mirroredIgnoredFileStat.isFile()).toBe(true);
			expect(readFileSync(mirroredIgnoredFilePath, "utf8")).toBe("WINDOWS_SMOKE=ready\n");
			expect(readFileSync(join(worktreeResponse.payload.path, longTrackedRelativePath), "utf8")).toBe(
				"Git for Windows long-path checkout\n",
			);

			const taskPrompt =
				"Wait for native Windows smoke input [agent-lab:idle]\r\nPreserve this exact multiline prompt.";
			const startTaskResponse = await requestJson<RuntimeTaskSessionStartResponse>({
				baseUrl,
				procedure: "runtime.startTaskSession",
				type: "mutation",
				projectId,
				payload: {
					taskId,
					prompt: taskPrompt,
					agentId: "codex",
					baseRef: "main",
					useWorktree: false,
				},
			});
			expect(startTaskResponse.status).toBe(200);
			expect(startTaskResponse.payload.ok).toBe(true);
			expect(startTaskResponse.payload.summary?.pid).toEqual(expect.any(Number));
			await waitUntil(() => existsSync(powerShellAgentMarkerPath), "PowerShell task-agent shim execution");
			expect(JSON.parse(readFileSync(powerShellAgentMarkerPath, "utf8"))).toContain(taskPrompt);
			await assertNativeConptyResizeReconnectRestore(baseUrl, projectId, taskId);
			const managedProcessesPath = join(customStateHome, "managed-processes");
			const ownershipRecordNames = (await readdir(managedProcessesPath)).filter((name) => name.endsWith(".json"));
			expect(ownershipRecordNames).toHaveLength(1);
			await assertPrivateWindowsAcls([
				managedProcessesPath,
				join(managedProcessesPath, ownershipRecordNames[0] ?? "missing-ownership-record"),
			]);

			const taskInputResponse = await requestJson<RuntimeTaskSessionInputResponse>({
				baseUrl,
				procedure: "runtime.sendTaskSessionInput",
				type: "mutation",
				projectId,
				payload: {
					taskId,
					text: "/working Native Windows task PTY",
					intent: "submit",
					appendNewline: true,
				},
			});
			expect(taskInputResponse.payload.ok).toBe(true);
			await waitUntil(async () => {
				const state = await requestJson<RuntimeProjectStateResponse>({
					baseUrl,
					procedure: "project.getState",
					type: "query",
					projectId,
				});
				return state.payload.board.columns.some(
					(column) => column.id === "in_progress" && column.cards.some((card) => card.id === taskId),
				);
			}, "native Codex hook transition");

			const stopTaskResponse = await requestJson<RuntimeTaskSessionStopResponse>({
				baseUrl,
				procedure: "runtime.stopTaskSession",
				type: "mutation",
				projectId,
				payload: { taskId, waitForExit: true },
			});
			expect(stopTaskResponse.status).toBe(200);
			expect(stopTaskResponse.payload).toMatchObject({ ok: true, didExit: true, outcome: "exited" });
			await waitUntil(
				async () => (await readdir(managedProcessesPath).catch(() => [])).every((name) => !name.endsWith(".json")),
				"managed process ownership retirement",
			);

			const shellTaskId = "__windows_native_shell__";
			const startShellResponse = await requestJson<RuntimeShellSessionStartResponse>({
				baseUrl,
				procedure: "runtime.startShellSession",
				type: "mutation",
				projectId,
				payload: { taskId: shellTaskId, baseRef: "main", cols: 100, rows: 30 },
			});
			expect(startShellResponse.status).toBe(200);
			expect(startShellResponse.payload.ok).toBe(true);
			expect(startShellResponse.payload.shellBinary?.toLowerCase()).toContain("cmd");

			const shortcutInputResponse = await requestJson<RuntimeTaskSessionInputResponse>({
				baseUrl,
				procedure: "runtime.sendTaskSessionInput",
				type: "mutation",
				projectId,
				payload: {
					taskId: shellTaskId,
					text: shellCommand,
					intent: "submit",
					appendNewline: true,
				},
			});
			expect(shortcutInputResponse.payload.ok).toBe(true);
			await waitUntil(() => existsSync(shellMarkerPath), "native shell shortcut marker");
			expect(readFileSync(shellMarkerPath, "utf8")).toBe("ok");
			const stopShellResponse = await requestJson<RuntimeTaskSessionStopResponse>({
				baseUrl,
				procedure: "runtime.stopTaskSession",
				type: "mutation",
				projectId,
				payload: { taskId: shellTaskId, waitForExit: true },
			});
			expect(stopShellResponse.status).toBe(200);
			expect(stopShellResponse.payload).toMatchObject({ ok: true, didExit: true, outcome: "exited" });

			const openProjectResponse = await requestJson<RuntimeOpenProjectResponse>({
				baseUrl,
				procedure: "runtime.openProject",
				type: "mutation",
				projectId,
				payload: { targetId: "vscode" },
			});
			expect(openProjectResponse.status).toBe(200);
			expect(openProjectResponse.payload).toEqual({ ok: true, outcome: "native" });
			expect(readFileSync(hostLaunchLogPath, "utf8").trim()).toBe(projectPath);

			const deleteWorktreeResponse = await requestJson<RuntimeWorktreeDeleteResponse>({
				baseUrl,
				procedure: "project.deleteWorktree",
				type: "mutation",
				projectId,
				payload: { taskId },
			});
			expect(deleteWorktreeResponse.payload).toMatchObject({ ok: true, removed: true });
			expect(existsSync(worktreeResponse.payload.path)).toBe(false);

			const orphanProbeRoot = join(tempHome, "managed orphan probe");
			const orphanOwnerScript = join(orphanProbeRoot, "owner.cjs");
			const orphanPidPath = join(orphanProbeRoot, "managed.pid");
			const managedAgentBinary = join(orphanProbeRoot, "codex.exe");
			const unrelatedAgentBinary = join(orphanProbeRoot, "claude.exe");
			mkdirSync(orphanProbeRoot, { recursive: true });
			copyFileSync(process.execPath, managedAgentBinary);
			copyFileSync(process.execPath, unrelatedAgentBinary);
			writeFileSync(
				orphanOwnerScript,
				[
					"const { spawn } = require('node:child_process');",
					"const { writeFileSync } = require('node:fs');",
					"const child = spawn(process.env.QUARTERDECK_MANAGED_ORPHAN_BINARY, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
					"if (!child.pid) throw new Error('Managed orphan probe did not start.');",
					"writeFileSync(process.env.QUARTERDECK_MANAGED_ORPHAN_PID_PATH, String(child.pid), 'utf8');",
					"setInterval(() => {}, 1000);",
					"",
				].join("\n"),
				"utf8",
			);
			orphanOwner = spawn(process.execPath, [orphanOwnerScript], {
				env: mergeProcessEnvironment(process.env, {
					QUARTERDECK_MANAGED_ORPHAN_BINARY: managedAgentBinary,
					QUARTERDECK_MANAGED_ORPHAN_PID_PATH: orphanPidPath,
				}),
				stdio: "ignore",
				windowsHide: true,
			});
			unrelatedAgent = spawn(unrelatedAgentBinary, ["-e", "setInterval(() => {}, 1000)", "codex", "pi"], {
				stdio: "ignore",
				windowsHide: true,
			});
			await waitUntil(() => existsSync(orphanPidPath), "managed orphan probe PID");
			managedOrphanPid = Number(readFileSync(orphanPidPath, "utf8"));
			expect(managedOrphanPid).toEqual(expect.any(Number));
			if (!orphanOwner.pid || !managedOrphanPid || !unrelatedAgent.pid) {
				throw new Error("Native Windows orphan cleanup probes did not start.");
			}
			const managedOrphanRecord = await registerManagedProcessOwnership(managedOrphanPid, randomUUID(), {
				platform: "win32",
				stateHome: customStateHome,
				runtimePid: orphanOwner.pid,
			});
			expect(managedOrphanRecord).not.toBeNull();
			await assertPrivateWindowsAcls([
				managedProcessesPath,
				managedOrphanRecord?.path ?? join(managedProcessesPath, "missing-orphan-record"),
			]);

			await forceStopProcess(orphanOwner);
			orphanOwner = null;
			expect(isPidAlive(managedOrphanPid)).toBe(true);
			expect(isPidAlive(unrelatedAgent.pid)).toBe(true);
			await crashServer();
			crashServer = null;
			stopServer = null;

			const cleanupServer = await startQuarterdeckServer({
				cwd: projectPath,
				homeDir: tempHome,
				port: await getAvailablePort(),
				extraEnv: mergeProcessEnvironment(serverEnvironment, {
					QUARTERDECK_AGENT_LAB: undefined,
				}),
			});
			stopServer = cleanupServer.stop;
			await waitUntil(() => !isPidAlive(managedOrphanPid ?? 0), "exact managed orphan process-tree cleanup", 20_000);
			expect(isPidAlive(unrelatedAgent.pid)).toBe(true);
			expect(existsSync(managedOrphanRecord?.path ?? "")).toBe(false);
		} finally {
			await stopServer?.();
			await forceStopProcess(orphanOwner);
			await forceStopProcess(unrelatedAgent);
			if (managedOrphanPid && isPidAlive(managedOrphanPid)) {
				process.kill(managedOrphanPid, "SIGKILL");
			}
			cleanupProject();
			cleanupHome();
		}
	}, 90_000);
});
