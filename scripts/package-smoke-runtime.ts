import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { QUARTERDECK_DESKTOP_ORIGIN, QUARTERDECK_DESKTOP_TOKEN_HEADER } from "../src/core/api/desktop-runtime-protocol";
import type { RuntimeOwnerDescriptor } from "../src/core/api/runtime-management";
import { terminateProcessTree } from "../src/core/process-termination";
import { enrollDesktopClient, revokeDesktopClient, verifyRuntimeOwner } from "../src/server/runtime-owner-client";
import { discoverRuntimeOwner } from "../src/server/runtime-ownership";

const TIMEOUT_MS = 15_000;

class PackageSmokeFailure extends Error {}

export function formatPackageSmokeFailure(error: unknown): string {
	return error instanceof PackageSmokeFailure
		? error.message
		: "Packed runtime operation failed; private transport details withheld.";
}

/** Exercise packed runtime admission, never browser bootstrap/cookies or a desktop installation. */
export async function verifyInstalledRuntimeAccess(
	descriptor: RuntimeOwnerDescriptor,
	options: {
		fetchImpl?: typeof fetch;
		enroll?: typeof enrollDesktopClient;
		revoke?: typeof revokeDesktopClient;
		verify?: typeof verifyRuntimeOwner;
	} = {},
): Promise<void> {
	const origin = await (options.verify ?? verifyRuntimeOwner)(descriptor, true);
	const fetchImpl = options.fetchImpl ?? fetch;
	const request = async (path: string, headers?: Record<string, string>): Promise<Response> => {
		try {
			return await fetchImpl(`${origin}${path}`, {
				headers,
				redirect: "error",
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
		} catch {
			throw new PackageSmokeFailure("Installed runtime admission request failed; private credentials withheld.");
		}
	};
	if ((await request("/api/trpc/projects.list")).status !== 401)
		throw new PackageSmokeFailure("Installed runtime accepted an unauthenticated client.");
	if ((await request("/api/runtime/client-bootstrap?capability=removed")).status !== 401)
		throw new PackageSmokeFailure("Installed runtime retained unauthenticated browser bootstrap.");
	if ((await request("/")).status !== 401)
		throw new PackageSmokeFailure("Installed runtime exposed its renderer to an unauthenticated client.");
	const clientToken = randomBytes(32).toString("base64url");
	const headers = { origin: QUARTERDECK_DESKTOP_ORIGIN, [QUARTERDECK_DESKTOP_TOKEN_HEADER]: clientToken };
	await (options.enroll ?? enrollDesktopClient)(descriptor, clientToken);
	try {
		const response = await request("/api/trpc/projects.list", headers);
		if (!response.ok || !(response.headers.get("content-type") ?? "").includes("application/json"))
			throw new PackageSmokeFailure("Installed runtime rejected its management-enrolled desktop client.");
		const payload: unknown = await response.json();
		if (!payload || typeof payload !== "object" || !("result" in payload))
			throw new PackageSmokeFailure("Installed runtime did not return its project API contract.");
		const document = await request("/", headers);
		if (!document.ok || !(document.headers.get("content-type") ?? "").includes("text/html"))
			throw new PackageSmokeFailure("Installed runtime did not serve its authenticated desktop renderer document.");
		const html = await document.text();
		const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/giu)].map((match) => match[1]);
		const styles = [...html.matchAll(/<link\b[^>]*\bhref=["']([^"']+\.css(?:\?[^"']*)?)["']/giu)].map(
			(match) => match[1],
		);
		if (!scripts.length || !styles.length)
			throw new PackageSmokeFailure("Installed renderer is missing its built JavaScript or CSS asset entries.");
		for (const asset of [...scripts, ...styles]) {
			const url = new URL(asset, origin);
			if (url.origin !== origin || url.username || url.password)
				throw new PackageSmokeFailure("Installed renderer refers to an unexpected external asset.");
			const response = await request(`${url.pathname}${url.search}`, headers);
			if (!response.ok || !(await response.text()).trim())
				throw new PackageSmokeFailure("Installed renderer references a missing or empty packaged asset.");
		}
	} finally {
		await (options.revoke ?? revokeDesktopClient)(descriptor, clientToken);
	}
	if ((await request("/api/trpc/projects.list", headers)).status !== 401)
		throw new PackageSmokeFailure("Installed runtime retained a revoked desktop client.");
}

