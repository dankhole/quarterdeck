import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeHookIngestRequest } from "../../src/core/api/task-session.js";
import {
	abandonHookTransition,
	acknowledgeHookTransition,
	enqueueHookTransition,
	getOutboxDirectoryPath,
	getOutboxRecordPath,
	HOOK_TRANSITION_OUTBOX_TTL_MS,
} from "../../src/hook-transition-outbox-core.js";
import { installRuntimeWriteAdmission } from "../../src/state/runtime-write-admission.js";

vi.mock("node:crypto", { spy: true });
vi.mock("node:fs/promises", { spy: true });

const deliveryId = "00000000-0000-4000-8000-000000000001";
const input: RuntimeHookIngestRequest = {
	taskId: "task-1",
	projectId: "project-1",
	event: "to_in_progress",
	metadata: {
		source: "claude",
		sessionInstanceId: "launch-1",
		promptId: "prompt-1",
		toolUseId: "tool-1",
		hookEventName: "PostToolUse",
		activityText: "private activity",
		transcriptPath: "/private/transcript.jsonl",
	},
	delivery: { id: deliveryId, occurredAt: 100 },
};

const originalStateHome = process.env.QUARTERDECK_STATE_HOME;
let stateHome: string;

beforeEach(async () => {
	stateHome = await fileSystem.mkdtemp(join(tmpdir(), "quarterdeck-outbox-core-"));
	process.env.QUARTERDECK_STATE_HOME = stateHome;
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (originalStateHome === undefined) {
		delete process.env.QUARTERDECK_STATE_HOME;
	} else {
		process.env.QUARTERDECK_STATE_HOME = originalStateHome;
	}
	await fileSystem.rm(stateHome, { recursive: true, force: true });
});

