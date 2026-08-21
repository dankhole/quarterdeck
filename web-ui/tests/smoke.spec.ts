import { expect, type Page, test } from "@playwright/test";

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

test("card action controls wrap without overlapping or overflowing", async ({ page }) => {
	await openBoard(page);
	const taskTitle = `card-layout-${Date.now()}`;
	await createTaskFromBacklog(page, taskTitle);

	const card = page.locator(BACKLOG_COLUMN).locator("[data-task-id]").filter({ hasText: taskTitle }).first();
	await card.evaluate((element) => {
		element.style.width = "150px";
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
	expect(actionRailBox!.y).toBeGreaterThan(titleBox!.y);

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
