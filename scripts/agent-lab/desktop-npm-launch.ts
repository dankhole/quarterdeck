import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { z } from "zod";
import { createDesktopInstallationService } from "../../src/desktop-install/index.js";
import { runDesktopInstallCommand } from "../../src/desktop-install/macos.js";
import { managedDesktopInstallationReceiptSchema } from "../../src/desktop-install/receipt.js";
import type { DesktopInstallation } from "../../src/desktop-install/types.js";
import { getDesktopDiagnosticJournalState } from "../../src/diagnostics/desktop-diagnostics.js";
import { readDiagnosticJournal } from "../../src/diagnostics/journal.js";
import { discoverRuntimeDiagnosticInstances } from "../../src/diagnostics/runtime-instance.js";
import { desktopLaunchRequestSchema } from "../../src/shared/desktop-launch-contract.js";
import type { DesktopLabDriver } from "./desktop-driver";
import { type DesktopLabFixture, resolveDesktopAppExecutable } from "./desktop-fixture";
import { writeJsonAtomic } from "./paths";

const bundleSchema = z.object({ version: z.string(), arch: z.enum(["arm64", "x64"]), sourceSha: z.string() });
const projectIndexSchema = z.object({
	entries: z.record(z.string(), z.object({ projectId: z.string(), repoPath: z.string() })),
});

interface NpmMainEvaluationModule {
	app: {
		on: (
			event: "second-instance",
			listener: (event: unknown, args: unknown, cwd: unknown, data: unknown) => void,
		) => void;
		__quarterdeckLabNpmLaunchPayloads?: unknown[];
	};
	BrowserWindow: {
		getAllWindows: () => Array<{ id: number; webContents: { id: number; getOSProcessId: () => number } }>;
	};
}

export interface DesktopNpmLaunchPreparation {
	sourceAppPath: string;
	sourceSha: string;
	primary: DesktopInstallation;
	alternate: DesktopInstallation;
}

function requestFor(installation: DesktopInstallation, fixture: DesktopLabFixture, projectPath: string) {
	return desktopLaunchRequestSchema.parse({
		schemaVersion: 1,
		version: installation.version,
		appPath: installation.appPath,
		arch: installation.arch,
		buildId: installation.buildId,
		appAsarSha256: installation.appAsarSha256,
		stateHome: fixture.config.stateHome,
		projectPath,
	});
}

/** Import through the real installer, redirecting its effect boundary only to private lab storage. */
export async function prepareDesktopNpmLaunch(fixture: DesktopLabFixture): Promise<DesktopNpmLaunchPreparation> {
	const sourceAppPath = fixture.manifest.appPath;
	const bundle = bundleSchema.parse(
		JSON.parse(await readFile(join(sourceAppPath, "Contents/Resources/runtime/bundle-manifest.json"), "utf8")),
	);
	fixture.managedInstallationRoots = [];
	const installations: DesktopInstallation[] = [];
	let downloadAttempts = 0;
	for (const label of ["primary", "alternate"]) {
		const managedRoot = join(fixture.config.tempRoot, `npm-managed-${label}`);
		await mkdir(managedRoot, { mode: 0o700 });
		fixture.managedInstallationRoots.push(managedRoot);
		const service = createDesktopInstallationService({
			platform: process.platform,
			arch: bundle.arch,
			managedRoot,
			runCommand: runDesktopInstallCommand,
			download: async () => {
				downloadAttempts += 1;
				throw new Error("The local packaged npm scenario must never download an app.");
			},
		});
		const imported = await service.ensureDesktopInstallation({ version: bundle.version, from: sourceAppPath });
		const selected = await service.ensureDesktopInstallation({ version: bundle.version });
		const identity: Array<keyof DesktopInstallation> = [
			"appPath",
			"installId",
			"version",
			"arch",
			"buildId",
			"appAsarSha256",
			"source",
			"receiptPath",
		];
		if (identity.some((key) => imported[key] !== selected[key]))
			throw new Error("Offline selection did not reuse the actual imported installation.");
		installations.push(selected);
	}
	const [primary, alternate] = installations;
	if (!primary || !alternate) throw new Error("The npm scenario did not prepare both isolated installations.");
	const application = await resolveDesktopAppExecutable(primary.appPath);
	Object.assign(fixture.manifest, application);
	const requestedProject = fixture.environment.QUARTERDECK_AGENT_LAB_ADDITIONAL_PROJECT;
	if (!requestedProject || requestedProject === fixture.config.projectPath)
		throw new Error("The npm initial request must differ from the synthetic runtime cwd project.");
	fixture.launchRequest = requestFor(primary, fixture, requestedProject);
	const preparation = { sourceAppPath, sourceSha: bundle.sourceSha, primary, alternate };
	await writeJsonAtomic(join(fixture.manifest.artifactDir, "npm-launch-installation.json"), {
		...preparation,
		offlineSelectionsRevalidated: true,
		downloadAttempts,
		initialRequest: fixture.launchRequest,
		receipts: await Promise.all(
			installations.map(async (installation) =>
				managedDesktopInstallationReceiptSchema.parse(JSON.parse(await readFile(installation.receiptPath, "utf8"))),
			),
		),
	});
	await writeJsonAtomic(fixture.manifestPath, fixture.manifest);
	return preparation;
}

