import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { listHostEvents, waitForHostEvent } from "./host-events";

const BACKLOG_COLUMN = 'section[data-column-id="backlog"]';
const E2E_PROJECT_PATH = "/project";

async function openBoard(page: Page) {
	await page.addInitScript(() => {
		window.localStorage.setItem("quarterdeck.onboarding.dialog.shown", "true");
		window.localStorage.setItem("quarterdeck.onboarding.tips.dismissed", "true");
		window.localStorage.removeItem("quarterdeck-active-tab");
	});
	await page.goto(E2E_PROJECT_PATH);
	await dismissStartupOnboarding(page);
	await expect(page.locator("section.kb-board")).toBeVisible();
}

async function dismissStartupOnboarding(page: Page) {
	const onboardingDialog = page.getByRole("dialog", { name: "Get started" });
	const isVisible = await onboardingDialog.isVisible({ timeout: 1_000 }).catch(() => false);
	if (!isVisible) {
		return;
	}
	await page.keyboard.press("Escape");
	await expect(onboardingDialog).toBeHidden();
}

async function createTaskFromBacklog(page: Page, title: string) {
	const backlogColumn = page.locator(BACKLOG_COLUMN).first();
	await backlogColumn.getByRole("button", { name: "Create task" }).click();
	const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "New task" }) });
	await expect(dialog).toBeVisible();
	const prompt = dialog.getByPlaceholder("Describe the task");
	await prompt.fill(title);
	await dialog.getByRole("button", { name: /^Create\b/ }).click();
	await expect(dialog).toBeHidden();
	await expect(backlogColumn.locator("[data-task-id]").filter({ hasText: title }).first()).toBeVisible();
}

async function openTaskFromBoard(page: Page, title: string) {
	const card = page.locator(BACKLOG_COLUMN).locator("[data-task-id]").filter({ hasText: title }).first();
	await expect(card).toBeVisible();
	await card.click();
}

test("renders quarterdeck top bar and columns", async ({ page }) => {
	await openBoard(page);
	await expect(page).toHaveTitle("project");
	await expect(page.getByTestId("open-settings-button")).toBeVisible();
	await expect(page.getByRole("button", { name: "Switch branch" })).toBeVisible();
	await expect(page.getByText("Backlog", { exact: true })).toBeVisible();
	await expect(page.getByText("In Progress", { exact: true })).toBeVisible();
	await expect(page.getByText("Review", { exact: true })).toBeVisible();
	await expect(page.getByText("Trash", { exact: true })).toBeVisible();
	await expect(page.locator(BACKLOG_COLUMN).getByRole("button", { name: "Create task" })).toBeVisible();
});

test("simulates the CLI host-browser launch while ordinary docs links stay browser-contained", async ({ page }) => {
	await openBoard(page);
	const startupEvents = await listHostEvents(page);
	const externalUrlEvent = startupEvents.events.find((event) => event.kind === "external_url");
	expect(externalUrlEvent).toMatchObject({
		kind: "external_url",
		origin: "runtime",
		outcome: "simulated",
	});
	if (!externalUrlEvent || externalUrlEvent.kind !== "external_url") {
		throw new Error("Expected the simulated startup external URL event.");
	}
	const simulatedUrl = new URL(externalUrlEvent.url);
	expect(simulatedUrl.hostname).toBe("127.0.0.1");
	expect(simulatedUrl.search).toBe("");
	expect(simulatedUrl.hash).toBe("");

	const beforeDocsLink = await listHostEvents(page);
	await page.evaluate(() => {
		const labWindow = window as typeof window & { __quarterdeckOpenedBrowserUrl?: string };
		window.open = ((url?: string | URL) => {
			labWindow.__quarterdeckOpenedBrowserUrl = String(url ?? "");
			return null;
		}) as typeof window.open;
	});
	await page.getByTestId("open-settings-button").click();
	await page.getByRole("button", { name: "Read the docs" }).click();
	expect(await page.evaluate(() => window.__quarterdeckOpenedBrowserUrl)).toBe(
		"https://github.com/dankhole/quarterdeck",
	);
	expect(await listHostEvents(page)).toEqual(beforeDocsLink);
});

