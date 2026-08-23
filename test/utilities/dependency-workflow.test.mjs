import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	assertLinkedRuntimeIsStopped,
	bootstrapDependencies,
	getMissingDependencyMessage,
	inspectDependencyTrees,
} from "../../scripts/dependency-workflow.mjs";

describe("dependency workflow preflight", () => {
	let checkoutRoot;

	beforeEach(async () => {
		checkoutRoot = await mkdtemp(join(tmpdir(), "quarterdeck-dependency-workflow-"));
	});

	afterEach(async () => {
		await rm(checkoutRoot, { recursive: true, force: true });
	});

	it("requires both root and web dependency trees before linking", async () => {
		await mkdir(join(checkoutRoot, "node_modules", "node-pty"), { recursive: true });
		await mkdir(join(checkoutRoot, "node_modules", "zod"), { recursive: true });
		await writeFile(join(checkoutRoot, "node_modules", "node-pty", "package.json"), "{}", "utf8");
		await writeFile(join(checkoutRoot, "node_modules", "zod", "package.json"), "{}", "utf8");

		const rootOnly = await inspectDependencyTrees(checkoutRoot);
		expect(rootOnly).toEqual({ rootAvailable: true, webAvailable: false });
		expect(getMissingDependencyMessage(rootOnly)).toContain("npm ci --prefix web-ui");

		await mkdir(join(checkoutRoot, "web-ui", "node_modules", "react"), { recursive: true });
		await mkdir(join(checkoutRoot, "web-ui", "node_modules", "vite"), { recursive: true });
		await writeFile(join(checkoutRoot, "web-ui", "node_modules", "react", "package.json"), "{}", "utf8");
		await writeFile(join(checkoutRoot, "web-ui", "node_modules", "vite", "package.json"), "{}", "utf8");

		expect(await inspectDependencyTrees(checkoutRoot)).toEqual({ rootAvailable: true, webAvailable: true });
		expect(getMissingDependencyMessage({ rootAvailable: true, webAvailable: true })).toBeNull();
	});

	it("refuses to reinstall or relink beneath an active linked runtime", async () => {
		await expect(
			assertLinkedRuntimeIsStopped(checkoutRoot, {
				activeRuntimePids: [1234],
				linkedCheckout: checkoutRoot,
			}),
		).rejects.toThrow("Stop Quarterdeck before reinstalling dependencies, rebuilding, or relinking");
	});

	it("allows a different checkout or a stopped runtime", async () => {
		const otherCheckout = await mkdtemp(join(tmpdir(), "quarterdeck-other-checkout-"));
		try {
			await expect(
				assertLinkedRuntimeIsStopped(checkoutRoot, {
					activeRuntimePids: [1234],
					linkedCheckout: otherCheckout,
				}),
			).resolves.toBeUndefined();
			await expect(
				assertLinkedRuntimeIsStopped(checkoutRoot, {
					activeRuntimePids: [],
					linkedCheckout: checkoutRoot,
				}),
			).resolves.toBeUndefined();
		} finally {
			await rm(otherCheckout, { recursive: true, force: true });
		}
	});

	it("migrates the legacy browser cache before replacing either dependency tree", async () => {
		const gitCommonDirectory = join(checkoutRoot, ".git");
		const legacyInstallation = join(
			checkoutRoot,
			"web-ui",
			"node_modules",
			".cache",
			"agent-lab-playwright",
			"chromium-1237",
		);
		await mkdir(legacyInstallation, { recursive: true });
		await writeFile(join(legacyInstallation, "INSTALLATION_COMPLETE"), "", "utf8");
		await writeFile(join(legacyInstallation, "browser-binary"), "complete\n", "utf8");
		const npmCalls = [];

		const prepared = await bootstrapDependencies(checkoutRoot, {
			runtime: { activeRuntimePids: [], linkedCheckout: null },
			gitCommonDirectory,
			executeNpm(args) {
				npmCalls.push(args);
			},
		});

		expect(prepared.status).toBe("migrated");
		expect(npmCalls).toEqual([["ci"], ["ci", "--prefix", "web-ui"]]);
		expect(
			await readFile(join(prepared.path, "chromium-1237", "browser-binary"), "utf8"),
		).toBe("complete\n");
	});
});
