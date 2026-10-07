import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { RuntimeProcessIdentity } from "../core/api/runtime-management.js";
import { mergeProcessEnvironment } from "../core/process-environment.js";
import { resolveWindowsPowerShellPath } from "../core/windows-system-paths.js";
import { queryManagedProcessIdentities } from "../terminal/managed-process-ownership.js";

export type RuntimeProcessLiveness = "live" | "dead" | "unknown";

/** Only ESRCH proves absence; failed or denied probes never authorize takeover. */
export function probeRuntimeProcess(pid: number): RuntimeProcessLiveness {
	try {
		process.kill(pid, 0);
		return "live";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ESRCH" ? "dead" : code === "EPERM" ? "live" : "unknown";
	}
}

function queryProcess(command: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			command,
			args,
			{
				encoding: "utf8",
				timeout: 5_000,
				maxBuffer: 65_536,
				windowsHide: true,
				env: mergeProcessEnvironment(process.env, { LC_ALL: "C", TZ: "UTC" }),
			},
			(error, stdout) => {
				if (error) reject(new Error("Runtime process identity query failed."));
				else resolve(stdout.trim());
			},
		);
	});
}

let hostIdentity: Promise<string> | undefined;

/** Stable machine evidence is private and read-only; it does not make network homes supported. */
export function readRuntimeHostIdentity(): Promise<string> {
	hostIdentity ??= resolveRuntimeHostIdentity();
	return hostIdentity;
}

async function resolveRuntimeHostIdentity(): Promise<string> {
	try {
		let identity: string;
		if (process.platform === "darwin") {
			const output = await queryProcess("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
			identity = /"IOPlatformUUID"\s*=\s*"([a-fA-F0-9-]{36})"/u.exec(output)?.[1] ?? "";
		} else if (process.platform === "linux") {
			identity = (await readFile("/etc/machine-id", "utf8")).trim();
			if (!/^[a-fA-F0-9]{32}$/u.test(identity)) throw new Error("Invalid machine identity.");
		} else if (process.platform === "win32") {
			identity = await queryProcess(resolveWindowsPowerShellPath(), [
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-ItemPropertyValue -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid -ErrorAction Stop",
			]);
		} else throw new Error("Unsupported machine identity platform.");
		if (process.platform !== "linux" && !/^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/u.test(identity))
			throw new Error("Invalid machine identity.");
		if (/^0+$/u.test(identity.replaceAll("-", ""))) throw new Error("Invalid machine identity.");
		return `${process.platform}:sha256:${createHash("sha256").update(identity.toLowerCase()).digest("hex")}`;
	} catch {
		throw new Error("Could not verify this machine's stable runtime identity.");
	}
}

/** Process birth evidence prevents a recycled PID from preserving a dead claim. */
export async function readRuntimeProcessIdentity(pid: number): Promise<RuntimeProcessIdentity | null> {
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid runtime process identifier.");
	if (probeRuntimeProcess(pid) === "dead") return null;
	try {
		let creationIdentity: string;
		if (process.platform === "linux") {
			const [stat, bootId] = await Promise.all([
				readFile(`/proc/${pid}/stat`, "utf8"),
				readFile("/proc/sys/kernel/random/boot_id", "utf8"),
			]);
			// comm can contain spaces and parentheses; fields after the final ')' start at field 3.
			const fields = stat
				.slice(stat.lastIndexOf(")") + 2)
				.trim()
				.split(/\s+/u);
			const startTicks = fields[19];
			if (!startTicks || !/^\d+$/u.test(startTicks)) throw new Error("Missing process creation identity.");
			creationIdentity = `linux:${bootId.trim()}:${startTicks}`;
		} else if (process.platform === "win32") {
			const [identity] = await queryManagedProcessIdentities([pid]);
			if (!identity) throw new Error("Missing process creation identity.");
			creationIdentity = `windows:${identity.creationTime}`;
		} else {
			// BSD ps exposes kernel launch time. Second precision is conservative for rapid PID reuse.
			const birth = await queryProcess("/bin/ps", ["-p", String(pid), "-o", "lstart="]);
			if (!birth) throw new Error("Missing process creation identity.");
			creationIdentity = `${process.platform}:${birth}`;
		}
		return { pid, creationIdentity };
	} catch {
		if (probeRuntimeProcess(pid) === "dead") return null;
		throw new Error("Could not verify runtime process creation identity.");
	}
}

export async function inspectRuntimeProcess(identity: RuntimeProcessIdentity): Promise<RuntimeProcessLiveness> {
	if (probeRuntimeProcess(identity.pid) === "dead") return "dead";
	try {
		const current = await readRuntimeProcessIdentity(identity.pid);
		if (!current) return "dead";
		return current.creationIdentity === identity.creationIdentity ? "live" : "dead";
	} catch {
		return "unknown";
	}
}
