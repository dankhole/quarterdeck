import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { z } from "zod";
import {
	FILE_EDITOR_RECOVERY_DATABASE,
	FILE_EDITOR_RECOVERY_DATABASE_VERSION,
	FILE_EDITOR_RECOVERY_OBJECT_STORE,
	FILE_EDITOR_RECOVERY_SNAPSHOT_KEY,
} from "../../src/shared/file-editor-recovery-storage-contract.js";
import { type DesktopLabDriver, withDesktopDeadline } from "./desktop-driver";
import type { DesktopEvaluationModule } from "./desktop-evaluation-types";
import { listDesktopProcesses, sameDesktopProcess } from "./desktop-processes";
import { type DesktopLabProcess, type DesktopProcessEvidence, DesktopProcessEvidenceSchema } from "./desktop-types";
import { writeJsonAtomic } from "./paths";

export const DESKTOP_FILE_RECOVERY_BACKEND = Object.freeze({
	kind: "indexeddb" as const,
	database: FILE_EDITOR_RECOVERY_DATABASE,
	version: FILE_EDITOR_RECOVERY_DATABASE_VERSION,
	store: FILE_EDITOR_RECOVERY_OBJECT_STORE,
	key: FILE_EDITOR_RECOVERY_SNAPSHOT_KEY,
});
type RecoveryState = "loading" | "pending" | "ready" | "error" | "unknown";
export interface DesktopRecoverySnapshotOptions {
	database: string;
	version: number;
	store: string;
	key: string;
	maxBytes: number;
	timeoutMs: number;
}
type DesktopRecoverySnapshot =
	| { kind: "read"; raw: string; transactionCommitted: true }
	| { kind: "uninitialized"; transactionCommitted: boolean }
	| { kind: "invalid" | "unavailable"; transactionCommitted: false }
	| { kind: "limit"; storageBytes: number; transactionCommitted: false };

// The root harness is Node-only. Describe this observer's browser port without
// importing ambient DOM globals into the runtime/npm TypeScript program.
type RecoveryIDBHandler = (() => void) | null;
interface RecoveryIDBRequest<Result> {
	readonly result: Result;
	onsuccess: RecoveryIDBHandler;
	onerror: RecoveryIDBHandler;
}
interface RecoveryIDBTransaction {
	onabort: RecoveryIDBHandler;
	oncomplete: RecoveryIDBHandler;
	onerror: RecoveryIDBHandler;
	abort(): void;
	objectStore(name: string): {
		openCursor(key: string): RecoveryIDBRequest<{ readonly key: unknown; readonly value: unknown } | null>;
	};
}
interface RecoveryIDBDatabase {
	readonly version: number;
	readonly objectStoreNames: { contains(name: string): boolean };
	transaction(store: string, mode: "readonly"): RecoveryIDBTransaction;
	close(): void;
}
interface RecoveryIDBFactory {
	databases(): Promise<Array<{ name?: string; version?: number }>>;
	open(
		name: string,
		version: number,
	): RecoveryIDBRequest<RecoveryIDBDatabase> & {
		readonly transaction: RecoveryIDBTransaction | null;
		onblocked: RecoveryIDBHandler;
		onupgradeneeded: RecoveryIDBHandler;
	};
}

