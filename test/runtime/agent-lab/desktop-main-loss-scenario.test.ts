import { createHash } from "node:crypto";
import type * as nodeFs from "node:fs/promises";
import { readFile } from "node:fs/promises";

import type { Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DesktopLabDriver } from "../../../scripts/agent-lab/desktop-driver";
import type { DesktopLabFixture } from "../../../scripts/agent-lab/desktop-fixture";
import type * as desktopMainLoss from "../../../scripts/agent-lab/desktop-main-loss";
import {
	assertDesktopMainLossRecovery,
	DesktopMainLossError,
	type DesktopMainLossProof,
	proveDesktopMainProcessLoss,
	readDesktopMainLossHistory,
	readDesktopMainLossOwner,
} from "../../../scripts/agent-lab/desktop-main-loss";
import {
	type DesktopMainLossRetirement,
	exerciseDesktopMainLoss,
} from "../../../scripts/agent-lab/desktop-main-loss-scenario";
import { listDesktopProcesses } from "../../../scripts/agent-lab/desktop-processes";
import type * as desktopRendererRecovery from "../../../scripts/agent-lab/desktop-renderer-recovery";
import {
	DESKTOP_FILE_RECOVERY_BACKEND,
	openDesktopPrimaryProject,
	readDesktopFileRecoveryEvidence,
} from "../../../scripts/agent-lab/desktop-renderer-recovery";
import { readDesktopTaskSession } from "../../../scripts/agent-lab/desktop-session-evidence";
import { readFakeInvocationReceipt } from "../../../scripts/agent-lab/fake-invocation-receipt";
import { writeJsonAtomic } from "../../../scripts/agent-lab/paths";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api/task-session";

vi.mock("../../../scripts/agent-lab/desktop-driver", () => ({ DesktopLabDriver: vi.fn() }));
vi.mock("../../../scripts/agent-lab/desktop-main-loss", async (importOriginal) => {
	const original = await importOriginal<typeof desktopMainLoss>();
	return {
		...original,
		proveDesktopMainProcessLoss: vi.fn(),
		readDesktopMainLossHistory: vi.fn(),
		readDesktopMainLossOwner: vi.fn(),
		assertDesktopMainLossRecovery: vi.fn(),
	};
});
vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof nodeFs>();
	return { ...original, readFile: vi.fn() };
});
vi.mock("../../../scripts/agent-lab/desktop-renderer-recovery", async (importOriginal) => {
	const original = await importOriginal<typeof desktopRendererRecovery>();
	return { ...original, openDesktopPrimaryProject: vi.fn(), readDesktopFileRecoveryEvidence: vi.fn() };
});
vi.mock("../../../scripts/agent-lab/desktop-session-evidence", () => ({ readDesktopTaskSession: vi.fn() }));
vi.mock("../../../scripts/agent-lab/desktop-processes", () => ({ listDesktopProcesses: vi.fn() }));
vi.mock("../../../scripts/agent-lab/fake-invocation-receipt", () => ({ readFakeInvocationReceipt: vi.fn() }));
vi.mock("../../../scripts/agent-lab/paths", () => ({ writeJsonAtomic: vi.fn() }));

function pageMock(): Page {
	const locator = {
		waitFor: vi.fn(async () => {}),
		focus: vi.fn(async () => {}),
		isVisible: vi.fn(async () => false),
		first() {
			return this;
		},
	};
	return {
		getByRole: vi.fn(() => locator),
		locator: vi.fn(() => locator),
		keyboard: { type: vi.fn(async () => {}), press: vi.fn(async () => {}) },
	} as unknown as Page;
}

function fixtureMock(): DesktopLabFixture {
	const config = {
		version: 1 as const,
		tempRoot: "/synthetic/fixture",
		stateHome: "/synthetic/fixture/state",
		userDataPath: "/synthetic/fixture/user-data",
		projectPath: "/synthetic/fixture/project",
		hostSimulationConfigPath: "/synthetic/fixture/host.json",
		processEvidencePath: "/synthetic/fixture/processes.json",
		showWindow: false,
	};
	return {
		config,
		configPath: "/synthetic/fixture/config.json",
		environment: { HOME: "/synthetic/fixture/home" },
		manifestPath: "/synthetic/evidence/desktop-manifest.json",
		forbiddenHostLaunchLogPath: "/synthetic/evidence/forbidden.log",
		keepTemp: false,
		manifest: {
			schemaVersion: 1,
			surface: "electron",
			runId: "main-loss-scenario",
			status: "ready",
			appPath: "/synthetic/Quarterdeck.app",
			executablePath: "/synthetic/Quarterdeck.app/Contents/MacOS/Quarterdeck",
			artifactDir: "/synthetic/evidence",
			tempRoot: config.tempRoot,
			stateHome: config.stateHome,
			userDataPath: config.userDataPath,
			projectPath: config.projectPath,
			showWindow: false,
			agent: { mode: "fake" },
			providerVersion: null,
			mainPid: 100,
			helperPid: 101,
			rendererPids: [],
			processes: [],
			remainingPids: [],
			createdAt: "synthetic",
			stoppedAt: null,
			failure: null,
		},
	};
}

