import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopFileSha256 } from "../../../src/desktop-install/files.js";
import { createDesktopInstallationService } from "../../../src/desktop-install/index.js";
import { validateDesktopReleaseManifest } from "../../../src/desktop-install/metadata.js";
import { managedDesktopInstallationReceiptSchema } from "../../../src/desktop-install/receipt.js";
import type { DesktopInstallationDependencies } from "../../../src/desktop-install/types.js";
import { createDesktopAppFixture, createInstallerDependencies } from "./fixture.js";

let root: string;
beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "quarterdeck-adhoc-install-test-")));
});
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

async function publicFixture(mode: "ad-hoc" | "signed" = "ad-hoc", version = "0.12.8") {
	const app = await createDesktopAppFixture(root, { signed: mode === "signed", distributionMode: mode, version });
	const { dependencies: linked, commands } = await createInstallerDependencies(root, app);
	const owner = linked.owner;
	// Model a real npm package slot, not a linked source tree. A second call replaces
	// the synthetic npm package first, as npm does before running its lifecycle hook.
	await rm(owner.packageSlot, { recursive: true, force: true });
	await rename(owner.packageRoot, owner.packageSlot);
	const dependencies: DesktopInstallationDependencies = {
		...linked,
		owner: { ...owner, kind: "npm", packageRoot: owner.packageSlot },
	};
	await capability(dependencies, mode === "ad-hoc" ? "adhoc-v1" : "signed-v1");
	return { app, dependencies, commands, service: createDesktopInstallationService(dependencies) };
}

async function capability(dependencies: DesktopInstallationDependencies, value: string) {
	if (!dependencies.owner) throw new Error("fixture owner missing");
	await writeFile(
		join(dependencies.owner.packageRoot, "package.json"),
		JSON.stringify({
			name: "quarterdeck",
			version: dependencies.owner.identity.version,
			quarterdeck: { desktopRelease: value },
		}),
	);
}

