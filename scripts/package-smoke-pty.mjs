import { realpathSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve, sep } from "node:path";

const READY = "quarterdeck-installed-pty-ready";
const INPUT = "quarterdeck-installed-pty-input";
const OUTPUT = "quarterdeck-installed-pty-ok";
const PROBE_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 1_000;

export class PtyProbeError extends Error {
	constructor(message, { cleanupConfirmed = false, pid, cause } = {}) {
		super(message, { cause });
		this.cleanupConfirmed = cleanupConfirmed;
		this.pid = pid;
	}
}

function isProcessAlive(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code !== "ESRCH";
	}
}

const childProgram = `
if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) process.exit(41);
process.stdin.setRawMode(true);
const timeout = setTimeout(() => process.exit(42), 4000);
let input = '';
process.stdin.on('data', data => {
  input += data.toString();
  if (!input.includes(${JSON.stringify(INPUT)})) return;
  clearTimeout(timeout);
  process.stdout.write(${JSON.stringify(OUTPUT)}, () => process.exit(0));
});
process.stdout.write(${JSON.stringify(READY)});
`;

/** Resolve only the installed artifact's dependency, never a source/global fallback. */
export function loadInstalledPty(installedCli, installRoot) {
	const installedRequire = createRequire(installedCli);
	const packagePath = realpathSync(installedRequire.resolve("node-pty/package.json"));
	const pathFromInstall = relative(realpathSync(installRoot), packagePath);
	if (pathFromInstall === ".." || pathFromInstall.startsWith(`..${sep}`) || isAbsolute(pathFromInstall)) {
		throw new Error("node-pty resolved outside the isolated installed package.");
	}
	const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
	return { pty: installedRequire("node-pty"), version: manifest.version };
}

/** Prove native spawn, bidirectional TTY transport, and normal child exit. */
export function probePty({
	pty,
	cwd,
	env,
	nodeBinary = process.execPath,
	timeoutMs = PROBE_TIMEOUT_MS,
	isAlive = isProcessAlive,
}) {
	return new Promise((resolveProbe, rejectProbe) => {
		let terminal;
		try {
			terminal = pty.spawn(nodeBinary, ["-e", childProgram], {
				name: "xterm-256color",
				cols: 80,
				rows: 24,
				cwd,
				env,
			});
		} catch (error) {
			rejectProbe(new PtyProbeError(error instanceof Error ? error.message : String(error), { cause: error }));
			return;
		}
		let output = "";
		let inputSent = false;
		let settled = false;
		let failure;
		let cleanupTimer;
		const subscriptions = [];
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(cleanupTimer);
			for (const subscription of subscriptions) subscription.dispose();
			const cleanupConfirmed = !isAlive(terminal.pid);
			if (error || !cleanupConfirmed) {
				rejectProbe(
					new PtyProbeError(
						error?.message ?? "Installed PTY exited but its process disappearance could not be confirmed.",
						{ cleanupConfirmed, pid: terminal.pid, cause: error },
					),
				);
			} else resolveProbe({ pid: terminal.pid, exitCode: 0 });
		};
		const timeoutError = new Error(
			"Installed node-pty did not complete its TTY input/output/exit probe before the deadline.",
		);
		const stop = (error) => {
			if (settled || failure) return;
			failure = error;
			cleanupTimer = setTimeout(() => finish(error), CLEANUP_TIMEOUT_MS);
			try {
				terminal.kill(process.platform === "win32" ? undefined : "SIGKILL");
			} catch {
				finish(error);
			}
		};
		const timer = setTimeout(() => stop(timeoutError), timeoutMs);
		subscriptions.push(
			terminal.onData((data) => {
				output = (output + data).slice(-64 * 1024);
				if (settled || inputSent || failure || !output.includes(READY)) return;
				inputSent = true;
				try {
					terminal.write(INPUT);
				} catch (error) {
					stop(error instanceof Error ? error : new Error(String(error)));
				}
			}),
			terminal.onExit(({ exitCode, signal }) => {
				if (failure) return finish(failure);
				if (exitCode !== 0 || signal || !inputSent || !output.includes(OUTPUT)) {
					return finish(
						new Error(
							`Installed node-pty TTY probe failed (exitCode=${String(exitCode)}, signal=${String(signal ?? 0)}, input=${inputSent}, output=${output.includes(OUTPUT)}).`,
						),
					);
				}
				finish();
			}),
		);
	});
}

if (resolve(process.argv[1] ?? "") === import.meta.filename) {
	let cleanupConfirmed = true;
	try {
		const [, , installedCli, installRoot] = process.argv;
		if (!installedCli || !installRoot)
			throw new Error("Expected an installed CLI path and its isolated install root.");
		const { pty, version } = loadInstalledPty(installedCli, installRoot);
		cleanupConfirmed = false;
		const result = await probePty({ pty, cwd: process.cwd(), env: process.env });
		cleanupConfirmed = true;
		console.log(
			`Installed node-pty ${version}: TTY input/output passed, child ${result.pid} exited ${result.exitCode} (Node ${process.version}, ABI ${process.versions.modules}).`,
		);
	} catch (error) {
		if (error instanceof PtyProbeError) cleanupConfirmed = error.cleanupConfirmed;
		console.error(error instanceof Error ? error.message : String(error));
		if (!cleanupConfirmed && Number.isSafeInteger(error?.pid) && error.pid > 0) {
			console.error(`Owned installed PTY PID ${error.pid} did not have confirmed process cleanup.`);
		}
		process.exitCode = 1;
	}
	console.log(
		cleanupConfirmed
			? "Installed PTY cleanup confirmed."
			: "Installed PTY cleanup unconfirmed; retain the isolated fixture.",
	);
}
