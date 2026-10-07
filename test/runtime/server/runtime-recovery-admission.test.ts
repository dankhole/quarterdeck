import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnedProcessSnapshot } from "../../../src/server/owned-process-snapshot";
import {
	assertPriorRuntimeProcessCustody,
	assertRuntimeRecoveryAdmission,
	type PriorRuntimeProcessCustody,
	RuntimeRecoveryAdmissionError,
} from "../../../src/server/runtime-recovery-admission";
import { createTempDir } from "../../utilities/temp-dir";

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
});

const BOOT_A = "darwin:11111111-1111-1111-1111-111111111111";
const BOOT_B = "darwin:22222222-2222-2222-2222-222222222222";
function custody(overrides: Partial<PriorRuntimeProcessCustody> = {}): PriorRuntimeProcessCustody {
	return {
		claim: {
			version: 1,
			generation: "12345678-1234-1234-1234-123456789012",
			canonicalStateHome: "/state",
			hostIdentity: "stable-host",
			custodyProtocolVersion: 1,
			bootIdentity: BOOT_A,
			previousGeneration: null,
			purpose: "runtime",
			process: { pid: 10, creationIdentity: "birth" },
			claimedAt: new Date(0).toISOString(),
		},
		released: false,
		custodyDirty: true,
		...overrides,
	};
}

describe("prior generation process custody", () => {
	it("blocks dirty unreleased custody on the same boot even when all saved roots disappeared", async () => {
		const { home } = fixture();
		await expect(
			assertRuntimeRecoveryAdmission({
				stateHome: home,
				currentGeneration: "current",
				bootIdentity: BOOT_A,
				readPriorClaims: async () => [custody()],
				snapshot: async () => [],
			}),
		).rejects.toMatchObject({ reason: "unconfirmed_prior_custody" });
	});

	it("admits proven clean release and protocol no-spawn startup failures", () => {
		expect(() => assertPriorRuntimeProcessCustody([custody({ released: true })], BOOT_A)).not.toThrow();
		expect(() => assertPriorRuntimeProcessCustody([custody({ custodyDirty: false })], null)).not.toThrow();
	});

	it("admits a proven reboot but fails closed for null, malformed or cross-platform identities", () => {
		expect(() => assertPriorRuntimeProcessCustody([custody()], BOOT_B)).not.toThrow();
		for (const unknown of [null, "darwin:garbage", "linux:22222222-2222-2222-2222-222222222222"]) {
			expect(() => assertPriorRuntimeProcessCustody([custody()], unknown)).toThrow(RuntimeRecoveryAdmissionError);
		}
	});

	it("uses only later reachable boot anchors, including maintenance, for legacy unknown custody", () => {
		const legacy = custody({ custodyDirty: null });
		delete legacy.claim.custodyProtocolVersion;
		delete legacy.claim.bootIdentity;
		const later = custody({ custodyDirty: false });
		later.claim.purpose = "maintenance";
		expect(() => assertPriorRuntimeProcessCustody([legacy, later], BOOT_B)).not.toThrow();
		expect(() => assertPriorRuntimeProcessCustody([legacy, later], BOOT_A)).toThrow();
		expect(() => assertPriorRuntimeProcessCustody([later, legacy], BOOT_B)).toThrow();
	});

	it("keeps pre-admission PID evidence blocked when roots vanish until reboot supplies an anchor", async () => {
		const { home, project } = fixture();
		writeFileSync(join(project, "sessions.json"), JSON.stringify({ legacy: { pid: 123 } }));
		const noSpawn = custody({ custodyDirty: false });
		await expect(
			assertRuntimeRecoveryAdmission({
				stateHome: home,
				currentGeneration: "current",
				bootIdentity: BOOT_A,
				readPriorClaims: async () => [noSpawn],
				snapshot: async () => [],
			}),
		).rejects.toMatchObject({ reason: "unconfirmed_prior_custody" });
		await assertRuntimeRecoveryAdmission({
			stateHome: home,
			currentGeneration: "current",
			bootIdentity: BOOT_B,
			readPriorClaims: async () => [noSpawn],
			snapshot: async () => [processRow(123)],
		});
	});
});

function fixture() {
	const temp = createTempDir("quarterdeck-recovery-admission-");
	cleanup.push(temp.cleanup);
	const project = join(temp.path, "projects", "project");
	mkdirSync(project, { recursive: true });
	return { home: temp.path, project };
}

function processRow(pid: number, creationIdentity = "birth", preciseIdentity = false): OwnedProcessSnapshot {
	return { pid, parentPid: 1, creationIdentity, preciseIdentity, zombie: false };
}

