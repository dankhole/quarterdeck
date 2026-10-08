import { createRequire } from "node:module";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rebuildRuntimePty } from "../scripts/native-runtime.mjs";
import { desktopRoot } from "../scripts/paths.mjs";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../scripts/process.mjs", () => ({ run }));
const require = createRequire(import.meta.url);

beforeEach(() => run.mockReset());

describe("bundled Node PTY compilation", () => {
	it("calls node-gyp directly with the helper target and preserves node-pty postinstall", () => {
		const runtimePath = "/synthetic/runtime";
		const nodeBin = join(runtimePath, "bin", "node");
		const env = {
			PATH: "/synthetic/runtime/bin:/toolchain/bin",
			npm_config_cache: "/synthetic/npm-cache",
			npm_config_python: "/toolchain/python",
			npm_config_runtime: "electron",
			npm_config_target: "44.5.1",
			npm_config_arch: "x64",
			npm_config_disturl: "https://electron.example",
			npm_config_devdir: "/electron/headers",
			npm_package_config_node_gyp_target: "44.5.1",
			npm_package_config_node_gyp_dist_url: "https://electron.example",
			npm_package_config_node_gyp_nodedir: "/electron/headers",
		};
		rebuildRuntimePty({ runtimePath, nodeBin, nodeVersion: "22.22.2", arch: "arm64", env });
		const options = {
			cwd: join(runtimePath, "node_modules", "node-pty"),
			env: { PATH: env.PATH, npm_config_cache: env.npm_config_cache, npm_config_python: env.npm_config_python },
		};
		expect(run.mock.calls).toEqual([
			[
				nodeBin,
				[
					require.resolve("node-gyp/bin/node-gyp.js"),
					"rebuild",
					"--target=22.22.2",
					"--arch=arm64",
					"--dist-url=https://nodejs.org/download/release",
					`--devdir=${join(desktopRoot, ".cache", "node-gyp")}`,
				],
				options,
			],
			[nodeBin, [join(options.cwd, "scripts", "post-install.js")], options],
		]);
		expect(env.npm_config_target).toBe("44.5.1");
	});

	it("does not run postinstall after a failed native compilation", () => {
		run.mockImplementationOnce(() => {
			throw new Error("Native compilation failed");
		});
		expect(() =>
			rebuildRuntimePty({
				runtimePath: "/synthetic/runtime",
				nodeBin: "/synthetic/runtime/bin/node",
				nodeVersion: "22.22.2",
				arch: "arm64",
				env: {},
			}),
		).toThrow("Native compilation failed");
		expect(run).toHaveBeenCalledTimes(1);
	});
});