describe("hook transition outbox core atomic writer", () => {
	it("publishes pretty JSON with the same schema, TTL, delivery identity, and minimal metadata", async () => {
		const before = Date.now();
		await expect(enqueueHookTransition(input)).resolves.toBe(true);

		const raw = await fileSystem.readFile(getOutboxRecordPath(deliveryId), "utf8");
		const record = JSON.parse(raw);
		expect(raw).toBe(JSON.stringify(record, null, 2));
		expect(record.version).toBe(1);
		expect(record.enqueuedAt).toBeGreaterThanOrEqual(before);
		expect(record.enqueuedAt).toBeLessThanOrEqual(Date.now());
		expect(record.expiresAt).toBe(record.enqueuedAt + HOOK_TRANSITION_OUTBOX_TTL_MS);
		expect(record.request.delivery).toEqual(input.delivery);
		expect(record.request.metadata).toMatchObject({
			source: "claude",
			sessionInstanceId: "launch-1",
			promptId: "prompt-1",
			toolUseId: "tool-1",
		});
		expect(raw).not.toContain("private");
		expect(await fileSystem.readdir(getOutboxDirectoryPath())).toEqual([`${deliveryId}.json`]);
	});

	it.skipIf(process.platform === "win32")("creates the temp and publishes the record with mode 0600", async () => {
		const realFs = await vi.importActual<typeof fileSystem>("node:fs/promises");
		vi.mocked(fileSystem.rename).mockImplementationOnce(async (from, to) => {
			expect((await fileSystem.stat(from)).mode & 0o777).toBe(0o600);
			expect(dirname(String(from))).toBe(dirname(String(to)));
			await realFs.rename(from, to);
		});

		await enqueueHookTransition(input);

		expect((await fileSystem.stat(getOutboxRecordPath(deliveryId))).mode & 0o777).toBe(0o600);
	});

	it.skipIf(process.platform === "win32")(
		"normalizes enqueue and abandon permissions despite a restrictive inherited umask",
		async () => {
			// Pre-existing accessible directory isolates file permissions from directory umask.
			await fileSystem.mkdir(getOutboxDirectoryPath(), { recursive: true });
			const moduleUrl = pathToFileURL(resolve("src/hook-transition-outbox-core.ts")).href;
			const script = `
			import { stat, readFile } from "node:fs/promises";
			import { enqueueHookTransition, abandonHookTransition, getOutboxRecordPath } from ${JSON.stringify(moduleUrl)};
			process.umask(0o400);
			await enqueueHookTransition(${JSON.stringify(input)});
			const path = getOutboxRecordPath(${JSON.stringify(deliveryId)});
			const enqueueMode = (await stat(path)).mode & 0o777;
			await readFile(path, "utf8");
			await abandonHookTransition(${JSON.stringify(deliveryId)}, 1234);
			console.log(JSON.stringify({ enqueueMode, abandonMode: (await stat(path)).mode & 0o777,
				abandonedAt: JSON.parse(await readFile(path, "utf8")).abandonedAt }));
		`;
			const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
				env: { ...process.env, QUARTERDECK_STATE_HOME: stateHome },
				encoding: "utf8",
			});
			expect(JSON.parse(output)).toEqual({ enqueueMode: 0o600, abandonMode: 0o600, abandonedAt: 1234 });
		},
	);

	it("atomically replaces a record when abandoning, without changing its replay data", async () => {
		await enqueueHookTransition(input);
		const path = getOutboxRecordPath(deliveryId);
		const before = JSON.parse(await fileSystem.readFile(path, "utf8"));

		await abandonHookTransition(deliveryId, 1234);

		const raw = await fileSystem.readFile(path, "utf8");
		expect(raw).toBe(JSON.stringify({ ...before, abandonedAt: 1234 }, null, 2));
		expect(await fileSystem.readdir(getOutboxDirectoryPath())).toEqual([`${deliveryId}.json`]);
		if (process.platform !== "win32") {
			expect((await fileSystem.stat(path)).mode & 0o777).toBe(0o600);
		}
		await acknowledgeHookTransition(deliveryId);
		await abandonHookTransition(deliveryId);
		expect(await fileSystem.readdir(getOutboxDirectoryPath())).toEqual([]);
	});

	it.each([false, true])(
		"cleans only its temp and preserves a partial-write error (close also fails: %s)",
		async (closeFails) => {
			const realFs = await vi.importActual<typeof fileSystem>("node:fs/promises");
			const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
			await fileSystem.mkdir(getOutboxDirectoryPath(), { recursive: true });
			const unrelated = "other.json.tmp.other-writer";
			await fileSystem.writeFile(join(getOutboxDirectoryPath(), unrelated), "other writer");
			vi.mocked(fileSystem.open).mockImplementationOnce(async (...args) => {
				const file = await realFs.open(...args);
				const write = file.writeFile.bind(file);
				if (closeFails) {
					const close = file.close.bind(file);
					vi.spyOn(file, "close").mockImplementationOnce(async () => {
						await close();
						throw new Error("close failed");
					});
				}
				vi.spyOn(file, "writeFile").mockImplementationOnce(async () => {
					await write("partial", "utf8");
					throw failure;
				});
				return file;
			});

			await expect(enqueueHookTransition(input)).rejects.toBe(failure);

			expect(await fileSystem.readdir(getOutboxDirectoryPath())).toEqual([unrelated]);
			expect(await fileSystem.readFile(join(getOutboxDirectoryPath(), unrelated), "utf8")).toBe("other writer");
		},
	);

	it.each(["enqueue", "abandon"])(
		"preserves the prior record and removes its temp if %s rename fails",
		async (operation) => {
			await enqueueHookTransition(input);
			const path = getOutboxRecordPath(deliveryId);
			const before = await fileSystem.readFile(path, "utf8");
			const failure = Object.assign(new Error("rename denied"), { code: "EPERM" });
			vi.mocked(fileSystem.rename).mockRejectedValueOnce(failure);

			await expect(
				operation === "enqueue" ? enqueueHookTransition(input) : abandonHookTransition(deliveryId),
			).rejects.toBe(failure);

			expect(await fileSystem.readFile(path, "utf8")).toBe(before);
			expect(await fileSystem.readdir(getOutboxDirectoryPath())).toEqual([`${deliveryId}.json`]);
		},
	);

	it("never deletes or overwrites a colliding temp it did not create", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1234);
		vi.mocked(randomUUID).mockReturnValue("00000000-0000-4000-8000-000000000099");
		await fileSystem.mkdir(getOutboxDirectoryPath(), { recursive: true });
		const tempPath = `${getOutboxRecordPath(deliveryId)}.tmp.${process.pid}.1234.${randomUUID()}`;
		await fileSystem.writeFile(tempPath, "other writer");

		await expect(enqueueHookTransition(input)).rejects.toMatchObject({ code: "EEXIST" });

		expect(await fileSystem.readFile(tempPath, "utf8")).toBe("other writer");
		expect(await fileSystem.readdir(getOutboxDirectoryPath())).toEqual([basename(tempPath)]);
	});

	it("keeps independent outbox writes exempt when runtime write admission is fenced", async () => {
		const uninstall = installRuntimeWriteAdmission({ canonicalStateHome: stateHome, isCurrent: () => false });
		try {
			await expect(enqueueHookTransition(input)).resolves.toBe(true);
			await abandonHookTransition(deliveryId);
			await acknowledgeHookTransition(deliveryId);
			expect(await fileSystem.readdir(getOutboxDirectoryPath())).toEqual([]);
		} finally {
			uninstall();
		}
	});
});
