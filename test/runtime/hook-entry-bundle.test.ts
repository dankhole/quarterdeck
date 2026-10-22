import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import * as esbuild from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

import { createQuarterdeckEsbuildOptions } from "../../scripts/esbuild-shared-options.mjs";

/**
 * Bundle hygiene for the lightweight hook entry (`src/hook-main.ts` /
 * `src/hook-entry.ts`, built by `scripts/build.mjs` to `dist/hooks.js`). Every
 * Claude/Codex/Pi hook spawns a full Node process running this bundle, so it
 * must never pull in commander, `@trpc/*`, node-pty, zod, or the heavy
 * terminal/session and workdir/git modules that the full CLI needs. Builds
 * with the exact same esbuild options as the real build (narrowed to this one
 * entry point) and inspects the metafile.
 *
 * `@trpc/*`, `commander`, `node-pty`, and `zod` are all in the esbuild
 * `external` list, so they can never appear as bundled *inputs* even if
 * something transitively imported them — checking inputs alone would not
 * fail if one of those leaked in. The output's `imports` list is what
 * actually records every external package the bundle still reaches for at
 * runtime (via `require`/`import`), so that's what's asserted against the
 * disallowed set below.
 */

const DISALLOWED_EXTERNAL_IMPORTS = ["commander", "node-pty", "zod"];

function isDisallowedExternalImport(path: string): boolean {
	return DISALLOWED_EXTERNAL_IMPORTS.includes(path) || path.startsWith("@trpc/");
}

// Built under the repo's own .cache/ (gitignored, same convention as
// test/global-setup.ts's integration CLI compile) rather than the OS temp
// directory: the spawned-process test below needs Node's module resolution
// for the external "proper-lockfile" import to find the repo's node_modules
// by walking up from the built file, which only works if it's built inside
// the repo tree.
let outputDirectory: string;

afterEach(async () => {
	if (outputDirectory) {
		await rm(outputDirectory, { recursive: true, force: true });
	}
});

async function buildHooksBundle(outfile: string) {
	return await esbuild.build({
		...createQuarterdeckEsbuildOptions("hook-bundle-hygiene-test"),
		entryPoints: ["src/hook-main.ts"],
		outfile,
		metafile: true,
		sourcemap: false,
	});
}

function outputEntryFor(metafile: esbuild.Metafile, outfile: string) {
	const entry =
		metafile.outputs[outfile] ??
		Object.values(metafile.outputs).find((candidate) => candidate.entryPoint === "src/hook-main.ts");
	if (!entry) {
		throw new Error("Expected a metafile output entry for the hook bundle.");
	}
	return entry;
}

describe("dist/hooks.js bundle hygiene", () => {
	it("never reaches for commander, @trpc/*, node-pty, or zod at runtime, and never bundles heavy terminal/workdir modules", async () => {
		await mkdir(resolve(".cache"), { recursive: true });
		outputDirectory = await mkdtemp(resolve(".cache/hooks-bundle-hygiene-"));
		const outfile = join(outputDirectory, "hooks.js");
		const result = await buildHooksBundle(outfile);
		const metafile = result.metafile;
		if (!metafile) {
			throw new Error("Expected esbuild to produce a metafile.");
		}

		const inputs = Object.keys(metafile.inputs);
		expect(inputs.length).toBeGreaterThan(0);

		const disallowedInputs = inputs.filter(
			(input) =>
				input.startsWith("src/terminal/session-") ||
				input.startsWith("src/workdir/") ||
				input === "src/core/index.ts" ||
				input === "src/terminal/index.ts" ||
				input === "src/fs/index.ts",
		);
		expect(disallowedInputs).toEqual([]);

		// External packages (commander, @trpc/*, node-pty, zod) never show up as
		// bundled *inputs* — they're excluded from bundling entirely — so this is
		// the check that actually catches a regression: every external import the
		// built output still performs at runtime.
		const output = outputEntryFor(metafile, outfile);
		const externalImportPaths = output.imports.filter((entry) => entry.external).map((entry) => entry.path);
		expect(externalImportPaths.length).toBeGreaterThan(0); // sanity: node: builtins/proper-lockfile are expected
		expect(externalImportPaths.filter(isDisallowedExternalImport)).toEqual([]);

		// The built entry explicitly calls process.exit(process.exitCode ?? 0) after
		// main() settles (mirroring src/cli.ts), so a successful best-effort notify
		// exits cleanly on its own rather than relying on the event loop draining.
		const notifyResult = runHooksWithoutEnv(outfile, "notify");
		expect(notifyResult.status).toBe(0);
		expect(notifyResult.stderr).toBe("");
	}, 20_000);

	it("runs correctly when invoked through a symlinked path (npm-global/Agent-Lab style layout)", async () => {
		await mkdir(resolve(".cache"), { recursive: true });
		outputDirectory = await mkdtemp(resolve(".cache/hooks-bundle-symlink-"));
		const realDistDir = join(outputDirectory, "real", "dist");
		const outfile = join(realDistDir, "hooks.js");
		await buildHooksBundle(outfile);

		const symlinkDir = join(outputDirectory, "linked");
		await symlink(join(outputDirectory, "real"), symlinkDir);
		const symlinkedOutfile = join(symlinkDir, "dist", "hooks.js");

		// "ingest" with no QUARTERDECK_HOOK_* env writes a specific stderr message
		// and exits 1 — unlike "notify", which silently swallows the same failure.
		// That makes it possible to tell "main() actually ran" apart from "main()
		// was silently skipped", which is exactly the bug class being guarded
		// against here (an earlier guard compared import.meta.url to argv[1] and
		// silently no-op'd under a symlinked invocation path).
		for (const path of [outfile, symlinkedOutfile]) {
			const result = runHooksWithoutEnv(path, "ingest");
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("quarterdeck hooks ingest:");
		}
	}, 20_000);
});

function runHooksWithoutEnv(
	hooksJsPath: string,
	subcommand: "ingest" | "notify",
): { status: number | null; stderr: string } {
	const env = { ...process.env };
	delete env.QUARTERDECK_HOOK_TASK_ID;
	delete env.QUARTERDECK_HOOK_PROJECT_ID;
	delete env.QUARTERDECK_HOOK_SESSION_INSTANCE_ID;
	try {
		execFileSync(process.execPath, [hooksJsPath, "hooks", subcommand, "--event", "to_review", "--source", "claude"], {
			stdio: ["ignore", "ignore", "pipe"],
			env,
		});
		return { status: 0, stderr: "" };
	} catch (error) {
		const execError = error as { status: number | null; stderr: Buffer | string };
		return { status: execError.status, stderr: String(execError.stderr) };
	}
}
