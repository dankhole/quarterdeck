import { join } from "node:path";
import type { Page } from "playwright-core";
import type { DesktopLabDriver } from "./desktop-driver";
import { readDesktopTaskSession } from "./desktop-session-evidence";
import { writeJsonAtomic } from "./paths";

// Referenced only inside Playwright's renderer callbacks; the harness runs in Node.
declare const document: { readonly activeElement: unknown };

/** Test renderer focus and PTY delivery, not foreground Windows activation. */
export async function exerciseWindowsTerminalFocus(page: Page, driver: DesktopLabDriver, taskId: string) {
	const input = page.getByRole("textbox", { name: "Terminal input", exact: true });
	const settings = page.getByRole("dialog", { name: "Settings", exact: true });
	const stateHome = driver.fixture.config.stateHome;
	const projectId = decodeURIComponent(new URL(page.url()).pathname.split("/").filter(Boolean)[0] ?? "");
	const initial = await readDesktopTaskSession(stateHome, taskId);
	if (!projectId || !initial?.sessionInstanceId || !initial.pid)
		throw new Error("Terminal focus test lacks an owned task PTY.");
	const inputElement = await input.elementHandle();
	const hasFocus = () => inputElement.evaluate((element) => element === document.activeElement);
	const probe = async (stage: "before-settings" | "after-settings") => {
		const marker = `terminal-focus-${stage}`;
		const fence = driver.sockets.terminalOutputFence(
			projectId,
			taskId,
			new RegExp(`AGENT LAB LOCAL ACTION: ${marker}\\b`, "u"),
		);
		try {
			await page.keyboard.type(`/local-action ${marker}`);
			await page.keyboard.press("Enter");
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline) {
				const receipt = fence.receipt();
				if (receipt !== null) return receipt;
				await page.waitForTimeout(100);
			}
			throw new Error(`No PTY output acknowledgement for ${stage}.`);
		} finally {
			fence.dispose();
		}
	};
	if (!(await hasFocus())) await input.focus();
	const before = await probe("before-settings");
	await page.keyboard.press("Control+Shift+S");
	await settings.waitFor({ state: "visible" });
	await page.waitForFunction((dialog) => dialog.contains(document.activeElement), await settings.elementHandle(), {
		timeout: 5_000,
	});
	await page.keyboard.press("Escape");
	await settings.waitFor({ state: "hidden" });
	await page.waitForFunction((element) => element === document.activeElement, inputElement, { timeout: 5_000 });
	// Do not click, focus, or target a locator when sending the post-dismissal keys.
	const after = await probe("after-settings");
	const current = await readDesktopTaskSession(stateHome, taskId);
	if (current?.sessionInstanceId !== initial.sessionInstanceId || current.pid !== initial.pid || after <= before)
		throw new Error("Settings changed the terminal PTY or reset its output receipts.");
	await writeJsonAtomic(join(driver.fixture.manifest.artifactDir, "windows-terminal-focus.json"), {
		taskId,
		sessionInstanceId: initial.sessionInstanceId,
		pid: initial.pid,
		beforeSettingsReceipt: before,
		afterSettingsReceipt: after,
		sameRendererInput: true,
	});
}
