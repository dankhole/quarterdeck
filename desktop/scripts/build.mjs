import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { mainBuildOptions, preloadBuildOptions } from "./build-options.mjs";
import { desktopRoot, repoRoot } from "./paths.mjs";

const [desktopPackage, runtimePackage] = await Promise.all([
	readFile(join(desktopRoot, "package.json"), "utf8").then(JSON.parse),
	readFile(join(repoRoot, "package.json"), "utf8").then(JSON.parse),
]);
if (desktopPackage.version !== runtimePackage.version) {
	throw new Error("Desktop and runtime package versions must match before building.");
}
await rm(join(desktopRoot, "dist"), { recursive: true, force: true });
await mkdir(join(desktopRoot, "dist"), { recursive: true });
await Promise.all([build(mainBuildOptions), build(preloadBuildOptions)]);
console.log(`Built Quarterdeck desktop shell ${desktopPackage.version}.`);
