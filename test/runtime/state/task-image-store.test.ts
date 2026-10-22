import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeBoardData, RuntimeTaskImage } from "../../../src/core";
import { getProjectStateTransactionPath } from "../../../src/state/project-state-transaction";
import {
	collectUnreferencedTaskImagesUnderLock,
	externalizeBoardTaskImagesUnderLock,
	findInlineTaskImageBytes,
	getProjectTaskImagesPath,
	linkTaskImageBlobs,
	loadTaskImagesForLaunch,
	projectTaskImageRefs,
	readTaskImageBlob,
	TASK_IMAGE_GC_GRACE_MS,
	TaskImageUnavailableError,
} from "../../../src/state/task-image-store";
import { createTempDir } from "../../utilities/temp-dir";

const projectId = "project-images";
const originalStateHome = process.env.QUARTERDECK_STATE_HOME;
let fixture: ReturnType<typeof createTempDir>;

const pngBytes = Buffer.from("synthetic-png-bytes");
const pngSha = createHash("sha256").update(pngBytes).digest("hex");
const inlinePng: RuntimeTaskImage = {
	id: "img-1",
	name: "shot.png",
	mimeType: "image/png",
	data: pngBytes.toString("base64"),
};

function boardWith(...cards: Array<{ id: string; column?: "review" | "trash"; images?: unknown[] }>): RuntimeBoardData {
	const card = (id: string, images?: unknown[]) => ({
		id,
		title: null,
		prompt: `Prompt ${id}`,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...(images ? { images: images as RuntimeBoardData["columns"][number]["cards"][number]["images"] } : {}),
	});
	return {
		columns: [
			{
				id: "review",
				title: "Review",
				cards: cards.filter((entry) => entry.column !== "trash").map((entry) => card(entry.id, entry.images)),
			},
			{
				id: "trash",
				title: "Trash",
				cards: cards.filter((entry) => entry.column === "trash").map((entry) => card(entry.id, entry.images)),
			},
		],
	};
}

function ageBlob(sha256: string, ageMs = TASK_IMAGE_GC_GRACE_MS + 60_000): void {
	const old = new Date(Date.now() - ageMs);
	utimesSync(join(getProjectTaskImagesPath(projectId), sha256), old, old);
}

beforeEach(() => {
	fixture = createTempDir("quarterdeck-task-images-");
	process.env.QUARTERDECK_STATE_HOME = join(fixture.path, "state");
});

afterEach(() => {
	fixture.cleanup();
	if (originalStateHome === undefined) delete process.env.QUARTERDECK_STATE_HOME;
	else process.env.QUARTERDECK_STATE_HOME = originalStateHome;
});