/** Serialized into the renderer: observe only an existing fixed store, never upgrade or write. */
export function readDesktopRecoverySnapshot(options: DesktopRecoverySnapshotOptions): Promise<DesktopRecoverySnapshot> {
	return new Promise((resolve) => {
		let settled = false;
		let database: RecoveryIDBDatabase | undefined;
		let transaction: RecoveryIDBTransaction | undefined;
		// Object methods retain their native names without TSX's module-level
		// __name helper, so this callback can be serialized into a fresh renderer.
		const completion = {
			finish(result: DesktopRecoverySnapshot) {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (!result.transactionCommitted) {
					try {
						transaction?.abort();
					} catch {
						/* Already settled. */
					}
				}
				try {
					database?.close();
				} catch {
					result = { kind: "unavailable", transactionCommitted: false };
				}
				resolve(result);
			},
			fail() {
				completion.finish({ kind: "unavailable", transactionCommitted: false });
			},
		};
		const timer = setTimeout(completion.fail, options.timeoutMs);
		void (async () => {
			const factory = (globalThis as typeof globalThis & { indexedDB?: RecoveryIDBFactory }).indexedDB;
			if (!factory || typeof factory.databases !== "function") {
				completion.fail();
				return;
			}
			const existing = (await factory.databases()).filter((entry) => entry.name === options.database);
			if (settled) return;
			if (existing.length === 0) {
				completion.finish({ kind: "uninitialized", transactionCommitted: false });
				return;
			}
			if (existing.length !== 1 || existing[0].version !== options.version) {
				completion.fail();
				return;
			}
			const opening = factory.open(options.database, options.version);
			opening.onblocked = completion.fail;
			opening.onerror = completion.fail;
			opening.onupgradeneeded = () => {
				// A delete/open race must never commit a newly created database or schema.
				try {
					opening.transaction?.abort();
				} catch {
					/* No writable transaction admitted. */
				}
				try {
					opening.result.close();
				} catch {
					/* Opening may already have failed. */
				}
				completion.fail();
			};
			opening.onsuccess = () => {
				const opened = opening.result;
				if (settled) {
					opened.close();
					return;
				}
				database = opened;
				if (opened.version !== options.version || !opened.objectStoreNames.contains(options.store)) {
					completion.fail();
					return;
				}
				try {
					transaction = opened.transaction(options.store, "readonly");
					let result: DesktopRecoverySnapshot | undefined;
					transaction.onabort = completion.fail;
					transaction.onerror = completion.fail;
					transaction.oncomplete = () =>
						completion.finish(result ?? { kind: "unavailable", transactionCommitted: false });
					const request = transaction.objectStore(options.store).openCursor(options.key);
					request.onerror = completion.fail;
					request.onsuccess = () => {
						const cursor = request.result;
						if (cursor === null) {
							result = { kind: "uninitialized", transactionCommitted: true };
							return;
						}
						const raw: unknown = cursor.value;
						if (cursor.key !== options.key || typeof raw !== "string") {
							completion.finish({ kind: "invalid", transactionCommitted: false });
							return;
						}
						const storageBytes = raw.length * 2;
						if (storageBytes > options.maxBytes) {
							completion.finish({ kind: "limit", storageBytes, transactionCommitted: false });
							return;
						}
						result = { kind: "read", raw, transactionCommitted: true };
					};
				} catch {
					completion.fail();
				}
			};
		})().catch(completion.fail);
	});
}
const MAX_RECOVERY_BYTES = 2 * 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const DesktopSavedFixtureSchema = z.object({ identitySha256: digest, contentSha256: digest }).strict();
export type DesktopSavedFixture = z.infer<typeof DesktopSavedFixtureSchema>;

// Match the existing recovery envelope, rejecting unreadable evidence instead of
// treating it as an empty snapshot. This observer never changes renderer storage.
const recoveryText = z
	.string()
	.min(1)
	.max(4096)
	.refine((value) => !value.includes("\0"));
const recoverySnapshotSchema = z
	.object({
		schemaVersion: z.literal(1),
		drafts: z
			.array(
				z
					.object({
						id: recoveryText,
						scopeKey: recoveryText,
						scope: z
							.object({
								projectId: recoveryText,
								taskId: recoveryText.nullable(),
								taskCreatedAt: z.number().finite().nonnegative().optional(),
								rootPath: recoveryText.refine((value) => value.startsWith("/")),
							})
							.strict()
							.refine((scope) => scope.taskId === null || scope.taskCreatedAt !== undefined),
						tab: z
							.object({
								path: recoveryText.refine(
									(value) =>
										!value.startsWith("/") &&
										!value.includes("\\") &&
										value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
								),
								value: z.string(),
								savedValue: z.string(),
								contentHash: z.string().max(4096).nullable(),
								language: z.string().max(256),
								binary: z.literal(false),
								truncated: z.literal(false),
								editable: z.boolean(),
								editBlockedReason: z.string().max(4096).nullable(),
								size: z.number().finite().nonnegative(),
							})
							.strict(),
						updatedAt: z.number().finite().nonnegative(),
					})
					.strict(),
			)
			.max(32),
	})
	.strict();

