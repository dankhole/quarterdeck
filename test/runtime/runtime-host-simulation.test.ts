import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeHostIntegrationEventLedgerFile } from "../../src/core";
import { RuntimeHostEventLedger } from "../../src/server/runtime-host-event-ledger";
import { loadRuntimeHostSimulation } from "../../src/server/runtime-host-simulation";

async function createSimulationFixture() {
	const root = await mkdtemp(join(tmpdir(), "quarterdeck-host-simulation-test-"));
	const projectPath = join(root, "project");
	const ledgerPath = join(root, "host-events.json");
	const configPath = join(root, "simulation.json");
	await writeFile(
		configPath,
		`${JSON.stringify({
			schemaVersion: 1,
			ledgerPath,
			pathScopes: [{ id: "primary_project", rootPath: projectPath }],
		})}\n`,
		"utf8",
	);
	return { root, projectPath, ledgerPath, configPath };
}

describe("runtime host simulation", () => {
	it("records scoped paths, typed IDE targets, and sanitized external URLs", async () => {
		const fixture = await createSimulationFixture();
		const { ledger, simulator } = await loadRuntimeHostSimulation(fixture.configPath);

		await simulator.recordUnsupportedDirectoryPicker();
		await expect(
			simulator.openPath(join(fixture.projectPath, "src", "index.ts"), {
				projectId: "project-1",
				taskId: "task-1",
			}),
		).resolves.toEqual({ ok: true });
		await expect(simulator.openPath(fixture.projectPath, { projectId: "project-1" })).resolves.toEqual({
			ok: true,
		});
		await expect(simulator.openProject("cursor", fixture.projectPath, { projectId: "project-1" })).resolves.toEqual({
			ok: true,
		});
		await expect(
			simulator.openExternalUrl("https://user:password@example.com/docs?token=secret#private"),
		).resolves.toEqual({ ok: true });

		expect(ledger.list().events).toMatchObject([
			{ kind: "directory_picker", outcome: "unsupported", sequence: 1 },
			{
				kind: "open_path",
				outcome: "simulated",
				target: { scope: "primary_project", relativePath: join("src", "index.ts") },
				projectId: "project-1",
				taskId: "task-1",
				sequence: 2,
			},
			{
				kind: "open_path",
				outcome: "simulated",
				target: { scope: "primary_project", relativePath: "." },
				projectId: "project-1",
				taskId: null,
				sequence: 3,
			},
			{
				kind: "open_project",
				targetId: "cursor",
				target: { scope: "primary_project", relativePath: "." },
				projectId: "project-1",
				sequence: 4,
			},
			{
				kind: "external_url",
				url: "https://example.com/docs",
				sequence: 5,
			},
		]);
		const persisted = JSON.parse(await readFile(fixture.ledgerPath, "utf8")) as {
			events: Array<{ kind: string }>;
		};
		expect(persisted.events).toHaveLength(5);
	});

	it("rejects unscoped paths and unsafe URL protocols without recording their values", async () => {
		const fixture = await createSimulationFixture();
		const { ledger, simulator } = await loadRuntimeHostSimulation(fixture.configPath);

		await expect(simulator.openPath(join(fixture.root, "outside.txt"))).resolves.toEqual({ ok: false });
		await expect(simulator.openProject("vscode", fixture.root)).resolves.toEqual({ ok: false });
		await expect(simulator.openExternalUrl("file:///private/secret.txt")).resolves.toEqual({ ok: false });
		await expect(simulator.openPath(join(fixture.projectPath, "a".repeat(1_025)))).resolves.toEqual({ ok: false });
		await expect(simulator.openExternalUrl(`https://example.com/${"a".repeat(2_100)}`)).resolves.toEqual({
			ok: false,
		});
		expect(ledger.list().events).toEqual([]);
	});

	it("supports deterministic long-poll observation and reset", async () => {
		const fixture = await createSimulationFixture();
		const { ledger } = await loadRuntimeHostSimulation(fixture.configPath);
		const observed = ledger.waitFor({ afterSequence: 0, kind: "clipboard_write" }, 1_000);

		await ledger.recordBrowserEvent({ kind: "clipboard_write", characterCount: 12 });
		await expect(observed).resolves.toMatchObject({
			lastSequence: 1,
			events: [{ kind: "clipboard_write", characterCount: 12, sequence: 1 }],
		});

		const pendingAtReset = ledger.waitFor({ afterSequence: 1, kind: "clipboard_read" }, 1_000);
		await ledger.reset();
		await expect(pendingAtReset).resolves.toEqual({ events: [], lastSequence: 0 });
		expect(ledger.list()).toEqual({ events: [], lastSequence: 0 });
	});

	it("publishes an event only after its validated snapshot persists", async () => {
		let rejectPersistence = false;
		const persisted: RuntimeHostIntegrationEventLedgerFile[] = [];
		const ledger = new RuntimeHostEventLedger("/unused/host-events.json", {
			now: () => new Date("2026-08-23T12:34:56.000Z"),
			persist: async (_path, payload) => {
				if (rejectPersistence) {
					throw new Error("disk unavailable");
				}
				persisted.push(structuredClone(payload));
			},
		});
		await ledger.initialize();
		rejectPersistence = true;

		await expect(ledger.recordBrowserEvent({ kind: "clipboard_write", characterCount: 4 })).rejects.toThrow(
			"disk unavailable",
		);
		expect(ledger.list()).toEqual({ events: [], lastSequence: 0 });
		await expect(ledger.flush()).rejects.toThrow("unhealthy");

		rejectPersistence = false;
		await ledger.reset();
		await expect(ledger.recordBrowserEvent({ kind: "clipboard_write", characterCount: 2 })).resolves.toMatchObject({
			sequence: 1,
		});
		expect(persisted.at(-1)).toMatchObject({
			lastSequence: 1,
			events: [{ kind: "clipboard_write", characterCount: 2, sequence: 1 }],
		});
	});

	it("fails deterministically when the bounded event capacity is exhausted", async () => {
		const ledger = new RuntimeHostEventLedger("/unused/host-events.json", {
			maxEvents: 1,
			persist: async () => {},
		});
		await ledger.initialize();
		await ledger.recordBrowserEvent({ kind: "clipboard_write", characterCount: 1 });

		await expect(ledger.recordBrowserEvent({ kind: "clipboard_read", characterCount: 1 })).rejects.toThrow(
			"1-event limit",
		);
		expect(ledger.list()).toMatchObject({
			lastSequence: 1,
			events: [{ kind: "clipboard_write", sequence: 1 }],
		});
		await expect(ledger.flush()).rejects.toThrow("1-event limit");
	});

	it("rejects contract-invalid runtime drafts before they become observable", async () => {
		const ledger = new RuntimeHostEventLedger("/unused/host-events.json", {
			persist: async () => {},
		});
		await ledger.initialize();

		await expect(
			ledger.record({
				kind: "open_path",
				origin: "runtime",
				outcome: "simulated",
				target: { scope: "primary_project", relativePath: "a".repeat(1_025) },
				projectId: null,
				taskId: null,
			}),
		).rejects.toThrow();
		expect(ledger.list()).toEqual({ events: [], lastSequence: 0 });
	});
});