async function waitFor(condition: () => Promise<boolean>, label: string): Promise<void> {
	const deadline = Date.now() + 25_000;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Packaged npm launch timed out waiting for ${label}.`);
}

async function selectedDesktopNpmProject(
	page: Page,
	fixture: DesktopLabFixture,
	projectPath: string,
): Promise<string | null> {
	const index = projectIndexSchema.parse(
		JSON.parse(await readFile(join(fixture.config.stateHome, "projects/index.json"), "utf8")),
	);
	const matches = Object.values(index.entries).filter((entry) => entry.repoPath === projectPath);
	const project = matches[0];
	return matches.length === 1 &&
		project &&
		new URL(page.url()).pathname === `/${encodeURIComponent(project.projectId)}`
		? project.projectId
		: null;
}

/** No picker fallback: the packaged initial argument itself must select the synthetic repository. */
export async function assertDesktopNpmInitialProject(page: Page, fixture: DesktopLabFixture): Promise<string> {
	const requestedProject = fixture.launchRequest?.projectPath;
	if (!requestedProject || requestedProject === fixture.config.projectPath)
		throw new Error("The npm initial request must differ from the synthetic runtime cwd project.");
	let projectId: string | null = null;
	await waitFor(async () => {
		projectId = await selectedDesktopNpmProject(page, fixture, requestedProject);
		return projectId !== null && (await page.locator("section.kb-board").isVisible());
	}, "initial typed project handoff");
	if (!projectId) throw new Error("Initial npm project identity was unavailable.");
	return projectId;
}

/** Exercise actual OS singleton delivery while retaining the original document and helper. */
export async function exerciseDesktopNpmLaunch(
	page: Page,
	driver: DesktopLabDriver,
	preparation: DesktopNpmLaunchPreparation,
) {
	const fixture = driver.fixture;
	const initialProjectId = await assertDesktopNpmInitialProject(page, fixture);
	const initialProjectPath = fixture.launchRequest?.projectPath;
	if (!initialProjectPath) throw new Error("The npm scenario lost its initial typed request.");
	const documentNonce = randomUUID();
	await page.evaluate((nonce) => Reflect.set(globalThis, "__quarterdeckLabNpmDocumentNonce", nonce), documentNonce);
	await driver.app.evaluate(({ app }: NpmMainEvaluationModule) => {
		app.__quarterdeckLabNpmLaunchPayloads = [];
		app.on("second-instance", (_event, _args, _cwd, data) => {
			if ((app.__quarterdeckLabNpmLaunchPayloads?.length ?? 0) < 4)
				app.__quarterdeckLabNpmLaunchPayloads?.push(data);
		});
	});
	const readDocument = () =>
		driver.app.evaluate(({ BrowserWindow }: NpmMainEvaluationModule) => {
			const windows = BrowserWindow.getAllWindows();
			const window = windows[0];
			if (windows.length !== 1 || !window) throw new Error("Npm launch must retain one isolated product document.");
			return {
				windowId: window.id,
				webContentsId: window.webContents.id,
				rendererPid: window.webContents.getOSProcessId(),
			};
		});
	const documentBefore = await readDocument();
	const readCount = await driver.observeSecondInstances();
	const secondProjectPath = fixture.config.projectPath;
	const secondRequest = requestFor(preparation.primary, fixture, secondProjectPath);
	const secondLaunch = await driver.proveSecondLaunch({
		readSecondInstanceCount: readCount,
		launchRequest: secondRequest,
	});
	let secondProjectId: string | null = null;
	await waitFor(async () => {
		secondProjectId = await selectedDesktopNpmProject(page, fixture, secondProjectPath);
		return secondProjectId !== null;
	}, "same-app second typed project handoff");
	await driver.inspect("npm-second-project");
	const alternateRequest = requestFor(preparation.alternate, fixture, initialProjectPath);
	const alternateLaunch = await driver.proveSecondLaunch({
		readSecondInstanceCount: readCount,
		launchRequest: alternateRequest,
		selectedApplication: await resolveDesktopAppExecutable(preparation.alternate.appPath),
	});
	// Admission/navigation normally completes immediately. Observe the unchanged current
	// project after actual additionalData arrived; focused native tests own refusal wording.
	await page.waitForTimeout(1_000);
	if ((await selectedDesktopNpmProject(page, fixture, secondProjectPath)) !== secondProjectId)
		throw new Error("A mismatched installation request changed the selected project.");
	const documentAfter = await readDocument();
	if (
		JSON.stringify(documentBefore) !== JSON.stringify(documentAfter) ||
		(await page.evaluate(() => Reflect.get(globalThis, "__quarterdeckLabNpmDocumentNonce"))) !== documentNonce
	)
		throw new Error("Npm project handoff replaced the original renderer document.");
	const payloads = await driver.app.evaluate(
		({ app }: NpmMainEvaluationModule) => app.__quarterdeckLabNpmLaunchPayloads ?? [],
	);
	const delivered = z.array(z.strictObject({ quarterdeckLaunch: desktopLaunchRequestSchema })).parse(payloads);
	if (
		JSON.stringify(delivered.map((payload) => payload.quarterdeckLaunch)) !==
		JSON.stringify([secondRequest, alternateRequest])
	)
		throw new Error("The actual singleton payloads did not match both typed requests.");
	let updater: ReturnType<typeof getDesktopDiagnosticJournalState> = null;
	await waitFor(async () => {
		const instances = await discoverRuntimeDiagnosticInstances(fixture.config.stateHome);
		const desktop = instances.find(
			(instance) =>
				instance.descriptor.processKind === "desktop" && instance.descriptor.pid === fixture.manifest.mainPid,
		);
		if (!desktop) return false;
		updater = getDesktopDiagnosticJournalState(
			(await readDiagnosticJournal(desktop.descriptor.journalDirectory)).records,
		);
		return updater?.state.update.phase === "disabled";
	}, "native updater disabled in the isolated marked app");
	const proof = {
		initialProjectId,
		secondProjectId,
		initialRequest: fixture.launchRequest,
		secondLaunch,
		alternateLaunch,
		delivered,
		alternateInstallationDidNotNavigate: true,
		documentBefore,
		documentAfter,
		sameDocument: true,
		updater,
		updaterScope:
			"Synthetic launch disables updates before the managed receipt policy; focused tests prove npm_managed.",
	};
	await writeJsonAtomic(join(fixture.manifest.artifactDir, "npm-launch-proof.json"), proof);
	await driver.inspect("npm-launch-completed");
	return proof;
}
