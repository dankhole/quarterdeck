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

async function readTaskIds(page: Page): Promise<string[]> {
	return await page.locator("[data-task-id]").evaluateAll((cards) =>
		cards.flatMap((card) => {
			const taskId = card.getAttribute("data-task-id");
			return taskId ? [taskId] : [];
		}),
	);
}

async function waitForCreatedTaskId(page: Page, existingTaskIds: ReadonlySet<string>): Promise<string> {
	let createdTaskId: string | null = null;
	await expect
		.poll(async () => {
			createdTaskId = (await readTaskIds(page)).find((taskId) => !existingTaskIds.has(taskId)) ?? null;
			return createdTaskId !== null;
		})
		.toBe(true);
	if (!createdTaskId) throw new Error("Expected one new stable task identity.");
	return createdTaskId;
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
	const existingTaskIds = new Set(await readTaskIds(page));
	await dialog.getByRole("button", { name: "Start task" }).click();
	const taskId = await waitForCreatedTaskId(page, existingTaskIds);
	const taskCard = page.locator(`[data-task-id="${taskId}"]`).first();
	await expect(taskCard).toBeVisible({ timeout: 20_000 });
	await expect(taskCard).toContainText("Review");
	await taskCard.click();
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
	// Automatic title generation may replace the initial prompt while this
	// layout test is running. Task identity is stable; visible title text is not.
	const card = page.locator(`[data-task-id="${taskId}"]`).first();
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

	await page.getByRole("button", { name: "Add Project" }).click();
	const pathDialog = page
		.getByRole("dialog")
		.filter({ has: page.getByRole("heading", { name: "Add project by path" }) });
	await expect(pathDialog).toBeVisible();
	await pathDialog.getByLabel("Project path").fill(additionalProjectPath);
	await pathDialog.getByRole("button", { name: "Add project" }).click();
	await expect(pathDialog).toBeHidden();
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
	const existingTaskIds = new Set(await readTaskIds(page));
	await dialog.getByRole("button", { name: "Start task" }).click();
	await expect(dialog).toBeHidden();

	const taskId = await waitForCreatedTaskId(page, existingTaskIds);
	const taskCard = page.locator(`[data-task-id="${taskId}"]`).first();
	await expect(taskCard).toBeVisible({ timeout: 20_000 });
	await expect(taskCard).toContainText("Review");
	await taskCard.click();
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

test("converges provider-approved permissions and fences historical interruption redraws", async ({ page }) => {
	test.setTimeout(60_000);
	await page.addInitScript(() => {
		window.localStorage.setItem("quarterdeck.task-create-last-agent-id", "codex");
	});
	await openBoard(page);
	await page.getByTestId("open-settings-button").click();
	const settingsDialog = page.getByRole("dialog", { name: "Settings" });
	const hiddenOnlySound = settingsDialog.getByRole("checkbox", { name: /Only when tab is hidden/ });
	await expect(hiddenOnlySound).toBeChecked();
	await hiddenOnlySound.click();
	await settingsDialog.getByRole("button", { name: "Save" }).click();
	await expect(settingsDialog).toBeHidden();
	const taskPrompt = `[agent-lab:idle] lifecycle-fences-${Date.now()}`;
	const backlogColumn = page.locator(BACKLOG_COLUMN).first();
	await backlogColumn.getByRole("button", { name: "Create task" }).click();
	const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "New task" }) });
	await dialog.getByPlaceholder("Describe the task").fill(taskPrompt);
	await expect(dialog.getByRole("button", { name: "Task harness" })).toContainText("Codex");
	const existingTaskIds = new Set(await readTaskIds(page));
	await dialog.getByRole("button", { name: "Start task" }).click();
	await expect(dialog).toBeHidden();

	const taskId = await waitForCreatedTaskId(page, existingTaskIds);
	const inProgressColumn = page.locator('section[data-column-id="in_progress"]').first();
	const initialCard = page.locator(`[data-task-id="${taskId}"]`).first();
	await expect(initialCard).toBeVisible({ timeout: 20_000 });
	await expect(initialCard).toContainText("Review");
	await expect(inProgressColumn.locator(`[data-task-id="${taskId}"]`)).toHaveCount(0);
	const projectRow = page.locator(".kb-project-row-selected:visible").first();
	const card = page.locator(`[data-task-id="${taskId}"]`).first();
	const readProjectIndicatorCount = async (title: "Review" | "Needs Input"): Promise<number> => {
		const [text] = await projectRow.locator(`[title="${title}"]:visible`).allTextContents();
		if (text === undefined) return 0;
		const match = text.match(/\d+/);
		if (!match) throw new Error(`Expected ${title} project indicator to contain a count.`);
		return Number(match[0]);
	};
	const submitTerminalCommand = async (command: string): Promise<void> => {
		await card.click();
		const terminalInput = page.getByRole("textbox", { name: "Terminal input" });
		await expect(terminalInput).toBeVisible();
		await terminalInput.focus();
		await page.keyboard.type(command);
		await page.keyboard.press("Enter");
	};
	const showBoard = async (): Promise<void> => {
		await page.getByRole("button", { name: "Home" }).click();
		await expect(projectRow).toBeVisible();
	};
	const beforeEvents = await listHostEvents(page);
	const lastEventSequence = beforeEvents.events.at(-1)?.sequence ?? 0;
	const initialReviewCount = await readProjectIndicatorCount("Review");
	const initialNeedsInputCount = await readProjectIndicatorCount("Needs Input");
	const needsInputMarkers = projectRow.locator('span[title$="needs input"]:visible');
	const initialNeedsInputMarkerCount = await needsInputMarkers.count();

	await submitTerminalCommand("/working provider-confirmed initial turn");
	await expect(card).toContainText("Running", { timeout: 20_000 });
	await showBoard();
	await expect(inProgressColumn.locator(`[data-task-id="${taskId}"]`)).toBeVisible();
	await expect.poll(async () => await readProjectIndicatorCount("Review")).toBe(initialReviewCount - 1);
	await expect.poll(async () => await readProjectIndicatorCount("Needs Input")).toBe(initialNeedsInputCount);

	await card.click();
	await expect(page.getByRole("textbox", { name: "Terminal input" })).toBeVisible();
	await page.getByRole("textbox", { name: "Terminal input" }).focus();
	await page.keyboard.press("Escape");
	await expect(card).toContainText("Interrupted", { timeout: 20_000 });
	await showBoard();
	await expect.poll(async () => await readProjectIndicatorCount("Review")).toBe(initialReviewCount);
	await expect.poll(async () => await readProjectIndicatorCount("Needs Input")).toBe(initialNeedsInputCount);

	await submitTerminalCommand("/working provider-confirmed after interrupt");
	await expect(card).toContainText("Running", { timeout: 20_000 });
	await showBoard();
	await expect.poll(async () => await readProjectIndicatorCount("Review")).toBe(initialReviewCount - 1);

	await submitTerminalCommand("/needs-input cancel before provider completion");
	await expect(card).toContainText("Waiting for approval", { timeout: 20_000 });
	await showBoard();
	await expect.poll(async () => await readProjectIndicatorCount("Needs Input")).toBe(initialNeedsInputCount + 1);
	await expect.poll(async () => await readProjectIndicatorCount("Review")).toBe(initialReviewCount - 1);
	const cancelledPermissionSound = await waitForHostEvent(page, "notification_audio", lastEventSequence);
	expect(cancelledPermissionSound).toMatchObject({
		kind: "notification_audio",
		eventType: "permission",
		projectId: expect.any(String),
		taskId,
		outcome: "simulated",
	});
	await card.click();
	const terminalInput = page.getByRole("textbox", { name: "Terminal input" });
	await expect(terminalInput).toBeVisible();
	await terminalInput.focus();
	await page.keyboard.press("Escape");
	await expect(card).toContainText("Response sent", { timeout: 20_000 });
	await showBoard();
	await expect.poll(async () => await readProjectIndicatorCount("Needs Input")).toBe(initialNeedsInputCount);
	await expect.poll(async () => await readProjectIndicatorCount("Review")).toBe(initialReviewCount);
	await expect(needsInputMarkers).toHaveCount(initialNeedsInputMarkerCount);

	await submitTerminalCommand("/needs-input-auto provider policy approved");
	await expect(card).toContainText("Waiting for approval", { timeout: 20_000 });
	await showBoard();
	await expect.poll(async () => await readProjectIndicatorCount("Needs Input")).toBe(initialNeedsInputCount + 1);
	await expect.poll(async () => await readProjectIndicatorCount("Review")).toBe(initialReviewCount - 1);
	await expect(needsInputMarkers).toHaveCount(initialNeedsInputMarkerCount + 1);
	const permissionSound = await waitForHostEvent(page, "notification_audio", cancelledPermissionSound.sequence);
	expect(permissionSound).toMatchObject({
		kind: "notification_audio",
		eventType: "permission",
		projectId: expect.any(String),
		taskId,
		outcome: "simulated",
	});

	await expect(card).toContainText("Running", { timeout: 20_000 });
	await expect(inProgressColumn.locator(`[data-task-id="${taskId}"]`)).toBeVisible();
	await expect.poll(async () => await readProjectIndicatorCount("Needs Input")).toBe(initialNeedsInputCount);
	await expect.poll(async () => await readProjectIndicatorCount("Review")).toBe(initialReviewCount - 1);
	await expect(needsInputMarkers).toHaveCount(initialNeedsInputMarkerCount);

	await submitTerminalCommand("/approval-overlay");
	await expect(card).toContainText("Waiting for approval", { timeout: 20_000 });
	await showBoard();
	await expect.poll(async () => await readProjectIndicatorCount("Needs Input")).toBe(initialNeedsInputCount + 1);
	await expect.poll(async () => await readProjectIndicatorCount("Review")).toBe(initialReviewCount - 1);
	const overlayPermissionSound = await waitForHostEvent(page, "notification_audio", permissionSound.sequence);
	expect(overlayPermissionSound).toMatchObject({
		kind: "notification_audio",
		eventType: "permission",
		projectId: expect.any(String),
		taskId,
		outcome: "simulated",
	});
	await card.click();
	await expect(terminalInput).toBeVisible();
	await terminalInput.focus();
	await page.keyboard.type("y");
	await expect(card).toContainText("Response sent", { timeout: 20_000 });
	await showBoard();
	await expect.poll(async () => await readProjectIndicatorCount("Needs Input")).toBe(initialNeedsInputCount);
	await expect.poll(async () => await readProjectIndicatorCount("Review")).toBe(initialReviewCount);
	await expect(card).toContainText("Running", { timeout: 20_000 });
	await expect.poll(async () => await readProjectIndicatorCount("Review")).toBe(initialReviewCount - 1);

	await submitTerminalCommand("/turn-interrupted");
	await expect(card).toContainText("Interrupted", { timeout: 20_000 });
	await showBoard();
	await expect.poll(async () => await readProjectIndicatorCount("Review")).toBe(initialReviewCount);
	await expect.poll(async () => await readProjectIndicatorCount("Needs Input")).toBe(initialNeedsInputCount);
	await expect(needsInputMarkers).toHaveCount(initialNeedsInputMarkerCount);

	await submitTerminalCommand("/new-turn follow-up started");
	await expect(card).toContainText("Running", { timeout: 20_000 });
	await showBoard();

	await submitTerminalCommand("/redraw-interruption-history");
	await expect.poll(async () => await card.textContent(), { timeout: 3_000 }).toContain("Running");
	await showBoard();
	await expect.poll(async () => await readProjectIndicatorCount("Review")).toBe(initialReviewCount - 1);
	await expect.poll(async () => await readProjectIndicatorCount("Needs Input")).toBe(initialNeedsInputCount);

	await submitTerminalCommand("/turn-interrupted");
	await expect(card).toContainText("Interrupted", { timeout: 20_000 });
	await showBoard();
	await expect.poll(async () => await readProjectIndicatorCount("Review")).toBe(initialReviewCount);
	await expect.poll(async () => await readProjectIndicatorCount("Needs Input")).toBe(initialNeedsInputCount);

	const afterEvents = await listHostEvents(page);
	expect(
		afterEvents.events.filter(
			(event) => event.kind === "notification_audio" && event.sequence > overlayPermissionSound.sequence,
		),
	).toEqual([]);
});
