import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";
import {
	type RuntimeHostIntegrationEvent,
	runtimeHostIntegrationEventLedgerFileSchema,
} from "../../src/core/api/host-integrations";
import type { DesktopLabDriver } from "./desktop-driver";
import type { DesktopEvaluationModule } from "./desktop-evaluation-types";
import type { DesktopAgentMode } from "./desktop-types";
import { writeJsonAtomic } from "./paths";

export function validateDesktopNotificationSelection(options: {
	includeAgent?: boolean;
	showWindow?: boolean;
	agentMode?: DesktopAgentMode;
	nativeExperience?: boolean;
	performance?: boolean;
	mainLoss?: boolean;
	sessionRecovery?: boolean;
	npmLaunch?: boolean;
	manualShells?: boolean;
}): void {
	if (
		options.includeAgent === false ||
		options.showWindow ||
		(options.agentMode ?? "fake") !== "fake" ||
		options.nativeExperience ||
		options.performance ||
		options.mainLoss ||
		options.sessionRecovery ||
		options.npmLaunch ||
		options.manualShells
	)
		throw new Error("Desktop notification checks require a hidden fake task and no other scenario.");
}

async function readEvents(driver: DesktopLabDriver): Promise<RuntimeHostIntegrationEvent[]> {
	const result: unknown = JSON.parse(
		await readFile(join(driver.fixture.manifest.artifactDir, "host-events.json"), "utf8"),
	);
	return runtimeHostIntegrationEventLedgerFileSchema.parse(result).events;
}

async function openSettings(page: Page) {
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
	await dialog.waitFor({ state: "visible" });
	return dialog;
}

export async function exerciseDesktopNotifications(
	page: Page,
	driver: DesktopLabDriver,
	startFakeTask: () => Promise<string>,
): Promise<void> {
	const hidden = await driver.app.evaluate(({ BrowserWindow }: DesktopEvaluationModule) =>
		BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
	);
	if (!hidden) throw new Error("Notification scenario requires a hidden, unfocused app.");
	const projectId = decodeURIComponent(new URL(page.url()).pathname.split("/").filter(Boolean)[0] ?? "");
	if (!projectId) throw new Error("Notification scenario requires its selected synthetic project.");
	const settings = await openSettings(page);
	const master = settings
		.getByText("Play sounds when tasks need attention", { exact: true })
		.locator("..")
		.getByRole("switch");
	const controlsDeadline = Date.now() + 5_000;
	while (!(await master.isEnabled()) && Date.now() < controlsDeadline) await page.waitForTimeout(100);
	if (!(await master.isEnabled())) throw new Error("Notification settings did not finish loading.");
	if ((await master.getAttribute("aria-checked")) !== "true") await master.click();
	const review = settings.locator("#audible-notification-review");
	if ((await review.getAttribute("aria-checked")) !== "true") await review.click();
	const volume = settings.locator('input[name="audible-notification-volume"]');
	await volume.press("Home");
	for (let index = 0; index < 40; index++) await volume.press("ArrowRight");
	if ((await volume.inputValue()) !== "40") throw new Error("Notification volume selection did not apply.");
	await settings.getByRole("button", { name: "Save", exact: true }).click();
	await settings.waitFor({ state: "hidden" });
	const taskId = await startFakeTask();
	const deadline = Date.now() + 15_000;
	let sounds: RuntimeHostIntegrationEvent[] = [];
	while (Date.now() < deadline) {
		sounds = (await readEvents(driver)).filter(
			(event) => event.kind === "notification_audio" && event.taskId === taskId,
		);
		if (sounds.length > 0) break;
		await page.waitForTimeout(100);
	}
	// Wait past the native settle window before checking the final desktop event count.
	await page.waitForTimeout(1_500);
	sounds = (await readEvents(driver)).filter(
		(event) => event.kind === "notification_audio" && event.taskId === taskId,
	);
	if (
		sounds.length !== 1 ||
		sounds[0]?.kind !== "notification_audio" ||
		sounds[0].origin !== "desktop" ||
		sounds[0].eventType !== "review" ||
		sounds[0].volume !== 0.4 ||
		sounds[0].projectId !== projectId
	)
		throw new Error("Hidden task review did not produce exactly one desktop sound intent.");
	const mutedSettings = await openSettings(page);
	await mutedSettings.locator("#audible-notification-review").click();
	await mutedSettings.getByRole("button", { name: "Save", exact: true }).click();
	await mutedSettings.waitFor({ state: "hidden" });
	const input = page.getByRole("textbox", { name: "Terminal input" });
	await input.focus();
	await page.keyboard.type("/working");
	await page.keyboard.press("Enter");
	await page.locator(`[data-task-id="${taskId}"]`).filter({ hasText: "Running" }).first().waitFor();
	await page.keyboard.type("/review Muted desktop notification check");
	await page.keyboard.press("Enter");
	await page.locator(`[data-task-id="${taskId}"]`).filter({ hasText: "Review" }).first().waitFor();
	await page.waitForTimeout(1_500);
	const afterMuted = (await readEvents(driver)).filter(
		(event) => event.kind === "notification_audio" && event.taskId === taskId,
	);
	if (afterMuted.length !== 1) throw new Error("Muted review emitted an unexpected sound intent.");
	await writeJsonAtomic(join(driver.fixture.manifest.artifactDir, "notification-proof.json"), {
		projectId,
		taskId,
		desktopHidden: hidden,
		taskSounds: afterMuted,
		mutedReviewSuppressed: true,
		limitation:
			"Simulated task intent only; speakers, OS banners, and the unchanged Settings preview were not exercised. Renderer duplicate suppression is covered by existing web ownership tests, not this packaged ledger.",
	});
}
