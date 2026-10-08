import { mkdtempSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import type { TestProject } from "vitest/node";

declare module "vitest" {
	export interface ProvidedContext {
		compileIntegrationCli: boolean;
		compiledIntegrationEntrypoints?: Readonly<Record<string, string>>;
	}
}

type Teardown = () => Promise<void>;
type SetupProject = Pick<TestProject, "getProvidedContext" | "provide">;

export default function setup(): Teardown;
export default function setup(project: SetupProject): Teardown | Promise<Teardown>;
export default function setup(project?: SetupProject): Teardown | Promise<Teardown> {
	const home = mkdtempSync(join(tmpdir(), "quarterdeck-suite-home-"));
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	// Vitest creates worker environments after global setup. Keep the default
	// state-home override unset so fixtures may select their own HOME normally.
	process.env.HOME = home;
	process.env.USERPROFILE = home;

	let compiledDirectory: string | undefined;
	const teardown = async () => {
		try {
			if (compiledDirectory)
				await rm(compiledDirectory, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 });
		} finally {
			try {
				await rm(home, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 });
			} finally {
				if (previousHome === undefined) delete process.env.HOME;
				else process.env.HOME = previousHome;
				if (previousUserProfile === undefined) delete process.env.USERPROFILE;
				else process.env.USERPROFILE = previousUserProfile;
			}
		}
	};
	if (!project?.getProvidedContext().compileIntegrationCli) return teardown;

	// Compile current source once per opted-in run, never reuse a package build
	// or a live runtime. Two levels below the root preserves assets.ts's source
	// web-ui fallback while external packages resolve from this worktree.
	return (async () => {
		try {
			await mkdir(resolve(".cache"), { recursive: true });
			const directory = await mkdtemp(resolve(".cache/integration-cli-"));
			compiledDirectory = directory;
			const sources = {
				cli: "src/cli.ts",
				"desktop-channel-child": "test/utilities/desktop-channel-child.ts",
				"desktop-host-effects-child": "test/utilities/desktop-host-effects-child.ts",
				"runtime-ownership-child": "test/utilities/runtime-ownership-child.ts",
				"runtime-recovery-child": "test/utilities/runtime-recovery-child.ts",
			};
			await build({
				entryPoints: sources,
				outdir: directory,
				outExtension: { ".js": ".mjs" },
				bundle: true,
				packages: "external",
				platform: "node",
				format: "esm",
				target: "node22",
				logLevel: "silent",
			});
			await mkdir(join(directory, "terminal"));
			await copyFile(
				resolve("src/terminal/pi-lifecycle-extension.runtime.js"),
				join(directory, "terminal/pi-lifecycle-extension.runtime.js"),
			);
			project.provide(
				"compiledIntegrationEntrypoints",
				Object.fromEntries(
					Object.entries(sources).map(([name, source]) => [source, join(directory, `${name}.mjs`)]),
				),
			);
			return teardown;
		} catch (error) {
			await teardown();
			throw error;
		}
	})();
}
