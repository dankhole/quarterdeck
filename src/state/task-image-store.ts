// Content-addressed task image storage for one project.
//
// Board cards persist `{ id, name?, mimeType, sha256, byteLength }` references;
// the bytes live at `<project state dir>/images/<sha256>`. Blobs are immutable:
// a write lands in a temporary file that is flushed and renamed into place, so
// readers never observe partial content and hard-linked backups stay valid.
// Board writers externalize under the project state lock before the journal
// commit, so a committed board never references a missing blob.

import { createHash, randomUUID } from "node:crypto";
import { copyFile, link, lstat, mkdir, open, readdir, readFile, rename, unlink, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
	RuntimeBoardData,
	RuntimePersistedBoardData,
	RuntimeTaskImage,
	RuntimeTaskImageInput,
	RuntimeTaskImageRef,
} from "../core";
import { createTaggedLogger, isRuntimeTaskImageRef, normalizeDiagnosticErrorClass } from "../core";
import { isNodeError } from "../fs/node-error";
import { hasPendingProjectStateTransaction } from "./project-state-transaction";
import { getProjectDirectoryPath } from "./project-state-utils";
import { assertRuntimeWriteAdmission, withRuntimeWriteOperation } from "./runtime-write-admission.js";

export const TASK_IMAGES_DIRNAME = "images";
/**
 * Unreferenced blobs younger than this survive collection. Writers hold the
 * project lock through commit, so this only protects against a writer outside
 * that boundary (for example another runtime build) and keeps GC conservative.
 */
export const TASK_IMAGE_GC_GRACE_MS = 10 * 60 * 1000;

const BLOB_FILE_MODE = 0o600;
const BLOB_DIRECTORY_MODE = 0o700;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const log = createTaggedLogger("task-image-store");

/** A command referenced stored bytes that this project does not have. */
export class TaskImageUnavailableError extends Error {
	constructor() {
		super("An attached image is no longer available. Remove or re-attach it and try again.");
		this.name = "TaskImageUnavailableError";
	}
}

/** Inline bytes are intact but could not be written to the project image store. */
export class TaskImageStorageError extends Error {
	constructor(options?: { cause?: unknown }) {
		super(
			"Quarterdeck could not save an attached image to its state folder. Check free disk space and try again.",
			options,
		);
		this.name = "TaskImageStorageError";
	}
}

function toErrorClass(error: unknown): string {
	return error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError";
}

export function isTaskImageSha256(value: string): boolean {
	return SHA256_PATTERN.test(value);
}

export function getProjectTaskImagesPath(projectId: string): string {
	return join(getProjectDirectoryPath(projectId), TASK_IMAGES_DIRNAME);
}

function getTaskImageBlobPath(projectId: string, sha256: string): string {
	if (!isTaskImageSha256(sha256)) throw new Error("Invalid task image hash.");
	return join(getProjectTaskImagesPath(projectId), sha256);
}

