import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";
import {
	type RuntimeHostIntegrationEvent,
	runtimeHostIntegrationEventLedgerFileSchema,
} from "../../src/core/api/host-integrations";
import type { DesktopLabDriver } from "./desktop-driver";
import { readDesktopTaskSession } from "./desktop-session-evidence";
import { writeJsonAtomic } from "./paths";

async function waitFor(check: () => Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Packaged product coverage timed out: ${label}.`);
}

interface Box {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

export function assertTaskActionLayout(boxes: readonly Box[], wrapped: boolean): void {
	if (boxes.length < 2 || new Set(boxes.map(({ top }) => top)).size > 1 !== wrapped)
		throw new Error("Task action rail did not retain its expected wrapping boundary.");
	for (let first = 0; first < boxes.length; first++) {
		for (let second = first + 1; second < boxes.length; second++) {
			const a = boxes[first];
			const b = boxes[second];
			if (a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top)
				throw new Error("Task card actions overlap.");
		}
	}
}

async function readHostEvents(driver: DesktopLabDriver): Promise<RuntimeHostIntegrationEvent[]> {
	return runtimeHostIntegrationEventLedgerFileSchema.parse(
		JSON.parse(await readFile(join(driver.fixture.manifest.artifactDir, "host-events.json"), "utf8")) as unknown,
	).events;
}

/**
 * A fresh simulated OSC 52 read proves xterm parsed the preceding output without
 * a native work hook that could repair an incorrect lifecycle transition. For
 * historical redraws the query must be inline: another Readline command can
 * alter the frame being tested. Never accept an old read.
 */
export async function fenceDesktopTerminalProcessing(options: {
	readEvents: () => Promise<RuntimeHostIntegrationEvent[]>;
	requestClipboardRead: () => Promise<void>;
	characterCount: number;
	label: string;
}): Promise<number> {
	const before = (await options.readEvents()).at(-1)?.sequence ?? 0;
	await options.requestClipboardRead();
	let receiptSequence = 0;
	await waitFor(async () => {
		const receipt = (await options.readEvents()).find(
			(event) =>
				event.kind === "clipboard_read" &&
				event.outcome === "simulated" &&
				event.sequence > before &&
				event.characterCount === options.characterCount,
		);
		if (!receipt) return false;
		receiptSequence = receipt.sequence;
		return true;
	}, `terminal-processing receipt after ${options.label}`);
	return receiptSequence;
}

async function exerciseDesktopHostCoverage(page: Page, driver: DesktopLabDriver): Promise<void> {
	const before = (await readHostEvents(driver)).at(-1)?.sequence ?? 0;
	const ide = page.getByRole("button", { name: "Open in VS Code", exact: true });
	await waitFor(() => ide.isEnabled(), "project IDE readiness");
	await ide.click();
	await waitFor(
		async () =>
			(await readHostEvents(driver)).some(
				(event) =>
					event.sequence > before &&
					event.kind === "open_project" &&
					event.outcome === "simulated" &&
					event.targetId === "vscode" &&
					event.target.scope === "primary_project" &&
					event.target.relativePath === ".",
			),
		"scoped IDE request",
	);
	await page.getByTestId("open-settings-button").click();
	const settings = page.getByRole("dialog", { name: "Settings", exact: true });
	await settings.waitFor({ state: "visible" });
	await settings.getByRole("button", { name: "Open configuration file for all projects", exact: true }).click();
	await waitFor(
		async () =>
			(await readHostEvents(driver)).some(
				(event) =>
					event.sequence > before &&
					event.kind === "open_path" &&
					event.outcome === "simulated" &&
					event.target.scope === "runtime_state" &&
					event.target.relativePath === "config.json",
			),
		"scoped config-file request",
	);
	// Human-approval assertions require explicit launch authority. Inherited
	// Codex policy can route requests to automatic review instead of the user.
	await settings.getByRole("button", { name: /^Codex\b/ }).click();
	const approvalPolicy = settings.locator("#runtime-settings-codex-approvals-reviewer");
	await waitFor(() => approvalPolicy.isEnabled(), "fake provider approval-policy readiness");
	await approvalPolicy.selectOption("user");
	await settings.getByRole("button", { name: "Save changes", exact: true }).click();
	await settings.waitFor({ state: "hidden" });
	await page.getByRole("button", { name: "Files", exact: true }).click();
	await page.getByRole("button", { name: "README.md", exact: true }).click();
	await page.getByRole("button", { name: "Copy file contents", exact: true }).click();
	await waitFor(
		async () =>
			(await readHostEvents(driver)).some(
				(event) =>
					event.sequence > before &&
					event.kind === "clipboard_write" &&
					event.outcome === "simulated" &&
					event.characterCount > 0,
			),
		"Files clipboard copy",
	);
	await page.getByRole("button", { name: "Home", exact: true }).click();
}

/** Retains unique former web smoke checks on the actual packaged renderer, without browser admission. */
export async function exerciseDesktopProductCoverage(page: Page, driver: DesktopLabDriver): Promise<void> {
	await page.getByRole("button", { name: "Home", exact: true }).click();
	await page.locator("section.kb-board").waitFor({ state: "visible" });
	for (const id of ["in_progress", "review", "trash"])
		await page.locator(`section[data-column-id="${id}"]`).waitFor({ state: "visible" });
	await page.getByRole("button", { name: "Switch branch" }).waitFor({ state: "visible" });
	await page.getByTestId("open-diagnostics-button").click();
	const panel = page.getByTestId("diagnostics-panel");
	await panel.waitFor({ state: "visible" });
	await waitFor(
		() => panel.getByRole("button", { name: "Refresh diagnostics", exact: true }).isEnabled(),
		"packaged diagnostics refresh readiness",
	);
	await panel.getByRole("button", { name: "Health", exact: true }).click();
	await panel.getByText("Connection", { exact: true }).waitFor({ state: "visible" });
	await panel.getByRole("button", { name: "Capture", exact: true }).click();
	await panel.getByText("Always-on flight recorder", { exact: true }).waitFor({ state: "visible" });
	await waitFor(
		() => panel.getByRole("button", { name: "Export diagnostic bundle", exact: true }).isEnabled(),
		"packaged diagnostic export readiness",
	);
	await panel.getByRole("button", { name: "Close diagnostics", exact: true }).click();
	await panel.waitFor({ state: "hidden" });
	await exerciseDesktopHostCoverage(page, driver);

	const promptText = `unstarted-${driver.fixture.manifest.runId}`;
	await page.getByRole("button", { name: "Create task", exact: true }).first().click();
	const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "New task" }) });
	await dialog.getByPlaceholder("Describe the task").fill(promptText);
	await dialog.getByRole("button", { name: /^Create\b/ }).click();
	await dialog.waitFor({ state: "hidden" });
	const card = page.locator('section[data-column-id="review"] [data-task-id]').filter({ hasText: promptText }).first();
	await card.waitFor({ state: "visible" });
	const taskId = await card.getAttribute("data-task-id");
	if (!taskId) throw new Error("Unstarted task has no stable identity.");
	await card.press("Enter");
	const prompt = page.getByPlaceholder("Describe the task");
	await prompt.waitFor({ state: "visible" });
	if ((await prompt.inputValue()) !== promptText) throw new Error("Unstarted task editor lost its prompt.");
	await page.getByRole("button", { name: "Save", exact: true }).waitFor({ state: "visible" });
	await page.getByRole("button", { name: "Start", exact: true }).waitFor({ state: "visible" });
	await prompt.press("Escape");
	await prompt.waitFor({ state: "hidden" });
	// Enter on an unstarted Home card opens its editor, not task detail. Use
	// the supported task deep link to measure the selected compact sidebar card.
	const detailUrl = new URL(page.url());
	detailUrl.searchParams.set("task", taskId);
	await page.evaluate((href) => {
		const renderer = globalThis as unknown as {
			history: { state: unknown; pushState(state: unknown, unused: string, url: string): void };
			PopStateEvent: new (type: string) => unknown;
			dispatchEvent(event: unknown): boolean;
		};
		// Stay in this renderer: reloading would reset its simulated clipboard.
		renderer.history.pushState(renderer.history.state, "", href);
		renderer.dispatchEvent(new renderer.PopStateEvent("popstate"));
	}, detailUrl.href);
	const sideCard = page.locator(`.kb-board-card-shell[data-task-id="${taskId}"][data-selected="true"]:visible`);
	await sideCard.waitFor({ state: "visible" });
	await driver.inspect("task-action-layout-ready");
	const header = sideCard.locator("[data-board-card-header]");
	const rail = header.locator("[data-board-card-action-rail]");
	try {
		for (const width of [126, 90]) {
			await sideCard.evaluate((element, pixels) => {
				element.style.width = `${pixels}px`;
			}, width);
			await sideCard.hover();
			await rail.getByRole("button", { name: "Edit title" }).waitFor({ state: "visible" });
			await waitFor(() => header.evaluate((element) => element.scrollWidth <= element.clientWidth), "card overflow");
			const boxes = await rail.getByRole("button").evaluateAll((buttons) =>
				buttons.map((button) => {
					const { left, right, top, bottom } = button.getBoundingClientRect();
					return { left, right, top, bottom };
				}),
			);
			assertTaskActionLayout(boxes, width === 90);
			await sideCard.screenshot({ path: join(driver.fixture.manifest.artifactDir, `task-actions-${width}.png`) });
		}
		await driver.inspect("task-action-layout");
	} finally {
		await sideCard.evaluate((element) => {
			element.style.removeProperty("width");
		});
		if (await prompt.isVisible()) await prompt.press("Escape");
		await page.getByRole("button", { name: "Home", exact: true }).click();
	}
	await writeJsonAtomic(join(driver.fixture.manifest.artifactDir, "product-coverage.json"), {
		boardColumns: true,
		diagnostics: true,
		fakeApprovalPolicy: "ask-me",
		unstartedEditor: true,
		escape: true,
		taskActionWrapping: true,
	});
}

/** Native hooks, not keystrokes or terminal output, must drive all three visible projections. */
export async function exerciseDesktopLifecycleCoverage(
	page: Page,
	driver: DesktopLabDriver,
	taskId: string,
): Promise<void> {
	const card = page.locator(`[data-task-id="${taskId}"]`).first();
	const projectRow = page.locator(".kb-project-row-selected:visible").first();
	await page.getByRole("button", { name: "Home", exact: true }).click();
	await projectRow.waitFor({ state: "visible" });
	const count = async (title: "Review" | "Needs Input"): Promise<number> => {
		const values = await projectRow.locator(`[title="${title}"]:visible`).allTextContents();
		return Number(values[0]?.match(/\d+/)?.[0] ?? 0);
	};
	const initialReview = await count("Review");
	const initialNeedsInput = await count("Needs Input");
	const command = async (value: string): Promise<void> => {
		await card.press("Enter");
		const input = page.getByRole("textbox", { name: "Terminal input" });
		await input.waitFor({ state: "visible" });
		await input.focus();
		await page.keyboard.type(value);
		await page.keyboard.press("Enter");
	};
	const projection = async (text: string, review: number, needsInput: number): Promise<void> => {
		try {
			await waitFor(async () => (await card.textContent())?.includes(text) === true, text);
		} catch (error) {
			await page.screenshot({ path: join(driver.fixture.manifest.artifactDir, "lifecycle-projection-failure.png") });
			throw error;
		}
		await page.getByRole("button", { name: "Home", exact: true }).click();
		await waitFor(
			async () => (await count("Review")) === review && (await count("Needs Input")) === needsInput,
			"project indicators",
		);
		const column = text === "Running" ? "in_progress" : "review";
		await page
			.locator(`section[data-column-id="${column}"] [data-task-id="${taskId}"]`)
			.waitFor({ state: "visible" });
	};
	const assertRunningStable = async (reason: string): Promise<void> => {
		await page.getByRole("button", { name: "Home", exact: true }).click();
		await projectRow.waitFor({ state: "visible" });
		const deadline = Date.now() + 1_000;
		do {
			const current = await readDesktopTaskSession(driver.fixture.config.stateHome, taskId);
			if (
				current?.state !== "running" ||
				!(await card.getByText("Running", { exact: true }).isVisible()) ||
				(await count("Review")) !== initialReview - 1 ||
				(await count("Needs Input")) !== initialNeedsInput
			)
				throw new Error(`Packaged ${reason} changed the running session or its visible projections.`);
			await page.waitForTimeout(50);
		} while (Date.now() < deadline);
	};
	const clipboard = (await readHostEvents(driver)).filter((event) => event.kind === "clipboard_write").at(-1);
	if (clipboard?.kind !== "clipboard_write" || clipboard.characterCount <= 0)
		throw new Error("Files copy did not reach the simulated clipboard.");
	const terminalProcessed = (
		label: string,
		requestClipboardRead: () => Promise<void> = () => command("/clipboard-read"),
	) =>
		fenceDesktopTerminalProcessing({
			readEvents: () => readHostEvents(driver),
			requestClipboardRead,
			characterCount: clipboard.characterCount,
			label,
		});
	const initialClipboardReceipt = await terminalProcessed("initial OSC 52 clipboard read");
	await command("/working provider-confirmed desktop coverage");
	await projection("Running", initialReview - 1, initialNeedsInput);
	await card.press("Enter");
	await page.getByRole("textbox", { name: "Terminal input" }).focus();
	await page.keyboard.press("Escape");
	// Observe neutrality before typing again: Readline must finish interpreting
	// standalone Escape rather than consume the receipt command's slash as Alt+/.
	await assertRunningStable("bare Escape before receipt");
	const bareEscapeReceipt = await terminalProcessed("bare Escape");
	await assertRunningStable("bare Escape");
	await command("/native-interrupt");
	await projection("Interrupted", initialReview, initialNeedsInput);
	await command("/new-turn after native interrupt");
	await projection("Running", initialReview - 1, initialNeedsInput);
	await command("/needs-input cancel before provider completion");
	await projection("Waiting for approval", initialReview - 1, initialNeedsInput + 1);
	await card.press("Enter");
	await page.getByRole("textbox", { name: "Terminal input" }).focus();
	await page.keyboard.press("Escape");
	await projection("Response sent", initialReview, initialNeedsInput);
	await command("/needs-input-auto provider policy approved");
	await projection("Waiting for approval", initialReview - 1, initialNeedsInput + 1);
	await projection("Running", initialReview - 1, initialNeedsInput);
	await command("/approval-overlay");
	await projection("Waiting for approval", initialReview - 1, initialNeedsInput + 1);
	await card.press("Enter");
	await page.getByRole("textbox", { name: "Terminal input" }).focus();
	await page.keyboard.type("y");
	await projection("Response sent", initialReview, initialNeedsInput);
	await projection("Running", initialReview - 1, initialNeedsInput);
	await command("/turn-interrupted");
	await projection("Interrupted", initialReview, initialNeedsInput);
	await command("/new-turn historical redraw fence");
	await projection("Running", initialReview - 1, initialNeedsInput);
	const historicalRedrawReceipt = await terminalProcessed("historical interruption redraw", () =>
		command("/redraw-interruption-history"),
	);
	await page.screenshot({ path: join(driver.fixture.manifest.artifactDir, "historical-redraw-after-receipt.png") });
	await assertRunningStable("historical interruption redraw");
	await command("/turn-interrupted");
	await projection("Interrupted", initialReview, initialNeedsInput);
	await command("/review Packaged desktop lifecycle verified");
	await projection("Review", initialReview, initialNeedsInput);
	await card.press("Enter");
	await writeJsonAtomic(join(driver.fixture.manifest.artifactDir, "lifecycle-coverage.json"), {
		taskId,
		nativeInterrupt: true,
		bareEscapeNeutral: true,
		responsePending: true,
		automaticPermission: true,
		overlayPermission: true,
		historicalRedrawFence: "packaged-inline-osc52-receipt-then-running-stable-negative-assertion",
		terminalProcessingReceipts: {
			initialClipboard: initialClipboardReceipt,
			bareEscape: bareEscapeReceipt,
			historicalRedraw: historicalRedrawReceipt,
		},
		subsequentCurrentInterruption: true,
	});
}