describe("task image store", () => {
	it("externalizes inline uploads into owner-only content-addressed blobs", async () => {
		const persisted = await externalizeBoardTaskImagesUnderLock(
			projectId,
			boardWith({ id: "a", images: [inlinePng] }),
			new Set(),
		);
		expect(persisted.columns[0]?.cards[0]?.images).toEqual([
			{ id: "img-1", name: "shot.png", mimeType: "image/png", sha256: pngSha, byteLength: pngBytes.length },
		]);
		const directory = getProjectTaskImagesPath(projectId);
		expect(readFileSync(join(directory, pngSha))).toEqual(pngBytes);
		expect(readdirSync(directory)).toEqual([pngSha]);
		if (process.platform !== "win32") {
			expect(statSync(join(directory, pngSha)).mode & 0o777).toBe(0o600);
			expect(statSync(directory).mode & 0o777).toBe(0o700);
		}
	});

	it("projects the same references in memory without writing blobs", () => {
		const legacy = boardWith({ id: "a", images: [inlinePng] });
		const projected = projectTaskImageRefs(legacy);
		expect(projected.columns[0]?.cards[0]?.images).toEqual([
			{ id: "img-1", name: "shot.png", mimeType: "image/png", sha256: pngSha, byteLength: pngBytes.length },
		]);
		expect(existsSync(getProjectTaskImagesPath(projectId))).toBe(false);
		expect(findInlineTaskImageBytes(legacy, pngSha)).toEqual(pngBytes);
		const referenceOnly = boardWith({ id: "b" });
		expect(projectTaskImageRefs(referenceOnly)).toBe(referenceOnly);
	});

	it("rejects a new reference whose blob is not stored in this project", async () => {
		const ref = { id: "img-2", mimeType: "image/png", sha256: pngSha, byteLength: pngBytes.length };
		await expect(
			externalizeBoardTaskImagesUnderLock(projectId, boardWith({ id: "a", images: [ref] }), new Set()),
		).rejects.toBeInstanceOf(TaskImageUnavailableError);

		await externalizeBoardTaskImagesUnderLock(projectId, boardWith({ id: "a", images: [inlinePng] }), new Set());
		await expect(
			externalizeBoardTaskImagesUnderLock(projectId, boardWith({ id: "b", images: [ref] }), new Set()),
		).resolves.toMatchObject({ columns: [{ cards: [{ images: [ref] }] }, { cards: [] }] });
		await expect(
			externalizeBoardTaskImagesUnderLock(
				projectId,
				boardWith({ id: "b", images: [{ ...ref, byteLength: 1 }] }),
				new Set(),
			),
		).rejects.toBeInstanceOf(TaskImageUnavailableError);
	});

	it("collects only unreferenced blobs outside the grace window, keeping Trash references", async () => {
		const otherBytes = Buffer.from("other-bytes");
		const otherSha = createHash("sha256").update(otherBytes).digest("hex");
		const youngBytes = Buffer.from("young-bytes");
		const youngSha = createHash("sha256").update(youngBytes).digest("hex");
		const board = await externalizeBoardTaskImagesUnderLock(
			projectId,
			boardWith(
				{ id: "a", images: [inlinePng] },
				{ id: "b", images: [{ id: "img-o", mimeType: "image/png", data: otherBytes.toString("base64") }] },
				{ id: "c", images: [{ id: "img-y", mimeType: "image/png", data: youngBytes.toString("base64") }] },
			),
			new Set(),
		);
		ageBlob(pngSha);
		ageBlob(otherSha);
		const directory = getProjectTaskImagesPath(projectId);
		const staleTemp = join(directory, `${pngSha}.tmp.1.2.3`);
		writeFileSync(staleTemp, "partial");
		utimesSync(staleTemp, new Date(0), new Date(0));

		// Card "a" moved to Trash still references its blob; "b" was deleted; "c" is too young to collect.
		const retained = boardWith({ id: "a", column: "trash", images: board.columns[0]?.cards[0]?.images });
		writeFileSync(getProjectStateTransactionPath(projectId), "{}");
		const now = Date.now();
		expect(await collectUnreferencedTaskImagesUnderLock(projectId, retained, { now })).toEqual({
			removed: 0,
			nextSweepAt: now,
		});
		expect(readdirSync(directory)).toHaveLength(4);

		unlinkSync(getProjectStateTransactionPath(projectId));
		const collected = await collectUnreferencedTaskImagesUnderLock(projectId, retained, { now });
		expect(collected.removed).toBe(2);
		// The young unreferenced blob becomes collectable once its grace window passes.
		const youngMtime = statSync(join(directory, youngSha)).mtimeMs;
		expect(collected.nextSweepAt).toBe(youngMtime + TASK_IMAGE_GC_GRACE_MS);
		expect(readdirSync(directory).sort()).toEqual([pngSha, youngSha].sort());
	});

	it("reads blobs with integrity checks and resolves launch images", async () => {
		await externalizeBoardTaskImagesUnderLock(projectId, boardWith({ id: "a", images: [inlinePng] }), new Set());
		expect(await readTaskImageBlob(projectId, pngSha)).toEqual(pngBytes);
		const ref = { id: "img-1", name: "shot.png", mimeType: "image/png", sha256: pngSha, byteLength: pngBytes.length };
		expect(await loadTaskImagesForLaunch(projectId, [ref])).toEqual([inlinePng]);
		expect(await loadTaskImagesForLaunch(projectId, [])).toBeUndefined();

		writeFileSync(join(getProjectTaskImagesPath(projectId), pngSha), "tampered");
		expect(await readTaskImageBlob(projectId, pngSha)).toBeNull();
		await expect(loadTaskImagesForLaunch(projectId, [ref])).rejects.toBeInstanceOf(TaskImageUnavailableError);
		await expect(readTaskImageBlob(projectId, "../board.json")).rejects.toThrow("Invalid task image hash.");
	});

	it("replaces a same-size corrupt blob before a commit references it", async () => {
		await externalizeBoardTaskImagesUnderLock(projectId, boardWith({ id: "a", images: [inlinePng] }), new Set());
		const blobPath = join(getProjectTaskImagesPath(projectId), pngSha);
		const corrupt = Buffer.from(pngBytes);
		corrupt[0] = (corrupt[0] ?? 0) ^ 0xff;
		writeFileSync(blobPath, corrupt);

		await externalizeBoardTaskImagesUnderLock(projectId, boardWith({ id: "b", images: [inlinePng] }), new Set());
		expect(readFileSync(blobPath)).toEqual(pngBytes);
		const ref = { id: "img-2", mimeType: "image/png", sha256: pngSha, byteLength: pngBytes.length };
		writeFileSync(blobPath, corrupt);
		await expect(
			externalizeBoardTaskImagesUnderLock(projectId, boardWith({ id: "c", images: [ref] }), new Set()),
		).rejects.toBeInstanceOf(TaskImageUnavailableError);
	});

	it("restores only verified regular files and replaces corrupt targets", async () => {
		await externalizeBoardTaskImagesUnderLock(projectId, boardWith({ id: "a", images: [inlinePng] }), new Set());
		const otherBytes = Buffer.from("other-restore-bytes");
		const otherSha = createHash("sha256").update(otherBytes).digest("hex");
		const backup = join(fixture.path, "backup-images");
		mkdirSync(backup);
		writeFileSync(join(backup, pngSha), pngBytes);
		writeFileSync(join(backup, otherSha), Buffer.from("tampered-restore-byt"));
		const outside = join(fixture.path, "outside.bin");
		const linkedBytes = Buffer.from("symlink-target-bytes");
		writeFileSync(outside, linkedBytes);
		const linkedSha = createHash("sha256").update(linkedBytes).digest("hex");
		// Windows symlinks need elevated privileges; the regular-file check is platform independent.
		if (process.platform !== "win32") symlinkSync(outside, join(backup, linkedSha));

		const live = getProjectTaskImagesPath(projectId);
		const corrupt = Buffer.from(pngBytes);
		corrupt[0] = (corrupt[0] ?? 0) ^ 0xff;
		writeFileSync(join(live, pngSha), corrupt);

		expect(await linkTaskImageBlobs(backup, live, { verifySource: true })).toBe(1);
		expect(readFileSync(join(live, pngSha))).toEqual(pngBytes);
		expect(existsSync(join(live, otherSha))).toBe(false);
		expect(existsSync(join(live, linkedSha))).toBe(false);
	});

	it("hard-links immutable blobs into another store and keeps existing names", async () => {
		await externalizeBoardTaskImagesUnderLock(projectId, boardWith({ id: "a", images: [inlinePng] }), new Set());
		const target = join(fixture.path, "backup", "images");
		mkdirSync(join(fixture.path, "backup"));
		expect(await linkTaskImageBlobs(getProjectTaskImagesPath(projectId), target)).toBe(1);
		const source = statSync(join(getProjectTaskImagesPath(projectId), pngSha));
		const linked = statSync(join(target, pngSha));
		if (process.platform !== "win32") expect(linked.ino).toBe(source.ino);
		expect(readFileSync(join(target, pngSha))).toEqual(pngBytes);
		expect(await linkTaskImageBlobs(getProjectTaskImagesPath(projectId), target)).toBe(0);
		expect(await linkTaskImageBlobs(join(fixture.path, "missing"), target)).toBe(0);
	});
});