function hashBytes(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Matches the decoding the agent launch path has always applied to inline uploads. */
function decodeInlineImage(image: RuntimeTaskImage): Buffer {
	return Buffer.from(image.data, "base64");
}

function toTaskImageRef(image: RuntimeTaskImage, bytes: Buffer): RuntimeTaskImageRef {
	return {
		id: image.id,
		...(image.name !== undefined ? { name: image.name } : {}),
		mimeType: image.mimeType,
		sha256: hashBytes(bytes),
		byteLength: bytes.length,
	};
}

function* iterateBoardImages(board: RuntimeBoardData): Generator<RuntimeTaskImageInput> {
	for (const column of board.columns) {
		for (const card of column.cards) {
			if (card.images) yield* card.images;
		}
	}
}

/** Data-free form of an attachment for retained records; hashes inline bytes without storing them. */
export function toTaskImageReference(image: RuntimeTaskImageInput): RuntimeTaskImageRef {
	return isRuntimeTaskImageRef(image) ? image : toTaskImageRef(image, decodeInlineImage(image));
}

export function boardHasInlineTaskImages(board: RuntimeBoardData): boolean {
	for (const image of iterateBoardImages(board)) {
		if (!isRuntimeTaskImageRef(image)) return true;
	}
	return false;
}

/** Hashes referenced by stored attachments; inline uploads have no stored identity yet. */
export function collectBoardTaskImageHashes(board: RuntimeBoardData): Set<string> {
	const hashes = new Set<string>();
	for (const image of iterateBoardImages(board)) {
		if (isRuntimeTaskImageRef(image)) hashes.add(image.sha256);
	}
	return hashes;
}

function mapBoardImages(
	board: RuntimeBoardData,
	toRef: (image: RuntimeTaskImageInput) => RuntimeTaskImageRef,
): RuntimePersistedBoardData {
	return {
		columns: board.columns.map((column) => ({
			...column,
			cards: column.cards.map((card) => {
				if (!card.images) {
					const { images: _images, ...rest } = card;
					return rest;
				}
				return { ...card, images: card.images.map(toRef) };
			}),
		})),
	};
}

/**
 * Read-only projection for state published from a board that still holds
 * legacy inline data. It computes the same references externalization will
 * persist, without writing, so browsers never receive inline bytes.
 */
export function projectTaskImageRefs(board: RuntimeBoardData): RuntimeBoardData {
	if (!boardHasInlineTaskImages(board)) return board;
	return mapBoardImages(board, (image) =>
		isRuntimeTaskImageRef(image) ? image : toTaskImageRef(image, decodeInlineImage(image)),
	);
}

async function syncPath(path: string, flags: "r" | "r+"): Promise<void> {
	const handle = await open(path, flags);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function syncDirectory(path: string): Promise<void> {
	// Node cannot open directories for fsync on Windows; see project-state-transaction.ts.
	if (process.platform === "win32") return;
	await syncPath(path, "r");
}

/** Creates an owner-only blob directory, flushing its parent entry when it is new. */
async function ensureBlobDirectory(directory: string, assertAdmission: (path: string) => void): Promise<void> {
	assertAdmission(directory);
	const created = await mkdir(directory, { recursive: true, mode: BLOB_DIRECTORY_MODE });
	if (created !== undefined) await syncDirectory(dirname(directory));
}

/** Regular-file bytes, or null when absent or not a plain file (symlinks are never followed). */
async function readRegularFile(path: string): Promise<Buffer | null> {
	try {
		if (!(await lstat(path)).isFile()) return null;
		return await readFile(path);
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return null;
		throw error;
	}
}

async function hasBlobContent(path: string, sha256: string, byteLength?: number): Promise<boolean> {
	try {
		const info = await lstat(path);
		if (!info.isFile() || (byteLength !== undefined && info.size !== byteLength)) return false;
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return false;
		throw error;
	}
	const bytes = await readRegularFile(path);
	return bytes !== null && hashBytes(bytes) === sha256;
}

function toTempPath(path: string): string {
	return `${path}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
}

/** Installs a complete, flushed file by rename; replaces whatever entry held the name. */
async function installFile(
	path: string,
	writeTemp: (tempPath: string) => Promise<void>,
	assertAdmission: (path: string) => void,
): Promise<void> {
	const tempPath = toTempPath(path);
	assertAdmission(path);
	try {
		await writeTemp(tempPath);
		await syncPath(tempPath, "r+");
		assertAdmission(path);
		await rename(tempPath, path);
	} catch (error) {
		await unlink(tempPath).catch(() => undefined);
		throw error;
	}
}

async function writeBlob(directory: string, sha256: string, bytes: Buffer): Promise<void> {
	const path = join(directory, sha256);
	if (await hasBlobContent(path, sha256, bytes.length)) {
		// Refresh the GC grace window for a blob that is about to be referenced again.
		assertRuntimeWriteAdmission(path);
		const now = new Date();
		await utimes(path, now, now);
		return;
	}
	await installFile(
		path,
		async (tempPath) => {
			const handle = await open(tempPath, "wx", BLOB_FILE_MODE);
			try {
				await handle.writeFile(bytes);
			} finally {
				await handle.close();
			}
		},
		assertRuntimeWriteAdmission,
	);
}

/**
 * Requires the project state lock. Durably stores every inline upload, verifies
 * references that are new relative to `knownHashes`, and returns the board in
 * its persisted reference-only form. Throws instead of dropping any bytes.
 */
export async function externalizeBoardTaskImagesUnderLock(
	projectId: string,
	board: RuntimeBoardData,
	knownHashes: ReadonlySet<string>,
): Promise<RuntimePersistedBoardData> {
	const pending = new Map<string, Buffer>();
	const unverified = new Map<string, number>();
	const persisted = mapBoardImages(board, (image) => {
		if (isRuntimeTaskImageRef(image)) {
			if (!knownHashes.has(image.sha256)) {
				const previous = unverified.get(image.sha256);
				if (previous !== undefined && previous !== image.byteLength) throw new TaskImageUnavailableError();
				unverified.set(image.sha256, image.byteLength);
			}
			return image;
		}
		const bytes = decodeInlineImage(image);
		const ref = toTaskImageRef(image, bytes);
		pending.set(ref.sha256, bytes);
		return ref;
	});
	for (const [sha256, byteLength] of unverified) {
		if (pending.get(sha256)?.length === byteLength) continue;
		if (!(await hasBlobContent(getTaskImageBlobPath(projectId, sha256), sha256, byteLength))) {
			throw new TaskImageUnavailableError();
		}
	}
	if (pending.size === 0) return persisted;
	const directory = getProjectTaskImagesPath(projectId);
	try {
		await withRuntimeWriteOperation([directory], async () => {
			await ensureBlobDirectory(directory, assertRuntimeWriteAdmission);
			for (const [sha256, bytes] of pending) {
				await writeBlob(directory, sha256, bytes);
			}
			// Order blob directory entries before the board journal that references them.
			await syncDirectory(directory);
		});
	} catch (error) {
		throw new TaskImageStorageError({ cause: error });
	}
	return persisted;
}

export interface TaskImageCollectionResult {
	removed: number;
	/** Earliest time a retained unreferenced entry becomes collectable, or null when none remains. */
	nextSweepAt: number | null;
}

/**
 * Requires the project state lock and a committed board. Removes blobs no
 * longer referenced by any card, Trash included, plus abandoned temp files.
 * Defers while a state journal is pending and spares entries inside the
 * grace window, reporting when a later sweep can collect them.
 */
export async function collectUnreferencedTaskImagesUnderLock(
	projectId: string,
	board: RuntimeBoardData,
	options: { now?: number; graceMs?: number } = {},
): Promise<TaskImageCollectionResult> {
	const now = options.now ?? Date.now();
	const graceMs = options.graceMs ?? TASK_IMAGE_GC_GRACE_MS;
	// Recovery normally consumes a journal first; never sweep against a commit that is still pending.
	if (await hasPendingProjectStateTransaction(projectId)) return { removed: 0, nextSweepAt: now };
	const directory = getProjectTaskImagesPath(projectId);
	return await withRuntimeWriteOperation([directory], async () => {
		let entries: string[];
		try {
			entries = await readdir(directory);
		} catch (error) {
			if (isNodeError(error, "ENOENT")) return { removed: 0, nextSweepAt: null };
			throw error;
		}
		const referenced = collectBoardTaskImageHashes(board);
		let removed = 0;
		let nextSweepAt: number | null = null;
		for (const entry of entries) {
			const isBlob = isTaskImageSha256(entry);
			if ((isBlob && referenced.has(entry)) || (!isBlob && !entry.includes(".tmp."))) continue;
			const path = join(directory, entry);
			try {
				const collectableAt = (await lstat(path)).mtimeMs + graceMs;
				if (collectableAt > now) {
					nextSweepAt = Math.min(nextSweepAt ?? collectableAt, collectableAt);
					continue;
				}
				assertRuntimeWriteAdmission(path);
				await unlink(path);
				removed += 1;
			} catch (error) {
				if (isNodeError(error, "ENOENT")) continue;
				log.warn("task image collection skipped an entry", { projectId, errorClass: toErrorClass(error) });
			}
		}
		return { removed, nextSweepAt };
	});
}

/** Lock-free: blobs are immutable and installed by atomic rename. */
export async function readTaskImageBlob(projectId: string, sha256: string): Promise<Buffer | null> {
	const bytes = await readRegularFile(getTaskImageBlobPath(projectId, sha256));
	if (bytes === null) return null;
	if (hashBytes(bytes) !== sha256) {
		log.warn("task image blob failed integrity check", { projectId });
		return null;
	}
	return bytes;
}

/**
 * Read-only fallback for a board that still holds legacy inline data: the
 * published reference exists before the first runtime write stores its blob.
 */
export function findInlineTaskImageBytes(board: RuntimeBoardData, sha256: string): Buffer | null {
	for (const image of iterateBoardImages(board)) {
		if (isRuntimeTaskImageRef(image)) continue;
		const bytes = decodeInlineImage(image);
		if (hashBytes(bytes) === sha256) return bytes;
	}
	return null;
}

/** Resolves card attachments into the inline bytes the agent launch path writes to temp files. */
export async function loadTaskImagesForLaunch(
	projectId: string,
	images: readonly RuntimeTaskImageInput[] | undefined,
): Promise<RuntimeTaskImage[] | undefined> {
	if (!images || images.length === 0) return undefined;
	return await Promise.all(
		images.map(async (image): Promise<RuntimeTaskImage> => {
			if (!isRuntimeTaskImageRef(image)) return image;
			const bytes = await readTaskImageBlob(projectId, image.sha256);
			if (!bytes) throw new TaskImageUnavailableError();
			return {
				id: image.id,
				data: bytes.toString("base64"),
				mimeType: image.mimeType,
				...(image.name !== undefined ? { name: image.name } : {}),
			};
		}),
	);
}

const LINK_FALLBACK_ERROR_CODES = ["EXDEV", "EPERM", "ENOTSUP", "EMLINK"];

/**
 * Mirrors immutable blobs between a project image store and a backup without
 * duplicating bytes on the same filesystem; copies across devices. Sources must
 * be regular files (macOS link() follows symlinks); `verifySource` also checks
 * each source hash. An existing target is kept only when its content matches.
 */
export async function linkTaskImageBlobs(
	sourceDirectory: string,
	targetDirectory: string,
	options: { admissionPath?: string; verifySource?: boolean } = {},
): Promise<number> {
	const assertAdmission = (path: string) => {
		assertRuntimeWriteAdmission(path);
		if (options.admissionPath) assertRuntimeWriteAdmission(options.admissionPath);
	};
	let entries: string[];
	try {
		entries = await readdir(sourceDirectory);
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return 0;
		throw error;
	}
	const blobs = entries.filter(isTaskImageSha256);
	if (blobs.length === 0) return 0;
	const admissionPaths = [targetDirectory, ...(options.admissionPath ? [options.admissionPath] : [])];
	return await withRuntimeWriteOperation(admissionPaths, async () => {
		await ensureBlobDirectory(targetDirectory, assertAdmission);
		let linked = 0;
		for (const blob of blobs) {
			const source = join(sourceDirectory, blob);
			const target = join(targetDirectory, blob);
			const sourceInfo = await lstat(source).catch((error: unknown) => {
				if (isNodeError(error, "ENOENT")) return null;
				throw error;
			});
			if (!sourceInfo?.isFile() || (options.verifySource && !(await hasBlobContent(source, blob)))) {
				if (sourceInfo)
					log.warn("task image blob skipped: not a verified regular file", { errorClass: "InvalidBlob" });
				continue;
			}
			if (await hasBlobContent(target, blob, sourceInfo.size)) continue;
			const copy = async () =>
				await installFile(target, async (tempPath) => await copyFile(source, tempPath), assertAdmission);
			let targetExists = false;
			try {
				await lstat(target);
				targetExists = true;
			} catch (error) {
				if (!isNodeError(error, "ENOENT")) throw error;
			}
			if (targetExists) {
				// A corrupt or foreign entry holds the name; replace it atomically.
				await copy();
			} else {
				try {
					assertAdmission(target);
					await link(source, target);
				} catch (error) {
					if (isNodeError(error, "EEXIST") || LINK_FALLBACK_ERROR_CODES.some((code) => isNodeError(error, code))) {
						await copy();
					} else if (isNodeError(error, "ENOENT")) {
						continue;
					} else {
						throw error;
					}
				}
			}
			linked += 1;
		}
		await syncDirectory(targetDirectory);
		return linked;
	});
}