test("simulates Open in IDE for the scoped synthetic project", async ({ page }) => {
	await openBoard(page);
	const projectId = await page.evaluate(async () => {
		const response = await fetch("/api/trpc/projects.list");
		const payload = (await response.json()) as {
			result?: { data?: { projects?: Array<{ id?: string; path?: string }> } };
		};
		return payload.result?.data?.projects?.find((project) => project.path?.endsWith("/project"))?.id ?? null;
	});

	await page.getByRole("button", { name: "Open in VS Code" }).click();
	await expect(page.getByText("Agent Lab recorded Open in VS Code; no desktop app was launched.")).toBeVisible();
	const event = await waitForHostEvent(page, "open_project");
	expect(event).toMatchObject({
		kind: "open_project",
		origin: "runtime",
		outcome: "simulated",
		targetId: "vscode",
		target: { scope: "primary_project", relativePath: "." },
		projectId,
	});
});

test("simulates config-file opening and notification audio without desktop side effects", async ({ page }) => {
	await openBoard(page);
	await page.getByTestId("open-settings-button").click();
	const settingsDialog = page.getByRole("dialog", { name: "Settings" });
	await expect(settingsDialog).toBeVisible();

	await settingsDialog.locator("p.font-mono").first().click();
	await expect(
		page.getByText("Agent Lab recorded the file-open request; no desktop window was opened."),
	).toBeVisible();
	const openPathEvent = await waitForHostEvent(page, "open_path");
	expect(openPathEvent).toMatchObject({
		kind: "open_path",
		origin: "runtime",
		outcome: "simulated",
		target: { scope: "runtime_state", relativePath: "config.json" },
	});

	await settingsDialog.getByRole("button", { name: "Test sound" }).click();
	await expect(page.getByText("Agent Lab simulated the notification sound; no audio was played.")).toBeVisible();
	const audioEvent = await waitForHostEvent(page, "notification_audio", openPathEvent.sequence);
	expect(audioEvent).toMatchObject({
		kind: "notification_audio",
		origin: "browser",
		outcome: "simulated",
		eventType: "permission",
		projectId: null,
		taskId: null,
	});
});

test("uses the in-memory lab clipboard for Files copy and terminal OSC 52 read", async ({ page }) => {
	await openBoard(page);
	await page.getByRole("button", { name: "Files" }).click();
	await page.getByRole("button", { name: "README.md", exact: true }).click();
	await expect(page.getByRole("button", { name: "Copy file contents" })).toBeVisible();
	await page.getByRole("button", { name: "Copy file contents" }).click();
	await expect(page.getByText("File contents copied to clipboard")).toBeVisible();
	const writeEvent = await waitForHostEvent(page, "clipboard_write");
	expect(writeEvent).toMatchObject({
		kind: "clipboard_write",
		origin: "browser",
		outcome: "simulated",
	});
	if (writeEvent.kind !== "clipboard_write") {
		throw new Error("Expected a simulated clipboard write.");
	}
	expect(writeEvent.characterCount).toBeGreaterThan(0);

	await page.getByRole("button", { name: "Home" }).click();
	const taskPrompt = `[agent-lab:idle] clipboard-${Date.now()}`;
	const backlogColumn = page.locator(BACKLOG_COLUMN).first();
	await backlogColumn.getByRole("button", { name: "Create task" }).click();
	const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "New task" }) });
	await dialog.getByPlaceholder("Describe the task").fill(taskPrompt);
	await dialog.getByRole("button", { name: "Start task" }).click();
	const inProgressColumn = page.locator('section[data-column-id="in_progress"]').first();
	const runningCard = inProgressColumn.locator("[data-task-id]").filter({ hasText: taskPrompt }).first();
	await expect(runningCard).toBeVisible({ timeout: 20_000 });
	const taskId = await runningCard.getAttribute("data-task-id");
	expect(taskId).not.toBeNull();
	await runningCard.click();
	await expect(page.getByRole("textbox", { name: "Terminal input" })).toBeVisible();
	await page.getByRole("textbox", { name: "Terminal input" }).focus();
	await page.keyboard.type("/clipboard-read");
	await page.keyboard.press("Enter");

	const readEvent = await waitForHostEvent(page, "clipboard_read", writeEvent.sequence);
	expect(readEvent).toMatchObject({
		kind: "clipboard_read",
		origin: "browser",
		outcome: "simulated",
		characterCount: writeEvent.characterCount,
	});
	await expect
		.poll(
			() =>
				page.evaluate((activeTaskId) => {
					const state = window.__quarterdeckDumpTerminalState?.();
					return state?.poolSlots.find((slot) => slot.taskId === activeTaskId)?.visibleLines.join("\n") ?? "";
				}, taskId),
			{ timeout: 20_000 },
		)
		.toContain("AGENT LAB CLIPBOARD READ: # Quarterdeck agent lab fixture");
});