export interface DesktopFileRecoveryTarget {
	projectPath: string;
	projectId?: string;
	contentSha256: string;
	identitySha256?: string;
}

export function projectDesktopFileRecovery(raw: string | null, target: DesktopFileRecoveryTarget, now = Date.now()) {
	const empty = {
		storageBytes: raw === null ? 0 : raw.length * 2,
		draftCount: null as number | null,
		expiredCount: null as number | null,
		fixtureEntryCount: null as number | null,
		fixtureIdentitySha256: target.identitySha256 ?? null,
		fixtureIdentityMatches: null as boolean | null,
		fixtureContentMatchCount: null as number | null,
		fixtureSavedContentMatchCount: null as number | null,
	};
	if (empty.storageBytes > MAX_RECOVERY_BYTES) return { ...empty, status: "limit" as const };
	if (raw === null) return { ...empty, status: "uninitialized" as const };
	let parsed: z.infer<typeof recoverySnapshotSchema>;
	try {
		parsed = recoverySnapshotSchema.parse(JSON.parse(raw));
	} catch {
		return { ...empty, status: "invalid" as const };
	}
	if (
		new Set(parsed.drafts.map((draft) => draft.id)).size !== parsed.drafts.length ||
		parsed.drafts.some((draft) => draft.updatedAt > now + 300_000 || draft.tab.value === draft.tab.savedValue)
	)
		return { ...empty, status: "invalid" as const };
	if (parsed.drafts.some((draft) => JSON.stringify(draft).length * 2 > 512 * 1024))
		return { ...empty, status: "limit" as const };
	const drafts = parsed.drafts.filter((draft) => now - draft.updatedAt <= 30 * 24 * 60 * 60 * 1000);
	const candidates = drafts.filter(
		(draft) =>
			draft.scope.taskId === null && draft.scope.rootPath === target.projectPath && draft.tab.path === "example.ts",
	);
	const identity = (draft: (typeof candidates)[number]) =>
		createHash("sha256")
			.update(JSON.stringify([draft.scope.projectId, draft.scope.taskId, draft.scope.rootPath, draft.tab.path]))
			.digest("hex");
	const fixture = candidates.filter(
		(draft) =>
			(!target.projectId || draft.scope.projectId === target.projectId) &&
			(!target.identitySha256 || identity(draft) === target.identitySha256),
	);
	return {
		...empty,
		status: "valid" as const,
		draftCount: drafts.length,
		expiredCount: parsed.drafts.length - drafts.length,
		fixtureEntryCount: fixture.length,
		fixtureIdentitySha256: target.identitySha256 ?? (fixture.length === 1 ? identity(fixture[0]) : null),
		fixtureIdentityMatches: target.identitySha256
			? candidates.every((draft) => identity(draft) === target.identitySha256)
			: null,
		fixtureContentMatchCount: fixture.filter(
			(draft) => createHash("sha256").update(draft.tab.value).digest("hex") === target.contentSha256,
		).length,
		fixtureSavedContentMatchCount: fixture.filter(
			(draft) => createHash("sha256").update(draft.tab.savedValue).digest("hex") === target.contentSha256,
		).length,
	};
}

async function readRecoveryState(page: Page): Promise<RecoveryState> {
	const status = page.getByTestId("file-editor-recovery-status");
	if ((await status.count()) !== 1) return "unknown";
	const state = await status.getAttribute("data-state");
	return state === "loading" || state === "pending" || state === "ready" || state === "error" ? state : "unknown";
}

