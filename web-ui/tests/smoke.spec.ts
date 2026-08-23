import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

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
	const runningCard = inProgressColumn.locator("[data-task-id]").first();
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