test("creating and opening a backlog task shows the inline editor", async ({ page }) => {
	await openBoard(page);
	const taskTitle = `smoke-${Date.now()}`;
	await createTaskFromBacklog(page, taskTitle);
	await openTaskFromBoard(page, taskTitle);
	await expect(page.getByPlaceholder("Describe the task")).toHaveValue(taskTitle);
	await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Start", exact: true })).toBeVisible();
});

test("side-panel card actions only wrap when the controls cannot fit", async ({ page }) => {
	await openBoard(page);
	const taskTitle = `card-layout-${Date.now()}`;
	await createTaskFromBacklog(page, taskTitle);

	const boardCard = page.locator(BACKLOG_COLUMN).locator("[data-task-id]").filter({ hasText: taskTitle }).first();
	const taskId = await boardCard.getAttribute("data-task-id");
	expect(taskId).not.toBeNull();
	await page.evaluate((selectedTaskId) => {
		const url = new URL(window.location.href);
		url.searchParams.set("task", selectedTaskId);
		window.history.pushState(window.history.state, "", url);
		window.dispatchEvent(new PopStateEvent("popstate"));
	}, taskId!);
	const card = page.locator(`[data-task-id="${taskId}"]`).filter({ hasText: taskTitle }).first();
	await expect(card).toBeVisible();
	await card.evaluate((element) => {
		element.style.width = "126px";
	});
	await card.hover();

	const header = card.locator("[data-board-card-header]");
	const title = header.locator("[data-board-card-title]");
	const actionRail = header.locator("[data-board-card-action-rail]");
	await expect(actionRail.getByRole("button", { name: "Edit title" })).toBeVisible();

	const titleBox = await title.boundingBox();
	const actionRailBox = await actionRail.boundingBox();
	expect(titleBox).not.toBeNull();
	expect(actionRailBox).not.toBeNull();
	expect(titleBox!.width).toBeLessThan(8);
	const titleCenterY = titleBox!.y + titleBox!.height / 2;
	const actionRailCenterY = actionRailBox!.y + actionRailBox!.height / 2;
	expect(Math.abs(actionRailCenterY - titleCenterY)).toBeLessThan(1);
	const wideActionTops = await actionRail
		.getByRole("button")
		.evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top));
	expect(new Set(wideActionTops).size).toBe(1);

	await card.evaluate((element) => {
		element.style.width = "90px";
	});

	await expect.poll(() => header.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

	const actionBoxes = await actionRail.getByRole("button").evaluateAll((buttons) =>
		buttons.map((button) => {
			const rect = button.getBoundingClientRect();
			return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
		}),
	);
	expect(new Set(actionBoxes.map((box) => box.top)).size).toBeGreaterThan(1);
	for (let index = 0; index < actionBoxes.length; index += 1) {
		for (let comparisonIndex = index + 1; comparisonIndex < actionBoxes.length; comparisonIndex += 1) {
			const first = actionBoxes[index]!;
			const second = actionBoxes[comparisonIndex]!;
			const intersects =
				first.left < second.right &&
				first.right > second.left &&
				first.top < second.bottom &&
				first.bottom > second.top;
			expect(intersects).toBe(false);
		}
	}
});

test("escape key closes the backlog inline editor", async ({ page }) => {
	await openBoard(page);
	const taskTitle = `escape-${Date.now()}`;
	await createTaskFromBacklog(page, taskTitle);
	await openTaskFromBoard(page, taskTitle);
	const prompt = page.getByPlaceholder("Describe the task");
	await expect(prompt).toHaveValue(taskTitle);
	await prompt.press("Escape");
	await expect(page.getByPlaceholder("Describe the task")).toHaveCount(0);
	await expect(page.getByText("Backlog", { exact: true })).toBeVisible();
	await expect(
		page.locator(BACKLOG_COLUMN).locator("[data-task-id]").filter({ hasText: taskTitle }).first(),
	).toBeVisible();
});

test("settings button opens runtime settings dialog", async ({ page }) => {
	await openBoard(page);
	await page.getByTestId("open-settings-button").click();
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
});

test("opens the unified diagnostics panel with health and capture controls", async ({ page }, testInfo) => {
	await openBoard(page);
	await page.getByTestId("open-diagnostics-button").click();
	const panel = page.getByTestId("diagnostics-panel");
	await expect(panel).toBeVisible();
	await expect(panel.getByText("Diagnostics", { exact: true })).toBeVisible();
	await expect(panel.getByRole("button", { name: "Refresh diagnostics" })).toBeEnabled();
	await panel.getByRole("button", { name: "Health" }).click();
	await expect(panel.getByText("Connection", { exact: true })).toBeVisible();
	await panel.getByRole("button", { name: "Capture" }).click();
	await expect(panel.getByText("Always-on flight recorder", { exact: true })).toBeVisible();
	await expect(panel.getByRole("button", { name: "Export diagnostic bundle" })).toBeEnabled();

	const screenshotPath = testInfo.outputPath("diagnostics-panel.png");
	await panel.screenshot({ path: screenshotPath });
	await testInfo.attach("diagnostics-panel", { path: screenshotPath, contentType: "image/png" });
});

