import { execFile } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { desktopBootstrapPath } from "../../src/desktop-install/layout.js";
import type { DesktopLabDriver } from "./desktop-driver";
import { collectOwnedDesktopProcesses, listDesktopProcesses } from "./desktop-processes";
import { writeJsonAtomic } from "./paths";

// Narrow test port keeps the root harness independent of desktop dependencies.
// Methods/options are checked against the pinned Electron declaration file.
interface CrashModule {
	app: { setPath: (name: "crashDumps", path: string) => void };
	crashReporter: { start: (options: { uploadToServer: false; productName: string }) => void };
}
const execute = promisify(execFile);

/** Exercise the real handler without generating a crash, uploading a report, or
 * changing Chromium's sandbox. The native lab-only probe checks actual OS jobs. */
export async function proveWindowsChromiumCustody(driver: DesktopLabDriver): Promise<void> {
	const fixture = driver.fixture,
		installation = fixture.windowsInstallation;
	if (!installation) throw new Error("Windows custody requires its native isolated installation.");
	const dumps = join(fixture.config.tempRoot, "crashpad-evidence");
	await mkdir(dumps);
	await driver.app.evaluate(({ app, crashReporter }: CrashModule, path) => {
		app.setPath("crashDumps", path);
		crashReporter.start({ uploadToServer: false, productName: "Quarterdeck Agent Lab" });
	}, dumps);
	let snapshot = await listDesktopProcesses();
	const deadline = Date.now() + 10000;
	while (!snapshot.some((row) => row.command.includes("--type=crashpad-handler")) && Date.now() < deadline) {
		await new Promise((accept) => setTimeout(accept, 100));
		snapshot = await listDesktopProcesses();
	}
	const main = snapshot.find((row) => row.pid === fixture.manifest.mainPid);
	if (!main) throw new Error("Chromium custody lost its original native main.");
	const owned = collectOwnedDesktopProcesses(snapshot, [main.parentPid]);
	const chromium = owned.filter((row) =>
		/--type=(?:renderer|gpu-process|utility|crashpad-handler)(?:\s|$)/u.test(row.command),
	);
	if (
		!chromium.some((row) => row.command.includes("--type=crashpad-handler")) ||
		!chromium.some((row) => row.command.includes("--type=renderer"))
	)
		throw new Error("The packaged renderer and crashpad handler were not observed.");
	const bootstrap = desktopBootstrapPath(fixture.manifest.appPath, "win32");
	const member = async (id: string, pid: number) => {
		try {
			await execute(bootstrap, ["--quarterdeck-test-job-member", id, String(pid)], {
				windowsHide: true,
				timeout: 5000,
				maxBuffer: 4096,
			});
			return true;
		} catch {
			return false;
		}
	};
	const markers = (await readdir(installation.metadataRoot)).filter((name) =>
		name.startsWith("admission.lock.launch-"),
	);
	let job: string | undefined;
	for (const name of markers) {
		const id = name.slice("admission.lock.launch-".length);
		if (await member(id, main.parentPid)) {
			job = id;
			break;
		}
	}
	if (!job) throw new Error("The original native launch job could not be identified.");
	for (const child of chromium)
		if (!(await member(job, child.pid)))
			throw new Error("A Chromium or crashpad process escaped native installation custody.");
	await writeJsonAtomic(join(fixture.manifest.artifactDir, "windows-chromium-custody.json"), {
		job,
		uploadToServer: false,
		sandboxUnchanged: true,
		processes: chromium.map((row) => ({ pid: row.pid, startedAt: row.startedAt, member: true })),
	});
}
