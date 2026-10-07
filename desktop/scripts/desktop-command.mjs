import { join } from "node:path";
import { parseArgs } from "node:util";
import { desktopRoot, requireNativeMacTarget } from "./paths.mjs";
import { run } from "./process.mjs";
import { stageRuntime } from "./stage-runtime.mjs";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { arch: { type: "string", default: process.arch } },
});
const command = positionals[0];
if (!["start", "package", "make"].includes(command) || positionals.length !== 1) {
	throw new Error("Use start, package, or make with an optional --arch=arm64|x64.");
}
requireNativeMacTarget(values.arch);
if (command === "start" && !process.env.QUARTERDECK_DESKTOP_LAB_CONFIG) {
	throw new Error("Desktop prototype start requires an isolated Agent Lab launch configuration.");
}
run(process.execPath, [join(desktopRoot, "scripts", "build.mjs")]);
const runtimePath = await stageRuntime(values.arch);
const env = {
	...process.env,
	QUARTERDECK_DESKTOP_ARCH: values.arch,
	QUARTERDECK_DESKTOP_RUNTIME_PATH: runtimePath,
	electron_config_cache: join(desktopRoot, ".cache", "electron"),
};
if (command === "start") run(process.execPath, [join(desktopRoot, "node_modules", "electron", "install.js")], { env });
const targetArguments = command === "start" ? [] : ["--platform=darwin", `--arch=${values.arch}`];
run(
	process.execPath,
	[
		join(desktopRoot, "node_modules", "@electron-forge", "cli", "dist", "electron-forge.js"),
		command,
		...targetArguments,
	],
	{ cwd: desktopRoot, env },
);
