import { test as base, expect } from "@playwright/test";

function isAllowedLabUrl(rawUrl: string): boolean {
	if (rawUrl.startsWith("about:") || rawUrl.startsWith("blob:") || rawUrl.startsWith("data:")) {
		return true;
	}
	const url = new URL(rawUrl);
	return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
}

export const test = base.extend({
	page: async ({ page }, use, testInfo) => {
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