function session(instance: string, pid: number) {
	return runtimeTaskSessionSummarySchema.parse({
		taskId: "task",
		agentId: "codex",
		sessionInstanceId: instance,
		resumeSessionId: "agent-lab-task",
		state: "awaiting_review",
		pid,
		startedAt: 1,
		updatedAt: 2,
		lastOutputAt: 2,
		reviewReason: "hook",
		exitCode: null,
		recentProviderHookOrderObservations: [
			{
				event: "activity",
				deliveryId:
					instance === "before" ? "22222222-2222-4222-8222-222222222222" : "33333333-3333-4333-8333-333333333333",
				occurredAt: 2,
				source: "codex",
				sessionInstanceId: instance,
				providerSessionId: "agent-lab-task",
				hookEventName: "SessionStart",
				notificationType: null,
				turnId: null,
				promptId: null,
				toolUseId: null,
				elicitationId: null,
				toolName: null,
			},
		],
	});
}

beforeEach(() => {
	vi.resetAllMocks();
});
afterEach(() => {
	vi.useRealTimers();
});

function setup() {
	const fixture = fixtureMock();
	const nextFixture = { ...fixture, manifest: structuredClone(fixture.manifest) };
	const proof = {
		session: { taskId: "task", sessionInstanceId: "before" },
		ownedProcesses: [],
	} as unknown as DesktopMainLossProof;
	const page = pageMock();
	const nextPage = pageMock();
	const replacement = {
		fixture: nextFixture,
		launch: vi.fn(async () => nextPage),
		markReady: vi.fn(async () => {}),
		inspect: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
	} as unknown as DesktopLabDriver;
	const driver = {
		fixture,
		inspect: vi.fn(async () => {}),
		retainMainLossProcesses: vi.fn(),
		observeMainLossProof: vi.fn(),
		retireAfterMainLoss: vi.fn(async () => nextFixture),
		stop: vi.fn(async () => {}),
	} as unknown as DesktopLabDriver & DesktopMainLossRetirement;
	vi.mocked(driver.observeMainLossProof).mockImplementation(async (operation) => {
		try {
			const observed = await operation(vi.fn());
			driver.retainMainLossProcesses(observed);
			return observed;
		} catch (error) {
			if (error instanceof DesktopMainLossError) driver.retainMainLossProcesses(error);
			throw error;
		}
	});
	function ReplacementDriver() {
		if (!new.target) throw new Error("Replacement driver requires construction.");
		return replacement;
	}
	vi.mocked(DesktopLabDriver).mockImplementation(ReplacementDriver);
	vi.mocked(readDesktopMainLossHistory).mockResolvedValue({ sha256: "synthetic-hash", bytes: 64 });
	vi.mocked(readDesktopTaskSession)
		.mockResolvedValueOnce(session("before", 102))
		.mockResolvedValue(session("after", 202));
	vi.mocked(proveDesktopMainProcessLoss).mockResolvedValue(proof);
	const savedFixture = {
		identitySha256: "a".repeat(64),
		contentSha256: createHash("sha256").update("known saved fixture").digest("hex"),
	};
	const emptyStorage = {
		observedAt: "2026-10-02T00:00:00.000Z",
		productDocumentVerified: true,
		storageBackend: DESKTOP_FILE_RECOVERY_BACKEND,
		transactionCommitted: true,
		recoveryStateBefore: "ready" as const,
		recoveryState: "ready" as const,
		status: "valid" as const,
		storageBytes: 62,
		draftCount: 0,
		expiredCount: 0,
		fixtureEntryCount: 0,
		fixtureIdentitySha256: savedFixture.identitySha256,
		fixtureIdentityMatches: true,
		fixtureContentMatchCount: 0,
		fixtureSavedContentMatchCount: 0,
		unsavedBadgeVisible: false,
		recoveryDialogVisible: false,
	};
	vi.mocked(readDesktopFileRecoveryEvidence).mockResolvedValue(emptyStorage);
	vi.mocked(readFile).mockImplementation(async (path) => {
		if (String(path).endsWith("renderer-recovery.json")) return JSON.stringify({ savedFixture });
		if (String(path).endsWith("example.ts")) return Buffer.from("known saved fixture");
		return JSON.stringify({
			version: 1,
			appPid: 200,
			helperPid: 201,
			generation: "generation-after",
			runtimeOrigin: "http://127.0.0.1:3502",
			phase: "ready",
		});
	});
	vi.mocked(readFakeInvocationReceipt).mockResolvedValue({
		version: 1,
		provider: "codex",
		taskId: "task",
		sessionInstanceId: "after",
		pid: 203,
		providerSessionId: "agent-lab-task",
		resumeKind: "targeted",
		requestedSessionId: "agent-lab-task",
		historyPresent: true,
	});
	vi.mocked(listDesktopProcesses).mockResolvedValue([]);
	vi.mocked(readDesktopMainLossOwner).mockResolvedValue(null);
	const recovery = { generation: "generation-after" } as ReturnType<typeof assertDesktopMainLossRecovery>;
	vi.mocked(assertDesktopMainLossRecovery).mockReturnValue(recovery);
	const setCleanupOwner = vi.fn();
	return {
		fixture,
		nextFixture,
		driver,
		replacement,
		page,
		nextPage,
		proof,
		recovery,
		setCleanupOwner,
		savedFixture,
		emptyStorage,
	};
}

