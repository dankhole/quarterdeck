import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	acquireRuntimeOwnership,
	discoverRuntimeOwner,
	type RuntimeOwnershipLease,
} from "../../src/server/runtime-ownership.js";
import { resolveIntegrationNodeArgs } from "../utilities/integration-server";

const execute = promisify(execFile);

describe("backup CLI ownership admission", () => {
	let directory: string;
	let stateHome: string;
	let backupHome: string;
	let projectHome: string;
	let lease: RuntimeOwnershipLease | null;
	let closing: boolean;
	const invocations = new Set<Promise<unknown>>();
	const transaction = {
		version: 1,
		board: { columns: [{ id: "in_progress", title: "In Progress", cards: [] }] },
		sessions: {},
		meta: { revision: 7, updatedAt: 1000, recentBoardCommands: [] },
	};
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "quarterdeck-backup-admission-"));
		stateHome = join(directory, "state");
		backupHome = join(directory, "backups");
		projectHome = join(stateHome, "projects", "synthetic-project");
		lease = null;
		closing = false;
		await mkdir(projectHome, { recursive: true });
		await writeFile(
			join(stateHome, "projects", "index.json"),
			JSON.stringify({ version: 1, entries: { "synthetic-project": { repoPath: join(directory, "project") } } }),
		);
		await writeFile(join(projectHome, "board.json"), '{"columns":[]}');
		await writeFile(join(projectHome, "state-transaction.json"), JSON.stringify(transaction));
	});
	afterEach(async () => {
		// A test timeout does not cancel its execFile. Keep ownership and the
		// Windows cwd alive until every bounded CLI invocation has closed.
		closing = true;
		await Promise.allSettled([...invocations]);
		await lease?.release();
		await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}, 20_000);

	async function invoke(...args: string[]) {
		if (closing) throw new Error("Backup fixture is already closing.");
		const invocation = execute(process.execPath, [...resolveIntegrationNodeArgs(), "backup", ...args], {
			cwd: directory,
			env: { ...process.env, QUARTERDECK_STATE_HOME: stateHome, QUARTERDECK_BACKUP_HOME: backupHome },
			timeout: 15_000,
		});
		invocations.add(invocation);
		try {
			return await invocation;
		} finally {
			invocations.delete(invocation);
		}
	}

	// Native admission plus two independently bounded CLI launches must fit
	// within the scenario's deadline, rather than one launch's 15-second budget.
	it("refuses create and restore before touching a live owner's committed journal", async () => {
		const admission = await acquireRuntimeOwnership({ stateHome, quarterdeckVersion: "test" });
		if (admission.kind !== "acquired") throw new Error("Expected isolated owner.");
		lease = admission.lease;
		for (const args of [["create"], ["restore", "synthetic-backup"]]) {
			await expect(invoke(...args)).rejects.toMatchObject({
				code: 1,
				stderr: expect.stringContaining("Stop the runtime before modifying its state home offline"),
			});
		}
		expect(await readFile(join(projectHome, "board.json"), "utf8")).toBe('{"columns":[]}');
		expect(JSON.parse(await readFile(join(projectHome, "state-transaction.json"), "utf8"))).toEqual(transaction);
		await expect(readdir(backupHome)).rejects.toMatchObject({ code: "ENOENT" });
	}, 45_000);

	it("recovers the committed journal only after acquiring maintenance and releases when done", async () => {
		const result = await invoke("create");
		expect(result.stdout).toContain("Backup created:");
		expect(JSON.parse(await readFile(join(projectHome, "board.json"), "utf8"))).toEqual(transaction.board);
		await expect(readFile(join(projectHome, "state-transaction.json"))).rejects.toMatchObject({ code: "ENOENT" });
		const owner = await discoverRuntimeOwner(stateHome);
		expect(owner?.claim.purpose).toBe("maintenance");
		expect(owner?.released).toBe(true);
	});
});
