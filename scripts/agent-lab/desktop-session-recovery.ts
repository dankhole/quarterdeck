import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "playwright-core";
import { type RuntimeOwnershipClaim, runtimeOwnershipClaimSchema } from "../../src/core/api/runtime-management.js";
import { runtimeTaskSessionSummarySchema } from "../../src/core/api/task-session.js";
import { isFileSystemPathWithin } from "../../src/core/path-comparison.js";
import { readRuntimeBootIdentity } from "../../src/server/runtime-boot-identity.js";
import { discoverRuntimeOwner, readPriorRuntimeOwnershipClaims } from "../../src/server/runtime-ownership.js";
import { readAcknowledgedRuntimeRecoveryBoundary } from "../../src/server/runtime-recovery-acknowledgement.js";
import type { DesktopLabDriver } from "./desktop-driver";
import type { DesktopLabFixture } from "./desktop-fixture";
import { AGENT_LAB_REPO_ROOT, writeJsonAtomic } from "./paths";

const executeFile = promisify(execFile);
const ERROR_URL = "app://quarterdeck/__desktop/error";

/** Admission is exclusive and runs before any fixture, provider or app access. */
export function validateDesktopSessionRecoverySelection(options: {
	includeAgent?: boolean;
	showWindow?: boolean;
	agentMode?: string;
	npmLaunch?: boolean;
	manualShells?: boolean;
	nativeExperience?: boolean;
	performance?: boolean;
	mainLoss?: boolean;
}): void {
	if (
		options.includeAgent !== false ||
		options.showWindow ||
		(options.agentMode ?? "fake") !== "fake" ||
		options.npmLaunch ||
		options.manualShells ||
		options.nativeExperience ||
		options.performance ||
		options.mainLoss
	)
		throw new Error(
			"Desktop session recovery requires --no-agent, a hidden fake-provider fixture, and no other scenario.",
		);
}

interface RecoveryDialogOptions {
	title?: string;
	message: string;
	detail?: string;
	buttons?: string[];
	defaultId?: number;
	cancelId?: number;
}
type RecoveryDialog = (options: RecoveryDialogOptions) => number | Promise<number>;
interface RecoveryDialogObservation {
	title: string;
	message: string;
	buttons: string[];
	defaultId: number;
	cancelId: number;
	response: number;
}
interface RecoveryNativeModule {
	app: {
		isPackaged: boolean;
		getAppPath(): string;
		getPath(name: "userData"): string;
		__quarterdeckLabSessionRecoveryDialog?: RecoveryDialog;
		__quarterdeckLabSessionRecoveryObservation?: {
			original?: RecoveryDialog;
			responses: number[];
			dialogs: RecoveryDialogObservation[];
		};
	};
	BrowserWindow: {
		getAllWindows(): Array<{ isVisible(): boolean; isFocused(): boolean; webContents: { getURL(): string } }>;
	};
}

export interface DesktopSessionRecoverySeed {
	claim: RuntimeOwnershipClaim;
	claimText: string;
	dirtyText: string;
	sessionsPath: string;
	sessionsText: string;
}