export async function readDesktopFileRecoveryEvidence(page: Page, target: DesktopFileRecoveryTarget) {
	let productDocumentVerified = false;
	const observe = async () => {
		await page.waitForURL(/^app:\/\/quarterdeck\/(?!__desktop\/)/, { timeout: 10_000 });
		productDocumentVerified = true;
		const recoveryStateBefore = await readRecoveryState(page);
		const snapshot = await page.evaluate(readDesktopRecoverySnapshot, {
			...DESKTOP_FILE_RECOVERY_BACKEND,
			maxBytes: MAX_RECOVERY_BYTES,
			timeoutMs: 4_000,
		});
		const [unsavedBadgeVisible, recoveryDialogVisible, recoveryState] = await Promise.all([
			page.getByText("Unsaved", { exact: true }).first().isVisible(),
			page.getByRole("dialog", { name: "Unsaved files", exact: true }).isVisible(),
			readRecoveryState(page),
		]);
		const projection =
			snapshot.kind === "read"
				? projectDesktopFileRecovery(snapshot.raw, target)
				: {
						...projectDesktopFileRecovery(null, target),
						status: snapshot.kind,
						storageBytes:
							snapshot.kind === "limit" ? snapshot.storageBytes : snapshot.kind === "unavailable" ? null : 0,
					};
		return {
			observedAt: new Date().toISOString(),
			productDocumentVerified,
			storageBackend: DESKTOP_FILE_RECOVERY_BACKEND,
			transactionCommitted: snapshot.transactionCommitted,
			...projection,
			recoveryStateBefore,
			recoveryState,
			unsavedBadgeVisible,
			recoveryDialogVisible,
		};
	};
	try {
		return await withDesktopDeadline(observe(), "Renderer recovery storage observation", 15_000);
	} catch {
		return {
			observedAt: new Date().toISOString(),
			productDocumentVerified,
			storageBackend: DESKTOP_FILE_RECOVERY_BACKEND,
			transactionCommitted: false,
			...projectDesktopFileRecovery("invalid", target),
			status: "unavailable" as const,
			storageBytes: null,
			recoveryStateBefore: "unknown" as RecoveryState,
			recoveryState: "unknown" as RecoveryState,
			unsavedBadgeVisible: null,
			recoveryDialogVisible: null,
		};
	}
}

/** A missing/uninitialized record cannot acknowledge a committed empty snapshot. */
export function isDesktopFileRecoveryCommittedEmpty(
	evidence: Awaited<ReturnType<typeof readDesktopFileRecoveryEvidence>>,
): boolean {
	return (
		evidence.productDocumentVerified &&
		evidence.status === "valid" &&
		evidence.transactionCommitted &&
		Object.entries(DESKTOP_FILE_RECOVERY_BACKEND).every(
			([key, value]) => evidence.storageBackend[key as keyof typeof DESKTOP_FILE_RECOVERY_BACKEND] === value,
		) &&
		evidence.draftCount === 0 &&
		evidence.expiredCount === 0 &&
		evidence.fixtureEntryCount === 0 &&
		evidence.fixtureIdentityMatches !== false
	);
}

