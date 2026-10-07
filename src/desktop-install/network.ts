import { open } from "node:fs/promises";
import { DesktopInstallationError } from "./errors.js";

const allowedDownloadHosts = new Set([
	"github.com",
	"release-assets.githubusercontent.com",
	"objects.githubusercontent.com",
	"github-releases.githubusercontent.com",
]);

export function desktopReleaseAssetUrl(version: string, name: string): string {
	return `https://github.com/dankhole/quarterdeck/releases/download/v${version}/${name}`;
}

function validateDownloadUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new DesktopInstallationError("invalid_artifact", "The release download URL is invalid.");
	}
	if (
		value.length > 8192 ||
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.port ||
		url.hash ||
		!allowedDownloadHosts.has(url.hostname)
	) {
		throw new DesktopInstallationError(
			"invalid_artifact",
			"The release download redirected outside the approved HTTPS asset hosts.",
		);
	}
	return url;
}

export async function downloadDesktopAsset(
	url: string,
	destination: string,
	maximumBytes: number,
	fetchAsset: typeof fetch = fetch,
): Promise<void> {
	const signal = AbortSignal.timeout(10 * 60_000);
	let current = validateDownloadUrl(url);
	let response: Response | undefined;
	for (let redirects = 0; redirects <= 4; redirects++) {
		try {
			response = await fetchAsset(current, {
				redirect: "manual",
				signal,
				headers: { Accept: "application/octet-stream" },
			});
		} catch {
			throw new DesktopInstallationError(
				"download_failed",
				"The exact desktop release could not be downloaded. Check network access or import a matching local app with --from /path/to/Quarterdeck.app.",
			);
		}
		if (![301, 302, 303, 307, 308].includes(response.status)) break;
		const location = response.headers.get("location");
		await response.body?.cancel();
		if (!location || redirects === 4)
			throw new DesktopInstallationError("invalid_artifact", "The desktop asset has too many or invalid redirects.");
		let redirectedUrl: string;
		try {
			redirectedUrl = new URL(location, current).href;
		} catch {
			throw new DesktopInstallationError("invalid_artifact", "The release download redirect URL is invalid.");
		}
		current = validateDownloadUrl(redirectedUrl);
	}
	if (response?.status === 404) {
		await response.body?.cancel();
		throw new DesktopInstallationError(
			"release_unavailable",
			"No matching desktop release asset is published. Build the matching desktop app and import it with the desktop install command's --from /path/to/Quarterdeck.app option.",
		);
	}
	if (!response?.ok || !response.body) {
		await response?.body?.cancel();
		throw new DesktopInstallationError("invalid_artifact", "The desktop release download failed.");
	}
	const length = response.headers.get("content-length");
	if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximumBytes)) {
		await response.body.cancel();
		throw new DesktopInstallationError("invalid_artifact", "The desktop release asset exceeds its size limit.");
	}
	let bytes = 0;
	const reader = response.body.getReader();
	let file: Awaited<ReturnType<typeof open>> | undefined;
	try {
		file = await open(destination, "wx", 0o600);
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > maximumBytes)
				throw new DesktopInstallationError("invalid_artifact", "The desktop release asset exceeds its size limit.");
			await file.writeFile(chunk.value);
		}
		if (!bytes) throw new DesktopInstallationError("invalid_artifact", "The desktop release asset is empty.");
		await file.sync();
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
		await file?.close();
	}
}
