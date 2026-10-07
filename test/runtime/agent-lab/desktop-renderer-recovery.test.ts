import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type * as nodeFs from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import type { Locator, Page } from "playwright-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	assertDesktopRendererRecovery,
	closeDesktopRecoveredDraftReview,
	DESKTOP_FILE_RECOVERY_BACKEND,
	type DesktopFileRecoveryTarget,
	type DesktopRecoverySnapshotOptions,
	type DesktopRendererCheckpoint,
	projectDesktopFileRecovery,
	readDesktopFileRecoveryEvidence,
	readDesktopRecoverySnapshot,
	verifyDesktopInitialDirtyFixture,
	verifyDesktopRecoveredDirtyFixture,
	verifyDesktopSavedFixture,
} from "../../../scripts/agent-lab/desktop-renderer-recovery";
import { writeJsonAtomic } from "../../../scripts/agent-lab/paths";

vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof nodeFs>();
	return { ...original, readFile: vi.fn() };
});
vi.mock("../../../scripts/agent-lab/paths", () => ({ writeJsonAtomic: vi.fn() }));

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(writeJsonAtomic).mockResolvedValue(undefined);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const draftContents = "known synthetic draft";
const draftDigest = createHash("sha256").update(draftContents).digest("hex");
const recoveryTarget: DesktopFileRecoveryTarget = {
	projectPath: "/synthetic/fixture/project",
	projectId: "fixture-project",
	contentSha256: draftDigest,
};

function draftRecord() {
	return {
		id: "synthetic-record",
		scopeKey: "synthetic-scope",
		scope: { projectId: "fixture-project", taskId: null as string | null, rootPath: recoveryTarget.projectPath },
		tab: {
			path: "example.ts",
			value: draftContents,
			savedValue: "known synthetic original",
			contentHash: null,
			language: "typescript",
			binary: false,
			truncated: false,
			editable: true,
			editBlockedReason: null,
			size: 20,
		},
		updatedAt: Date.now(),
	};
}

function recoveryPage(raw: string | null) {
	const state = { raw, unsaved: true, recoveryState: "ready", statusNodes: 1, saveDisabled: true };
	const page = {
		waitForURL: vi.fn(async () => {}),
		evaluate: vi.fn(async () =>
			state.raw === null
				? { kind: "uninitialized" as const, transactionCommitted: true }
				: { kind: "read" as const, raw: state.raw, transactionCommitted: true },
		),
		getByTestId: vi.fn(() => ({
			count: async () => state.statusNodes,
			getAttribute: async () => state.recoveryState,
		})),
		getByText: vi.fn(() => ({ first: () => ({ isVisible: async () => state.unsaved }) })),
		getByRole: vi.fn((role: string) =>
			role === "dialog" ? { isVisible: async () => false } : { isDisabled: async () => state.saveDisabled },
		),
	} as unknown as Page;
	return { page, state };
}

