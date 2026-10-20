import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	assertLinkedRuntimeIsStopped,
	bootstrapDependencies,
	ensureDependencies,
	inspectDependencyTrees,
	linkCheckout,
	normalizeCheckoutPathForComparison,
	shouldLinkDesktop,
} from "../../scripts/dependency-workflow.mjs";

describe("dependency workflow preflight", () => {
	let checkoutRoot;

	beforeEach(async () => {
		checkoutRoot = await realpath(await mkdtemp(join(tmpdir(), "quarterdeck-dependency-workflow-")));
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
		await writeFile(join(packageRoot, "node_modules/.package-lock.json"), await readFile(join(packageRoot, "package-lock.json")));
		for (const [name, version] of Object.entries(versions)) {
			await mkdir(join(packageRoot, "node_modules", name), { recursive: true });
			await writeFile(join(packageRoot, "node_modules", name, "package.json"), JSON.stringify({ version }));
		}
	}

	it("inspects both root and web dependency trees", async () => {
		await installFixture("", { "node-pty": "1.0.0", zod: "4.6.2" });
		const rootOnly = await inspectDependencyTrees(checkoutRoot);
		expect(rootOnly).toEqual({ rootAvailable: true, webAvailable: false });
		await installFixture("web-ui", { react: "19.0.0", vite: "8.0.0" });
		expect(await inspectDependencyTrees(checkoutRoot)).toEqual({ rootAvailable: true, webAvailable: true });
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
	});

	it("detects stale transitive and nested packages after lockfile-only security updates", async () => {
		await installFixture("", { zod: "4.6.2" });
		const lockPath = join(checkoutRoot, "package-lock.json");
		const lock = JSON.parse(await readFile(lockPath, "utf8"));
		const nestedPath = "node_modules/zod/node_modules/transitive";
		lock.packages[nestedPath] = { version: "2.0.1" };
		await writeFile(lockPath, JSON.stringify(lock));
		await mkdir(join(checkoutRoot, nestedPath), { recursive: true });
		await writeFile(join(checkoutRoot, nestedPath, "package.json"), JSON.stringify({ version: "2.0.0" }));
		expect((await inspectDependencyTrees(checkoutRoot)).rootAvailable).toBe(false);
		await writeFile(join(checkoutRoot, nestedPath, "package.json"), JSON.stringify({ version: "2.0.1" }));
		expect((await inspectDependencyTrees(checkoutRoot)).rootAvailable).toBe(true);
	});

	it("detects removed packages still recorded in the installed tree", async () => {
		await installFixture("", { zod: "4.6.2", obsolete: "1.0.0" });
		await writeFile(join(checkoutRoot, "package.json"), JSON.stringify({ dependencies: { zod: "4.6.2" } }));
		const lockPath = join(checkoutRoot, "package-lock.json");
		const lock = JSON.parse(await readFile(lockPath, "utf8"));
		delete lock.packages["node_modules/obsolete"];
		await writeFile(lockPath, JSON.stringify(lock));
		expect((await inspectDependencyTrees(checkoutRoot)).rootAvailable).toBe(false);
	});

	it("permits omitted optional packages but checks their versions when installed", async () => {
		await installFixture("", { zod: "4.6.2" });
		const lockPath = join(checkoutRoot, "package-lock.json");
		const lock = JSON.parse(await readFile(lockPath, "utf8"));
		lock.packages["node_modules/optional-native"] = { version: "1.1.0", optional: true };
		await writeFile(lockPath, JSON.stringify(lock));
		expect((await inspectDependencyTrees(checkoutRoot)).rootAvailable).toBe(true);
		await mkdir(join(checkoutRoot, "node_modules/optional-native"));
		await writeFile(join(checkoutRoot, "node_modules/optional-native/package.json"), JSON.stringify({ version: "1.0.0" }));
		expect((await inspectDependencyTrees(checkoutRoot)).rootAvailable).toBe(false);
	});

	it("installs only missing or stale trees", async () => {
		await installFixture("", { zod: "4.6.2" });
		await installFixture("web-ui", { react: "19.0.0" });
		const calls = [];
		const options = {
			runtime: { activeRuntimePids: [], linkedCheckout: null },
			gitCommonDirectory: join(checkoutRoot, ".git"),
			executeNpm: (args) => calls.push(args),
		};
		await ensureDependencies(checkoutRoot, options);
		expect(calls).toEqual([]);
		await writeFile(join(checkoutRoot, "node_modules/zod/package.json"), JSON.stringify({ version: "4.0.0" }));
		await rm(join(checkoutRoot, "web-ui/node_modules/react"), { recursive: true });
		await ensureDependencies(checkoutRoot, options);
		expect(calls).toEqual([["ci"], ["ci", "--prefix", "web-ui"]]);
	});

	it("prepares desktop dependencies and Electron only for desktop workflows", async () => {
		await installFixture("", {});
		await installFixture("web-ui", {});
		const calls = [];
		await ensureDependencies(checkoutRoot, {
			desktop: true,
			runtime: { activeRuntimePids: [], linkedCheckout: null },
			executeNpm: (args) => calls.push(args),
		});
		expect(calls).toEqual([
			["ci", "--prefix", "desktop"],
			["--prefix", "desktop", "exec", "--no", "--", "install-electron"],
		]);
	});

	it("builds browser mode before linking without installing desktop dependencies", async () => {
		await installFixture("", {});
		await installFixture("web-ui", {});
		const calls = [];
		await linkCheckout(checkoutRoot, {
			browser: true,
			managedInstallation: { platform: "linux" },
			runtime: { activeRuntimePids: [], linkedCheckout: null },
			executeNpm: (args) => calls.push(args),
			resolveGlobalPackageLocation: () => ({ packageSlot: join(checkoutRoot, "prefix/lib/node_modules/quarterdeck"), prefix: join(checkoutRoot, "prefix") }),
		});
		expect(calls).toEqual([["run", "build"], ["link", "--ignore-scripts"]]);
	});

	it("selects desktop by host support and preserves compatibility and browser opt-outs", () => {
		const supported = { platform: "darwin", arch: "arm64", osRelease: "25.0.0", installMode: "" };
		expect(shouldLinkDesktop(supported)).toBe(true);
		expect(shouldLinkDesktop({ ...supported, desktop: true })).toBe(true);
		expect(shouldLinkDesktop({ ...supported, browser: true })).toBe(false);
		expect(shouldLinkDesktop({ ...supported, installMode: "browser" })).toBe(false);
		expect(shouldLinkDesktop({ ...supported, platform: "linux" })).toBe(false);
		expect(shouldLinkDesktop({ ...supported, osRelease: "21.0" })).toBe(false);
	});

	function desktopLinkOptions(calls, overrides = {}) {
		const buildId = "11111111-1111-4111-8111-111111111111";
		return {
			desktop: true, platform: "darwin", arch: "arm64", osRelease: "25.0.0",
			managedInstallation: { platform: "darwin", userHome: join(checkoutRoot, "synthetic-home") },
			runtime: { activeRuntimePids: [], linkedCheckout: null },
			executeNpm: (args) => calls.push(args),
			buildDesktop: () => calls.push(["run", "desktop:build"]),
			readBuildIdentity: () => ({ schemaVersion: 1, version: "1.2.3", buildId, sourceSha: "a".repeat(40), sourceDirty: false }),
			resolveGlobalPackageLocation: () => ({ packageSlot: "/synthetic/prefix/lib/node_modules/quarterdeck", prefix: "/synthetic/prefix" }),
			resolveLinkedCheckout: () => checkoutRoot,
			installDesktop: (location) => calls.push(["install", location.packageSlot]),
			readDesktopStatus: () => ({
				state: "ready", pending: false,
				installation: {
					buildId,
					owner: { kind: "link", packageRoot: checkoutRoot, packageSlot: "/synthetic/prefix/lib/node_modules/quarterdeck", prefix: "/synthetic/prefix" },
				},
			}),
			...overrides,
		};
	}

	it("builds once, links, installs the paired app, and verifies the completed global link", async () => {
		const calls = [];
		let inspected = 0;
		await linkCheckout(checkoutRoot, desktopLinkOptions(calls, { resolveLinkedCheckout: () => { inspected += 1; return checkoutRoot; } }));
		expect(calls).toEqual([["run", "desktop:build"], ["link", "--ignore-scripts"], ["install", "/synthetic/prefix/lib/node_modules/quarterdeck"]]);
		expect(inspected).toBe(2);
	});

	it("authorizes one paired desktop build and verifies status only after app installation", async () => {
		const calls = [];
		const options = desktopLinkOptions(calls);
		const buildDesktop = vi.fn(() => calls.push(["build-desktop"]));
		const readDesktopStatus = vi.fn(() => {
			calls.push(["status"]);
			return options.readDesktopStatus();
		});
		await linkCheckout(checkoutRoot, { ...options, buildDesktop, readDesktopStatus });
		expect(buildDesktop).toHaveBeenCalledOnce();
		expect(buildDesktop.mock.calls[0][1]).toMatchObject({ pairedDesktopInstall: true });
		expect(calls).toEqual([
			["build-desktop"], ["link", "--ignore-scripts"],
			["install", "/synthetic/prefix/lib/node_modules/quarterdeck"], ["status"],
		]);
	});

	it.each([
		["missing", false], ["incomplete", true], ["owner_conflict", false], ["changed", false], ["ready", true],
	])("rejects a final app status of %s with pending=%s without reporting success", async (state, pending) => {
		const calls = [];
		const options = desktopLinkOptions(calls);
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await expect(linkCheckout(checkoutRoot, {
				...options,
				readDesktopStatus: () => ({ ...options.readDesktopStatus(), state, pending }),
			})).rejects.toThrow();
			expect(output).not.toHaveBeenCalledWith(expect.stringContaining("installation completed"));
		} finally {
			output.mockRestore();
		}
	});

	it.each([
		{ kind: "npm" }, { packageRoot: "/other/checkout" },
		{ packageSlot: "/other/prefix/lib/node_modules/quarterdeck" }, { prefix: "/other/prefix" },
	])("rejects a ready app belonging to another owner: %j", async (ownerOverrides) => {
		const options = desktopLinkOptions([]);
		const status = options.readDesktopStatus();
		await expect(linkCheckout(checkoutRoot, {
			...options,
			readDesktopStatus: () => ({
				...status,
				installation: { ...status.installation, owner: { ...status.installation.owner, ...ownerOverrides } },
			}),
		})).rejects.toThrow();
	});

	it("rejects a ready app from an earlier build of the same owner", async () => {
		const options = desktopLinkOptions([]);
		const status = options.readDesktopStatus();
		await expect(linkCheckout(checkoutRoot, {
			...options,
			readDesktopStatus: () => ({
				...status,
				installation: { ...status.installation, buildId: "22222222-2222-4222-8222-222222222222" },
			}),
		})).rejects.toThrow();
	});

	it("propagates failed or unreadable final status instead of reporting success", async () => {
		const options = desktopLinkOptions([]);
		await expect(linkCheckout(checkoutRoot, {
			...options,
			readDesktopStatus: () => { throw new Error("status failed"); },
		})).rejects.toThrow("status failed");
	});

	it.each([null, {}, { state: "ready", pending: false }])("rejects malformed final desktop status: %j", async (status) => {
		await expect(linkCheckout(checkoutRoot, {
			...desktopLinkOptions([]),
			readDesktopStatus: () => status,
		})).rejects.toThrow();
	});

	it("detects a global link replaced during app installation", async () => {
		const calls = [];
		let inspections = 0;
		await expect(linkCheckout(checkoutRoot, desktopLinkOptions(calls, {
			resolveLinkedCheckout: () => ++inspections === 1 ? checkoutRoot : "/other/checkout",
		}))).rejects.toThrow("does not point to this checkout");
		expect(calls).toContainEqual(["install", "/synthetic/prefix/lib/node_modules/quarterdeck"]);
	});

	it("does not install an app after a failed global link", async () => {
		const calls = [];
		await expect(linkCheckout(checkoutRoot, desktopLinkOptions(calls, {
			executeNpm(args) {
				calls.push(args);
				if (args[0] === "link") throw new Error("link failed");
			},
		}))).rejects.toThrow("link failed");
		expect(calls).toEqual([["run", "desktop:build"], ["link", "--ignore-scripts"]]);
	});

	it("reports an incomplete pair when app replacement fails after linking", async () => {
		const calls = [];
		await expect(linkCheckout(checkoutRoot, desktopLinkOptions(calls, { installDesktop: () => { throw new Error("quit and retry"); } }))).rejects.toThrow("quit and retry");
		expect(calls).toEqual([["run", "desktop:build"], ["link", "--ignore-scripts"]]);
	});

	it("rejects a conflicting resolved global link before app placement", async () => {
		const calls = [];
		await expect(linkCheckout(checkoutRoot, desktopLinkOptions(calls, { resolveLinkedCheckout: () => "/other/checkout" }))).rejects.toThrow("does not point to this checkout");
		expect(calls).toEqual([["run", "desktop:build"], ["link", "--ignore-scripts"]]);
	});

	it("checks active linked runtime before desktop preparation", async () => {
		const calls = [];
		await expect(linkCheckout(checkoutRoot, desktopLinkOptions(calls, { runtime: { activeRuntimePids: [1234], linkedCheckout: checkoutRoot } }))).rejects.toThrow("Stop Quarterdeck");
		expect(calls).toEqual([]);
	});

	it("rejects a shared dependency symlink before installing any tree", async () => {
		await mkdir(join(checkoutRoot, "web-ui"));
		await symlink(checkoutRoot, join(checkoutRoot, "web-ui/node_modules"), "junction");
		const calls = [];
		await expect(ensureDependencies(checkoutRoot, {
			runtime: { activeRuntimePids: [], linkedCheckout: null },
			executeNpm: (args) => calls.push(args),
		})).rejects.toThrow("real, independent node_modules");
		expect(calls).toEqual([]);
	});

	it("does not install dependencies beneath an active linked runtime", async () => {
		const calls = [];
		await expect(ensureDependencies(checkoutRoot, {
			runtime: { activeRuntimePids: [1234], linkedCheckout: checkoutRoot },
			executeNpm: (args) => calls.push(args),
		})).rejects.toThrow("Stop Quarterdeck");
		expect(calls).toEqual([]);
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
