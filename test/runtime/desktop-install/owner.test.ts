import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	resolveDesktopInstallationOwner,
	validateDesktopInstallationOwner,
} from "../../../src/desktop-install/owner.js";
import { desktopBuildsMatch } from "../../../src/shared/desktop-installation-contract.js";
import { createDesktopAppFixture, createInstallerDependencies } from "./fixture.js";

let root: string;
const originalArgv = process.argv;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "quarterdeck-owner-test-"));
});
afterEach(async () => {
	process.argv = originalArgv;
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});
describe("recorded npm package slot", () => {
	it("compares semantic owner fields regardless of JSON property insertion order", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies } = await createInstallerDependencies(root, fixture);
		const owner = dependencies.owner;
		await expect(
			validateDesktopInstallationOwner({
				identity: {
					sourceDirty: owner.identity.sourceDirty,
					sourceSha: owner.identity.sourceSha,
					buildId: owner.identity.buildId,
					version: owner.identity.version,
					schemaVersion: 1,
				},
				prefix: owner.prefix,
				packageRoot: owner.packageRoot,
				packageSlot: owner.packageSlot,
				kind: owner.kind,
			}),
		).resolves.toBeUndefined();
	});
	it("uses the exact invoking prefix rather than npm or npm_config_prefix from another toolchain", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies } = await createInstallerDependencies(root, fixture);
		const prefix = join(root, "second-prefix");
		const slot = join(prefix, "lib/node_modules/quarterdeck");
		await mkdir(join(prefix, "lib/node_modules"), { recursive: true });
		await symlink(dependencies.owner.packageRoot, slot);
		process.argv = [process.execPath, join(prefix, "bin/quarterdeck")];
		vi.stubEnv("PATH", "/no-tools");
		vi.stubEnv("npm_config_prefix", dependencies.owner.prefix);
		const resolved = await resolveDesktopInstallationOwner({ packageRoot: dependencies.owner.packageRoot });
		expect(resolved.packageSlot).toBe(slot);
		expect(resolved.prefix).toBe(prefix);
	});
	it("rejects an owner slot retargeted to a different checkout even with identical build metadata", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies } = await createInstallerDependencies(root, fixture);
		const other = join(await realpath(root), "other-checkout");
		await mkdir(join(other, "dist"), { recursive: true });
		await writeFile(join(other, "dist/build-manifest.json"), JSON.stringify(dependencies.owner.identity));
		await writeFile(join(other, "package.json"), JSON.stringify({ name: "quarterdeck", version: "0.12.8" }));
		await rm(dependencies.owner.packageSlot);
		await symlink(other, dependencies.owner.packageSlot);
		await expect(validateDesktopInstallationOwner(dependencies.owner)).rejects.toThrow("owning npm CLI");
	});
	it("requires package.json name and version to agree with the shipped build stamp", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies } = await createInstallerDependencies(root, fixture);
		await writeFile(
			join(dependencies.owner.packageRoot, "package.json"),
			JSON.stringify({ name: "quarterdeck", version: "0.12.9" }),
		);
		await expect(validateDesktopInstallationOwner(dependencies.owner)).rejects.toThrow("owning npm CLI");
	});
	it("allows independent published builds while every local import requires the exact paired build", async () => {
		const fixture = await createDesktopAppFixture(root);
		const { dependencies } = await createInstallerDependencies(root, fixture);
		const owner = { ...dependencies.owner, kind: "npm" as const };
		const app = { ...owner.identity, buildId: randomUUID() };
		expect(desktopBuildsMatch(owner, app, "release")).toBe(true);
		expect(desktopBuildsMatch(owner, app, "local")).toBe(false);
		expect(desktopBuildsMatch(owner, { ...app, sourceDirty: true }, "release")).toBe(false);
	});
});