describe("initial dirty acknowledgement evidence retention", () => {
	it("preserves the existing exact dirty ACK gate and retains only hashes and bounded metadata", async () => {
		vi.useFakeTimers();
		const raw = JSON.stringify({ schemaVersion: 1, drafts: [draftRecord()] });
		const { page, state } = recoveryPage(raw);
		state.recoveryState = "pending";
		let finished = false;
		const checking = verifyDesktopInitialDirtyFixture(page, recoveryTarget, "/synthetic/evidence").then((result) => {
			finished = true;
			return result;
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(finished).toBe(false);
		state.recoveryState = "ready";
		await vi.advanceTimersByTimeAsync(100);
		const savedFixture = await checking;
		expect(savedFixture).toEqual({
			identitySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			contentSha256: draftDigest,
		});
		expect(writeJsonAtomic).toHaveBeenCalledWith(
			"/synthetic/evidence/renderer-file-recovery-dirty.json",
			expect.objectContaining({
				stage: "initial_dirty_snapshot",
				outcome: "acknowledged",
				category: "acknowledged",
				savedFixture,
				evidence: expect.objectContaining({
					storageBackend: DESKTOP_FILE_RECOVERY_BACKEND,
					transactionCommitted: true,
				}),
			}),
		);
		const retained = JSON.stringify(vi.mocked(writeJsonAtomic).mock.calls[0][1]);
		for (const content of [draftContents, "known synthetic original", recoveryTarget.projectPath, "fixture-project"])
			expect(retained).not.toContain(content);
		expect(readFile).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		"retains an unavailable initial read and preserves its timeout (publication fails: %s)",
		async (publicationFails) => {
			vi.useFakeTimers();
			const { page } = recoveryPage(null);
			vi.mocked(page.evaluate).mockRejectedValue(new Error("private synthetic storage failure"));
			if (publicationFails)
				vi.mocked(writeJsonAtomic).mockRejectedValue(new Error("private synthetic publication failure"));
			const checking = verifyDesktopInitialDirtyFixture(page, recoveryTarget, "/synthetic/evidence").catch(
				(error) => error,
			);
			await vi.advanceTimersByTimeAsync(25_100);
			expect(await checking).toEqual(
				expect.objectContaining({
					message: "Renderer recovery timed out waiting for exact renderer-observed recovery copy.",
				}),
			);
			expect(writeJsonAtomic).toHaveBeenCalledWith(
				"/synthetic/evidence/renderer-file-recovery-dirty.json",
				expect.objectContaining({
					stage: "initial_dirty_snapshot",
					outcome: "incomplete",
					category: "unavailable",
					expectedContentSha256: draftDigest,
					evidence: expect.objectContaining({
						status: "unavailable",
						transactionCommitted: false,
						recoveryState: "unknown",
						storageBackend: DESKTOP_FILE_RECOVERY_BACKEND,
					}),
				}),
			);
			expect(JSON.stringify(vi.mocked(writeJsonAtomic).mock.calls[0][1])).not.toContain("private synthetic");
			expect(readFile).not.toHaveBeenCalled();
		},
	);

	it.each(["uninitialized", "fixture_mismatch", "controller_not_ready"] as const)(
		"retains the last %s observation without accepting or changing the fixture",
		async (category) => {
			vi.useFakeTimers();
			const raw =
				category === "uninitialized"
					? null
					: JSON.stringify({ schemaVersion: 1, drafts: category === "fixture_mismatch" ? [] : [draftRecord()] });
			const { page, state } = recoveryPage(raw);
			if (category === "controller_not_ready") state.recoveryState = "pending";
			const checking = verifyDesktopInitialDirtyFixture(page, recoveryTarget, "/synthetic/evidence").catch(
				(error) => error,
			);
			await vi.advanceTimersByTimeAsync(25_100);
			expect(await checking).toEqual(expect.objectContaining({ message: expect.stringContaining("timed out") }));
			expect(writeJsonAtomic).toHaveBeenCalledWith(
				"/synthetic/evidence/renderer-file-recovery-dirty.json",
				expect.objectContaining({ stage: "initial_dirty_snapshot", outcome: "incomplete", category }),
			);
			expect(readFile).not.toHaveBeenCalled();
		},
	);
});

describe("acknowledged dirty fixture after renderer recovery", () => {
	function recoveredFixture() {
		const raw = JSON.stringify({ schemaVersion: 1, drafts: [draftRecord()] });
		const baseline = projectDesktopFileRecovery(raw, recoveryTarget);
		return {
			...recoveryPage(raw),
			target: { ...recoveryTarget, identitySha256: baseline.fixtureIdentitySha256 ?? "" },
		};
	}

	it("waits for hydration's pending strict rewrite without dismissing the recovered review", async () => {
		vi.useFakeTimers();
		const { page, state, target } = recoveredFixture();
		state.recoveryState = "pending";
		let finished = false;
		const checking = verifyDesktopRecoveredDirtyFixture(page, target, "/synthetic/evidence").then((result) => {
			finished = true;
			return result;
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(finished).toBe(false);
		expect(readFile).not.toHaveBeenCalled();
		state.recoveryState = "ready";
		await vi.advanceTimersByTimeAsync(100);
		expect(await checking).toMatchObject({
			transactionCommitted: true,
			recoveryStateBefore: "ready",
			recoveryState: "ready",
			fixtureContentMatchCount: 1,
			fixtureIdentityMatches: true,
		});
		expect(writeJsonAtomic).toHaveBeenCalledWith(
			"/synthetic/evidence/renderer-file-recovery-after-crash.json",
			expect.objectContaining({ observation: "renderer-observed-committed-dirty-after-renderer-crash" }),
		);
	});

	it("does not accept pending-before/ready-after as the final controller acknowledgement", async () => {
		vi.useFakeTimers();
		const { page, state, target } = recoveredFixture();
		state.recoveryState = "pending";
		vi.mocked(page.evaluate).mockImplementationOnce(async () => {
			state.recoveryState = "ready";
			if (state.raw === null) throw new Error("Expected committed dirty fixture.");
			return { kind: "read", raw: state.raw, transactionCommitted: true };
		});
		const checking = verifyDesktopRecoveredDirtyFixture(page, target, "/synthetic/evidence");
		await vi.advanceTimersByTimeAsync(100);
		await checking;
		expect(page.evaluate).toHaveBeenCalledTimes(2);
	});

	it.each(["missing", "malformed", "wrong identity", "wrong contents", "controller error"] as const)(
		"fails without recovery actions when acknowledged dirty storage is %s",
		async (failure) => {
			const { page, state, target } = recoveredFixture();
			if (failure === "missing") state.raw = null;
			if (failure === "malformed") state.raw = "{";
			if (failure === "wrong identity") {
				const wrong = draftRecord();
				wrong.scope.projectId = "another-project";
				state.raw = JSON.stringify({ schemaVersion: 1, drafts: [wrong] });
			}
			if (failure === "wrong contents") {
				const wrong = draftRecord();
				wrong.tab.value = "another synthetic draft";
				state.raw = JSON.stringify({ schemaVersion: 1, drafts: [wrong] });
			}
			if (failure === "controller error") state.recoveryState = "error";
			await expect(verifyDesktopRecoveredDirtyFixture(page, target, "/synthetic/evidence")).rejects.toThrow(
				"did not preserve the exact acknowledged dirty recovery record",
			);
			expect(writeJsonAtomic).toHaveBeenCalledWith(
				"/synthetic/evidence/renderer-file-recovery-after-crash.json",
				expect.objectContaining({ evidence: expect.any(Object) }),
			);
			expect(readFile).not.toHaveBeenCalled();
		},
	);

	it("bounds never-acknowledged readiness and preserves the original timeout if retention fails", async () => {
		vi.useFakeTimers();
		const { page, state, target } = recoveredFixture();
		state.recoveryState = "pending";
		vi.mocked(writeJsonAtomic).mockRejectedValue(new Error("artifact write failed"));
		const checking = verifyDesktopRecoveredDirtyFixture(page, target, "/synthetic/evidence").catch((error) => error);
		await vi.advanceTimersByTimeAsync(25_100);
		expect(await checking).toEqual(
			expect.objectContaining({ message: expect.stringContaining("timed out waiting") }),
		);
	});
});

describe("bounded renderer-observed saved fixture evidence", () => {
	it("hashes the exact project/file identity and content without retaining paths or text", () => {
		const evidence = projectDesktopFileRecovery(
			JSON.stringify({ schemaVersion: 1, drafts: [draftRecord()] }),
			recoveryTarget,
		);
		expect(evidence).toMatchObject({
			status: "valid",
			draftCount: 1,
			fixtureEntryCount: 1,
			fixtureContentMatchCount: 1,
		});
		expect(evidence.fixtureIdentitySha256).toMatch(/^[a-f0-9]{64}$/);
		const retained = JSON.stringify(evidence);
		for (const sensitive of [
			draftContents,
			"known synthetic original",
			recoveryTarget.projectPath,
			"fixture-project",
		])
			expect(retained).not.toContain(sensitive);
	});
	it.each(["project", "task", "root"] as const)(
		"does not adopt a same-path draft with the wrong %s identity",
		(field) => {
			const record = draftRecord();
			if (field === "project") record.scope.projectId = "another-project";
			if (field === "task") Object.assign(record.scope, { taskId: "another-task", taskCreatedAt: 1 });
			if (field === "root") record.scope.rootPath = "/synthetic/another-root";
			expect(
				projectDesktopFileRecovery(JSON.stringify({ schemaVersion: 1, drafts: [record] }), recoveryTarget),
			).toMatchObject({
				status: "valid",
				fixtureEntryCount: 0,
				fixtureIdentitySha256: null,
				fixtureContentMatchCount: 0,
			});
		},
	);
	it("distinguishes an empty valid envelope from malformed or oversized evidence", () => {
		expect(projectDesktopFileRecovery(null, recoveryTarget)).toMatchObject({
			status: "uninitialized",
			draftCount: null,
			fixtureEntryCount: null,
		});
		expect(
			projectDesktopFileRecovery(JSON.stringify({ schemaVersion: 1, drafts: [] }), recoveryTarget),
		).toMatchObject({ status: "valid", draftCount: 0 });
		for (const raw of ["{", JSON.stringify({ schemaVersion: 1, drafts: [], unexpected: true })])
			expect(projectDesktopFileRecovery(raw, recoveryTarget)).toMatchObject({
				status: "invalid",
				draftCount: null,
				fixtureEntryCount: null,
			});
		expect(projectDesktopFileRecovery("x".repeat(1024 * 1024 + 1), recoveryTarget)).toMatchObject({
			status: "limit",
			draftCount: null,
			fixtureEntryCount: null,
		});
	});
	it("does not read storage from a document whose product origin could not be verified", async () => {
		const { page } = recoveryPage(null);
		vi.mocked(page.waitForURL).mockRejectedValue(new Error("not the product document"));
		expect(await readDesktopFileRecoveryEvidence(page, recoveryTarget)).toMatchObject({
			status: "unavailable",
			productDocumentVerified: false,
			fixtureEntryCount: null,
		});
		expect(page.evaluate).not.toHaveBeenCalled();
	});
	it("does not count a failed IndexedDB read as an absent saved entry", async () => {
		const { page } = recoveryPage(null);
		vi.mocked(page.evaluate).mockRejectedValue(new Error("storage unavailable"));
		expect(await readDesktopFileRecoveryEvidence(page, recoveryTarget)).toMatchObject({
			status: "unavailable",
			productDocumentVerified: true,
			fixtureEntryCount: null,
		});
	});
	it("bounds the complete observation when a DOM protocol read does not settle", async () => {
		vi.useFakeTimers();
		const { page } = recoveryPage(null);
		const blocked = { first: () => ({ isVisible: () => new Promise<boolean>(() => {}) }) } as unknown as Locator;
		vi.mocked(page.getByText).mockReturnValue(blocked);
		const observation = readDesktopFileRecoveryEvidence(page, recoveryTarget);
		await vi.advanceTimersByTimeAsync(15_100);
		expect(await observation).toMatchObject({
			status: "unavailable",
			productDocumentVerified: true,
			fixtureEntryCount: null,
		});
	});
	it("waits past disabled Save until both the Unsaved badge and exact stored draft are gone", async () => {
		vi.useFakeTimers();
		const raw = JSON.stringify({ schemaVersion: 1, drafts: [draftRecord()] });
		const baseline = projectDesktopFileRecovery(raw, recoveryTarget);
		const target = { ...recoveryTarget, identitySha256: baseline.fixtureIdentitySha256 ?? "" };
		const { page, state } = recoveryPage(raw);
		vi.mocked(readFile).mockResolvedValue(Buffer.from(draftContents));
		let finished = false;
		const checking = verifyDesktopSavedFixture(page, target, "/synthetic/evidence").then((result) => {
			finished = true;
			return result;
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(finished).toBe(false);
		state.unsaved = false;
		await vi.advanceTimersByTimeAsync(100);
		expect(finished).toBe(false);
		state.raw = JSON.stringify({ schemaVersion: 1, drafts: [] });
		await vi.advanceTimersByTimeAsync(100);
		expect(await checking).toMatchObject({
			fixtureEntryCount: 0,
			unsavedBadgeVisible: false,
			sourceMatches: true,
			saveDisabled: true,
		});
		expect(writeJsonAtomic).toHaveBeenCalledWith(
			"/synthetic/evidence/renderer-file-recovery-after-save.json",
			expect.objectContaining({
				observation: "renderer-observed",
				savedFixture: { identitySha256: target.identitySha256, contentSha256: draftDigest },
			}),
		);
	});
	it.each([false, true])(
		"preserves rejected Save acknowledgement while attempting diagnostic retention (write fails: %s)",
		async (writeFails) => {
			vi.useFakeTimers();
			const { page, state } = recoveryPage(null);
			state.unsaved = false;
			vi.mocked(page.evaluate).mockRejectedValue(new Error("storage unavailable"));
			vi.mocked(readFile).mockResolvedValue(Buffer.from(draftContents));
			if (writeFails) vi.mocked(writeJsonAtomic).mockRejectedValue(new Error("artifact write failed"));
			const checking = verifyDesktopSavedFixture(
				page,
				{ ...recoveryTarget, identitySha256: "a".repeat(64) },
				"/synthetic/evidence",
			);
			const rejected = expect(checking).rejects.toThrow("Save acknowledgement");
			await vi.advanceTimersByTimeAsync(25_100);
			await rejected;
			expect(writeJsonAtomic).toHaveBeenCalledWith(
				"/synthetic/evidence/renderer-file-recovery-after-save.json",
				expect.objectContaining({
					evidence: expect.objectContaining({
						status: "unavailable",
						fixtureEntryCount: null,
						sourceMatches: true,
					}),
				}),
			);
		},
	);
});

const snapshotOptions: DesktopRecoverySnapshotOptions = {
	...DESKTOP_FILE_RECOVERY_BACKEND,
	maxBytes: 2 * 1024 * 1024,
	timeoutMs: 4_000,
};

function fakeRecoveryDatabase(
	raw: unknown,
	options: {
		missingDatabase?: boolean;
		missingKey?: boolean;
		version?: number;
		missingStore?: boolean;
		complete?: boolean;
		failure?: "upgrade" | "blocked" | "open" | "request" | "transaction" | "abort";
	} = {},
) {
	type Handler = (() => void) | null;
	const request = {
		result: options.missingKey ? null : { key: snapshotOptions.key, value: raw },
		onsucceeded: false,
		onsuccess: null as Handler,
		onerror: null as Handler,
	};
	const store = {
		openCursor: vi.fn(() => {
			queueMicrotask(() => {
				if (options.failure === "request") {
					request.onerror?.();
					return;
				}
				if (options.failure === "transaction") {
					transaction.onerror?.();
					return;
				}
				if (options.failure === "abort") {
					transaction.onabort?.();
					return;
				}
				request.onsuccess?.();
				request.onsucceeded = true;
				if (options.complete !== false) queueMicrotask(() => transaction.oncomplete?.());
			});
			return request;
		}),
	};
	const transaction = {
		oncomplete: null as Handler,
		onerror: null as Handler,
		onabort: null as Handler,
		objectStore: vi.fn(() => store),
		abort: vi.fn(() => {
			queueMicrotask(() => transaction.onabort?.());
		}),
	};
	const database = {
		version: options.version ?? snapshotOptions.version,
		objectStoreNames: { contains: vi.fn(() => !options.missingStore) },
		transaction: vi.fn(() => transaction),
		close: vi.fn(),
		createObjectStore: vi.fn(),
	};
	const opening = {
		result: database,
		transaction,
		onsucceeded: false,
		onsuccess: null as Handler,
		onerror: null as Handler,
		onupgradeneeded: null as Handler,
		onblocked: null as Handler,
	};
	const factory = {
		databases: vi.fn(async () =>
			options.missingDatabase ? [] : [{ name: snapshotOptions.database, version: database.version }],
		),
		open: vi.fn(() => {
			queueMicrotask(() => {
				if (options.failure === "upgrade") opening.onupgradeneeded?.();
				else if (options.failure === "blocked") opening.onblocked?.();
				else if (options.failure === "open") opening.onerror?.();
				else opening.onsuccess?.();
				opening.onsucceeded = true;
			});
			return opening;
		}),
	};
	vi.stubGlobal("indexedDB", factory);
	return { factory, opening, database, transaction, request, store };
}

describe("actual TSX observer serialization into a fresh browser realm", () => {
	let source: string;
	beforeAll(async () => {
		const child = await promisify(execFile)(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"-e",
				'import { readDesktopRecoverySnapshot } from "./scripts/agent-lab/desktop-renderer-recovery.ts"; process.stdout.write(readDesktopRecoverySnapshot.toString());',
			],
			{ cwd: process.cwd(), encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024 },
		);
		source = child.stdout;
	}, 15_000);

	function serializedObserver(factory: ReturnType<typeof fakeRecoveryDatabase>["factory"]) {
		const globals = { indexedDB: factory, setTimeout, clearTimeout };
		expect(runInNewContext("typeof __name", globals)).toBe("undefined");
		expect(source).not.toContain("__name");
		return runInNewContext(`(${source})`, globals, { timeout: 1_000 }) as typeof readDesktopRecoverySnapshot;
	}

	it("reads a valid record only after readonly transaction completion, without a loader closure", async () => {
		const raw = JSON.stringify({ schemaVersion: 1, drafts: [] });
		const fake = fakeRecoveryDatabase(raw, { complete: false });
		let finished = false;
		const reading = serializedObserver(fake.factory)(snapshotOptions).then((result) => {
			finished = true;
			return result;
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(fake.request.onsucceeded).toBe(true);
		expect(finished).toBe(false);
		fake.transaction.oncomplete?.();
		expect(await reading).toEqual({ kind: "read", raw, transactionCommitted: true });
		expect(fake.database.transaction).toHaveBeenCalledExactlyOnceWith(snapshotOptions.store, "readonly");
		expect(fake.database.close).toHaveBeenCalledOnce();
		expect(fake.database.createObjectStore).not.toHaveBeenCalled();
	});

	it.each([false, true])("keeps a missing record uninitialized (database missing: %s)", async (missingDatabase) => {
		const fake = fakeRecoveryDatabase(undefined, { missingDatabase, missingKey: true });
		expect(await serializedObserver(fake.factory)(snapshotOptions)).toEqual({
			kind: "uninitialized",
			transactionCommitted: !missingDatabase,
		});
		if (missingDatabase) expect(fake.factory.open).not.toHaveBeenCalled();
		expect(fake.database.createObjectStore).not.toHaveBeenCalled();
	});

	it("reports request failure as unavailable without confirming a transaction", async () => {
		const fake = fakeRecoveryDatabase("synthetic contents", { failure: "request" });
		expect(await serializedObserver(fake.factory)(snapshotOptions)).toEqual({
			kind: "unavailable",
			transactionCommitted: false,
		});
		expect(fake.transaction.abort).toHaveBeenCalledOnce();
		expect(fake.database.close).toHaveBeenCalledOnce();
	});

	it("rejects a corrupt value and bounds raw bytes before returning from the fresh realm", async () => {
		const corrupt = fakeRecoveryDatabase(undefined);
		expect(await serializedObserver(corrupt.factory)(snapshotOptions)).toEqual({
			kind: "invalid",
			transactionCommitted: false,
		});
		const oversized = fakeRecoveryDatabase("x".repeat(snapshotOptions.maxBytes / 2 + 1));
		expect(await serializedObserver(oversized.factory)(snapshotOptions)).toEqual({
			kind: "limit",
			storageBytes: snapshotOptions.maxBytes + 2,
			transactionCommitted: false,
		});
		expect(oversized.database.close).toHaveBeenCalledOnce();
	});

	it("preserves the deadline when a fresh-realm transaction never acknowledges", async () => {
		vi.useFakeTimers();
		const fake = fakeRecoveryDatabase("synthetic contents", { complete: false });
		const reading = serializedObserver(fake.factory)(snapshotOptions);
		await vi.advanceTimersByTimeAsync(snapshotOptions.timeoutMs + 1);
		expect(await reading).toEqual({ kind: "unavailable", transactionCommitted: false });
		expect(fake.transaction.abort).toHaveBeenCalledOnce();
		expect(fake.database.close).toHaveBeenCalledOnce();
	});
});

describe("read-only committed IndexedDB recovery receipts", () => {
	it("waits for read transaction completion after cursor success and uses only the fixed readonly store/key", async () => {
		const raw = JSON.stringify({ schemaVersion: 1, drafts: [] });
		const fake = fakeRecoveryDatabase(raw, { complete: false });
		let settled = false;
		const reading = readDesktopRecoverySnapshot(snapshotOptions).then((result) => {
			settled = true;
			return result;
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(fake.request.onsucceeded).toBe(true);
		expect(settled).toBe(false);
		expect(fake.factory.open).toHaveBeenCalledExactlyOnceWith(snapshotOptions.database, snapshotOptions.version);
		expect(fake.database.transaction).toHaveBeenCalledExactlyOnceWith(snapshotOptions.store, "readonly");
		expect(fake.store.openCursor).toHaveBeenCalledExactlyOnceWith(snapshotOptions.key);
		fake.transaction.oncomplete?.();
		expect(await reading).toEqual({ kind: "read", raw, transactionCommitted: true });
		expect(fake.database.close).toHaveBeenCalledOnce();
		expect(fake.database.createObjectStore).not.toHaveBeenCalled();
		expect(fake.transaction.abort).not.toHaveBeenCalled();
	});

	it("does not create a missing database or fall back to a populated legacy record", async () => {
		const fake = fakeRecoveryDatabase(undefined, { missingDatabase: true });
		const legacy = { getItem: vi.fn(() => JSON.stringify({ schemaVersion: 1, drafts: [] })) };
		vi.stubGlobal("localStorage", legacy);
		expect(await readDesktopRecoverySnapshot(snapshotOptions)).toEqual({
			kind: "uninitialized",
			transactionCommitted: false,
		});
		expect(fake.factory.open).not.toHaveBeenCalled();
		expect(legacy.getItem).not.toHaveBeenCalled();
	});

	it("distinguishes missing key, corrupt present undefined, and a committed empty record", async () => {
		fakeRecoveryDatabase(undefined, { missingKey: true });
		expect(await readDesktopRecoverySnapshot(snapshotOptions)).toEqual({
			kind: "uninitialized",
			transactionCommitted: true,
		});
		fakeRecoveryDatabase(undefined);
		expect(await readDesktopRecoverySnapshot(snapshotOptions)).toEqual({
			kind: "invalid",
			transactionCommitted: false,
		});
		const raw = JSON.stringify({ schemaVersion: 1, drafts: [] });
		fakeRecoveryDatabase(raw);
		expect(await readDesktopRecoverySnapshot(snapshotOptions)).toEqual({
			kind: "read",
			raw,
			transactionCommitted: true,
		});
	});

	it.each(["upgrade", "blocked", "open", "request", "transaction", "abort"] as const)(
		"never acknowledges %s failure",
		async (failure) => {
			const fake = fakeRecoveryDatabase("synthetic", { failure });
			expect(await readDesktopRecoverySnapshot(snapshotOptions)).toEqual({
				kind: "unavailable",
				transactionCommitted: false,
			});
			expect(fake.database.createObjectStore).not.toHaveBeenCalled();
			if (failure === "upgrade") expect(fake.transaction.abort).toHaveBeenCalledOnce();
			if (["upgrade", "request", "transaction", "abort"].includes(failure))
				expect(fake.database.close).toHaveBeenCalledOnce();
		},
	);

	it.each(["version", "store"] as const)("refuses a different %s without reading or upgrading", async (failure) => {
		const fake = fakeRecoveryDatabase("synthetic", failure === "version" ? { version: 2 } : { missingStore: true });
		expect(await readDesktopRecoverySnapshot(snapshotOptions)).toEqual({
			kind: "unavailable",
			transactionCommitted: false,
		});
		expect(fake.store.openCursor).not.toHaveBeenCalled();
		expect(fake.database.createObjectStore).not.toHaveBeenCalled();
	});

	it("bounds large values in the renderer before any raw contents cross its bridge", async () => {
		const fake = fakeRecoveryDatabase("x".repeat(1024 * 1024 + 1));
		const { page } = recoveryPage(null);
		let transported: unknown;
		vi.mocked(
			page.evaluate<Awaited<ReturnType<typeof readDesktopRecoverySnapshot>>, DesktopRecoverySnapshotOptions>,
		).mockImplementation(async (reader, options) => {
			if (typeof reader !== "function") throw new Error("Expected the serialized recovery observer callback.");
			const result = await reader(options);
			transported = result;
			return result;
		});
		const evidence = await readDesktopFileRecoveryEvidence(page, recoveryTarget);
		expect(transported).toEqual({ kind: "limit", storageBytes: 2 * 1024 * 1024 + 2, transactionCommitted: false });
		expect(evidence).toMatchObject({
			status: "limit",
			fixtureEntryCount: null,
			transactionCommitted: false,
			storageBytes: 2 * 1024 * 1024 + 2,
		});
		expect(fake.transaction.abort).toHaveBeenCalledOnce();
		expect(fake.database.close).toHaveBeenCalledOnce();
	});

	it("aborts a read that never completes and does not promote request success into an acknowledgement", async () => {
		vi.useFakeTimers();
		const fake = fakeRecoveryDatabase(JSON.stringify({ schemaVersion: 1, drafts: [] }), { complete: false });
		const reading = readDesktopRecoverySnapshot(snapshotOptions);
		await vi.advanceTimersByTimeAsync(4_001);
		expect(await reading).toEqual({ kind: "unavailable", transactionCommitted: false });
		expect(fake.transaction.abort).toHaveBeenCalledOnce();
		expect(fake.database.close).toHaveBeenCalledOnce();
	});

	it("requires a unique ready controller both before and after the storage read", async () => {
		const { page, state } = recoveryPage(JSON.stringify({ schemaVersion: 1, drafts: [] }));
		const sequence: string[] = [];
		vi.mocked(page.getByTestId).mockImplementation(
			() =>
				({
					count: async () => 1,
					getAttribute: async () => {
						sequence.push("state");
						return sequence.length === 1 ? "pending" : "ready";
					},
				}) as unknown as Locator,
		);
		vi.mocked(page.evaluate).mockImplementation(async () => {
			sequence.push("read");
			return { kind: "read", raw: state.raw, transactionCommitted: true };
		});
		expect(await readDesktopFileRecoveryEvidence(page, recoveryTarget)).toMatchObject({
			recoveryStateBefore: "pending",
			recoveryState: "ready",
			transactionCommitted: true,
		});
		expect(sequence).toEqual(["state", "read", "state"]);
		state.statusNodes = 0;
		vi.mocked(page.getByTestId).mockReturnValue({ count: async () => 0 } as unknown as Locator);
		expect(await readDesktopFileRecoveryEvidence(page, recoveryTarget)).toMatchObject({
			recoveryState: "unknown",
			recoveryStateBefore: "unknown",
		});
	});

	it("waits past source success and empty committed data until the controller is ready, source matches and editor is clean", async () => {
		vi.useFakeTimers();
		const { page, state } = recoveryPage(JSON.stringify({ schemaVersion: 1, drafts: [] }));
		state.unsaved = false;
		state.recoveryState = "pending";
		vi.mocked(readFile).mockResolvedValue(Buffer.from("different source"));
		let settled = false;
		const checking = verifyDesktopSavedFixture(
			page,
			{ ...recoveryTarget, identitySha256: "a".repeat(64) },
			"/synthetic/evidence",
		).then((result) => {
			settled = true;
			return result;
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(settled).toBe(false);
		vi.mocked(readFile).mockResolvedValue(Buffer.from(draftContents));
		await vi.advanceTimersByTimeAsync(100);
		expect(settled).toBe(false);
		state.recoveryState = "ready";
		state.unsaved = true;
		await vi.advanceTimersByTimeAsync(100);
		expect(settled).toBe(false);
		state.unsaved = false;
		state.saveDisabled = false;
		await vi.advanceTimersByTimeAsync(100);
		expect(settled).toBe(false);
		state.saveDisabled = true;
		await vi.advanceTimersByTimeAsync(100);
		expect(await checking).toMatchObject({
			transactionCommitted: true,
			recoveryStateBefore: "ready",
			recoveryState: "ready",
			sourceMatches: true,
			saveDisabled: true,
		});
	});

	it("never acknowledges missing/uninitialized storage even when the source and editor look saved", async () => {
		vi.useFakeTimers();
		const { page, state } = recoveryPage(null);
		state.unsaved = false;
		vi.mocked(readFile).mockResolvedValue(Buffer.from(draftContents));
		const checking = verifyDesktopSavedFixture(
			page,
			{ ...recoveryTarget, identitySha256: "a".repeat(64) },
			"/synthetic/evidence",
		);
		const rejected = expect(checking).rejects.toThrow("Save acknowledgement");
		await vi.advanceTimersByTimeAsync(25_100);
		await rejected;
		expect(writeJsonAtomic).toHaveBeenCalledWith(
			"/synthetic/evidence/renderer-file-recovery-after-save.json",
			expect.objectContaining({
				evidence: expect.objectContaining({ status: "uninitialized", transactionCommitted: true }),
			}),
		);
	});
});

function checkpoint(rendererPid: number): DesktopRendererCheckpoint {
	return {
		app: { pid: 50_001, parentPid: 10, startedAt: "Thu Oct  1 14:50:00 2026", command: "synthetic packaged app" },
		helper: {
			pid: 50_002,
			parentPid: 50_001,
			startedAt: "Thu Oct  1 14:50:01 2026",
			command: "synthetic owned helper",
		},
		runtime: {
			version: 1,
			phase: "ready",
			appPid: 50_001,
			helperPid: 50_002,
			generation: "synthetic-generation",
			runtimeOrigin: "http://127.0.0.1:45678",
		},
		windowId: 1,
		rendererPid,
	};
}

describe("packaged renderer crash evidence", () => {
	it("accepts a replaced renderer only when the exact app and helper survive", () => {
		expect(() => assertDesktopRendererRecovery(checkpoint(50_003), checkpoint(50_004))).not.toThrow();
	});

	it.each(["app", "helper"] as const)("rejects a reused %s PID with a different process birth or command", (owner) => {
		const after = checkpoint(50_004);
		after[owner].startedAt = "Thu Oct  1 14:51:00 2026";
		expect(() => assertDesktopRendererRecovery(checkpoint(50_003), after)).toThrow("original desktop runtime");
		after[owner].startedAt = checkpoint(50_003)[owner].startedAt;
		after[owner].command = "replacement process";
		expect(() => assertDesktopRendererRecovery(checkpoint(50_003), after)).toThrow("original desktop runtime");
	});

	it.each(["generation", "runtimeOrigin", "helperPid", "appPid", "phase"] as const)(
		"rejects changed runtime %s despite an otherwise successful renderer recreation",
		(field) => {
			const after = checkpoint(50_004);
			if (field === "generation") after.runtime.generation = "new-generation";
			if (field === "runtimeOrigin") after.runtime.runtimeOrigin = "http://127.0.0.1:45679";
			if (field === "helperPid") after.runtime.helperPid = 50_099;
			if (field === "appPid") after.runtime.appPid = 50_099;
			if (field === "phase") after.runtime.phase = "failed";
			expect(() => assertDesktopRendererRecovery(checkpoint(50_003), after)).toThrow("original desktop runtime");
		},
	);

	it.each([50_003, 0, Number.NaN, 1.5])("rejects unchanged or invalid renderer identity %s", (rendererPid) => {
		expect(() => assertDesktopRendererRecovery(checkpoint(50_003), checkpoint(rendererPid))).toThrow(
			"actual renderer process replacement",
		);
	});
});

describe("automatic desktop draft recovery review", () => {
	function review(contents = "synthetic exact draft") {
		const actions: string[] = [];
		const dialog = {
			waitFor: vi.fn(async ({ state }: { state: string }) => {
				actions.push(state);
			}),
			getByRole: vi.fn((role: string, options: { name: string; exact: boolean }) => {
				if (role === "textbox" && options.name === "Unsaved contents of example.ts" && options.exact)
					return { inputValue: async () => contents };
				if (role === "button" && options.name === "Close" && options.exact)
					return {
						click: async () => {
							actions.push("close");
						},
					};
				throw new Error("Unexpected recovery action");
			}),
		};
		const page = { getByRole: vi.fn(() => dialog) } as unknown as Page;
		const verifySource = vi.fn(async () => {
			actions.push("source-unchanged");
		});
		return { page, actions, verifySource };
	}

	it("verifies the exact recovered draft and unchanged disk before closing without a write or discard", async () => {
		const state = review();
		await closeDesktopRecoveredDraftReview(state.page, "synthetic exact draft", state.verifySource);
		expect(state.actions).toEqual(["visible", "source-unchanged", "close", "hidden", "source-unchanged"]);
		expect(state.page.getByRole).toHaveBeenCalledWith("dialog", { name: "Unsaved files", exact: true });
	});

	it("refuses to close a changed or lost recovered draft", async () => {
		const state = review("different draft");
		await expect(
			closeDesktopRecoveredDraftReview(state.page, "synthetic exact draft", state.verifySource),
		).rejects.toThrow("lost or changed");
		expect(state.actions).toEqual(["visible"]);
	});

	it("refuses to close when the original file was written before recovery", async () => {
		const state = review();
		state.verifySource.mockRejectedValueOnce(new Error("source changed"));
		await expect(
			closeDesktopRecoveredDraftReview(state.page, "synthetic exact draft", state.verifySource),
		).rejects.toThrow("source changed");
		expect(state.actions).toEqual(["visible"]);
	});
});
