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
