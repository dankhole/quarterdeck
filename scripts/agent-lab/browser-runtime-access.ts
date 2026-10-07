import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeOwnerDescriptor } from "../../src/core/api/runtime-management.js";
import { createOwnerBrowserBootstrap, verifyRuntimeOwner } from "../../src/server/runtime-owner-client.js";
import { discoverRuntimeOwner } from "../../src/server/runtime-ownership.js";
import type { ReadableAgentLabManifest } from "./types";

interface AuthenticatedNavigation {
	prepareArguments: string[] | null;
	navigationArguments: string[];
	sessionArguments: string[];
}

/** Keep the user's stable navigation in transcripts; admission happens privately before it. */
export function planAuthenticatedLabNavigation(
	args: readonly string[],
	manifest: Pick<ReadableAgentLabManifest, "webUrl">,
): AuthenticatedNavigation | null {
	const commandIndex = args.findIndex((argument) => ["open", "goto", "reload"].includes(argument));
	if (commandIndex < 0) return null;
	const command = args[commandIndex];
	const sessionArguments: string[] = [];
	for (let index = 0; index < commandIndex; index++) {
		const argument = args[index];
		if (!argument) continue;
		if (argument === "-s" || argument === "--session") {
			const value = args[++index];
			if (value) sessionArguments.push(argument, value);
		} else if (argument.startsWith("-s=") || argument.startsWith("--session=")) sessionArguments.push(argument);
	}
	if (sessionArguments.length === 0) return null;
	if (command === "reload") return { prepareArguments: null, navigationArguments: [...args], sessionArguments };
	const target = args[commandIndex + 1];
	if (!target) return null;
	let url: URL;
	try {
		url = new URL(target);
	} catch {
		return null;
	}
	if (url.origin !== new URL(manifest.webUrl).origin || url.username || url.password) return null;
	if (url.pathname.startsWith("/api/")) throw new Error("Agent Lab navigation must use the public project URL.");
	if (command !== "open") return { prepareArguments: null, navigationArguments: [...args], sessionArguments };
	const prepareArguments = [...args];
	prepareArguments[commandIndex + 1] = "about:blank";
	return { prepareArguments, navigationArguments: [...sessionArguments, "goto", target], sessionArguments };
}

export async function verifyLabRuntimeOwner(
	manifest: Pick<ReadableAgentLabManifest, "statePath" | "runtimeUrl" | "processes">,
): Promise<RuntimeOwnerDescriptor> {
	const owner = await discoverRuntimeOwner(manifest.statePath);
	if (owner?.descriptor?.status !== "ready" || owner.released)
		throw new Error("The Agent Lab runtime is not ready for browser admission.");
	if (owner.descriptor.process.pid !== manifest.processes.runtime?.pid)
		throw new Error("The Agent Lab runtime process changed during browser admission.");
	if ((await verifyRuntimeOwner(owner.descriptor, false)) !== manifest.runtimeUrl)
		throw new Error("The Agent Lab runtime endpoint changed during browser admission.");
	return owner.descriptor;
}

export async function withLabBrowserAdmissionScript(
	manifest: Pick<ReadableAgentLabManifest, "statePath" | "runtimeUrl" | "webUrl" | "processes" | "tempRoot">,
	run: (scriptPath: string) => Promise<void>,
): Promise<void> {
	const owner = await verifyLabRuntimeOwner(manifest);
	const bootstrap = new URL(await createOwnerBrowserBootstrap(owner));
	// Vite proxies this request, preserving the dev browser's host-only cookie.
	const bootstrapUrl = new URL(`${bootstrap.pathname}${bootstrap.search}`, manifest.webUrl).href;
	const privateDirectory = await mkdtemp(join(manifest.tempRoot, ".browser-admission-"));
	const scriptPath = join(privateDirectory, "admit.js");
	try {
		await writeFile(
			scriptPath,
			`async page => { const response = await page.context().request.get(${JSON.stringify(bootstrapUrl)}, { maxRedirects: 0 }); if (response.status() !== 303) throw new Error("Agent Lab browser admission failed."); }`,
			{ mode: 0o600 },
		);
		await run(scriptPath);
	} finally {
		await rm(privateDirectory, { recursive: true, force: true });
	}
}
