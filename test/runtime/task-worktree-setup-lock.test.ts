import { mkdirSync, realpathSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const paths = vi.hoisted(() => ({
	getGitCommonDir: vi.fn<(repoPath: string) => Promise<string>>(),
	realpath: vi.fn<(path: string) => Promise<string>>(),
}));

vi.mock("../../src/workdir/git-utils", () => ({ getGitCommonDir: paths.getGitCommonDir }));
vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof FsPromises>()),
	realpath: paths.realpath,
}));

import { lockedFileSystem } from "../../src/fs/locked-file-system";
import {
	installRuntimeWriteAdmission,
	RuntimeWriteAdmissionError,
	waitForRuntimeWriteQuiescence,
} from "../../src/state/runtime-write-admission";
import { withTaskWorktreeSetupLock } from "../../src/workdir/task-worktree-setup-lock";
import { createTempDir } from "../utilities/temp-dir";

beforeEach(() => {
	paths.getGitCommonDir.mockReset().mockImplementation(async (path) => path);
	paths.realpath.mockReset().mockImplementation(async (path) => path);
});

afterEach(() => vi.restoreAllMocks());

it("queues aliased repository owners before the filesystem lock and continues after a failed owner", async () => {
	paths.realpath.mockImplementation(async () => "/canonical/common");
	let release = () => {};
	const blocker = new Promise<void>((resolve) => {
		release = resolve;
	});
	let active = false;
	const physicalLock = vi.spyOn(lockedFileSystem, "withLock").mockImplementation(async (_request, operation) => {
		if (active) throw new Error("Lock file is already being held");
		active = true;
		try {
			return await operation();
		} finally {
			active = false;
		}
	});
	const owner = withTaskWorktreeSetupLock("/main/common", async () => {
		await blocker;
		throw new Error("Synthetic owner failure");
	});
	const ownerFailure = expect(owner).rejects.toThrow("Synthetic owner failure");
	await vi.waitFor(() => expect(physicalLock).toHaveBeenCalledOnce());
	const queuedOperation = vi.fn(async () => "queued result");
	const queued = withTaskWorktreeSetupLock("/linked/common", queuedOperation);
	try {
		await vi.waitFor(() => expect(paths.realpath).toHaveBeenCalledTimes(2));
		expect(physicalLock).toHaveBeenCalledOnce();
		expect(queuedOperation).not.toHaveBeenCalled();
	} finally {
		release();
		await ownerFailure;
	}
	await expect(queued).resolves.toBe("queued result");
	expect(physicalLock).toHaveBeenCalledTimes(2);
	expect(physicalLock.mock.calls.every(([request]) => request.path === "/canonical/common")).toBe(true);
});

it("allows independent repositories to acquire their filesystem locks concurrently", async () => {
	let release = () => {};
	const blocker = new Promise<void>((resolve) => {
		release = resolve;
	});
	const physicalLock = vi
		.spyOn(lockedFileSystem, "withLock")
		.mockImplementation(async (_request, operation) => operation());
	const owner = withTaskWorktreeSetupLock("/one/common", () => blocker);
	await vi.waitFor(() => expect(physicalLock).toHaveBeenCalledOnce());
	try {
		await expect(withTaskWorktreeSetupLock("/two/common", async () => "independent")).resolves.toBe("independent");
		expect(physicalLock).toHaveBeenCalledTimes(2);
	} finally {
		release();
		await owner;
	}
});

it("keeps queued owners in the write drain and rejects their lock acquisition after ownership is fenced", async () => {
	const temp = createTempDir("quarterdeck-setup-lock-admission-");
	const home = realpathSync(temp.path);
	const commonDirectory = join(home, "repo", ".git");
	mkdirSync(commonDirectory, { recursive: true });
	let current = true;
	const admission = vi.fn(() => current);
	const dispose = installRuntimeWriteAdmission({ canonicalStateHome: home, isCurrent: admission });
	let release = () => {};
	let markEntered = () => {};
	const entered = new Promise<void>((resolve) => {
		markEntered = resolve;
	});
	const blocker = new Promise<void>((resolve) => {
		release = resolve;
	});
	const physicalLock = vi.spyOn(lockedFileSystem, "withLock");
	const owner = withTaskWorktreeSetupLock(commonDirectory, async () => {
		markEntered();
		await blocker;
	});
	await entered;
	admission.mockClear();
	const queuedOperation = vi.fn(async () => undefined);
	const queued = withTaskWorktreeSetupLock(commonDirectory, queuedOperation);
	const queuedFailure = expect(queued).rejects.toThrow(RuntimeWriteAdmissionError);
	try {
		// One admission check proves the second owner entered the queue; it has
		// not reached the physical lock's independent ownership recheck yet.
		await vi.waitFor(() => expect(admission).toHaveBeenCalledOnce());
		expect(physicalLock).toHaveBeenCalledOnce();
		expect(dispose).toThrow("not quiesced");
		let drained = false;
		const drain = waitForRuntimeWriteQuiescence(home).then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);
		current = false;
		release();
		await owner;
		await queuedFailure;
		await drain;
		expect(drained).toBe(true);
		expect(queuedOperation).not.toHaveBeenCalled();
	} finally {
		current = false;
		release();
		await Promise.allSettled([owner, queued]);
		await waitForRuntimeWriteQuiescence(home);
		dispose();
		await temp.cleanupAsync();
	}
});