/** Retain the last bounded observation even when the initial dirty copy never acknowledges. */
export async function verifyDesktopInitialDirtyFixture(
	page: Page,
	target: DesktopFileRecoveryTarget,
	artifactDir: string,
): Promise<DesktopSavedFixture> {
	let latest: Awaited<ReturnType<typeof readDesktopFileRecoveryEvidence>> | undefined;
	const category = () => {
		if (!latest) return "unavailable";
		if (latest.status !== "valid") return latest.status;
		if (!latest.transactionCommitted) return "transaction_unconfirmed";
		if (latest.recoveryStateBefore !== "ready" || latest.recoveryState !== "ready") return "controller_not_ready";
		return latest.fixtureEntryCount === 1 &&
			latest.fixtureContentMatchCount === 1 &&
			latest.fixtureIdentitySha256 !== null
			? "acknowledged"
			: "fixture_mismatch";
	};
	const retainObservation = (outcome: "acknowledged" | "incomplete", savedFixture?: DesktopSavedFixture) =>
		writeJsonAtomic(join(artifactDir, "renderer-file-recovery-dirty.json"), {
			observation: "renderer-observed",
			stage: "initial_dirty_snapshot",
			outcome,
			category: category(),
			expectedContentSha256: target.contentSha256,
			...(savedFixture ? { savedFixture } : {}),
			evidence: latest ?? { status: "unavailable" },
		});
	let savedFixture: DesktopSavedFixture;
	try {
		await waitFor(async () => {
			latest = await readDesktopFileRecoveryEvidence(page, target);
			return category() === "acknowledged";
		}, "exact renderer-observed recovery copy");
		savedFixture = DesktopSavedFixtureSchema.parse({
			identitySha256: latest?.fixtureIdentitySha256,
			contentSha256: target.contentSha256,
		});
	} catch (error) {
		await retainObservation("incomplete").catch(() => {});
		throw error;
	}
	await retainObservation("acknowledged", savedFixture);
	return savedFixture;
}

export async function verifyDesktopSavedFixture(
	page: Page,
	target: DesktopFileRecoveryTarget & DesktopSavedFixture,
	artifactDir: string,
) {
	let latest:
		| (Awaited<ReturnType<typeof readDesktopFileRecoveryEvidence>> & {
				sourceMatches: boolean;
				saveDisabled: boolean;
		  })
		| undefined;
	const retainObservation = () =>
		writeJsonAtomic(join(artifactDir, "renderer-file-recovery-after-save.json"), {
			observation: "renderer-observed",
			savedFixture: { identitySha256: target.identitySha256, contentSha256: target.contentSha256 },
			evidence: latest ?? { status: "unavailable" },
		});
	try {
		await waitFor(async () => {
			const storage = await readDesktopFileRecoveryEvidence(page, target);
			const sourceMatches =
				createHash("sha256")
					.update(await readFile(join(target.projectPath, "example.ts")))
					.digest("hex") === target.contentSha256;
			const saveDisabled = await page.getByRole("button", { name: "Save file", exact: true }).isDisabled();
			latest = { ...storage, sourceMatches, saveDisabled };
			return (
				sourceMatches &&
				saveDisabled &&
				storage.unsavedBadgeVisible === false &&
				isDesktopFileRecoveryCommittedEmpty(storage) &&
				storage.recoveryStateBefore === "ready" &&
				storage.recoveryState === "ready"
			);
		}, "explicit Files Save acknowledgement and renderer-observed recovery removal");
	} catch (error) {
		await retainObservation().catch(() => {});
		throw error;
	}
	await retainObservation();
	return latest;
}

/** Hydration can render the review before its initial strict snapshot write is acknowledged. */
export async function verifyDesktopRecoveredDirtyFixture(
	page: Page,
	target: DesktopFileRecoveryTarget & DesktopSavedFixture,
	artifactDir: string,
) {
	let latest: Awaited<ReturnType<typeof readDesktopFileRecoveryEvidence>> | undefined;
	const retainObservation = () =>
		writeJsonAtomic(join(artifactDir, "renderer-file-recovery-after-crash.json"), {
			observation: "renderer-observed-committed-dirty-after-renderer-crash",
			savedFixture: { identitySha256: target.identitySha256, contentSha256: target.contentSha256 },
			evidence: latest ?? { status: "unavailable" },
		});
	try {
		await waitFor(async () => {
			latest = await readDesktopFileRecoveryEvidence(page, target);
			if (
				latest.status !== "valid" ||
				!latest.transactionCommitted ||
				latest.draftCount !== 1 ||
				latest.expiredCount !== 0 ||
				latest.fixtureEntryCount !== 1 ||
				latest.fixtureContentMatchCount !== 1 ||
				latest.fixtureIdentityMatches !== true ||
				latest.recoveryStateBefore === "error" ||
				latest.recoveryState === "error"
			)
				throw new Error("Renderer crash did not preserve the exact acknowledged dirty recovery record.");
			return latest.recoveryStateBefore === "ready" && latest.recoveryState === "ready";
		}, "the recovered dirty fixture's committed acknowledgement");
	} catch (error) {
		await retainObservation().catch(() => {});
		throw error;
	}
	await retainObservation();
	return latest;
}

