import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "./fixtures";

test("production bundle starts the board and opens settings without browser errors", async ({ page }) => {
	const index = await readFile(resolve(import.meta.dirname, "../../dist/web-ui/index.html"), "utf8");
	const entryAsset = index.match(/<script[^>]+src="([^"]+\.js)"/u)?.[1];
	if (!entryAsset?.startsWith("/assets/")) throw new Error("Expected a built production entry asset.");
	const errors: string[] = [];
	const requests: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	page.on("request", (request) => requests.push(new URL(request.url()).pathname));
	await page.addInitScript(() => {
		window.localStorage.setItem("quarterdeck.onboarding.dialog.shown", "true");
		window.localStorage.setItem("quarterdeck.onboarding.tips.dismissed", "true");
	});
	const entryResponse = page.waitForResponse((response) => new URL(response.url()).pathname === entryAsset);
	await page.goto("/project");
	expect((await entryResponse).ok()).toBe(true);
	// Surface a render-boundary crash immediately instead of waiting for a missing board.
	await expect.poll(async () => errors.length > 0 || (await page.locator("section.kb-board").isVisible())).toBe(true);
	expect(errors).toEqual([]);
	await expect(page.locator("section.kb-board")).toBeVisible();
	await expect(page).toHaveTitle("project");
	await expect(page.getByRole("button", { name: "Create task", exact: true })).toBeVisible();
	await expect(page.getByText("In Progress", { exact: true })).toBeVisible();
	await expect(page.getByText("Review", { exact: true })).toBeVisible();
	await expect(page.getByText("Trash", { exact: true })).toBeVisible();
	await page.getByTestId("open-settings-button").click();
	await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
	expect(requests).toContain(entryAsset);
	expect(requests.some((path) => path.startsWith("/src/") || path === "/@vite/client")).toBe(false);
	expect(errors).toEqual([]);
});
