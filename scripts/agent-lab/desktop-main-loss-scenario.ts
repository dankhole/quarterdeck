import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Page } from "playwright-core";
import { z } from "zod";

import { DesktopLabDriver } from "./desktop-driver";
import { projectDesktopFakeReadiness } from "./desktop-fake-readiness";
import type { DesktopLabFixture } from "./desktop-fixture";
import {
	assertDesktopMainLossRecovery,
	type DesktopMainLossError,
	type DesktopMainLossProof,
	desktopMainLossHistoryMarker,
	proveDesktopMainProcessLoss,
	readDesktopMainLossHistory,
	readDesktopMainLossOwner,
} from "./desktop-main-loss";
import { listDesktopProcesses } from "./desktop-processes";
import {
	DesktopSavedFixtureSchema,
	isDesktopFileRecoveryCommittedEmpty,
	openDesktopPrimaryProject,
	readDesktopFileRecoveryEvidence,
} from "./desktop-renderer-recovery";
import { readDesktopTaskSession } from "./desktop-session-evidence";
import { DesktopProcessEvidenceSchema } from "./desktop-types";
import { readFakeInvocationReceipt } from "./fake-invocation-receipt";
import { writeJsonAtomic } from "./paths";

/** The concrete driver gains this narrow lifecycle boundary; no fixture preparation is repeated. */
export interface DesktopMainLossRetirement {
	observeMainLossProof: DesktopLabDriver["observeMainLossProof"];
	retainMainLossProcesses(evidence: DesktopMainLossProof | DesktopMainLossError): void;
	retireAfterMainLoss(proof: DesktopMainLossProof): Promise<DesktopLabFixture>;
}

async function waitFor<T>(read: () => Promise<T | null>, label: string, timeoutMs: number): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	do {
		const value = await read();
		if (value !== null) return value;
		if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	throw new Error(`Desktop main-loss scenario timed out waiting for ${label}.`);
}

/**
 * The caller's handlers/finally must always stop its current cleanup owner.
 * We register the replacement synchronously before launch can fail and leave final graceful Quit to that caller.
 */