export interface DesktopRendererCheckpoint {
	app: DesktopLabProcess;
	helper: DesktopLabProcess;
	runtime: DesktopProcessEvidence;
	windowId: number;
	rendererPid: number;
}

/** A recreated window is not evidence that its existing runtime survived. */
export function assertDesktopRendererRecovery(
	before: DesktopRendererCheckpoint,
	after: DesktopRendererCheckpoint,
): void {
	if (
		!sameDesktopProcess(before.app, after.app) ||
		!sameDesktopProcess(before.helper, after.helper) ||
		before.runtime.appPid !== before.app.pid ||
		after.runtime.appPid !== after.app.pid ||
		before.runtime.helperPid !== before.helper.pid ||
		after.runtime.helperPid !== after.helper.pid ||
		before.runtime.phase !== "ready" ||
		after.runtime.phase !== "ready" ||
		!before.runtime.generation ||
		before.runtime.generation !== after.runtime.generation ||
		!before.runtime.runtimeOrigin ||
		before.runtime.runtimeOrigin !== after.runtime.runtimeOrigin
	)
		throw new Error("Renderer recovery replaced or changed the original desktop runtime.");
	if (
		!Number.isSafeInteger(before.rendererPid) ||
		!Number.isSafeInteger(after.rendererPid) ||
		before.rendererPid <= 0 ||
		after.rendererPid <= 0 ||
		before.rendererPid === after.rendererPid
	)
		throw new Error("Renderer recovery did not prove an actual renderer process replacement.");
}