function managedRecord(home: string, pid: number, creationTime = "100") {
	const recordId = "12345678-1234-1234-1234-123456789012";
	const registry = join(home, "managed-processes");
	mkdirSync(registry, { recursive: true });
	const path = join(registry, `${recordId}.json`);
	writeFileSync(
		path,
		JSON.stringify({
			version: 1,
			recordId,
			registeredAt: new Date().toISOString(),
			ownerRuntime: { pid: 999, creationTime: "50" },
			rootProcess: { pid, creationTime },
		}),
	);
	return path;
}

describe("runtime recovery admission", () => {
	it("does not query processes for a fresh state home", async () => {
		const { home } = fixture();
		const snapshot = vi.fn();
		await assertRuntimeRecoveryAdmission({ stateHome: home, snapshot });
		expect(snapshot).not.toHaveBeenCalled();
	});

	it("blocks live saved PID evidence without changing saved sessions or signalling it", async () => {
		const { home, project } = fixture();
		const path = join(project, "sessions.json");
		const content = JSON.stringify({ task: { pid: 123, state: "running" } });
		writeFileSync(path, content);
		const signal = vi.spyOn(process, "kill");
		try {
			await expect(
				assertRuntimeRecoveryAdmission({ stateHome: home, snapshot: async () => [processRow(123)] }),
			).rejects.toMatchObject({ reason: "live_prior_process", pids: [123] });
			expect(readFileSync(path, "utf8")).toBe(content);
			expect(signal).not.toHaveBeenCalled();
		} finally {
			signal.mockRestore();
		}
	});

	it("includes committed transaction and structured owner evidence before cleanup", async () => {
		const { home, project } = fixture();
		writeFileSync(join(project, "state-transaction.json"), JSON.stringify({ sessions: { task: { pid: 123 } } }));
		writeFileSync(
			join(project, "execution-ownership.json"),
			JSON.stringify({ owners: { task: { ownerProcess: { pid: 124 } } } }),
		);
		await expect(
			assertRuntimeRecoveryAdmission({ stateHome: home, snapshot: async () => [processRow(123), processRow(124)] }),
		).rejects.toMatchObject({ reason: "live_prior_process", pids: [123, 124] });
	});

	it("admits roots confirmed absent or zombies", async () => {
		const { home, project } = fixture();
		writeFileSync(join(project, "sessions.json"), JSON.stringify({ gone: { pid: 123 }, zombie: { pid: 124 } }));
		await assertRuntimeRecoveryAdmission({
			stateHome: home,
			snapshot: async () => [{ ...processRow(124), zombie: true }],
		});
	});

	it("blocks exact retained Windows roots and leaves their record for repair", async () => {
		const { home } = fixture();
		const path = managedRecord(home, 123);
		const content = readFileSync(path, "utf8");
		await expect(
			assertRuntimeRecoveryAdmission({
				stateHome: home,
				platform: "win32",
				snapshot: async () => [processRow(123, "100", true)],
			}),
		).rejects.toBeInstanceOf(RuntimeRecoveryAdmissionError);
		expect(readFileSync(path, "utf8")).toBe(content);
	});

	it("admits precisely recycled Windows registry-only PIDs without signalling the replacement", async () => {
		const { home } = fixture();
		managedRecord(home, 123);
		await assertRuntimeRecoveryAdmission({
			stateHome: home,
			platform: "win32",
			snapshot: async () => [processRow(123, "200", true)],
		});
	});

	it("does not use an older managed record to dismiss independent session PID evidence", async () => {
		const { home, project } = fixture();
		managedRecord(home, 123);
		writeFileSync(join(project, "sessions.json"), JSON.stringify({ task: { pid: 123 } }));
		await expect(
			assertRuntimeRecoveryAdmission({
				stateHome: home,
				platform: "win32",
				snapshot: async () => [processRow(123, "200", true)],
			}),
		).rejects.toMatchObject({ reason: "live_prior_process" });
	});

	it("denies unavailable queries and unreadable evidence without retiring malformed records", async () => {
		const { home, project } = fixture();
		writeFileSync(join(project, "sessions.json"), JSON.stringify({ task: { pid: 123 } }));
		await expect(
			assertRuntimeRecoveryAdmission({
				stateHome: home,
				snapshot: async () => {
					throw new Error("query unavailable");
				},
			}),
		).rejects.toMatchObject({ reason: "unverifiable_evidence" });
		const path = managedRecord(home, 123);
		writeFileSync(path, "incomplete");
		await expect(assertRuntimeRecoveryAdmission({ stateHome: home, snapshot: async () => [] })).rejects.toMatchObject(
			{ reason: "unverifiable_evidence" },
		);
		expect(readFileSync(path, "utf8")).toBe("incomplete");
	});
});
