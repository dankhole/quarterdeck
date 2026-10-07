import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join } from "node:path";

import { type Browser, type ConnectOverCDPOptions, chromium, type Page } from "playwright-core";

export interface DesktopDebugEndpoint {
	readonly userDataPath: string;
	readonly endpoint: string;
	readonly fingerprint: string;
}

/** This launch's private profile is the only endpoint authority; never discover or scan ports. */
export async function readDesktopDebugEndpoint(userDataPath: string): Promise<DesktopDebugEndpoint> {
	if ((await realpath(userDataPath)) !== userDataPath) throw new Error("Desktop debug profile is not canonical.");
	const file = await open(
		join(userDataPath, "DevToolsActivePort"),
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const metadata = await file.stat();
		if (!metadata.isFile() || metadata.size === 0 || metadata.size > 256)
			throw new Error("Desktop debug endpoint file is invalid.");
		const buffer = Buffer.alloc(257);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		if (bytesRead !== metadata.size || bytesRead > 256) throw new Error("Desktop debug endpoint file changed.");
		const contents = buffer.subarray(0, bytesRead).toString("utf8");
		const match = /^(\d{1,5})\n(\/devtools\/browser\/[a-fA-F0-9-]{36})\n?$/u.exec(contents);
		const port = Number(match?.[1]);
		if (
			!match?.[2] ||
			!Number.isInteger(port) ||
			port < 1 ||
			port > 65535 ||
			!/^\/devtools\/browser\/[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/u.test(match[2])
		)
			throw new Error("Desktop debug endpoint file is malformed.");
		return {
			userDataPath,
			endpoint: `ws://127.0.0.1:${port}${match[2]}`,
			fingerprint: createHash("sha256")
				.update(`${metadata.dev}:${metadata.ino}:${metadata.mtimeMs}:`)
				.update(contents)
				.digest("hex"),
		};
	} finally {
		await file.close();
	}
}

export async function assertDesktopDebugEndpointUnchanged(captured: DesktopDebugEndpoint): Promise<void> {
	const current = await readDesktopDebugEndpoint(captured.userDataPath);
	if (current.endpoint !== captured.endpoint || current.fingerprint !== captured.fingerprint)
		throw new Error("Desktop debug endpoint no longer belongs to the captured launch.");
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Desktop renderer observation timed out.")), 5_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export interface DesktopRendererObservation {
	readonly browser: Browser;
	readonly page: Page;
}

/** Public Playwright attach only; the original ElectronApplication keeps process/quit custody. */
export async function observeDesktopRenderer(options: {
	capturedEndpoint: DesktopDebugEndpoint;
	artifactDir: string;
	nonce: string;
	assertOriginalOwner: () => Promise<void>;
	registerObserver: (browser: Browser) => void;
	connect?: (endpoint: string, options: ConnectOverCDPOptions) => Promise<Browser>;
}): Promise<DesktopRendererObservation> {
	await options.assertOriginalOwner();
	await assertDesktopDebugEndpointUnchanged(options.capturedEndpoint);
	let browser: Browser;
	try {
		browser = await (options.connect ?? chromium.connectOverCDP.bind(chromium))(options.capturedEndpoint.endpoint, {
			noDefaults: true,
			timeout: 10_000,
			artifactsDir: options.artifactDir,
		});
	} catch {
		throw new Error("Desktop renderer observer could not connect to the captured launch.");
	}
	// Register cleanup before any validation can fail; never close a target/context.
	options.registerObserver(browser);
	try {
		const contexts = browser.contexts();
		const pages = contexts.flatMap((context) => context.pages());
		if (contexts.length !== 1 || pages.length !== 1)
			throw new Error("Desktop renderer observation found unexpected targets.");
		const page = pages[0];
		if (!page?.url().startsWith("app://quarterdeck/"))
			throw new Error("Desktop renderer observation has no private target.");
		const nonce = await bounded(
			page.evaluate(
				() =>
					(globalThis as unknown as { __quarterdeckDesktopLabReobserveNonce?: string })
						.__quarterdeckDesktopLabReobserveNonce,
			),
		);
		if (nonce !== options.nonce) throw new Error("Desktop renderer observation did not bind the owned document.");
		await options.assertOriginalOwner();
		await assertDesktopDebugEndpointUnchanged(options.capturedEndpoint);
		page.setDefaultTimeout(20_000);
		return { browser, page };
	} catch {
		// Driver still retains the observer if detach is unconfirmed and attempts app Quit.
		try {
			await bounded(browser.close());
		} catch {
			throw new Error("Desktop renderer observation failed and observer detach is unconfirmed.");
		}
		throw new Error("Desktop renderer observation did not bind the captured launch.");
	}
}
