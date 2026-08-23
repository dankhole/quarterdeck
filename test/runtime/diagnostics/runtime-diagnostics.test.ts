import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRuntimeDiagnostics, type RuntimeDiagnostics } from "../../../src/diagnostics";

function browserSnapshot(clientId: string, terminal: unknown = null) {
	return {
		version: 1 as const,
		clientId,
		capturedAt: Date.now(),
		route: "/",
		visibility: "visible" as const,
		viewport: { width: 1_280, height: 720, devicePixelRatio: 2 },
		activeProjectId: null,
		activeTaskId: null,
		boardRevision: null,
		runtimeStream: { connected: true },
		pendingProjectPersistence: false,
		terminal,
		layout: {},
	};
}

describe("runtime diagnostics coordination", () => {
	let stateHome: string;
	let diagnostics: RuntimeDiagnostics;

	beforeEach(async () => {
		stateHome = await mkdtemp(join(tmpdir(), "quarterdeck-runtime-diagnostics-"));
		diagnostics = await createRuntimeDiagnostics({
			stateHome,
			host: "127.0.0.1",
			port: 4_242,
			quarterdeckVersion: "test",
		});
	});

	afterEach(async () => {
		await diagnostics.close();
		await rm(stateHome, { recursive: true, force: true });
	});

	it("coalesces concurrent browser snapshot requests", async () => {
		const clientId = "client-1";
		diagnostics.issueBrowserCapability(clientId);
		let requests = 0;
		diagnostics.setBrowserSnapshotRequester(({ nonce }) => {
			requests += 1;
			diagnostics.ingestBrowserSnapshot(clientId, nonce, browserSnapshot(clientId));
		});

		const [first, second] = await Promise.all([
			diagnostics.requestBrowserSnapshots(),
			diagnostics.requestBrowserSnapshots(),
		]);
		expect(requests).toBe(1);
		expect(first).toEqual(second);
		expect(first.missingClientIds).toEqual([]);
	});

	it("keeps browser capabilities scoped to the current matching connection", () => {
		const first = diagnostics.issueBrowserCapability("client-1");
		expect(diagnostics.setBrowserLiveSubscription("client-1", first, true, 1)).toEqual({
			subscribed: true,
			revision: 1,
		});
		expect(diagnostics.hasBrowserLiveSubscribers()).toBe(true);
		const replacement = diagnostics.issueBrowserCapability("client-1");

		expect(diagnostics.verifyBrowserCapability(first, "client-1")).toBeNull();
		expect(diagnostics.isBrowserLiveSubscribed("client-1", first)).toBe(false);
		expect(diagnostics.hasBrowserLiveSubscribers()).toBe(false);
		expect(diagnostics.verifyBrowserCapability(replacement, "client-1")).toBe("client-1");
		expect(diagnostics.setBrowserLiveSubscription("client-1", replacement, true, 2)).toEqual({
			subscribed: true,
			revision: 2,
		});
		expect(diagnostics.isBrowserLiveSubscribed("client-1", replacement)).toBe(true);
		expect(diagnostics.setBrowserLiveSubscription("client-1", replacement, false, 3)).toEqual({
			subscribed: false,
			revision: 3,
		});
		expect(diagnostics.setBrowserLiveSubscription("client-1", replacement, true, 2)).toEqual({
			subscribed: false,
			revision: 3,
		});
		expect(diagnostics.isBrowserLiveSubscribed("client-1", replacement)).toBe(false);
		expect(diagnostics.setBrowserLiveSubscription("client-1", first, true, 4)).toEqual({
			subscribed: false,
			revision: 4,
		});
		expect(diagnostics.isBrowserLiveSubscribed("client-1", replacement)).toBe(false);
		diagnostics.revokeBrowserCapability("client-1", first);
		expect(diagnostics.verifyBrowserCapability(replacement, "client-1")).toBe("client-1");
		diagnostics.revokeBrowserCapability("client-1", replacement);
		expect(diagnostics.verifyBrowserCapability(replacement, "client-1")).toBeNull();
	});

	it("passes record filters into provider snapshots and excludes other scoped records", async () => {
		diagnostics.recordEvent("project.one", {}, { projectId: "p1", taskId: "t1" }, { essential: true });
		diagnostics.recordEvent("project.two", {}, { projectId: "p2", taskId: "t2" }, { essential: true });
		diagnostics.registerSnapshotProvider({
			name: "scoped",
			capture: (scope) => ({ scope, projects: ["p1", "p2"].filter((projectId) => projectId === scope.projectId) }),
		});

		const capture = await diagnostics.collectCaptureData({
			filter: { projectId: "p1", taskId: "t1" },
			providers: ["scoped"],
		});

		expect(capture.records.map((record) => record.name)).toEqual(["project.one"]);
		expect(capture.snapshot.scope).toEqual({ projectId: "p1", taskId: "t1" });
		expect(capture.snapshot.providers[0]?.data).toEqual({
			scope: { projectId: "p1", taskId: "t1" },
			projects: ["p1"],
		});
	});

	it("marks requested browser evidence partial when a client disconnects before responding", async () => {
		const clientId = "client-1";
		diagnostics.issueBrowserCapability(clientId);
		diagnostics.setBrowserSnapshotRequester(() => diagnostics.revokeBrowserCapability(clientId));

		const capture = await diagnostics.collectCaptureData({ requestBrowser: true });
		expect(capture.warnings.some((warning) => warning.includes("did not return a snapshot"))).toBe(true);
	});

	it("removes stale browser snapshots when their capability disconnects", async () => {
		const clientId = "client-1";
		const capability = diagnostics.issueBrowserCapability(clientId);
		diagnostics.ingestBrowserSnapshot(clientId, "nonce", browserSnapshot(clientId));
		diagnostics.revokeBrowserCapability(clientId, capability);

		const capture = await diagnostics.collectCaptureData({ providers: ["browser"] });
		expect(capture.snapshot.providers[0]?.data).toEqual({
			clients: [],
			connectedClientIds: [],
			liveSubscriberCount: 0,
		});
	});

	it("strips submitted terminal text from production browser snapshots", async () => {
		const clientId = "client-1";
		diagnostics.ingestBrowserSnapshot(clientId, "nonce", {
			...browserSnapshot(clientId, {
				registered: { total: 1, pool: 1, dedicated: 0 },
				dom: { xtermElementCount: 1 },
				poolSlots: [
					{
						kind: "pool",
						slotId: 1,
						buffer: {},
						visibleLines: ["sentinel terminal text must not survive"],
					},
				],
				arbitrary: { transcript: "sentinel transcript" },
			}),
			layout: {
				root: { x: 0, y: 0, width: 1_280, height: 720 },
				arbitrary: { x: 0, y: 0, width: 10, height: 10 },
			},
		});

		const capture = await diagnostics.collectCaptureData({ providers: ["browser"] });
		const serialized = JSON.stringify(capture.snapshot);
		expect(serialized).not.toContain("sentinel terminal text");
		expect(serialized).not.toContain("sentinel transcript");
		expect(serialized).not.toContain("visibleLines");
		expect(serialized).not.toContain("arbitrary");
	});

	it("retains descriptor and journal persistence failures without recursively journaling them", async () => {
		const blockedStateHome = join(stateHome, "blocked-state-home");
		await writeFile(blockedStateHome, "not a directory", "utf8");
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const degraded = await createRuntimeDiagnostics({
			stateHome: blockedStateHome,
			host: "127.0.0.1",
			port: 4_243,
			quarterdeckVersion: "test",
		});

		try {
			expect(degraded.getRecords().map((record) => record.name)).toEqual(
				expect.arrayContaining(["runtime.descriptor_write_failed", "diagnostics.journal_write_failed"]),
			);
			expect(degraded.recorder.getHealth()).toMatchObject({ journalHealthy: false, journalFailureCount: 1 });
		} finally {
			await degraded.close();
			stderr.mockRestore();
		}
	});
});