test("agent lab adds a synthetic project through the browser manual-path fallback", async ({ page }) => {
	await openBoard(page);
	const additionalProjectPath = await page.evaluate(async () => {
		const injectedPath = (window as typeof window & { __quarterdeckAgentLab?: { additionalProjectPath?: string } })
			.__quarterdeckAgentLab?.additionalProjectPath;
		if (injectedPath) {
			return injectedPath;
		}
		const response = await fetch("/api/trpc/projects.list");
		const payload = (await response.json()) as {
			result?: { data?: { projects?: Array<{ path?: string }> } };
		};
		const currentPath = payload.result?.data?.projects?.[0]?.path;
		return currentPath?.replace(/project$/, "project-secondary");
	});
	expect(additionalProjectPath).toBeTruthy();

	let promptHandled = false;
	page.once("dialog", async (dialog) => {
		expect(dialog.type()).toBe("prompt");
		expect(dialog.message()).toContain("Enter a project path to add");
		promptHandled = true;
		await dialog.accept(additionalProjectPath);
	});
	await page.getByRole("button", { name: "Add Project" }).click();

	await expect.poll(() => promptHandled, { timeout: 3_000 }).toBe(true);
	await expect(page.getByRole("button", { name: /^project-secondary\b/ })).toBeVisible({ timeout: 10_000 });
	await expect(page).toHaveURL(/\/project-secondary(?:[?#]|$)/);
	const pickerEvent = await waitForHostEvent(page, "directory_picker");
	expect(pickerEvent).toMatchObject({
		kind: "directory_picker",
		origin: "runtime",
		outcome: "unsupported",
	});
});

test("drives the deterministic agent terminal through review", async ({ page }, testInfo) => {
	await openBoard(page);
	const taskPrompt = `[agent-lab:idle] functional-${Date.now()}`;
	const backlogColumn = page.locator(BACKLOG_COLUMN).first();
	await backlogColumn.getByRole("button", { name: "Create task" }).click();
	const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "New task" }) });
	await dialog.getByPlaceholder("Describe the task").fill(taskPrompt);
	await dialog.getByRole("button", { name: "Start task" }).click();
	await expect(dialog).toBeHidden();

	const inProgressColumn = page.locator('section[data-column-id="in_progress"]').first();
	const runningCard = inProgressColumn.locator("[data-task-id]").filter({ hasText: taskPrompt }).first();
	await expect(runningCard).toBeVisible({ timeout: 20_000 });
	const taskId = await runningCard.getAttribute("data-task-id");
	expect(taskId).not.toBeNull();
	await runningCard.click();
	await expect(page.getByRole("textbox", { name: "Terminal input" })).toBeVisible();

	await expect
		.poll(
			() =>
				page.evaluate((activeTaskId) => {
					const state = window.__quarterdeckDumpTerminalState?.();
					return state?.poolSlots.find((slot) => slot.taskId === activeTaskId)?.visibleLines.join("\n") ?? "";
				}, taskId),
			{ timeout: 20_000 },
		)
		.toContain("AGENT LAB READY");

	await page.getByRole("textbox", { name: "Terminal input" }).focus();
	await page.keyboard.type("/write agent-lab-e2e.txt created-by-playwright");
	await page.keyboard.press("Enter");
	await expect
		.poll(
			() =>
				page.evaluate((activeTaskId) => {
					const state = window.__quarterdeckDumpTerminalState?.();
					return state?.poolSlots.find((slot) => slot.taskId === activeTaskId)?.visibleLines.join("\n") ?? "";
				}, taskId),
			{ timeout: 20_000 },
		)
		.toContain("AGENT LAB WROTE: agent-lab-e2e.txt");

	await page.keyboard.type("/review Playwright lifecycle verified");
	await page.keyboard.press("Enter");

	const reviewCard = page.locator(`[data-task-id="${taskId}"]`).filter({ hasText: "Ready for review" }).first();
	await expect(reviewCard).toBeVisible({ timeout: 20_000 });
	await expect(reviewCard).toContainText("Ready for review");
	await page.screenshot({ path: testInfo.outputPath("fake-agent-review.png"), fullPage: true });
});
