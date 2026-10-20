import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildCheckout } from "../../scripts/build-all.mjs";
import { cleanCheckout } from "../../scripts/clean.mjs";
import { buildDesktopCheckout, linkCheckout } from "../../scripts/dependency-workflow.mjs";
import { assertStandaloneBuildIsSafe } from "../../scripts/managed-installation-guard.mjs";

describe("managed installation source-build guard", () => {
	let root;
	let checkoutRoot;
	let userHome;
	let receiptPath;
	let guardOptions;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "quarterdeck-build-guard-"));
		checkoutRoot = join(root, "checkout");
		userHome = join(root, "home");
		receiptPath = join(userHome, "Library/Application Support/Quarterdeck/installation/managed-installation.json");
		await mkdir(checkoutRoot);
		await mkdir(dirname(receiptPath), { recursive: true });
		guardOptions = { platform: "darwin", userHome, receiptPath };
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	});

	async function writeReceipt(overrides = {}) {
		const prefix = join(root, "owner-prefix");
		const buildId = "11111111-1111-4111-8111-111111111111";
		const receipt = {
			schemaVersion: 2,
			managedBy: "quarterdeck-npm",
			installId: "22222222-2222-4222-8222-222222222222",
			version: "1.2.3",
			arch: "arm64",
			source: "local",
			appPath: join(userHome, "Applications", "Quarterdeck.app"),
			bundleId: "io.github.dankhole.quarterdeck",
			buildId,
			appAsarSha256: "a".repeat(64),
			appTreeSha256: "b".repeat(64),
			desktopLaunchProtocolVersion: 1,
			updatesEnabled: false,
			owner: {
				kind: "link",
				packageSlot: join(prefix, "lib/node_modules/quarterdeck"),
				packageRoot: checkoutRoot,
				prefix,
				identity: { schemaVersion: 1, version: "1.2.3", buildId, sourceSha: "c".repeat(40), sourceDirty: false },
			},
			signing: { verified: false, teamId: null },
			release: null,
			...overrides,
		};
		await writeFile(receiptPath, JSON.stringify(receipt));
		return receipt;
	}

	it("allows a checkout with no managed receipt", async () => {
		await expect(assertStandaloneBuildIsSafe(checkoutRoot, guardOptions)).resolves.toBeUndefined();
	});

	it("allows another worktree even when its sibling owns the installed app", async () => {
		const otherCheckout = join(root, "other-worktree");
		await mkdir(otherCheckout);
		await writeReceipt();
		await expect(assertStandaloneBuildIsSafe(otherCheckout, guardOptions)).resolves.toBeUndefined();
	});

	it("blocks the recorded owner even when its npm prefix is no longer current", async () => {
		await writeReceipt();
		vi.stubEnv("npm_config_prefix", join(root, "different-prefix"));
		await expect(assertStandaloneBuildIsSafe(checkoutRoot, guardOptions)).rejects.toThrow(/npm run (link|desktop:install)/u);
	});

	it("also protects a recorded npm owner", async () => {
		const receipt = await writeReceipt();
		await writeReceipt({ owner: { ...receipt.owner, kind: "npm" } });
		await expect(assertStandaloneBuildIsSafe(checkoutRoot, guardOptions)).rejects.toThrow();
	});

	it("compares the build checkout and recorded owner through real paths", async () => {
		const alias = join(root, "checkout-alias");
		await symlink(checkoutRoot, alias, "junction");
		await writeReceipt();
		await expect(assertStandaloneBuildIsSafe(alias, guardOptions)).rejects.toThrow(/npm run (link|desktop:install)/u);
		const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
		await writeReceipt({ owner: { ...receipt.owner, packageRoot: alias } });
		await expect(assertStandaloneBuildIsSafe(checkoutRoot, guardOptions)).rejects.toThrow(/npm run (link|desktop:install)/u);
	});

	it("blocks a recorded package slot that now resolves to this checkout", async () => {
		const receipt = await writeReceipt();
		const previousCheckout = join(root, "previous-owner");
		await mkdir(previousCheckout);
		await mkdir(dirname(receipt.owner.packageSlot), { recursive: true });
		await symlink(checkoutRoot, receipt.owner.packageSlot, "junction");
		await writeReceipt({ owner: { ...receipt.owner, packageRoot: previousCheckout } });
		await expect(assertStandaloneBuildIsSafe(checkoutRoot, guardOptions)).rejects.toThrow(/npm run (link|desktop:install)/u);
	});

	it("recognizes an aliased owner slot even when its package directories are missing", async () => {
		const receipt = await writeReceipt();
		await mkdir(receipt.owner.prefix);
		const prefixAlias = join(root, "prefix-alias");
		await symlink(await realpath(receipt.owner.prefix), prefixAlias, "junction");
		const otherCheckout = join(root, "other-worktree");
		await mkdir(otherCheckout);
		await expect(assertStandaloneBuildIsSafe(otherCheckout, {
			...guardOptions,
			packageSlot: join(prefixAlias, "lib/node_modules/quarterdeck"),
		})).rejects.toThrow();
	});

	it.each(["{broken", "null", JSON.stringify({ schemaVersion: 2, managedBy: "quarterdeck-npm" })])(
		"fails conservatively for malformed managed metadata: %s",
		async (contents) => {
			await writeFile(receiptPath, contents);
			await expect(assertStandaloneBuildIsSafe(checkoutRoot, guardOptions)).rejects.toThrow();
		},
	);

	it("fails conservatively when the receipt cannot be read as a file", async () => {
		await mkdir(receiptPath);
		await expect(assertStandaloneBuildIsSafe(checkoutRoot, guardOptions)).rejects.toThrow();
	});

	it("does not impose macOS installation policy on other platforms", async () => {
		await writeFile(receiptPath, "{broken");
		await expect(assertStandaloneBuildIsSafe(checkoutRoot, { ...guardOptions, platform: "linux" })).resolves.toBeUndefined();
	});

	it("cannot bypass the owner guard through inherited build or state environment", async () => {
		await writeReceipt();
		vi.stubEnv("HOME", join(root, "alternate-home"));
		vi.stubEnv("QUARTERDECK_STATE_HOME", join(root, "alternate-state"));
		vi.stubEnv("QUARTERDECK_BUILD_ID", "33333333-3333-4333-8333-333333333333");
		await expect(assertStandaloneBuildIsSafe(checkoutRoot, { platform: "darwin", userHome })).rejects.toThrow();
	});

	it("allows an explicitly paired installation build of a valid owned checkout", async () => {
		await writeReceipt();
		await expect(assertStandaloneBuildIsSafe(checkoutRoot, { ...guardOptions, pairedDesktopInstall: true })).resolves.toBeUndefined();
	});

	it("still rejects malformed receipt metadata in an explicitly paired workflow", async () => {
		await writeFile(receiptPath, "{broken");
		await expect(assertStandaloneBuildIsSafe(checkoutRoot, { ...guardOptions, pairedDesktopInstall: true })).rejects.toThrow();
	});

	it("rejects malformed metadata before a paired link starts building or installing", async () => {
		await writeFile(receiptPath, "{broken");
		const calls = [];
		await expect(linkCheckout(checkoutRoot, {
			desktop: true, platform: "darwin", arch: "arm64", osRelease: "25.0.0",
			managedInstallation: guardOptions,
			runtime: { activeRuntimePids: [], linkedCheckout: null },
			resolveGlobalPackageLocation: () => ({ packageSlot: join(root, "prefix/lib/node_modules/quarterdeck"), prefix: join(root, "prefix") }),
			buildDesktop: () => calls.push("build"),
			executeNpm: (args) => calls.push(args),
			installDesktop: () => calls.push("install"),
		})).rejects.toThrow();
		expect(calls).toEqual([]);
	});

	it("blocks the ordinary build before cleaning existing runtime output", async () => {
		await writeReceipt();
		await mkdir(join(checkoutRoot, "dist"));
		await writeFile(join(checkoutRoot, "dist/cli.js"), "installed runtime");
		const calls = [];
		await expect(buildCheckout(checkoutRoot, {
			managedInstallation: guardOptions,
			execute: (command, args) => calls.push([command, args]),
		})).rejects.toThrow(/npm run (link|desktop:install)/u);
		expect(calls).toEqual([]);
		expect(await readFile(join(checkoutRoot, "dist/cli.js"), "utf8")).toBe("installed runtime");
	});

	it.each([false, true])("builds fresh matching artifacts and provenance with paired authorization=%s", async (pairedDesktopInstall) => {
		if (pairedDesktopInstall) await writeReceipt();
		const staleBuildId = "44444444-4444-4444-8444-444444444444";
		const sourceSha = "d".repeat(40);
		vi.stubEnv("QUARTERDECK_BUILD_ID", staleBuildId);
		await writeFile(join(checkoutRoot, "package.json"), JSON.stringify({ version: "1.2.3" }));
		await mkdir(join(checkoutRoot, "dist"));
		await writeFile(join(checkoutRoot, "dist/stale-output"), "old artifact");
		await writeFile(join(checkoutRoot, "dist/build-manifest.json"), JSON.stringify({ buildId: staleBuildId }));
		await mkdir(join(checkoutRoot, "coverage"));
		await writeFile(join(checkoutRoot, "coverage/stale-report"), "old coverage");
		const stages = [];
		const buildIds = [];
		const execute = (command, args, options) => {
			expect(options.cwd).toBe(checkoutRoot);
			if (command === "git") {
				if (args.join(" ") === "rev-parse HEAD") return { status: 0, stdout: `${sourceSha}\n` };
				if (args.join(" ") === "status --porcelain") return { status: 0, stdout: "" };
				throw new Error(`Unexpected Git invocation: ${args.join(" ")}`);
			}
			const buildId = options.env.QUARTERDECK_BUILD_ID;
			buildIds.push(buildId);
			if (args.includes("web:build")) {
				stages.push("web");
				// This is the real cleanCheckout call, including its owner guard.
				expect(existsSync(join(checkoutRoot, "dist"))).toBe(false);
				expect(existsSync(join(checkoutRoot, "coverage"))).toBe(false);
				return { status: 0 };
			}
			if (command === process.execPath && args.join(" ") === "scripts/build.mjs") {
				stages.push("runtime");
				mkdirSync(join(checkoutRoot, "dist/web-ui/assets"), { recursive: true });
				writeFileSync(join(checkoutRoot, "dist/cli.js"), `runtime build ${buildId}`);
				writeFileSync(join(checkoutRoot, "dist/web-ui/index.html"), '<script src="/assets/index.js"></script>');
				writeFileSync(join(checkoutRoot, "dist/web-ui/assets/index.js"), `browser build ${buildId}`);
				return { status: 0 };
			}
			throw new Error(`Unexpected build command: ${command} ${args.join(" ")}`);
		};
		const manifest = await buildCheckout(checkoutRoot, {
			pairedDesktopInstall,
			managedInstallation: guardOptions,
			runtime: { activeRuntimePids: [], linkedCheckout: null },
			execute,
		});
		expect(stages).toEqual(["web", "runtime"]);
		expect(manifest).toEqual({
			schemaVersion: 1, version: "1.2.3", sourceSha, sourceDirty: false,
			buildId: expect.stringMatching(/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/u),
		});
		expect(manifest.buildId).not.toBe(staleBuildId);
		expect(buildIds).toEqual([manifest.buildId, manifest.buildId]);
		expect(JSON.parse(await readFile(join(checkoutRoot, "dist/build-manifest.json"), "utf8"))).toEqual(manifest);
		expect(await readFile(join(checkoutRoot, "dist/cli.js"), "utf8")).toContain(manifest.buildId);
		expect(await readFile(join(checkoutRoot, "dist/web-ui/assets/index.js"), "utf8")).toContain(manifest.buildId);
	});

	it("blocks direct cleaning before removing installed runtime output", async () => {
		await writeReceipt();
		await mkdir(join(checkoutRoot, "dist"));
		await writeFile(join(checkoutRoot, "dist/cli.js"), "installed runtime");
		await expect(cleanCheckout(checkoutRoot, { managedInstallation: guardOptions })).rejects.toThrow();
		expect(await readFile(join(checkoutRoot, "dist/cli.js"), "utf8")).toBe("installed runtime");
	});

	it("blocks standalone desktop packaging before dependency installation or building", async () => {
		await writeReceipt();
		const calls = [];
		await expect(buildDesktopCheckout(checkoutRoot, {
			managedInstallation: guardOptions,
			executeNpm: (args) => calls.push(args),
			buildCheckout: () => calls.push("build"),
			runtime: { activeRuntimePids: [], linkedCheckout: null },
		})).rejects.toThrow(/npm run (link|desktop:install)/u);
		expect(calls).toEqual([]);
	});

	it.skipIf(process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch))(
		"prepares, builds once, and packages the desktop candidate with paired authorization",
		async () => {
			await writeReceipt();
			const originalReceipt = await readFile(receiptPath, "utf8");
			await Promise.all(["", "web-ui", "desktop"].map(async (prefix) => {
				const packageRoot = join(checkoutRoot, prefix);
				await mkdir(join(packageRoot, "node_modules"), { recursive: true });
				await Promise.all([
					writeFile(join(packageRoot, "package.json"), JSON.stringify({ dependencies: {} })),
					writeFile(join(packageRoot, "package-lock.json"), JSON.stringify({ packages: {} })),
					writeFile(join(packageRoot, "node_modules/.package-lock.json"), JSON.stringify({ packages: {} })),
				]);
			}));
			const calls = [];
			const identity = { schemaVersion: 1, version: "1.2.3", buildId: "55555555-5555-4555-8555-555555555555", sourceSha: "e".repeat(40), sourceDirty: false };
			const build = vi.fn((buildRoot, options) => {
				expect(buildRoot).toBe(checkoutRoot);
				expect(options).toMatchObject({ pairedDesktopInstall: true, managedInstallation: guardOptions });
				calls.push(["build"]);
				return identity;
			});
			const result = await buildDesktopCheckout(checkoutRoot, {
				pairedDesktopInstall: true,
				managedInstallation: guardOptions,
				runtime: { activeRuntimePids: [], linkedCheckout: null },
				executeNpm: (args) => calls.push(args),
				buildCheckout: build,
			});
			expect(build).toHaveBeenCalledOnce();
			expect(calls).toEqual([
				["--prefix", "desktop", "exec", "--no", "--", "install-electron"],
				["build"],
				["--prefix", "desktop", "run", "package", "--", `--arch=${process.arch}`],
			]);
			expect(result).toEqual({
				appPath: join(checkoutRoot, "desktop/out", `Quarterdeck-darwin-${process.arch}`, "Quarterdeck.app"),
				identity,
			});
			expect(await readFile(receiptPath, "utf8")).toBe(originalReceipt);
		},
	);

	it("blocks browser relinking before dependency installation or build commands", async () => {
		await writeReceipt();
		const calls = [];
		await expect(linkCheckout(checkoutRoot, {
			browser: true,
			managedInstallation: guardOptions,
			resolveGlobalPackageLocation: () => ({ packageSlot: join(root, "browser-prefix/lib/node_modules/quarterdeck"), prefix: join(root, "browser-prefix") }),
			executeNpm: (args) => calls.push(args),
			runtime: { activeRuntimePids: [], linkedCheckout: null },
		})).rejects.toThrow(/npm run (link|desktop:install)/u);
		expect(calls).toEqual([]);
	});

	it("blocks another checkout from browser-only replacement of the installed owner's package slot", async () => {
		const receipt = await writeReceipt();
		const otherCheckout = join(root, "other-worktree");
		await mkdir(otherCheckout);
		const calls = [];
		await expect(linkCheckout(otherCheckout, {
			browser: true,
			managedInstallation: guardOptions,
			resolveGlobalPackageLocation: () => ({ packageSlot: receipt.owner.packageSlot, prefix: receipt.owner.prefix }),
			executeNpm: (args) => calls.push(args),
			runtime: { activeRuntimePids: [], linkedCheckout: null },
		})).rejects.toThrow();
		expect(calls).toEqual([]);
	});
});