async function waitForExit(child: ChildProcess): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return true;
	return await new Promise<boolean>((resolveExit) => {
		const timer = setTimeout(() => {
			child.removeListener("exit", exited);
			resolveExit(false);
		}, TIMEOUT_MS);
		const exited = () => {
			clearTimeout(timer);
			resolveExit(true);
		};
		child.once("exit", exited);
	});
}

export async function runInstalledRuntimeSmoke(installedCli: string): Promise<void> {
	const stateHome = process.env.QUARTERDECK_STATE_HOME;
	if (!stateHome || process.env.QUARTERDECK_AGENT_LAB !== "1")
		throw new PackageSmokeFailure(
			"Package runtime smoke requires an explicit synthetic state home and Agent Lab context.",
		);
	const child = spawn(process.execPath, [installedCli, "--internal-runtime", "--no-native-ui", "--port", "auto"], {
		env: process.env,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	// Drain without retaining capability-bearing output. Discovery reads only this synthetic state home.
	child.stdout?.resume();
	child.stderr?.resume();
	let spawnFailed = false;
	child.once("error", () => {
		spawnFailed = true;
	});
	let clean = false;
	let operationFailed = false;
	let operationFailure: unknown;
	try {
		const deadline = Date.now() + TIMEOUT_MS;
		let descriptor: RuntimeOwnerDescriptor | null = null;
		while (Date.now() < deadline) {
			if (spawnFailed || child.exitCode !== null || child.signalCode !== null)
				throw new PackageSmokeFailure("Installed internal runtime exited before authenticated readiness.");
			const owner = await discoverRuntimeOwner(stateHome);
			if (owner?.descriptor?.status === "ready" && !owner.released && owner.descriptor.process.pid === child.pid) {
				descriptor = owner.descriptor;
				break;
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, 100));
		}
		if (!descriptor)
			throw new PackageSmokeFailure(
				"Installed internal runtime did not publish its exact ready ownership descriptor.",
			);
		await verifyInstalledRuntimeAccess(descriptor);
	} catch (error) {
		operationFailed = true;
		operationFailure = error;
	} finally {
		child.stdin?.end();
		if (await waitForExit(child)) {
			const owner = await discoverRuntimeOwner(stateHome);
			clean = owner?.released === true;
		}
		if (!clean) {
			if (child.pid && child.exitCode === null && child.signalCode === null) {
				const pid = child.pid;
				await new Promise<void>((resolveStop) => terminateProcessTree(pid, "SIGKILL", () => resolveStop()));
				await waitForExit(child);
			}
		} else process.stdout.write("Installed runtime cleanup confirmed.\n");
	}
	if (!clean)
		throw new PackageSmokeFailure(
			"Installed runtime cleanup is unconfirmed; retain its synthetic state and inspect ownership.",
		);
	if (operationFailed) throw operationFailure;
	const expected = process.platform === "win32" ? 143 : 129;
	if (child.exitCode !== expected)
		throw new PackageSmokeFailure(`Installed runtime exited with ${String(child.exitCode)} instead of ${expected}.`);
	process.stdout.write("Installed management/desktop runtime admission verified.\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const installedCli = process.argv[2];
	if (!installedCli) throw new PackageSmokeFailure("Expected the isolated installed CLI path.");
	await runInstalledRuntimeSmoke(installedCli).catch((error: unknown) => {
		// Runtime/transport failures may retain credentials in nested causes. Emit only a fixed diagnostic.
		process.stderr.write(`${formatPackageSmokeFailure(error)}\n`);
		process.exitCode = 1;
	});
}
