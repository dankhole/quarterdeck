import { parse, type SemVer } from "semver";
import { z } from "zod";
import { desktopVersionSchema } from "../desktop-install/receipt.js";
import type { DesktopUpdateSnapshot } from "../shared/desktop-update-contract.js";

const registryUrl = "https://registry.npmjs.org/quarterdeck";
const maximumResponseBytes = 2 * 1024 * 1024;
const maximumTimeoutMs = 10_000;

export type DesktopUpdateChannel = NonNullable<DesktopUpdateSnapshot["channel"]>;
export interface DesktopUpdateCheckResult {
	channel: DesktopUpdateChannel;
	availableVersion: string | null;
}

export interface DesktopUpdateCheckOptions {
	fetch?: typeof fetch;
	/** Tests may shorten, but never extend, production bounds. */
	timeoutMs?: number;
	maxResponseBytes?: number;
}

export type DesktopUpdateCheckErrorCode =
	| "invalid_installed_version"
	| "invalid_options"
	| "network_failed"
	| "timed_out"
	| "invalid_registry_response";

const errorMessages: Record<DesktopUpdateCheckErrorCode, string> = {
	invalid_installed_version: "The installed Quarterdeck version cannot be checked for updates.",
	invalid_options: "The update check configuration is invalid.",
	network_failed: "The public npm registry could not be reached. Check network access and try again.",
	timed_out: "The public npm registry update check timed out. Try again.",
	invalid_registry_response: "The public npm registry returned invalid Quarterdeck update metadata. Try again later.",
};

/** Never retain response text, transport errors, URLs, or credentials in public failures. */
export class DesktopUpdateCheckError extends Error {
	constructor(readonly code: DesktopUpdateCheckErrorCode) {
		super(errorMessages[code]);
		this.name = "DesktopUpdateCheckError";
	}
}

const packumentSchema = z.object({
	name: z.literal("quarterdeck"),
	"dist-tags": z.record(z.string(), z.unknown()),
	versions: z.record(z.string(), z.unknown()),
});
const manifestSchema = z.object({ name: z.literal("quarterdeck"), version: z.string() });

function parseExactVersion(value: unknown): SemVer | null {
	const supported = desktopVersionSchema.safeParse(value);
	if (!supported.success) return null;
	const parsed = parse(supported.data);
	return parsed?.version === value ? parsed : null;
}

/** Revalidate a previously checked, exact target before preparing an update handoff. */
export function isDesktopUpdateTarget(installedVersion: string, targetVersion: string): boolean {
	const installed = parseExactVersion(installedVersion);
	const target = parseExactVersion(targetVersion);
	return Boolean(
		installed &&
			target &&
			target.prerelease.length > 0 === installed.prerelease.length > 0 &&
			target.compare(installed) > 0,
	);
}

function boundedOption(value: number | undefined, maximum: number): number {
	if (value === undefined) return maximum;
	if (!Number.isSafeInteger(value) || value <= 0 || value > maximum)
		throw new DesktopUpdateCheckError("invalid_options");
	return value;
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
	void body?.cancel().catch(() => undefined);
}

async function readMetadata(response: Response, byteLimit: number, signal: AbortSignal): Promise<unknown> {
	// Refuse all redirects, including same-origin ones, so discovery has exactly one fixed destination.
	if (
		response.status !== 200 ||
		response.redirected ||
		(response.url && response.url !== registryUrl) ||
		!response.body
	) {
		cancelBody(response.body);
		throw new DesktopUpdateCheckError("invalid_registry_response");
	}
	const length = response.headers.get("content-length");
	if (length !== null && (!/^\d+$/u.test(length) || Number(length) > byteLimit)) {
		cancelBody(response.body);
		throw new DesktopUpdateCheckError("invalid_registry_response");
	}
	const reader = response.body.getReader();
	const cancel = () => {
		void reader.cancel().catch(() => undefined);
	};
	signal.addEventListener("abort", cancel, { once: true });
	const chunks: Uint8Array[] = [];
	let byteCount = 0;
	try {
		for (;;) {
			if (signal.aborted) throw new DesktopUpdateCheckError("timed_out");
			const chunk = await reader.read();
			if (chunk.done) break;
			byteCount += chunk.value.byteLength;
			if (byteCount > byteLimit) throw new DesktopUpdateCheckError("invalid_registry_response");
			chunks.push(chunk.value);
		}
		if (signal.aborted) throw new DesktopUpdateCheckError("timed_out");
		try {
			return JSON.parse(Buffer.concat(chunks, byteCount).toString("utf8"));
		} catch {
			throw new DesktopUpdateCheckError("invalid_registry_response");
		}
	} finally {
		signal.removeEventListener("abort", cancel);
		cancel();
		reader.releaseLock();
	}
}

function selectUpdate(metadata: unknown, installed: SemVer, channel: DesktopUpdateChannel): DesktopUpdateCheckResult {
	const packument = packumentSchema.safeParse(metadata);
	if (!packument.success) throw new DesktopUpdateCheckError("invalid_registry_response");
	const version = packument.data["dist-tags"][channel];
	const target = parseExactVersion(version);
	if (!target || target.prerelease.length > 0 !== (channel === "preview"))
		throw new DesktopUpdateCheckError("invalid_registry_response");
	const manifest = manifestSchema.safeParse(packument.data.versions[target.raw]);
	if (!manifest.success || manifest.data.version !== target.raw)
		throw new DesktopUpdateCheckError("invalid_registry_response");
	return { channel, availableVersion: target.compare(installed) > 0 ? target.raw : null };
}

/** Read-only discovery. The caller owns check scheduling and whether this installation is eligible. */
export async function checkForDesktopUpdate(
	installedVersion: string,
	options: DesktopUpdateCheckOptions = {},
): Promise<DesktopUpdateCheckResult> {
	const installed = parseExactVersion(installedVersion);
	if (!installed) throw new DesktopUpdateCheckError("invalid_installed_version");
	const channel: DesktopUpdateChannel = installed.prerelease.length ? "preview" : "latest";
	const timeoutMs = boundedOption(options.timeoutMs, maximumTimeoutMs);
	const byteLimit = boundedOption(options.maxResponseBytes, maximumResponseBytes);
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new DesktopUpdateCheckError("timed_out"));
		}, timeoutMs);
	});
	const read = async () => {
		const response = await (options.fetch ?? fetch)(registryUrl, {
			method: "GET",
			redirect: "manual",
			credentials: "omit",
			signal: controller.signal,
			headers: { Accept: "application/vnd.npm.install-v1+json" },
		});
		if (controller.signal.aborted) {
			cancelBody(response.body);
			throw new DesktopUpdateCheckError("timed_out");
		}
		return selectUpdate(await readMetadata(response, byteLimit, controller.signal), installed, channel);
	};
	try {
		return await Promise.race([read(), deadline]);
	} catch (error) {
		if (controller.signal.aborted) throw new DesktopUpdateCheckError("timed_out");
		if (error instanceof DesktopUpdateCheckError) throw error;
		throw new DesktopUpdateCheckError("network_failed");
	} finally {
		clearTimeout(timer);
	}
}
