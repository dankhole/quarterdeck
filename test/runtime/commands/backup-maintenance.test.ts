import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBackupCommand } from "../../../src/commands/backup.js";
import type * as RuntimeWriteAdmission from "../../../src/state/runtime-write-admission.js";
import {
	assertRuntimeWriteAdmission,
	RuntimeWriteAdmissionError,
	type RuntimeWriteAdmissionOptions,
	withRuntimeWriteOperation,
} from "../../../src/state/runtime-write-admission.js";

const mocks = vi.hoisted(() => ({
	stateHome: "",
	disposeAdmission: null as (() => void) | null,
	events: [] as string[],
	createBackup: vi.fn<() => Promise<string | null>>(),
	lease: {
		get canonicalStateHome(): string {
			return mocks.stateHome;
		},
		generation: "synthetic-maintenance",
		bootIdentity: "synthetic-boot",
		isCurrent: vi.fn(() => true),
		assertCurrent: vi.fn(),
		release: vi.fn<() => Promise<void>>(),
	},
}));

vi.mock("../../../src/server/runtime-ownership.js", () => ({
	withRuntimeMaintenance: async (_home: string, operation: (lease: typeof mocks.lease) => Promise<unknown>) => {
		try {
			return await operation(mocks.lease);
		} finally {
			await mocks.lease.release();
		}
	},
}));
vi.mock("../../../src/server/runtime-recovery-admission.js", () => ({ assertRuntimeRecoveryAdmission: vi.fn() }));
vi.mock("../../../src/state", () => ({
	createBackup: mocks.createBackup,
	getRuntimeHomePath: () => mocks.stateHome,
}));
vi.mock("../../../src/state/runtime-write-admission.js", async (importOriginal) => {
	const actual = await importOriginal<typeof RuntimeWriteAdmission>();
	return {
		...actual,
		installRuntimeWriteAdmission: (options: RuntimeWriteAdmissionOptions) => {
			mocks.disposeAdmission = actual.installRuntimeWriteAdmission(options);
			return mocks.disposeAdmission;
		},
	};
});

describe("backup maintenance write fence", () => {
	let directory: string;
	let originalExitCode: NodeJS.Process["exitCode"];
	const releases: Array<() => void> = [];
	const pending: Promise<unknown>[] = [];
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "quarterdeck-backup-fence-"));
		mocks.stateHome = join(directory, "state");
		mocks.events = [];
		mocks.disposeAdmission = null;
		mocks.createBackup.mockReset();
		mocks.lease.release.mockReset().mockImplementation(async () => {
			mocks.events.push("release");
		});
		mocks.lease.isCurrent.mockReturnValue(true);
		vi.stubEnv("QUARTERDECK_STATE_HOME", mocks.stateHome);
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		originalExitCode = process.exitCode;
		process.exitCode = undefined;
	});
	afterEach(async () => {
		for (const release of releases.splice(0)) release();
		await Promise.allSettled(pending.splice(0));
		mocks.disposeAdmission?.();
		process.exitCode = originalExitCode;
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	});

	function barrier() {
		let release = () => {};
		const promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		releases.push(() => release());
		return { promise, release };
	}
	function track<T>(promise: Promise<T>): Promise<T> {
		pending.push(promise);
		void promise.catch(() => undefined);
		return promise;
	}
	function command() {
		const program = new Command();
		registerBackupCommand(program);
		return track(program.parseAsync(["backup", "create"], { from: "user" }));
	}
	const statePath = () => join(mocks.stateHome, "projects", "synthetic", "board.json");

	it("fences the drained-to-release microtask gap and keeps admission closed after release", async () => {
		const admitted = barrier();
		const late = barrier();
		let lateEffect = false;
		let lateOutcome: Promise<boolean> | null = null;
		mocks.createBackup.mockImplementation(async () => {
			const write = track(
				withRuntimeWriteOperation([statePath()], async () => {
					await admitted.promise;
					mocks.events.push("admitted_settled");
				}),
			);
			void write.then(() => {
				mocks.events.push("late_attempt");
				lateOutcome = track(
					withRuntimeWriteOperation([statePath()], async () => {
						lateEffect = true;
						await late.promise;
					}),
				).then(
					() => false,
					(error: unknown) => error instanceof RuntimeWriteAdmissionError,
				);
			});
			return "synthetic-backup";
		});
		const finished = command();
		await vi.waitFor(() =>
			expect(() => assertRuntimeWriteAdmission(statePath())).toThrow(RuntimeWriteAdmissionError),
		);
		expect(mocks.lease.release).not.toHaveBeenCalled();
		admitted.release();
		await finished;
		late.release();
		expect(await lateOutcome).toBe(true);
		expect(lateEffect).toBe(false);
		expect(mocks.events).toEqual(["admitted_settled", "late_attempt", "release"]);
		expect(mocks.lease.isCurrent()).toBe(true);
		expect(() => assertRuntimeWriteAdmission(statePath())).toThrow(RuntimeWriteAdmissionError);
	});

	it("drains an already admitted failing write before releasing a failed maintenance operation", async () => {
		const admitted = barrier();
		mocks.createBackup.mockImplementation(async () => {
			track(
				withRuntimeWriteOperation([statePath()], async () => {
					await admitted.promise;
					mocks.events.push("failed_write_settled");
					throw new Error("synthetic write failed");
				}),
			);
			throw new Error("synthetic backup failed");
		});
		const finished = command();
		await vi.waitFor(() =>
			expect(() => assertRuntimeWriteAdmission(statePath())).toThrow(RuntimeWriteAdmissionError),
		);
		expect(mocks.lease.release).not.toHaveBeenCalled();
		admitted.release();
		await finished;
		expect(mocks.events).toEqual(["failed_write_settled", "release"]);
		expect(process.exitCode).toBe(1);
		expect(() => assertRuntimeWriteAdmission(statePath())).toThrow(RuntimeWriteAdmissionError);
	});

	it("retains the closed admission guard if release publication fails", async () => {
		mocks.createBackup.mockResolvedValue("synthetic-backup");
		mocks.lease.release.mockRejectedValue(new Error("synthetic release failed"));
		await command();
		expect(process.exitCode).toBe(1);
		expect(mocks.lease.isCurrent()).toBe(true);
		expect(() => assertRuntimeWriteAdmission(statePath())).toThrow(RuntimeWriteAdmissionError);
	});
});
