import { copyFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { desktopResourcesPath } from "../../src/desktop-install/layout";
import { DesktopLabDriver } from "./desktop-driver";
import { prepareDesktopLabFixture } from "./desktop-fixture";
import { openDesktopPrimaryProject } from "./desktop-renderer-recovery";
import { assertWindowsDesktopInUse, finishWindowsDesktopLifecycle } from "./desktop-windows-fixture";

export async function runWindowsNativePaste(appPath: string, desktop: string): Promise<string> {
	if (
		process.platform !== "win32" ||
		process.env.CI ||
		!process.stdin.isTTY ||
		!process.stdout.isTTY ||
		!desktop ||
		desktop !== process.env.COMPUTERNAME
	) {
		throw new Error(
			"Physical paste requires a non-CI interactive Windows console and the explicitly chosen disposable computer name.",
		);
	}
	const fixture = await prepareDesktopLabFixture({ appPath, name: "windows-native-paste", showWindow: true });
	const { manifest, manifestPath } = fixture;
	const driver = new DesktopLabDriver(fixture);
	const abort = new AbortController();
	const interrupt = () => abort.abort(new Error("Physical paste interrupted."));
	const reject = (error: unknown) => abort.abort(error);
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", interrupt);
	process.on("unhandledRejection", reject);
	let failure: unknown;
	try {
		process.stdout.write(`Desktop evidence: ${manifestPath}\n`);
		await copyFile(
			join(desktopResourcesPath(manifest.appPath, "win32"), "runtime/bundle-manifest.json"),
			join(manifest.artifactDir, "native-paste-bundle-manifest.json"),
		);
		await copyFile(
			new URL("./windows-native-paste-probe.mjs", import.meta.url),
			join(fixture.config.projectPath, "native-paste-probe.mjs"),
		);
		const page = await driver.launch();
		await page.getByRole("button", { name: "Settings", exact: true }).waitFor({ timeout: 45_000 });
		const onboarding = page.getByRole("dialog", { name: "Get started" });
		if (await onboarding.isVisible()) await page.keyboard.press("Escape");
		await openDesktopPrimaryProject(page);
		await driver.markReady();
		await assertWindowsDesktopInUse(fixture);
		await page.getByRole("button", { name: "Open terminal", exact: true }).click();
		await page.locator("textarea.xterm-helper-textarea:visible").waitFor({ timeout: 15_000 });
		process.stdout.write(
			"In the Agent Lab terminal, type node native-paste-probe.mjs and follow the Windows native smoke protocol.\n",
		);
		const receipt = "native-paste-receipt.json";
		const deadline = Date.now() + 180_000;
		while (true) {
			abort.signal.throwIfAborted();
			let raw: string | undefined;
			try {
				raw = await readFile(join(fixture.config.projectPath, receipt), "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (raw?.endsWith("\n")) {
				await copyFile(join(fixture.config.projectPath, receipt), join(manifest.artifactDir, receipt));
				const result = JSON.parse(raw) as {
					failure: string | null;
					checkpoint?: { submitsBeforeEnter?: number };
					submits?: number;
				};
				if (result.failure !== null || result.checkpoint?.submitsBeforeEnter !== 0 || result.submits !== 1)
					throw new Error(result.failure ?? "Probe did not pass.");
				await driver.inspect("native-paste-completed");
				break;
			}
			if (Date.now() >= deadline)
				throw new Error("No complete physical paste receipt before the operator deadline.");
			await delay(250, undefined, { signal: abort.signal });
		}
	} catch (error) {
		failure = error;
		throw error;
	} finally {
		try {
			await driver.stop(failure);
		} finally {
			process.removeListener("SIGINT", interrupt);
			process.removeListener("SIGTERM", interrupt);
			process.removeListener("unhandledRejection", reject);
		}
	}
	await finishWindowsDesktopLifecycle(fixture);
	await rm(fixture.config.tempRoot, { recursive: true, force: true });
	return manifestPath;
}