async function waitFor(condition: () => Promise<boolean>, label: string, timeoutMs = 25_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Renderer recovery timed out waiting for ${label}.`);
}

/** Select the fixture through the same SPA project command as a person. */
export async function openDesktopPrimaryProject(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Home", exact: true }).click();
	await page.getByRole("button", { name: "Open project", exact: true }).click();
	await page.locator("section.kb-board").waitFor({ state: "visible" });
}

async function checkpoint(driver: DesktopLabDriver): Promise<DesktopRendererCheckpoint> {
	await driver.markReady();
	const runtime = DesktopProcessEvidenceSchema.parse(
		JSON.parse(await readFile(driver.fixture.config.processEvidencePath, "utf8")) as unknown,
	);
	const processes = await listDesktopProcesses();
	const app = processes.find((item) => item.pid === driver.fixture.manifest.mainPid);
	const helper = processes.find((item) => item.pid === runtime.helperPid);
	if (!app || !helper || runtime.appPid !== app.pid || runtime.helperPid !== driver.fixture.manifest.helperPid)
		throw new Error("Renderer recovery requires the existing verified app and runtime helper.");
	const windows = await driver.app.evaluate(({ BrowserWindow }: DesktopEvaluationModule) =>
		BrowserWindow.getAllWindows().map((window) => ({
			id: window.id,
			rendererPid: window.webContents.getOSProcessId(),
			url: window.webContents.getURL(),
		})),
	);
	const window = windows[0];
	if (windows.length !== 1 || !window || !window.url.startsWith("app://quarterdeck/"))
		throw new Error("Renderer recovery requires exactly one isolated product window.");
	return { app, helper, runtime, windowId: window.id, rendererPid: window.rendererPid };
}

async function sourceMustRemainUnchanged(path: string, original: string, durationMs = 0): Promise<void> {
	const deadline = Date.now() + durationMs;
	let observedAt: number;
	do {
		if ((await readFile(path, "utf8")) !== original)
			throw new Error("Recovered Files draft changed its source before explicit Save.");
		observedAt = Date.now();
		if (observedAt < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
	} while (observedAt < deadline);
}

async function productPage(
	driver: DesktopLabDriver,
	name: "The Quarterdeck window stopped" | "Settings" | "Unsaved files",
): Promise<Page> {
	let selected: Page | undefined;
	await waitFor(
		async () => {
			for (const page of driver.rendererPages()) {
				if (page.isClosed() || !page.url().startsWith("app://quarterdeck/")) continue;
				const locator =
					name === "Settings"
						? page.getByRole("button", { name, exact: true })
						: name === "Unsaved files"
							? page.getByRole("dialog", { name, exact: true })
							: page.getByRole("heading", { name, exact: true });
				if (await locator.isVisible().catch(() => false)) {
					selected = page;
					return true;
				}
			}
			return false;
		},
		name,
		45_000,
	);
	if (!selected) throw new Error("Renderer recovery did not expose its current isolated page.");
	selected.setDefaultTimeout(20_000);
	return selected;
}

/** Dismiss the automatic review without restoring, discarding, or writing its draft. */
export async function closeDesktopRecoveredDraftReview(
	page: Page,
	draft: string,
	verifySource: () => Promise<void>,
): Promise<void> {
	const recovery = page.getByRole("dialog", { name: "Unsaved files", exact: true });
	await recovery.waitFor({ state: "visible" });
	if (
		(await recovery.getByRole("textbox", { name: "Unsaved contents of example.ts", exact: true }).inputValue()) !==
		draft
	)
		throw new Error("Renderer recovery lost or changed the original unsaved Files draft.");
	await verifySource();
	await recovery.getByRole("button", { name: "Close", exact: true }).click();
	await recovery.waitFor({ state: "hidden" });
	await verifySource();
}

export async function exerciseDesktopRendererRecovery(page: Page, driver: DesktopLabDriver): Promise<Page> {
	const sourcePath = join(driver.fixture.config.projectPath, "example.ts");
	const original = await readFile(sourcePath, "utf8");
	const marker = "desktop-renderer-crash-recovery-proof";
	const draft = `${original}\n// ${marker}\n`;
	const index = z
		.object({ entries: z.record(z.string(), z.object({ projectId: recoveryText, repoPath: recoveryText })) })
		.parse(JSON.parse(await readFile(join(driver.fixture.config.stateHome, "projects", "index.json"), "utf8")));
	const matchingProjects = Object.values(index.entries).filter(
		(entry) => entry.repoPath === driver.fixture.config.projectPath,
	);
	if (matchingProjects.length !== 1) throw new Error("Renderer recovery lacks one exact indexed fixture project.");
	const recoveryTarget: DesktopFileRecoveryTarget = {
		projectPath: driver.fixture.config.projectPath,
		projectId: matchingProjects[0].projectId,
		contentSha256: createHash("sha256").update(draft).digest("hex"),
	};
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	const settings = page.getByRole("dialog", { name: "Settings" });
	if ((await settings.getByRole("combobox", { name: "File editor autosave" }).inputValue()) !== "off")
		throw new Error("Renderer recovery fixture must begin with file autosave disabled.");
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Files", exact: true }).click();
	await page.getByRole("button", { name: "example.ts", exact: true }).first().click();
	const editor = page.locator('.cm-content[role="textbox"][contenteditable="true"]');
	await editor.focus();
	await page.keyboard.press("Meta+A");
	await page.keyboard.insertText(draft);
	await waitFor(() => page.getByRole("button", { name: "Save file", exact: true }).isEnabled(), "dirty Files draft");
	const savedFixture = await verifyDesktopInitialDirtyFixture(
		page,
		recoveryTarget,
		driver.fixture.manifest.artifactDir,
	);
	await sourceMustRemainUnchanged(sourcePath, original);
	await driver.inspect("renderer-dirty-draft");
	const before = await checkpoint(driver);
	await Promise.all([
		page.waitForEvent("crash", { timeout: 15_000 }),
		driver.app.evaluate(({ BrowserWindow }: DesktopEvaluationModule, windowId) => {
			const window = BrowserWindow.getAllWindows().find((item) => item.id === windowId);
			if (!window?.webContents.getURL().startsWith("app://quarterdeck/"))
				throw new Error("Cannot crash a window outside the isolated desktop app.");
			window.webContents.forcefullyCrashRenderer();
		}, before.windowId),
	]);
	await driver.reobserveAfterRendererCrash(before.windowId);
	const failedPage = await productPage(driver, "The Quarterdeck window stopped");
	await sourceMustRemainUnchanged(sourcePath, original);
	await driver.inspect("renderer-crashed");
	await failedPage.getByRole("link", { name: "Reload window", exact: true }).click();
	// Hydration opens the recovered-draft review before the product toolbar can
	// participate in accessibility queries. Preserve it until Files owns its workspace.
	const reviewPage = await productPage(driver, "Unsaved files");
	await verifyDesktopRecoveredDirtyFixture(
		reviewPage,
		{ ...recoveryTarget, ...savedFixture },
		driver.fixture.manifest.artifactDir,
	);
	await closeDesktopRecoveredDraftReview(reviewPage, draft, () => sourceMustRemainUnchanged(sourcePath, original));
	const recoveredPage = await productPage(driver, "Settings");
	await openDesktopPrimaryProject(recoveredPage);
	assertDesktopRendererRecovery(before, await checkpoint(driver));
	// Enable the existing delay policy before restoring: recovered text must still
	// require a deliberate Save, even after the ordinary 1.5-second autosave period.
	await recoveredPage.getByRole("button", { name: "Settings", exact: true }).click();
	const recoveredSettings = recoveredPage.getByRole("dialog", { name: "Settings" });
	await recoveredSettings.getByRole("combobox", { name: "File editor autosave" }).selectOption("delay");
	await recoveredSettings.getByRole("button", { name: "Save", exact: true }).click();
	await recoveredSettings.waitFor({ state: "hidden" });
	await recoveredPage.getByRole("button", { name: "Files", exact: true }).click();
	await recoveredPage.getByRole("button", { name: /^Recover unsaved files \(/u }).click();
	const recovery = recoveredPage.getByRole("dialog", { name: "Unsaved files" });
	if (
		(await recovery.getByRole("textbox", { name: "Unsaved contents of example.ts", exact: true }).inputValue()) !==
		draft
	)
		throw new Error("Renderer recovery lost or changed the original unsaved Files draft.");
	await recovery.getByRole("button", { name: "Restore in Files", exact: true }).click();
	await recovery.getByRole("button", { name: "Close", exact: true }).click();
	await recoveredPage.getByRole("button", { name: "example.ts", exact: true }).first().click();
	await waitFor(
		() => recoveredPage.getByRole("button", { name: "Save file", exact: true }).isEnabled(),
		"restored dirty draft",
	);
	await sourceMustRemainUnchanged(sourcePath, original, 2_000);
	await driver.inspect("renderer-draft-restored");
	await recoveredPage.getByRole("button", { name: "Save file", exact: true }).click();
	const afterSave = await verifyDesktopSavedFixture(
		recoveredPage,
		{ ...recoveryTarget, ...savedFixture },
		driver.fixture.manifest.artifactDir,
	);
	const after = await checkpoint(driver);
	assertDesktopRendererRecovery(before, after);
	await writeJsonAtomic(join(driver.fixture.manifest.artifactDir, "renderer-recovery.json"), {
		before,
		after,
		crashObserved: true,
		draftRecovered: true,
		sourceUnchangedBeforeSave: true,
		recoveredDraftIgnoredDelayAutosave: true,
		explicitSaveVerified: true,
		syntheticFile: "example.ts",
		savedFixture,
		afterSave,
	});
	await openDesktopPrimaryProject(recoveredPage);
	return recoveredPage;
}