// These fixtures use real filesystem transactions with injected macOS tools and
// downloads. They neither execute app code nor claim native Gatekeeper acceptance.
describe.skipIf(process.platform === "win32")("public ad-hoc npm/app installation", () => {
	it("checks source and copy integrity, records unauthenticated trust, and validates offline without Gatekeeper", async () => {
		const f = await publicFixture();
		const installed = await f.service.ensureDesktopInstallation({ version: "0.12.8" });
		expect(installed).toMatchObject({ source: "release", distributionMode: "ad-hoc", cleanupPending: false });
		const receipt = JSON.parse(await readFile(installed.receiptPath, "utf8"));
		expect(receipt).toMatchObject({
			distributionMode: "ad-hoc",
			signing: { verified: false, teamId: null },
			release: { sourceSha: "a".repeat(40) },
		});
		expect(managedDesktopInstallationReceiptSchema.safeParse(receipt).success).toBe(true);
		const signatures = f.commands.filter(
			({ command, args }) => command === "/usr/bin/codesign" && args[0] === "--verify",
		);
		expect(signatures).toHaveLength(2);
		for (const signature of signatures)
			expect(signature.args.slice(0, 3)).toEqual(["--verify", "--deep", "--strict"]);
		expect(f.commands.some(({ command }) => command === "/usr/sbin/spctl")).toBe(false);
		expect(f.commands.some(({ command, args }) => command === "/usr/bin/codesign" && args[0] === "--display")).toBe(
			false,
		);
		expect(f.commands.findIndex(({ command }) => command === "/usr/bin/codesign")).toBeLessThan(
			f.commands.findIndex(({ command }) => command === "/usr/bin/ditto"),
		);
		expect((await f.service.getDesktopInstallationStatus()).state).toBe("ready");
		expect(await f.service.ensureDesktopInstallation({ version: "0.12.8" })).toEqual(installed);
		expect(f.dependencies.download).toHaveBeenCalledTimes(2);
		expect(f.commands.filter(({ command }) => command === "/usr/bin/codesign")).toHaveLength(4);
		expect(
			f.commands.every(({ command }) =>
				["/usr/bin/plutil", "/usr/bin/lipo", "/usr/bin/hdiutil", "/usr/bin/ditto", "/usr/bin/codesign"].includes(
					command,
				),
			),
		).toBe(true);
	});

	it("fails launch validation if installed ad-hoc signature integrity is no longer accepted", async () => {
		const f = await publicFixture();
		const installed = await f.service.ensureDesktopInstallation({ version: "0.12.8" });
		const receipt = await readFile(installed.receiptPath, "utf8");
		const runCommand = f.dependencies.runCommand;
		f.dependencies.runCommand = async (command, args) => {
			if (command === "/usr/bin/codesign") throw new Error("installed signature is invalid");
			return runCommand(command, args);
		};
		await expect(f.service.validateDesktopInstallation()).rejects.toThrow("installed signature is invalid");
		expect((await f.service.getDesktopInstallationStatus()).state).toBe("changed");
		expect(await readFile(installed.receiptPath, "utf8")).toBe(receipt);
	});

	it("updates N to N+1 in the same npm slot, removes staging, and retains user state", async () => {
		const first = await publicFixture();
		const installed = await first.service.ensureDesktopInstallation({ version: "0.12.8" });
		const state = join(root, "synthetic-user-state.json");
		await writeFile(state, "preserve projects and sessions");
		const next = await publicFixture("ad-hoc", "0.12.9");
		const updated = await next.service.ensureDesktopInstallation({ version: "0.12.9" });
		expect(updated).toMatchObject({
			appPath: installed.appPath,
			version: "0.12.9",
			distributionMode: "ad-hoc",
			owner: {
				prefix: installed.owner.prefix,
				packageSlot: installed.owner.packageSlot,
				packageRoot: installed.owner.packageRoot,
			},
		});
		expect(updated.installId).not.toBe(installed.installId);
		expect((await next.service.getDesktopInstallationStatus()).state).toBe("ready");
		expect(await readdir(join(root, "Applications"))).toEqual(["Quarterdeck.app"]);
		expect(await readFile(state, "utf8")).toBe("preserve projects and sessions");
	});

	it.each(["signed-v1", "browser-only", "unknown"])(
		"refuses ad-hoc downloads for owning capability %s",
		async (value) => {
			const f = await publicFixture();
			await capability(f.dependencies, value);
			vi.stubEnv("QUARTERDECK_DESKTOP_DISTRIBUTION", "ad-hoc");
			await expect(f.service.ensureDesktopInstallation({ version: "0.12.8" })).rejects.toThrow(
				/distribution policy|unknown desktop release capability/u,
			);
			expect(f.dependencies.acquireMutation).not.toHaveBeenCalled();
			expect(f.dependencies.download).toHaveBeenCalledTimes(1);
		},
	);

	it("requires ad-hoc assets for an ad-hoc npm capability, even if the download is signed", async () => {
		const f = await publicFixture("signed");
		await capability(f.dependencies, "adhoc-v1");
		await expect(f.service.ensureDesktopInstallation({ version: "0.12.8" })).rejects.toThrow("distribution policy");
		expect(f.dependencies.acquireMutation).not.toHaveBeenCalled();
	});

	it.each(["source signature", "copied signature", "changed copy", "container checksum"])(
		"retains the existing pair after a bad %s",
		async (failure) => {
			const first = await publicFixture();
			const installed = await first.service.ensureDesktopInstallation({ version: "0.12.8" });
			const before = await readFile(installed.receiptPath, "utf8");
			const next = await publicFixture("ad-hoc", "0.12.9");
			const original = next.dependencies.runCommand;
			next.dependencies.runCommand = vi.fn(async (command, args) => {
				if (
					command === "/usr/bin/codesign" &&
					args[0] === "--verify" &&
					((failure === "source signature" && args.at(-1)?.includes("/mount/")) ||
						(failure === "copied signature" && !args.at(-1)?.includes("/mount/")))
				)
					throw new Error("invalid signature");
				const result = await original(command, args);
				if (command === "/usr/bin/ditto" && failure === "changed copy")
					await writeFile(join(args[1], "Contents/Resources/app.asar"), "corrupt copy");
				return result;
			});
			if (failure === "container checksum") {
				const download = next.dependencies.download;
				next.dependencies.download = vi.fn(async (url, destination, maximum) => {
					await download(url, destination, maximum);
					if (url.endsWith(".dmg")) await writeFile(destination, "corrupt image");
				});
			}
			await expect(next.service.ensureDesktopInstallation({ version: "0.12.9" })).rejects.toThrow(
				/signature|copy is incomplete|checksum/u,
			);
			expect(await readFile(installed.receiptPath, "utf8")).toBe(before);
			expect(await readFile(join(installed.appPath, "Contents/Resources/app.asar"), "utf8")).toBe(
				`shell-${first.app.bundle.buildId}`,
			);
			expect(next.dependencies.acquireMutation).not.toHaveBeenCalled();
			expect(await readdir(join(root, "Applications"))).toEqual(["Quarterdeck.app"]);
		},
	);

	it("rejects a local prototype hidden behind an otherwise valid public manifest", async () => {
		const f = await publicFixture();
		for (const resource of ["runtime/bundle-manifest.json", "runtime/release-policy.json"]) {
			const path = join(f.app.appPath, "Contents/Resources", resource);
			const metadata = JSON.parse(await readFile(path, "utf8"));
			metadata.distributionMode = "local";
			await writeFile(path, JSON.stringify(metadata));
			f.app.manifest.checksums[resource] = await desktopFileSha256(path);
		}
		await expect(f.service.ensureDesktopInstallation({ version: "0.12.8" })).rejects.toThrow(
			"distribution mode differs",
		);
		expect(f.dependencies.acquireMutation).not.toHaveBeenCalled();
	});

	it("requires the exact local build for --from while allowing public architecture build identities", async () => {
		const f = await publicFixture();
		if (!f.dependencies.owner) throw new Error("fixture owner missing");
		f.dependencies.owner.identity.buildId = randomUUID();
		await writeFile(
			join(f.dependencies.owner.packageRoot, "dist/build-manifest.json"),
			JSON.stringify(f.dependencies.owner.identity),
		);
		await expect(f.service.ensureDesktopInstallation({ version: "0.12.8", from: f.app.appPath })).rejects.toThrow(
			"different source or local build",
		);
		expect(f.dependencies.acquireMutation).not.toHaveBeenCalled();
		expect((await f.service.ensureDesktopInstallation({ version: "0.12.8" })).distributionMode).toBe("ad-hoc");
	});

	it("rejects public source mismatch before admission, even with a valid signature", async () => {
		const f = await publicFixture();
		if (!f.dependencies.owner) throw new Error("fixture owner missing");
		f.dependencies.owner.identity.sourceSha = "b".repeat(40);
		await writeFile(
			join(f.dependencies.owner.packageRoot, "dist/build-manifest.json"),
			JSON.stringify(f.dependencies.owner.identity),
		);
		await expect(f.service.ensureDesktopInstallation({ version: "0.12.8" })).rejects.toThrow("different source");
		expect(f.dependencies.acquireMutation).not.toHaveBeenCalled();
	});

	it("refuses a live installation before replacement without changing the old app", async () => {
		const first = await publicFixture();
		const installed = await first.service.ensureDesktopInstallation({ version: "0.12.8" });
		const next = await publicFixture("ad-hoc", "0.12.9");
		next.dependencies.acquireMutation = vi.fn(async () => {
			throw new Error("installation in use");
		});
		await expect(
			createDesktopInstallationService(next.dependencies).ensureDesktopInstallation({ version: "0.12.9" }),
		).rejects.toThrow("installation in use");
		expect(await readFile(join(installed.appPath, "Contents/Resources/app.asar"), "utf8")).toBe(
			`shell-${first.app.bundle.buildId}`,
		);
	});

	it("recovers committed ad-hoc metadata and refuses a changed owning trust mode on launch", async () => {
		const f = await publicFixture();
		f.dependencies.checkpoint = async (phase) => {
			if (phase === "receipt_committed") throw new Error("interrupted cleanup");
		};
		const installed = await f.service.ensureDesktopInstallation({ version: "0.12.8" });
		expect(installed.cleanupPending).toBe(true);
		expect((await f.service.getDesktopInstallationStatus()).state).toBe("incomplete");
		delete f.dependencies.checkpoint;
		expect((await f.service.ensureDesktopInstallation({ version: "0.12.8" })).cleanupPending).toBe(false);
		await capability(f.dependencies, "signed-v1");
		expect((await f.service.getDesktopInstallationStatus()).state).toBe("changed");
	});

	it("restores an old signed manifest after an ad-hoc npm update fails, independently of new capability", async () => {
		const first = await publicFixture("signed");
		const installed = await first.service.ensureDesktopInstallation({ version: "0.12.8" });
		const oldReceipt = await readFile(installed.receiptPath, "utf8");
		const oldManifest = await readFile(join(first.dependencies.managedRoot, "release-manifest.json"), "utf8");
		const next = await publicFixture("ad-hoc", "0.12.9");
		next.dependencies.checkpoint = async (phase) => {
			if (phase === "metadata_written") throw new Error("interrupted update");
		};
		await expect(next.service.ensureDesktopInstallation({ version: "0.12.9" })).rejects.toThrow("interrupted update");
		expect(await readFile(installed.receiptPath, "utf8")).toBe(oldReceipt);
		expect(await readFile(join(next.dependencies.managedRoot, "release-manifest.json"), "utf8")).toBe(oldManifest);
		expect(await readdir(join(root, "Applications"))).toEqual(["Quarterdeck.app"]);
		delete next.dependencies.checkpoint;
		expect((await next.service.ensureDesktopInstallation({ version: "0.12.9" })).distributionMode).toBe("ad-hoc");
	});

	it("continues to validate legacy signed bundles and receipts without mode fields", async () => {
		const f = await publicFixture("signed");
		for (const resource of ["runtime/bundle-manifest.json", "runtime/release-policy.json"]) {
			const path = join(f.app.appPath, "Contents/Resources", resource);
			const metadata = JSON.parse(await readFile(path, "utf8"));
			delete metadata.distributionMode;
			await writeFile(path, JSON.stringify(metadata));
			f.app.manifest.checksums[resource] = await desktopFileSha256(path);
		}
		const manifest: Record<string, unknown> = { ...f.app.manifest };
		delete manifest.distributionMode;
		const download = f.dependencies.download;
		f.dependencies.download = async (url, destination, maximum) => {
			await download(url, destination, maximum);
			if (url.endsWith(".json")) await writeFile(destination, JSON.stringify(manifest));
		};
		const installed = await f.service.ensureDesktopInstallation({ version: "0.12.8" });
		const receipt = JSON.parse(await readFile(installed.receiptPath, "utf8"));
		delete receipt.distributionMode;
		await writeFile(installed.receiptPath, JSON.stringify(receipt));
		expect((await f.service.validateDesktopInstallation()).distributionMode).toBe("signed");
	});

	it("does not let an ad-hoc receipt claim Developer ID verification or hide its public origin", async () => {
		const f = await publicFixture();
		const installed = await f.service.ensureDesktopInstallation({ version: "0.12.8" });
		const receipt = JSON.parse(await readFile(installed.receiptPath, "utf8"));
		for (const mutation of [
			{ signing: { verified: true, teamId: null } },
			{ signing: { verified: false, teamId: "ABCDE12345" } },
			{ distributionMode: undefined },
			{ source: "local" },
			{ release: null },
		])
			expect(managedDesktopInstallationReceiptSchema.safeParse({ ...receipt, ...mutation }).success).toBe(false);
	});
});

describe("public ad-hoc artifact policy", () => {
	it("rejects local prototypes, missing mode, unsafe fuses, and conflicting signing claims", async () => {
		const app = await createDesktopAppFixture(root, { distributionMode: "ad-hoc" });
		for (const mutation of [
			{ distributionMode: "local" },
			{ distributionMode: undefined },
			{ signedDistribution: true },
			{ expectedTeamId: "ABCDE12345" },
			{ sourceDirty: true },
			{ distribution: "signed-notarized" },
			{ fuses: { ...app.manifest.fuses, EnableNodeCliInspectArguments: true } },
		])
			expect(() =>
				validateDesktopReleaseManifest({ ...app.manifest, ...mutation }, "0.12.8", "arm64", "ad-hoc"),
			).toThrow();
		expect(validateDesktopReleaseManifest(app.manifest, "0.12.8", "arm64", "ad-hoc").distribution).toBe("ad-hoc");
	});
});
