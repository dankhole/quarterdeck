import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { test as base, expect, type Page } from "@playwright/test";
import { z } from "zod";

import { readAgentLabManifest } from "../../scripts/agent-lab/paths";
import { createFixtureBrowserHeaders } from "../../test/utilities/integration-server";

async function admitFixtureBrowser(page: Page, baseURL: string | undefined): Promise<void> {
	const pointerPath = process.env.QUARTERDECK_E2E_MANIFEST_POINTER_PATH;
	if (!pointerPath || !baseURL) throw new Error("Playwright requires its isolated runtime fixture.");
	const { manifestPath } = z
		.object({ manifestPath: z.string().min(1) })
		.strict()
		.parse(JSON.parse(await readFile(pointerPath, "utf8")) as unknown);
	const deadline = Date.now() + 10_000;
	let manifest = await readAgentLabManifest(manifestPath);
	while (manifest.status === "starting" && Date.now() < deadline) {
		await delay(100);
		manifest = await readAgentLabManifest(manifestPath);
	}
	if (manifest.status !== "ready" || new URL(manifest.webUrl).origin !== new URL(baseURL).origin)
		throw new Error("Playwright isolated runtime is not ready at the configured browser origin.");
	// Exchange outside Playwright's request recorder: no one-use capability is navigated or logged.
	const { cookie } = await createFixtureBrowserHeaders(manifest.runtimeUrl, manifest.statePath);
	if (!cookie) throw new Error("Playwright browser admission did not return a cookie.");
	const separator = cookie.indexOf("=");
	if (separator < 1) throw new Error("Playwright browser admission returned an invalid cookie.");
	await page.context().addCookies([
		{
			name: cookie.slice(0, separator),
			value: cookie.slice(separator + 1),
			url: baseURL,
			httpOnly: true,
			sameSite: "Strict",
		},
	]);
}

function isAllowedLabUrl(rawUrl: string): boolean {
	if (rawUrl.startsWith("about:") || rawUrl.startsWith("blob:") || rawUrl.startsWith("data:")) {
		return true;
	}
	const url = new URL(rawUrl);
	return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
}

export const test = base.extend({
	page: async ({ page, baseURL }, use, testInfo) => {
		await admitFixtureBrowser(page, baseURL);
		const consoleEntries: string[] = [];
		const networkEntries: string[] = [];
		page.on("console", (message) => {
			consoleEntries.push(`${message.type().toUpperCase()} ${message.text()}`);
		});
		page.on("pageerror", (error) => {
			consoleEntries.push(`PAGEERROR ${error.stack ?? error.message}`);
		});
		page.on("request", (request) => {
			networkEntries.push(`> ${request.method()} ${request.url()}`);
		});
		page.on("response", (response) => {
			networkEntries.push(`< ${response.status()} ${response.request().method()} ${response.url()}`);
		});
		page.on("requestfailed", (request) => {
			networkEntries.push(`! ${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`);
		});
		await page.route("**/*", async (route) => {
			if (isAllowedLabUrl(route.request().url())) {
				await route.continue();
				return;
			}
			consoleEntries.push(`BLOCKED ${route.request().url()}`);
			await route.abort("blockedbyclient");
		});
		await use(page);
		await testInfo.attach("browser-console", {
			body: Buffer.from(`${consoleEntries.join("\n")}\n`, "utf8"),
			contentType: "text/plain",
		});
		await testInfo.attach("browser-network", {
			body: Buffer.from(`${networkEntries.join("\n")}\n`, "utf8"),
			contentType: "text/plain",
		});
	},
});

export { expect };
