import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	assertLinkedRuntimeIsStopped,
	bootstrapDependencies,
	getMissingDependencyMessage,
	inspectDependencyTrees,
	normalizeCheckoutPathForComparison,
} from "../../scripts/dependency-workflow.mjs";

describe("dependency workflow preflight", () => {
	let checkoutRoot;

	beforeEach(async () => {
		checkoutRoot = await mkdtemp(join(tmpdir(), "quarterdeck-dependency-workflow-"));
	});

	afterEach(async () => {
		await rm(checkoutRoot, { recursive: true, force: true });
	});

	async function installFixture(relativeRoot, versions) {
		const packageRoot = join(checkoutRoot, relativeRoot);
		await mkdir(join(packageRoot, "node_modules"), { recursive: true });
		await writeFile(join(packageRoot, "package.json"), JSON.stringify({ dependencies: versions }));
		await writeFile(join(packageRoot, "package-lock.json"), JSON.stringify({
			packages: Object.fromEntries(Object.entries(versions).map(([name, version]) => [`node_modules/${name}`, { version }])),
		}));
		for (const [name, version] of Object.entries(versions)) {
			await mkdir(join(packageRoot, "node_modules", name), { recursive: true });
			await writeFile(join(packageRoot, "node_modules", name, "package.json"), JSON.stringify({ version }));
		}
	}

	it("requires both root and web dependency trees before linking", async () => {
		await installFixture("", { "node-pty": "1.0.0", zod: "4.6.2" });
		const rootOnly = await inspectDependencyTrees(checkoutRoot);
		expect(rootOnly).toEqual({ rootAvailable: true, webAvailable: false });
		expect(getMissingDependencyMessage(rootOnly)).toContain("npm ci --prefix web-ui");
		await installFixture("web-ui", { react: "19.0.0", vite: "8.0.0" });
		expect(await inspectDependencyTrees(checkoutRoot)).toEqual({ rootAvailable: true, webAvailable: true });
		expect(getMissingDependencyMessage({ rootAvailable: true, webAvailable: true })).toBeNull();
	});

	it("detects missing newly added packages even when the old markers exist", async () => {
		await installFixture("web-ui", { react: "19.0.0", vite: "8.0.0", "@dnd-kit/core": "6.3.1" });
		await rm(join(checkoutRoot, "web-ui/node_modules/@dnd-kit"), { recursive: true });
		expect((await inspectDependencyTrees(checkoutRoot)).webAvailable).toBe(false);
	});

	it("detects stale installed versions including dev dependencies", async () => {
		await installFixture("", { zod: "4.6.2" });
		await writeFile(join(checkoutRoot, "package.json"), JSON.stringify({ devDependencies: { zod: "^4.6.2" } }));
		await writeFile(join(checkoutRoot, "node_modules/zod/package.json"), JSON.stringify({ version: "4.4.0" }));
		const health = await inspectDependencyTrees(checkoutRoot);
		expect(health.rootAvailable).toBe(false);
		expect(getMissingDependencyMessage(health)).toContain("npm run bootstrap");
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

	it("treats Windows case and extended-length namespace aliases as one checkout", () => {
		expect(normalizeCheckoutPathForComparison("\\\\?\\C:\\Work\\Quarterdeck", "win32")).toBe(
			normalizeCheckoutPathForComparison("c:\\work\\quarterdeck", "win32"),
		);
		expect(normalizeCheckoutPathForComparison("\\\\?\\UNC\\Server\\Share\\Repo", "win32")).toBe(
			normalizeCheckoutPathForComparison("\\\\server\\share\\repo", "win32"),
		);
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