describe("packaged main-loss scenario cleanup ownership", () => {
	it("seeds exact history, retires first, registers replacement before launch, and leaves final Quit to the caller", async () => {
		const test = setup();
		vi.mocked(test.replacement.launch).mockImplementation(async () => {
			expect(test.setCleanupOwner).toHaveBeenCalledExactlyOnceWith(test.replacement);
			expect(test.driver.retireAfterMainLoss).toHaveBeenCalledExactlyOnceWith(test.proof);
			return test.nextPage;
		});
		const result = await exerciseDesktopMainLoss(test.page, test.driver, "task", {
			setCleanupOwner: test.setCleanupOwner,
		});
		expect(test.page.keyboard.type).toHaveBeenNthCalledWith(1, "/progress desktop-main-loss-main-loss-scenario-task");
		expect(test.page.keyboard.type).toHaveBeenNthCalledWith(2, "/review Packaged main-loss conversation prepared");
		expect(test.driver.retainMainLossProcesses).toHaveBeenCalledExactlyOnceWith(test.proof);
		expect(test.driver.observeMainLossProof).toHaveBeenCalledOnce();
		expect(proveDesktopMainProcessLoss).toHaveBeenCalledWith(
			test.fixture,
			expect.objectContaining({ signalMain: expect.any(Function) }),
		);
		expect(DesktopLabDriver).toHaveBeenCalledExactlyOnceWith(test.nextFixture);
		expect(openDesktopPrimaryProject).toHaveBeenCalledExactlyOnceWith(test.nextPage);
		expect(assertDesktopMainLossRecovery).toHaveBeenCalledWith(
			test.proof,
			expect.objectContaining({
				fixture: test.nextFixture,
				invocation: expect.objectContaining({ resumeKind: "targeted" }),
			}),
		);
		expect(writeJsonAtomic).toHaveBeenCalledWith(
			"/synthetic/evidence/main-loss-proof.json",
			expect.objectContaining({ sameFixture: true, reviewPreserved: true }),
		);
		expect(result).toEqual({
			driver: test.replacement,
			page: test.nextPage,
			proof: test.proof,
			recovery: test.recovery,
		});
		expect(test.driver.stop).not.toHaveBeenCalled();
		expect(test.replacement.stop).not.toHaveBeenCalled();
	});

	it("transfers proof-discovered reparented identity custody before propagating a failed loss proof", async () => {
		const test = setup();
		const failure = new DesktopMainLossError("parent-loss cleanup unconfirmed", true, [
			{ pid: 103, parentPid: 1, startedAt: "retained", command: "synthetic child" },
		]);
		vi.mocked(proveDesktopMainProcessLoss).mockRejectedValue(failure);
		await expect(
			exerciseDesktopMainLoss(test.page, test.driver, "task", { setCleanupOwner: test.setCleanupOwner }),
		).rejects.toBe(failure);
		expect(test.driver.retainMainLossProcesses).toHaveBeenCalledExactlyOnceWith(failure);
		expect(test.driver.retireAfterMainLoss).not.toHaveBeenCalled();
		expect(DesktopLabDriver).not.toHaveBeenCalled();
		expect(test.setCleanupOwner).not.toHaveBeenCalled();
	});

	it("keeps the old cleanup owner on retirement failure and never constructs or starts a replacement", async () => {
		const test = setup();
		const failure = new Error("archive unavailable");
		vi.mocked(test.driver.retireAfterMainLoss).mockImplementation(async () => {
			expect(test.driver.retainMainLossProcesses).toHaveBeenCalledExactlyOnceWith(test.proof);
			throw failure;
		});
		await expect(
			exerciseDesktopMainLoss(test.page, test.driver, "task", { setCleanupOwner: test.setCleanupOwner }),
		).rejects.toBe(failure);
		expect(test.setCleanupOwner).not.toHaveBeenCalled();
		expect(DesktopLabDriver).not.toHaveBeenCalled();
	});

	it("has already installed the new cleanup owner when its SDK launch rejects", async () => {
		const test = setup();
		const failure = new Error("replacement handshake failed");
		let owner: DesktopLabDriver = test.driver;
		vi.mocked(test.replacement.launch).mockImplementation(async () => {
			expect(owner).toBe(test.replacement);
			throw failure;
		});
		await expect(
			exerciseDesktopMainLoss(test.page, test.driver, "task", {
				setCleanupOwner: (next) => {
					owner = next;
				},
			}),
		).rejects.toBe(failure);
		expect(owner).toBe(test.replacement);
		expect(test.replacement.stop).not.toHaveBeenCalled();
	});

	it("propagates failed targeted recovery with the replacement still owned by the outer cleanup path", async () => {
		const test = setup();
		const failure = new Error("targeted history mismatch");
		vi.mocked(assertDesktopMainLossRecovery).mockImplementation(() => {
			throw failure;
		});
		await expect(
			exerciseDesktopMainLoss(test.page, test.driver, "task", { setCleanupOwner: test.setCleanupOwner }),
		).rejects.toBe(failure);
		expect(test.setCleanupOwner).toHaveBeenCalledExactlyOnceWith(test.replacement);
		expect(writeJsonAtomic).not.toHaveBeenCalledWith("/synthetic/evidence/main-loss-proof.json", expect.anything());
	});

	it("captures the saved fixture immediately before invoking the guarded loss proof", async () => {
		const test = setup();
		vi.mocked(proveDesktopMainProcessLoss).mockImplementation(async () => {
			expect(writeJsonAtomic).toHaveBeenLastCalledWith(
				"/synthetic/evidence/main-loss-file-recovery-before-proof.json",
				expect.objectContaining({
					observation: "renderer-observed-before-proof",
					savedFixture: test.savedFixture,
					sourceMatches: true,
					evidence: expect.objectContaining({ fixtureEntryCount: 0 }),
				}),
			);
			expect(test.page.keyboard.type).toHaveBeenCalledTimes(2);
			expect(readDesktopFileRecoveryEvidence).toHaveBeenCalledExactlyOnceWith(
				test.page,
				expect.objectContaining(test.savedFixture),
			);
			return test.proof;
		});
		await exerciseDesktopMainLoss(test.page, test.driver, "task", { setCleanupOwner: test.setCleanupOwner });
		expect(readDesktopFileRecoveryEvidence).toHaveBeenNthCalledWith(
			2,
			test.nextPage,
			expect.objectContaining(test.savedFixture),
		);
	});

	it("retains unknown pre-proof storage and refuses to signal or launch a replacement", async () => {
		const test = setup();
		vi.mocked(readDesktopFileRecoveryEvidence).mockResolvedValue({
			...test.emptyStorage,
			status: "unavailable",
			storageBytes: null,
			fixtureEntryCount: null,
			draftCount: null,
			unsavedBadgeVisible: null,
			recoveryDialogVisible: null,
		});
		await expect(
			exerciseDesktopMainLoss(test.page, test.driver, "task", { setCleanupOwner: test.setCleanupOwner }),
		).rejects.toThrow("acknowledged committed IndexedDB");
		expect(writeJsonAtomic).toHaveBeenCalledWith(
			"/synthetic/evidence/main-loss-file-recovery-before-proof.json",
			expect.objectContaining({
				evidence: expect.objectContaining({ status: "unavailable", fixtureEntryCount: null }),
			}),
		);
		expect(proveDesktopMainProcessLoss).not.toHaveBeenCalled();
		expect(DesktopLabDriver).not.toHaveBeenCalled();
	});

	it.each([
		["uninitialized record", { status: "uninitialized" }],
		["uncommitted readonly transaction", { transactionCommitted: false }],
		["controller pending before the read", { recoveryStateBefore: "pending" }],
		["controller error after the read", { recoveryState: "error" }],
		["unrelated retained draft", { draftCount: 1 }],
		["expired retained draft", { expiredCount: 1 }],
	] satisfies Array<[string, Partial<Awaited<ReturnType<typeof readDesktopFileRecoveryEvidence>>>]>)(
		"refuses main-loss proof despite a clean source when there is an %s",
		async (_label, patch) => {
			const test = setup();
			vi.mocked(readDesktopFileRecoveryEvidence).mockResolvedValue({ ...test.emptyStorage, ...patch });
			await expect(
				exerciseDesktopMainLoss(test.page, test.driver, "task", { setCleanupOwner: test.setCleanupOwner }),
			).rejects.toThrow("acknowledged committed IndexedDB");
			expect(proveDesktopMainProcessLoss).not.toHaveBeenCalled();
			expect(test.driver.retireAfterMainLoss).not.toHaveBeenCalled();
			expect(test.setCleanupOwner).not.toHaveBeenCalled();
		},
	);

	it.each([
		["uninitialized", { status: "uninitialized" }],
		["uncommitted", { transactionCommitted: false }],
		["nonempty unrelated draft", { draftCount: 1, fixtureEntryCount: 0 }],
		["controller error", { recoveryStateBefore: "error" }],
	] satisfies Array<[string, Partial<Awaited<ReturnType<typeof readDesktopFileRecoveryEvidence>>>]>)(
		"rejects an %s replacement receipt without touching Settings or recovery actions",
		async (_label, patch) => {
			const test = setup();
			vi.mocked(readDesktopFileRecoveryEvidence)
				.mockResolvedValueOnce(test.emptyStorage)
				.mockResolvedValue({ ...test.emptyStorage, ...patch });
			await expect(
				exerciseDesktopMainLoss(test.page, test.driver, "task", { setCleanupOwner: test.setCleanupOwner }),
			).rejects.toThrow("Replacement renderer");
			expect(test.setCleanupOwner).toHaveBeenCalledExactlyOnceWith(test.replacement);
			expect(test.nextPage.getByRole).not.toHaveBeenCalled();
			expect(openDesktopPrimaryProject).not.toHaveBeenCalled();
		},
	);

	it("cannot accept a same-shaped empty receipt from a different storage backend", async () => {
		const test = setup();
		// Deliberately inject corrupt external metadata, outside the production receipt type.
		const corruptReceipt = {
			...test.emptyStorage,
			storageBackend: { ...DESKTOP_FILE_RECOVERY_BACKEND, database: "unrelated-database" },
		} as unknown as Awaited<ReturnType<typeof readDesktopFileRecoveryEvidence>>;
		vi.mocked(readDesktopFileRecoveryEvidence)
			.mockResolvedValueOnce(test.emptyStorage)
			.mockResolvedValue(corruptReceipt);
		await expect(
			exerciseDesktopMainLoss(test.page, test.driver, "task", { setCleanupOwner: test.setCleanupOwner }),
		).rejects.toThrow("Replacement renderer");
		expect(test.nextPage.getByRole).not.toHaveBeenCalled();
	});

	it("waits for the replacement controller's committed acknowledgement before Settings", async () => {
		vi.useFakeTimers();
		const test = setup();
		const pending = {
			...test.emptyStorage,
			recoveryStateBefore: "pending" as const,
			recoveryState: "pending" as const,
		};
		vi.mocked(readDesktopFileRecoveryEvidence)
			.mockResolvedValueOnce(test.emptyStorage)
			.mockResolvedValueOnce(pending)
			.mockResolvedValueOnce(pending)
			.mockImplementationOnce(async () => {
				expect(test.nextPage.getByRole).not.toHaveBeenCalled();
				return test.emptyStorage;
			})
			.mockResolvedValue(test.emptyStorage);
		const running = exerciseDesktopMainLoss(test.page, test.driver, "task", {
			setCleanupOwner: test.setCleanupOwner,
		});
		await vi.runAllTimersAsync();
		expect((await running).driver).toBe(test.replacement);
		expect(writeJsonAtomic).toHaveBeenCalledWith(
			"/synthetic/evidence/main-loss-file-recovery-after-ready.json",
			expect.objectContaining({
				evidence: expect.objectContaining({
					recoveryStateBefore: "ready",
					recoveryState: "ready",
					transactionCommitted: true,
				}),
			}),
		);
	});

	it("retains the final failure receipt and preserves it when diagnostic publication also fails", async () => {
		const test = setup();
		vi.mocked(readDesktopFileRecoveryEvidence)
			.mockResolvedValueOnce(test.emptyStorage)
			.mockResolvedValueOnce(test.emptyStorage)
			.mockResolvedValue({ ...test.emptyStorage, status: "uninitialized", fixtureEntryCount: null });
		vi.mocked(writeJsonAtomic).mockImplementation(async (path) => {
			if (path.endsWith("after-ready.json")) throw new Error("artifact write failed");
		});
		await expect(
			exerciseDesktopMainLoss(test.page, test.driver, "task", { setCleanupOwner: test.setCleanupOwner }),
		).rejects.toThrow("became uninitialized, unreadable or nonempty before acknowledgement");
		expect(writeJsonAtomic).toHaveBeenCalledWith(
			"/synthetic/evidence/main-loss-file-recovery-after-ready.json",
			expect.objectContaining({
				evidence: expect.objectContaining({ status: "uninitialized", fixtureEntryCount: null }),
			}),
		);
		expect(test.nextPage.getByRole).not.toHaveBeenCalled();
	});

	it("retains a resurrected saved entry before any replacement Settings action and fails closed", async () => {
		const test = setup();
		vi.mocked(readDesktopFileRecoveryEvidence)
			.mockResolvedValueOnce(test.emptyStorage)
			.mockResolvedValue({
				...test.emptyStorage,
				draftCount: 1,
				fixtureEntryCount: 1,
				fixtureContentMatchCount: 1,
				recoveryDialogVisible: true,
			});
		await expect(
			exerciseDesktopMainLoss(test.page, test.driver, "task", { setCleanupOwner: test.setCleanupOwner }),
		).rejects.toThrow("Replacement renderer");
		expect(writeJsonAtomic).toHaveBeenCalledWith(
			"/synthetic/evidence/main-loss-file-recovery-after-replacement.json",
			expect.objectContaining({
				observation: "renderer-observed-before-settings",
				evidence: expect.objectContaining({ fixtureEntryCount: 1, recoveryDialogVisible: true }),
			}),
		);
		expect(test.nextPage.getByRole).not.toHaveBeenCalled();
		expect(test.setCleanupOwner).toHaveBeenCalledExactlyOnceWith(test.replacement);
		expect(openDesktopPrimaryProject).not.toHaveBeenCalled();
	});

	it("keeps the original Settings failure if retaining its latest diagnostic also fails", async () => {
		const test = setup();
		const failure = new Error("Settings blocked by recovery modal");
		vi.mocked(test.nextPage.getByRole).mockReturnValue({
			waitFor: vi.fn(async () => {
				throw failure;
			}),
		} as unknown as ReturnType<Page["getByRole"]>);
		vi.mocked(writeJsonAtomic).mockImplementation(async (path) => {
			if (path.endsWith("settings-failed.json")) throw new Error("artifact write failed");
		});
		await expect(
			exerciseDesktopMainLoss(test.page, test.driver, "task", { setCleanupOwner: test.setCleanupOwner }),
		).rejects.toBe(failure);
		expect(writeJsonAtomic).toHaveBeenCalledWith(
			"/synthetic/evidence/main-loss-file-recovery-after-replacement.json",
			expect.objectContaining({ evidence: expect.objectContaining({ fixtureEntryCount: 0 }) }),
		);
		expect(readDesktopFileRecoveryEvidence).toHaveBeenCalledTimes(4);
		expect(openDesktopPrimaryProject).not.toHaveBeenCalled();
	});
});
