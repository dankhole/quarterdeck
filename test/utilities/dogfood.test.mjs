import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDogfoodRuntimeEnv, getDefaultDogfoodStateHome } from "../../scripts/dogfood.mjs";

describe("dogfood launch isolation", () => {
	let directory;
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "quarterdeck-dogfood-env-"));
		await mkdir(join(directory, "first"));
		await mkdir(join(directory, "second"));
	});
	afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

	it("assigns a stable state home to each canonical checkout", async () => {
		const first = getDefaultDogfoodStateHome(join(directory, "first"), directory);
		expect(getDefaultDogfoodStateHome(join(directory, "first"), directory)).toBe(first);
		expect(getDefaultDogfoodStateHome(join(directory, "second"), directory)).not.toBe(first);
		expect(first.startsWith(join(directory, ".quarterdeck-dogfood", "checkouts"))).toBe(true);
		expect(first).not.toBe(join(directory, ".quarterdeck"));
		await symlink(join(directory, "first"), join(directory, "alias"), process.platform === "win32" ? "junction" : "dir");
		expect(getDefaultDogfoodStateHome(join(directory, "alias"), directory)).toBe(first);
	});

	it("honors explicit case-insensitive state-home overrides and cleans provider PATH", () => {
		const baseEnv = {
			Path: ["/checkout/node_modules/.bin", "/installed/bin"].join(delimiter),
			quarterdeck_state_home: join(directory, "explicit"),
		};
		expect(buildDogfoodRuntimeEnv(baseEnv, join(directory, "first"), directory)).toEqual({
			Path: "/installed/bin", quarterdeck_state_home: join(directory, "explicit"),
		});
		expect(baseEnv.Path).toContain("node_modules/.bin");
	});

	it("replaces an empty override with the checkout home", () => {
		expect(buildDogfoodRuntimeEnv({ QUARTERDECK_STATE_HOME: "" }, join(directory, "first"), directory).QUARTERDECK_STATE_HOME)
			.toBe(getDefaultDogfoodStateHome(join(directory, "first"), directory));
	});
});