export async function exerciseDesktopMainLoss(
	page: Page,
	driver: DesktopLabDriver & DesktopMainLossRetirement,
	taskId: string,
	options: { setCleanupOwner: (driver: DesktopLabDriver) => void },
): Promise<{
	driver: DesktopLabDriver;
	page: Page;
	proof: DesktopMainLossProof;
	recovery: ReturnType<typeof assertDesktopMainLossRecovery>;
}> {
	const fixture = driver.fixture;
	const marker = desktopMainLossHistoryMarker(fixture, taskId);
	const input = page.getByRole("textbox", { name: "Terminal input" });
	await input.waitFor({ state: "visible" });
	await input.focus();
	await page.keyboard.type(`/progress ${marker}`);
	await page.keyboard.press("Enter");
	await waitFor(
		async () => {
			try {
				return await readDesktopMainLossHistory(fixture, taskId);
			} catch {
				return null;
			}
		},
		"the exact synthetic progress history",
		25_000,
	);
	await page.keyboard.type("/review Packaged main-loss conversation prepared");
	await page.keyboard.press("Enter");
	const session = await waitFor(
		async () => {
			const current = await readDesktopTaskSession(fixture.config.stateHome, taskId);
			return current?.state === "awaiting_review" &&
				current.reviewReason === "hook" &&
				projectDesktopFakeReadiness(current, taskId)
				? current
				: null;
		},
		"the current completed fake launch",
		25_000,
	);
	await driver.inspect("main-loss-before");
	const savedArtifact = await readFile(join(fixture.manifest.artifactDir, "renderer-recovery.json"), "utf8");
	if (savedArtifact.length > 128 * 1024) throw new Error("Saved fixture evidence exceeds its bound.");
	const { savedFixture } = z.object({ savedFixture: DesktopSavedFixtureSchema }).parse(JSON.parse(savedArtifact));
	const target = { ...savedFixture, projectPath: fixture.config.projectPath };
	const proof = await driver.observeMainLossProof(async (signalMain) => {
		const evidence = await readDesktopFileRecoveryEvidence(page, target);
		const sourceMatches =
			createHash("sha256")
				.update(await readFile(join(target.projectPath, "example.ts")))
				.digest("hex") === target.contentSha256;
		await writeJsonAtomic(join(fixture.manifest.artifactDir, "main-loss-file-recovery-before-proof.json"), {
			observation: "renderer-observed-before-proof",
			savedFixture,
			evidence,
			sourceMatches,
		});
		if (
			!sourceMatches ||
			!isDesktopFileRecoveryCommittedEmpty(evidence) ||
			evidence.recoveryStateBefore !== "ready" ||
			evidence.recoveryState !== "ready" ||
			evidence.unsavedBadgeVisible !== false
		)
			throw new Error(
				"Main-loss proof requires the explicitly saved fixture absent from acknowledged committed IndexedDB recovery storage.",
			);
		return proveDesktopMainProcessLoss(fixture, { taskId, session, signalMain });
	});
	const nextFixture = await driver.retireAfterMainLoss(proof);
	const replacement = new DesktopLabDriver(nextFixture);
	options.setCleanupOwner(replacement);
	const replacementPage = await replacement.launch();
	const replacementStorage = await readDesktopFileRecoveryEvidence(replacementPage, target);
	const replacementSourceMatches =
		createHash("sha256")
			.update(await readFile(join(target.projectPath, "example.ts")))
			.digest("hex") === target.contentSha256;
	await writeJsonAtomic(join(nextFixture.manifest.artifactDir, "main-loss-file-recovery-after-replacement.json"), {
		observation: "renderer-observed-before-settings",
		savedFixture,
		evidence: replacementStorage,
		sourceMatches: replacementSourceMatches,
	});
	if (
		!replacementSourceMatches ||
		!isDesktopFileRecoveryCommittedEmpty(replacementStorage) ||
		replacementStorage.recoveryState === "error" ||
		replacementStorage.recoveryStateBefore === "error"
	)
		throw new Error(
			"Replacement renderer did not prove the explicitly saved fixture absent from the same committed IndexedDB snapshot.",
		);
	let latestReadyStorage = replacementStorage;
	const retainReadyObservation = () =>
		writeJsonAtomic(join(nextFixture.manifest.artifactDir, "main-loss-file-recovery-after-ready.json"), {
			observation: "renderer-observed-after-controller-acknowledgement",
			savedFixture,
			evidence: latestReadyStorage,
		});
	try {
		await waitFor(
			async () => {
				latestReadyStorage = await readDesktopFileRecoveryEvidence(replacementPage, target);
				if (
					!isDesktopFileRecoveryCommittedEmpty(latestReadyStorage) ||
					latestReadyStorage.recoveryState === "error" ||
					latestReadyStorage.recoveryStateBefore === "error"
				)
					throw new Error(
						"Replacement recovery storage became uninitialized, unreadable or nonempty before acknowledgement.",
					);
				return latestReadyStorage.recoveryStateBefore === "ready" &&
					latestReadyStorage.recoveryState === "ready" &&
					latestReadyStorage.unsavedBadgeVisible === false
					? latestReadyStorage
					: null;
			},
			"replacement recovery controller's committed empty acknowledgement",
			25_000,
		);
	} catch (error) {
		await retainReadyObservation().catch(() => {});
		throw error;
	}
	await retainReadyObservation();

	try {
		await replacementPage
			.getByRole("button", { name: "Settings", exact: true })
			.waitFor({ state: "visible", timeout: 45_000 });
	} catch (error) {
		try {
			await writeJsonAtomic(join(nextFixture.manifest.artifactDir, "main-loss-file-recovery-settings-failed.json"), {
				observation: "renderer-observed-after-settings-failure",
				savedFixture,
				evidence: await readDesktopFileRecoveryEvidence(replacementPage, target),
			});
		} catch {
			// Preserve the original product-readiness failure if its diagnostic cannot be retained.
		}
		throw error;
	}
	const onboarding = replacementPage.getByRole("dialog", { name: "Get started" });
	if (await onboarding.isVisible()) await replacementPage.keyboard.press("Escape");
	await openDesktopPrimaryProject(replacementPage);
	await replacement.markReady();
	await replacementPage.locator(`[data-task-id="${taskId}"]`).first().waitFor({ state: "visible", timeout: 45_000 });
	const recovery = await waitFor(
		async () => {
			const current = await readDesktopTaskSession(nextFixture.config.stateHome, taskId);
			const launch = current && projectDesktopFakeReadiness(current, taskId);
			if (!current || !launch || launch.sessionInstanceId === proof.session.sessionInstanceId) return null;
			const invocation = await readFakeInvocationReceipt({
				stateHome: nextFixture.config.stateHome,
				sessionInstanceId: launch.sessionInstanceId,
			});
			if (!invocation) return null;
			if (current.state !== "awaiting_review" || current.reviewReason !== "hook")
				throw new Error("Main-loss recovery did not preserve completed Review semantics.");
			return assertDesktopMainLossRecovery(proof, {
				fixture: nextFixture,
				evidence: DesktopProcessEvidenceSchema.parse(
					JSON.parse(await readFile(nextFixture.config.processEvidencePath, "utf8")) as unknown,
				),
				session: current,
				invocation,
				history: await readDesktopMainLossHistory(nextFixture, taskId),
				processes: await listDesktopProcesses(),
				owner: await readDesktopMainLossOwner(nextFixture.config.stateHome),
			});
		},
		"targeted recovery in the same fixture with a new owned PTY and native hook",
		90_000,
	);
	await replacement.inspect("main-loss-recovered");
	await writeJsonAtomic(join(nextFixture.manifest.artifactDir, "main-loss-proof.json"), {
		before: proof,
		after: recovery,
		sameFixture: true,
		reviewPreserved: true,
	});
	return { driver: replacement, page: replacementPage, proof, recovery };
}