async function optionalEntries(directory: string): Promise<string[]> {
	try {
		return (await readdir(directory)).filter((entry) => !entry.startsWith("."));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

async function recoveryHistory(stateHome: string): Promise<RuntimeOwnershipClaim[]> {
	const owner = await discoverRuntimeOwner(stateHome);
	if (!owner) throw new Error("Desktop session recovery has no immutable ownership history.");
	const prior = await readPriorRuntimeOwnershipClaims(stateHome, owner.claim.generation);
	return [...prior.map((entry) => entry.claim), owner.claim];
}

/** A real exited fixture child establishes trustworthy birth/boot evidence without a provider. */
export async function prepareDesktopSessionRecovery(fixture: DesktopLabFixture): Promise<DesktopSessionRecoverySeed> {
	const home = fixture.config.stateHome;
	if (
		!isFileSystemPathWithin(fixture.config.tempRoot, home) ||
		fixture.environment.QUARTERDECK_STATE_HOME !== home ||
		fixture.manifest.stateHome !== home ||
		(await discoverRuntimeOwner(home)) !== null
	)
		throw new Error("Desktop session recovery refuses a state home outside its new isolated fixture.");
	const child = await executeFile(
		process.execPath,
		["--import", "tsx", join(AGENT_LAB_REPO_ROOT, "scripts/agent-lab/desktop-session-recovery-child.ts")],
		{
			cwd: AGENT_LAB_REPO_ROOT,
			env: { ...fixture.environment, QUARTERDECK_DESKTOP_RECOVERY_SEED_HOME: home },
			timeout: 15_000,
			maxBuffer: 16_384,
		},
	);
	const claim = runtimeOwnershipClaimSchema.parse(JSON.parse(child.stdout) as unknown);
	const owner = await discoverRuntimeOwner(home);
	if (
		!claim.bootIdentity ||
		claim.bootIdentity !== (await readRuntimeBootIdentity()) ||
		claim.purpose !== "runtime" ||
		claim.previousGeneration !== null ||
		owner?.claim.generation !== claim.generation ||
		owner.processState !== "dead" ||
		owner.released
	)
		throw new Error("Desktop session recovery requires an exited, same-boot, unreleased fixture owner.");
	const root = join(home, "runtime-ownership");
	const claimText = await readFile(join(root, "first-owner.json"), "utf8");
	const dirtyText = await readFile(join(root, "custody-dirty", `${claim.generation}.json`), "utf8");
	if (claimText !== dirtyText) throw new Error("Desktop recovery fixture did not retain its exact dirty claim.");
	// An unregistered saved-session fixture proves maintenance does not rewrite provider resume evidence.
	const sessionsPath = join(home, "projects", "desktop-session-recovery-fixture", "sessions.json");
	await writeJsonAtomic(sessionsPath, {
		"synthetic-retained-session": runtimeTaskSessionSummarySchema.parse({
			taskId: "synthetic-retained-session",
			agentId: "codex",
			sessionInstanceId: "synthetic-retained-instance",
			pid: null,
			resumeSessionId: "synthetic-retained-provider-session",
			state: "awaiting_review",
			startedAt: 1,
			updatedAt: 1,
			lastOutputAt: null,
			reviewReason: "hook",
			exitCode: null,
		}),
	});
	return { claim, claimText, dirtyText, sessionsPath, sessionsText: await readFile(sessionsPath, "utf8") };
}

async function assertOriginalEvidence(fixture: DesktopLabFixture, seed: DesktopSessionRecoverySeed): Promise<void> {
	const root = join(fixture.config.stateHome, "runtime-ownership");
	if (
		(await readFile(join(root, "first-owner.json"), "utf8")) !== seed.claimText ||
		(await readFile(join(root, "custody-dirty", `${seed.claim.generation}.json`), "utf8")) !== seed.dirtyText ||
		(await readFile(seed.sessionsPath, "utf8")) !== seed.sessionsText ||
		(await optionalEntries(join(root, "released"))).includes(`${seed.claim.generation}.json`)
	)
		throw new Error("Desktop recovery changed original custody, release, or saved-session evidence.");
}

async function waitForDialogCount(driver: DesktopLabDriver, count: number): Promise<RecoveryDialogObservation[]> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const dialogs = await driver.app.evaluate(
			({ app }: RecoveryNativeModule) => app.__quarterdeckLabSessionRecoveryObservation?.dialogs ?? [],
		);
		if (dialogs.length === count) return dialogs;
		if (dialogs.length > count) throw new Error("Desktop recovery showed an unexpected confirmation dialog.");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("Desktop session recovery did not request its native confirmation.");
}

/** Check only blocked startup, Cancel, acknowledgement and ordinary startup retry. */
export async function exerciseDesktopSessionRecovery(
	page: Page,
	driver: DesktopLabDriver,
	seed: DesktopSessionRecoverySeed,
): Promise<void> {
	const fixture = driver.fixture;
	const root = join(fixture.config.stateHome, "runtime-ownership");
	const receiptsDirectory = join(root, "recovery-acknowledged");
	const recover = page.getByRole("link", { name: "Recover sessions…", exact: true });
	const activateRecovery = () =>
		page.evaluate(
			({ errorUrl, actionUrl }) => {
				const browser = globalThis as unknown as {
					location: { href: string };
					document: {
						querySelectorAll(
							selector: "a",
						): Iterable<{ href: string; textContent: string | null; click(): void }>;
					};
				};
				const links = [...browser.document.querySelectorAll("a")].filter(
					(link) => link.href === actionUrl && link.textContent?.trim() === "Recover sessions…",
				);
				const link = links[0];
				if (browser.location.href !== errorUrl || links.length !== 1 || !link)
					throw new Error("Recovery action is unavailable on its exact startup document.");
				// Electron prevents this action's navigation. Dispatch the DOM action without
				// asking Playwright to wait for a navigation that never commits.
				link.click();
			},
			{ errorUrl: ERROR_URL, actionUrl: "app://quarterdeck/__desktop/recover" },
		);
	await recover.waitFor({ state: "visible", timeout: 45_000 });
	if (page.url() !== ERROR_URL || (await page.getByRole("button", { name: "Settings", exact: true }).isVisible()))
		throw new Error("Desktop session recovery did not begin on its blocked startup document.");
	const blockedHistory = await recoveryHistory(fixture.config.stateHome);
	const blockedClaim = blockedHistory.at(-1);
	if (!blockedClaim || blockedClaim.previousGeneration !== seed.claim.generation || blockedClaim.purpose !== "runtime")
		throw new Error("Blocked desktop startup did not retain the seeded custody predecessor.");
	await assertOriginalEvidence(fixture, seed);
	if ((await optionalEntries(receiptsDirectory)).length !== 0)
		throw new Error("Blocked desktop startup unexpectedly acknowledged recovery.");
	await driver.inspect("session-recovery-blocked");
	await driver.app.evaluate(
		({ app, BrowserWindow }: RecoveryNativeModule, binding) => {
			const windows = BrowserWindow.getAllWindows();
			const window = windows[0];
			if (
				!app.isPackaged ||
				app.getAppPath() !== binding.appPath ||
				app.getPath("userData") !== binding.userDataPath ||
				windows.length !== 1 ||
				!window ||
				window.webContents.getURL() !== binding.errorUrl ||
				window.isVisible() ||
				window.isFocused() ||
				app.__quarterdeckLabSessionRecoveryObservation
			)
				throw new Error("Recovery confirmation refuses another app, document, or visible window.");
			const state = {
				original: app.__quarterdeckLabSessionRecoveryDialog,
				responses: [0, 1],
				dialogs: [] as RecoveryDialogObservation[],
			};
			app.__quarterdeckLabSessionRecoveryObservation = state;
			app.__quarterdeckLabSessionRecoveryDialog = (options) => {
				if (
					options.title !== "Recover sessions" ||
					options.message !== "Have prior agents and background commands stopped?" ||
					options.defaultId !== 0 ||
					options.cancelId !== 0 ||
					JSON.stringify(options.buttons) !== JSON.stringify(["Cancel", "Confirm Stopped and Recover"])
				)
					throw new Error("Recovery confirmation changed its explicit choice or safe default.");
				const response = state.responses.shift();
				if (response === undefined) throw new Error("Unexpected repeated recovery confirmation.");
				state.dialogs.push({
					title: options.title,
					message: options.message,
					buttons: options.buttons ?? [],
					defaultId: options.defaultId,
					cancelId: options.cancelId,
					response,
				});
				return response;
			};
		},
		{
			appPath: join(fixture.manifest.appPath, "Contents/Resources/app.asar"),
			userDataPath: fixture.config.userDataPath,
			errorUrl: ERROR_URL,
		},
	);
	let restorationFailure: Error | undefined;
	try {
		await activateRecovery();
		await waitForDialogCount(driver, 1);
		if (
			page.url() !== ERROR_URL ||
			(await page.getByRole("button", { name: "Settings", exact: true }).isVisible()) ||
			(await optionalEntries(receiptsDirectory)).length !== 0 ||
			JSON.stringify(await recoveryHistory(fixture.config.stateHome)) !== JSON.stringify(blockedHistory)
		)
			throw new Error("Cancelling desktop recovery changed admission or acknowledged prior custody.");
		await assertOriginalEvidence(fixture, seed);
		// The checks above establish Cancel semantics. Electron's prevented action URL
		// leaves Playwright's locator navigation pending until the product retry commits.
		await activateRecovery();
		const dialogs = await waitForDialogCount(driver, 2);
		await page.getByRole("button", { name: "Settings", exact: true }).waitFor({ state: "visible", timeout: 45_000 });
		const history = await recoveryHistory(fixture.config.stateHome);
		const boundary = await readAcknowledgedRuntimeRecoveryBoundary(
			fixture.config.stateHome,
			history,
			seed.claim.bootIdentity ?? null,
		);
		const maintenance = history.find((claim) => claim.generation === boundary);
		const receipts = await optionalEntries(receiptsDirectory);
		if (
			!boundary ||
			maintenance?.purpose !== "maintenance" ||
			maintenance.previousGeneration !== blockedClaim.generation ||
			maintenance.bootIdentity !== seed.claim.bootIdentity ||
			receipts.length !== 1 ||
			receipts[0] !== `${boundary}.json` ||
			history.at(-1)?.previousGeneration !== boundary
		)
			throw new Error("Confirmed recovery did not bind the exact predecessor history and ordinary retry.");
		const receiptPath = join(receiptsDirectory, `${boundary}.json`);
		const receiptStat = await lstat(receiptPath);
		if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || (receiptStat.mode & 0o077) !== 0)
			throw new Error("Desktop recovery acknowledgement is not a private ordinary file.");
		await assertOriginalEvidence(fixture, seed);
		await writeJsonAtomic(join(fixture.manifest.artifactDir, "session-recovery.json"), {
			seededClaim: seed.claim,
			blockedClaim,
			dialogs,
			cancelLeftBlocked: true,
			confirmationRequired: true,
			boundaryClaim: maintenance,
			receipt: JSON.parse(await readFile(receiptPath, "utf8")) as unknown,
			receiptPrivate: true,
			originalCustodyPreserved: true,
			savedSessionsSha256: createHash("sha256").update(seed.sessionsText).digest("hex"),
			savedSessionsPreserved: true,
			ordinaryStartupRetried: true,
			readyGeneration: history.at(-1)?.generation,
		});
	} finally {
		try {
			const dialogs = await driver.app.evaluate(({ app }: RecoveryNativeModule) => {
				const state = app.__quarterdeckLabSessionRecoveryObservation;
				if (state?.original) app.__quarterdeckLabSessionRecoveryDialog = state.original;
				else delete app.__quarterdeckLabSessionRecoveryDialog;
				delete app.__quarterdeckLabSessionRecoveryObservation;
				return state?.dialogs ?? [];
			});
			await writeJsonAtomic(join(fixture.manifest.artifactDir, "session-recovery-dialogs.json"), { dialogs });
		} catch (error) {
			restorationFailure = error instanceof Error ? error : new Error(String(error));
		}
	}
	if (restorationFailure) throw restorationFailure;
}
