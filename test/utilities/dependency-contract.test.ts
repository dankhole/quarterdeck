import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface Lockfile {
	packages: Record<string, { version?: string }>;
}

const root = resolve(import.meta.dirname, "../..");
const runtimeLock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8")) as Lockfile;
const browserLock = JSON.parse(readFileSync(resolve(root, "web-ui/package-lock.json"), "utf8")) as Lockfile;

describe("shared runtime/browser dependency contracts", () => {
	it.each(["zod", "@trpc/client", "@trpc/server"])("locks %s to the same version in both trees", (name) => {
		const runtimeVersion = runtimeLock.packages[`node_modules/${name}`]?.version;
		const browserVersion = browserLock.packages[`node_modules/${name}`]?.version;
		expect(runtimeVersion).toBeTypeOf("string");
		expect(browserVersion, `Update ${name} in both dependency trees together`).toBe(runtimeVersion);
	});
});
