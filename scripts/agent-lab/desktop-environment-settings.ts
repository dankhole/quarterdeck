import type { Page } from "playwright-core";
import {
	type DesktopEnvironmentBridge,
	desktopEnvironmentSnapshotSchema,
} from "../../src/shared/desktop-environment-contract";
import type { DesktopLabDriver } from "./desktop-driver";

async function readEnvironment(page: Page) {
	return desktopEnvironmentSnapshotSchema.parse(
		await page.evaluate(async () => {
			const bridge = Reflect.get(globalThis, "quarterdeckDesktopEnvironment") as
				| DesktopEnvironmentBridge
				| undefined;
			return (await bridge?.getSnapshot()) ?? null;
		}),
	);
}

async function waitForImportChoice(page: Page, enabled: boolean): Promise<void> {
	const checkbox = page.getByRole("checkbox", { name: "Import login-shell environment", exact: true });
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (
			(await readEnvironment(page)).preferences?.importLoginShellEnvironment === enabled &&
			(await checkbox.isEnabled()) &&
			(await checkbox.isChecked()) === enabled
		)
			return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("Desktop Settings did not persist the shell-import choice.");
}

/** Synthetic packaged proof of the real preload, native preference owner, and guarded refresh path. */
export async function exerciseDesktopEnvironmentSettings(page: Page, driver: DesktopLabDriver): Promise<void> {
	const initial = await readEnvironment(page);
	if (initial.ownership !== "owned" || initial.preferences?.importLoginShellEnvironment !== true)
		throw new Error("A new desktop fixture did not default to login-shell environment import.");

	const settings = page.getByRole("dialog", { name: "Settings", exact: true });
	const open = async (): Promise<void> => {
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		await settings.waitFor({ state: "visible" });
		await settings.getByRole("checkbox", { name: "Import login-shell environment", exact: true }).waitFor();
	};
	await open();
	await waitForImportChoice(page, true);
	const checkbox = settings.getByRole("checkbox", { name: "Import login-shell environment", exact: true });
	await checkbox.click();
	await waitForImportChoice(page, false);
	await settings.getByRole("button", { name: "Cancel", exact: true }).click();
	await open();
	await waitForImportChoice(page, false);
	await checkbox.click();
	await waitForImportChoice(page, true);
	await driver.inspect("environment-settings-saved");

	const generation = await page.evaluate(() => {
		const bridge = Reflect.get(globalThis, "quarterdeckDesktop") as { bootstrap: { runtimeGeneration: string } };
		return bridge.bootstrap.runtimeGeneration;
	});
	await settings.getByRole("button", { name: "Refresh Environment", exact: true }).click();
	await page.waitForFunction(
		(previous) => {
			const bridge = Reflect.get(globalThis, "quarterdeckDesktop") as
				| { bootstrap: { runtimeGeneration: string } }
				| undefined;
			return bridge && bridge.bootstrap.runtimeGeneration !== previous;
		},
		generation,
		{ timeout: 45_000 },
	);
	await page.getByRole("button", { name: "Settings", exact: true }).waitFor({ state: "visible" });
	const refreshed = await readEnvironment(page);
	if (refreshed.ownership !== "owned" || refreshed.appliedImportLoginShellEnvironment !== true)
		throw new Error("Guarded desktop refresh did not apply the saved environment choice.");
	await driver.inspect("environment-settings-refreshed");
}
